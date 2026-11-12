import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers";
import { LivePreviewSaveCoordinator } from "../../src/extension/livePreviewSaveCoordinator";
import { SerialQueue } from "../../src/extension/serialQueue";

const cases: { name: string; run: () => Promise<void> }[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
// Advance promise continuations without moving the controlled clock.
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

function fixture() {
  const editQueue = new SerialQueue();
  const errors: unknown[] = [];
  const writes: string[] = [];
  const conflicts = new Set<string>();
  const peers = new Map<string, Peer[]>();
  type Document = ReturnType<typeof document>;
  type Peer = ReturnType<typeof peer>;
  const host = {
    forceSave: async (doc: Document) => { await doc.save(); },
    hasConflicts: (key: string) => conflicts.has(key),
  };
  const coordinator = new LivePreviewSaveCoordinator<Document, Peer>({
    editQueue,
    readyPeers: key => peers.get(key),
    hasConflicts: key => host.hasConflicts(key),
    forceSave: async doc => { writes.push("force:" + doc.uri); await host.forceSave(doc); },
    reportError: error => { errors.push(error); },
  });
  function document(key = "note", text = "original\n") {
    const doc = {
      uri: { toString: () => key }, isClosed: false, isDirty: false, text, disk: text,
      save: async (): Promise<boolean> => {
        writes.push(key + ":" + doc.text);
        doc.disk = doc.text; doc.isDirty = false;
        return true;
      },
    };
    peers.set(key, []);
    return doc;
  }
  function peer(doc: Document, visible = true) {
    const messages: { type: "flush"; requestId: number }[] = [];
    const p = { visible, messages, webview: {
      postMessage: (message: { type: "flush"; requestId: number }): boolean | PromiseLike<boolean> => {
        messages.push(message); return true;
      },
    } };
    peers.get(doc.uri.toString())!.push(p);
    return p;
  }
  function receipt(p: Peer, index = p.messages.length - 1) {
    coordinator.acknowledge(p, p.messages[index].requestId);
  }
  function edit(doc: Document, text: string) {
    return editQueue.run(doc.uri.toString(), async () => { doc.text += text; doc.isDirty = true; });
  }
  return { coordinator, editQueue, errors, writes, conflicts, peers, host, document, peer, receipt, edit };
}

test("a save barrier snapshots both ready peers, including hidden input in transit", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc), b = f.peer(doc, false);
  const saving = f.coordinator.saveDocument(doc);
  await settle();
  assert.equal(a.messages.length, 1); assert.equal(b.messages.length, 1);
  assert.equal(a.messages[0].type, "flush");
  assert.notEqual(a.messages[0].requestId, b.messages[0].requestId);
  f.coordinator.acknowledge(b, a.messages[0].requestId);
  f.coordinator.acknowledge(a, -1);
  await settle(); assert.deepEqual(f.writes, []);
  await f.edit(doc, "FIRST\n"); f.receipt(a);
  await settle(); assert.deepEqual(f.writes, []);
  // A peer becoming ready after the snapshot belongs to the next barrier.
  const later = f.peer(doc);
  await f.edit(doc, "SECOND\n"); f.receipt(b);
  assert.equal(await saving, true);
  assert.equal(doc.disk, "original\nFIRST\nSECOND\n");
  assert.equal(later.messages.length, 0);
  f.coordinator.dispose();
});

test("native participation returns a wait immediately and fast synchronization leaves subsequent typing unsaved", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc);
  const wait = f.coordinator.participateNativeSave(doc);
  assert.ok(wait instanceof Promise);
  let finished = false;
  void wait.then(() => { finished = true; });
  mock.timers.tick(999); await settle(); assert.equal(finished, false);
  await f.edit(doc, "pending\n"); f.receipt(p);
  await wait;
  await doc.save();
  await f.edit(doc, "later typing\n");
  await f.coordinator.completeNativeSave(doc);
  assert.equal(doc.disk, "original\npending\n");
  assert.equal(doc.isDirty, true);
  assert.deepEqual(f.errors, []);
  f.coordinator.dispose();
});

for (const deadline of [1000, 1001]) test("native synchronization at " + deadline + " ms forces a clean-document follow-up after completion", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc);
  const wait = f.coordinator.participateNativeSave(doc)!;
  mock.timers.tick(999);
  let finished = false; void wait.then(() => { finished = true; });
  await settle(); assert.equal(finished, false);
  mock.timers.tick(deadline - 999); await wait;
  await f.edit(doc, "late pending input\n"); f.receipt(p);
  await settle(); assert.deepEqual(f.writes, [], "synchronization alone is not native completion");
  // A stale native write may clear this flag even though it wrote old bytes.
  doc.isDirty = false;
  await f.coordinator.completeNativeSave(doc);
  assert.equal(doc.disk, "original\nlate pending input\n");
  assert.deepEqual(f.writes, ["force:note", "note:original\nlate pending input\n"]);
  assert.equal(p.messages.length, 1, "follow-up reuses the completed barrier");
  await f.coordinator.completeNativeSave(doc);
  assert.equal(f.writes.length, 2, "consume each native completion once");
  f.coordinator.dispose();
});

test("native completion before synchronization waits for both the receipt and shared edit queue", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc), blocked = gate();
  const wait = f.coordinator.participateNativeSave(doc)!;
  mock.timers.tick(1000); await wait;
  const completion = f.coordinator.completeNativeSave(doc);
  await settle(); assert.deepEqual(f.writes, []);
  const edit = f.editQueue.run("note", async () => { await blocked.promise; doc.text += "late\n"; doc.isDirty = true; });
  f.receipt(p); await settle(); assert.deepEqual(f.writes, []);
  blocked.release(); await edit; await completion;
  assert.equal(doc.disk, "original\nlate\n");
  f.coordinator.dispose();
});

test("synchronization during a slow native disk write still forces persistence after stale completion", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc), disk = gate();
  const wait = f.coordinator.participateNativeSave(doc)!;
  mock.timers.tick(1000); await wait;
  const staleBytes = doc.text;
  const initialWrite = (async () => { await disk.promise; doc.disk = staleBytes; doc.isDirty = false; })();
  await f.edit(doc, "complete answer\n"); f.receipt(p);
  await settle(); assert.deepEqual(f.writes, []);
  disk.release(); await initialWrite;
  assert.equal(doc.isDirty, false);
  assert.equal(doc.disk, "original\n");
  await f.coordinator.completeNativeSave(doc);
  assert.equal(doc.disk, "original\ncomplete answer\n");
  f.coordinator.dispose();
});

test("explicit saves hold the collaboration queue through disk writes and serialize repeated saves per document", async () => {
  const f = fixture(), doc = f.document(), other = f.document("other"), disk = gate(), started = gate();
  const originalSave = doc.save;
  let first = true;
  doc.save = async () => {
    assert.equal(f.coordinator.participateNativeSave(doc), undefined, "suppress recursive native participation");
    if (first) { first = false; started.release(); await disk.promise; }
    return originalSave();
  };
  const saving = f.coordinator.saveDocument(doc);
  await started.promise;
  const laterEdit = f.edit(doc, "later typing\n");
  assert.equal(await f.coordinator.saveDocument(other), true, "other document is independent");
  await settle(); assert.equal(doc.text, "original\n");
  disk.release(); assert.equal(await saving, true); await laterEdit;
  assert.equal(doc.disk, "original\n"); assert.equal(doc.isDirty, true);
  assert.deepEqual(await Promise.all([f.coordinator.saveDocument(doc), f.coordinator.saveDocument(doc)]), [true, true]);
  assert.equal(doc.disk, "original\nlater typing\n");
  assert.deepEqual(f.writes, ["other:original\n", "note:original\n", "note:original\nlater typing\n", "note:original\nlater typing\n"]);
  f.coordinator.dispose();
});

test("the save barrier drains edits appended while its original edit tail is running", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc), blocked = gate();
  const first = f.editQueue.run("note", async () => {
    await blocked.promise;
    void f.editQueue.run("note", async () => {
      doc.text += "first\n";
      void f.edit(doc, "second\n");
    });
  });
  const saving = f.coordinator.saveDocument(doc);
  await settle(); f.receipt(p); await settle(); assert.deepEqual(f.writes, []);
  blocked.release(); await first; await saving;
  assert.equal(doc.disk, "original\nfirst\nsecond\n");
  f.coordinator.dispose();
});

for (const eol of ["\n", "\r\n"]) test("persistence preserves " + JSON.stringify(eol) + " text from the document adapter", async () => {
  const f = fixture(), doc = f.document("note", "first" + eol + "second" + eol);
  await f.coordinator.saveDocument(doc);
  assert.equal(doc.disk, "first" + eol + "second" + eol);
  f.coordinator.dispose();
});

test("retained conflicts reject after draining, then a retry can recover", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc);
  f.conflicts.add("note");
  const saving = assert.rejects(f.coordinator.saveDocument(doc), {
    message: "Live Preview has unsynchronized edits. Retry synchronization or save a recovery copy.",
  });
  await settle(); f.receipt(p); await saving; assert.deepEqual(f.writes, []);
  f.conflicts.clear();
  const retry = f.coordinator.saveDocument(doc); await settle(); f.receipt(p);
  assert.equal(await retry, true);
  f.coordinator.dispose();
});

for (const native of [false, true]) test((native ? "late native" : "explicit") + " persistence rechecks conflicts inside the shared edit queue", async () => {
  const f = fixture(), doc = f.document();
  let checks = 0;
  f.host.hasConflicts = key => {
    if (++checks === 1) {
      // Queue work at the observable conflict predicate, after the drain but
      // before persistence can acquire the collaboration queue.
      void f.editQueue.run(key, async () => { f.conflicts.add(key); });
      return false;
    }
    return f.conflicts.has(key);
  };
  if (native) {
    const p = f.peer(doc);
    const wait = f.coordinator.participateNativeSave(doc)!;
    mock.timers.tick(1000); await wait; f.receipt(p);
    await f.coordinator.completeNativeSave(doc);
    assert.match(String(f.errors[0]), /Live Preview has unsynchronized edits\./);
  } else await assert.rejects(f.coordinator.saveDocument(doc), { message: "Live Preview has unsynchronized edits." });
  assert.equal(checks, 2); assert.deepEqual(f.writes, []);
  f.coordinator.dispose();
});

for (const failure of ["undelivered", "throwing", "rejecting", "receipt-before-rejection"]) test("transport " + failure + " rejects saving and permits recovery", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc), sibling = f.peer(doc);
  const transport = p.webview.postMessage;
  p.webview.postMessage = message => {
    p.messages.push(message);
    if (failure === "undelivered") return false;
    if (failure === "throwing") throw new Error("transport failed");
    if (failure === "receipt-before-rejection") f.coordinator.acknowledge(p, message.requestId);
    return Promise.reject(new Error("transport failed"));
  };
  await assert.rejects(f.coordinator.saveDocument(doc), failure === "undelivered" ? {
    message: "Live Preview closed before confirming its pending edits.",
  } : /transport failed/);
  assert.deepEqual(f.writes, []);
  p.webview.postMessage = transport;
  mock.timers.tick(5000); await settle();
  const retry = f.coordinator.saveDocument(doc); await settle();
  f.receipt(p, 0); f.receipt(sibling, 0);
  await settle(); assert.deepEqual(f.writes, [], "stale receipts cannot satisfy a newer save");
  f.receipt(p); f.receipt(sibling);
  assert.equal(await retry, true); assert.deepEqual(f.errors, []);
  f.coordinator.dispose();
});

test("a receipt cannot turn an undelivered request into a successful preview save", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc);
  p.webview.postMessage = message => { f.coordinator.acknowledge(p, message.requestId); return false; };
  await assert.rejects(f.coordinator.saveDocument(doc), /closed before confirming/);
  assert.deepEqual(f.writes, []);
  f.coordinator.dispose();
});

test("a missing or wrong-peer receipt times out at exactly 5,000 ms and a retry gets a fresh deadline", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc), stranger = f.peer(f.document("stranger"));
  let rejected = false;
  const saving = assert.rejects(f.coordinator.saveDocument(doc), {
    message: "A Live Preview did not respond to the save request. Your edits remain unsaved.",
  }).then(() => { rejected = true; });
  await settle(); f.coordinator.acknowledge(stranger, p.messages[0].requestId);
  mock.timers.tick(4999); await settle(); assert.equal(rejected, false);
  mock.timers.tick(1); await saving; assert.deepEqual(f.writes, []);
  const retry = f.coordinator.saveDocument(doc); await settle();
  f.receipt(p, 0); await settle(); assert.deepEqual(f.writes, []);
  mock.timers.tick(4999); f.receipt(p); assert.equal(await retry, true);
  // Advancing past cleared timers must not resurrect failed saves.
  mock.timers.tick(10000); await settle(); assert.equal(f.writes.length, 1);
  f.coordinator.dispose();
});

test("peer cancellation rejects its pending barrier without blocking another document", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc), other = f.document("other"), q = f.peer(other);
  const saving = assert.rejects(f.coordinator.saveDocument(doc), { message: "Live Preview closed during save synchronization." });
  const otherSave = f.coordinator.saveDocument(other);
  await settle(); f.coordinator.cancelPeer(p); f.receipt(q);
  await saving; assert.equal(await otherSave, true);
  assert.deepEqual(f.writes, ["other:original\n"]);
  f.coordinator.dispose();
});

for (const failure of ["false", "rejection"]) test("explicit persistence " + failure + " releases the guard and queue for a retry", async () => {
  const f = fixture(), doc = f.document();
  const save = doc.save;
  doc.save = async () => {
    assert.equal(f.coordinator.participateNativeSave(doc), undefined);
    if (failure === "rejection") throw new Error("disk failed");
    return false;
  };
  if (failure === "rejection") await assert.rejects(f.coordinator.saveDocument(doc), /disk failed/);
  else assert.equal(await f.coordinator.saveDocument(doc), false);
  // A native event after failure must participate again (guard was released).
  const wait = f.coordinator.participateNativeSave(doc); assert.ok(wait); await wait;
  await f.coordinator.completeNativeSave(doc);
  doc.save = save; assert.equal(await f.coordinator.saveDocument(doc), true);
  f.coordinator.dispose();
});

for (const failure of ["rejection", "still-dirty"]) test("forced native persistence " + failure + " reports failure and recovers", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc);
  f.host.forceSave = async () => {
    assert.equal(f.coordinator.participateNativeSave(doc), undefined);
    if (failure === "rejection") throw new Error("native disk failed");
    doc.isDirty = true;
  };
  const wait = f.coordinator.participateNativeSave(doc)!;
  mock.timers.tick(1000); await wait; f.receipt(p);
  await f.coordinator.completeNativeSave(doc);
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), failure === "rejection" ? /native disk failed/ : /The document was not saved\./);
  const retry = f.coordinator.saveDocument(doc); await settle(); f.receipt(p);
  assert.equal(await retry, true);
  const nativeRetry = f.coordinator.participateNativeSave(doc); assert.ok(nativeRetry); f.receipt(p); await nativeRetry;
  await f.coordinator.completeNativeSave(doc);
  assert.equal(f.errors.length, 1);
  f.coordinator.dispose();
});

test("native barrier failures settle participation, report once and never start a follow-up", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc);
  const wait = f.coordinator.participateNativeSave(doc)!;
  mock.timers.tick(1000); await wait;
  const completion = f.coordinator.completeNativeSave(doc);
  f.coordinator.cancelPeer(p); await completion;
  assert.equal(f.errors.length, 1); assert.match(String(f.errors[0]), /closed during save synchronization/);
  assert.deepEqual(f.writes, []);
  f.coordinator.dispose();
});

test("a late native write holds the same edit queue and does not flush again", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc), started = gate(), disk = gate();
  f.host.forceSave = async document => {
    assert.equal(f.coordinator.participateNativeSave(document), undefined);
    started.release(); await disk.promise; await document.save();
  };
  const wait = f.coordinator.participateNativeSave(doc)!;
  mock.timers.tick(1000); await wait; f.receipt(p);
  const completion = f.coordinator.completeNativeSave(doc); await started.promise;
  const edit = f.edit(doc, "later typing\n");
  disk.release(); await completion; await edit;
  assert.equal(doc.disk, "original\n"); assert.equal(doc.isDirty, true);
  assert.equal(p.messages.length, 1);
  f.coordinator.dispose();
});

for (const phase of ["flush", "drain", "queued-write"]) test("disposal during " + phase + " rejects preview saves without clearing collaboration work", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc), blocked = gate();
  let edit: Promise<unknown> | undefined;
  if (phase === "drain") edit = f.editQueue.run("note", () => blocked.promise);
  if (phase === "queued-write") f.host.hasConflicts = key => {
    edit = f.editQueue.run(key, () => blocked.promise); return false;
  };
  const saving = assert.rejects(f.coordinator.saveDocument(doc), /The editor was disposed during save\./);
  await settle();
  if (phase !== "flush") { f.receipt(p); await settle(); }
  f.coordinator.dispose(); blocked.release(); await edit; await saving;
  assert.deepEqual(f.writes, []);
  await f.edit(doc, "collaboration still works\n");
  assert.equal(doc.text, "original\ncollaboration still works\n");
  await assert.rejects(f.coordinator.saveDocument(doc), /disposed during save/);
  assert.equal(f.coordinator.participateNativeSave(doc), undefined);
});

for (const action of ["close", "dispose"]) for (const phase of ["before-completion", "after-completion", "queued-write"]) {
  test(action + " during " + phase + " prevents delayed native persistence", async () => {
    const f = fixture(), doc = f.document(), p = f.peer(doc), blocked = gate();
    const wait = f.coordinator.participateNativeSave(doc)!;
    mock.timers.tick(1000); await wait;
    let completion: Promise<void> | undefined;
    if (phase !== "before-completion") completion = f.coordinator.completeNativeSave(doc);
    if (phase === "queued-write") {
      f.host.hasConflicts = key => { void f.editQueue.run(key, () => blocked.promise); return false; };
      f.receipt(p); await settle();
    }
    if (action === "close") doc.isClosed = true; else f.coordinator.dispose();
    if (phase !== "queued-write") f.receipt(p);
    blocked.release();
    await (completion ?? f.coordinator.completeNativeSave(doc));
    mock.timers.tick(10000); await settle(); assert.deepEqual(f.writes, []);
    f.coordinator.dispose();
  });
}

test("disposal settles native participation immediately, even while edit draining is blocked", async () => {
  const f = fixture(), doc = f.document(), p = f.peer(doc), blocked = gate();
  const edit = f.editQueue.run("note", () => blocked.promise);
  const wait = f.coordinator.participateNativeSave(doc)!; f.receipt(p); await settle();
  f.coordinator.dispose(); await wait;
  blocked.release(); await edit; await f.coordinator.completeNativeSave(doc);
  assert.deepEqual(f.writes, []);
});

test("disposal allows a disk write already executing to settle but rejects saves queued behind it", async () => {
  const f = fixture(), doc = f.document(), started = gate(), disk = gate();
  const save = doc.save;
  doc.save = async () => { started.release(); await disk.promise; return save(); };
  const saving = f.coordinator.saveDocument(doc); await started.promise;
  const next = assert.rejects(f.coordinator.saveDocument(doc), /disposed during save/);
  f.coordinator.dispose(); disk.release();
  assert.equal(await saving, true); await next;
  assert.deepEqual(f.writes, ["note:original\n"]);
});

test("native participation skips documents with no registered preview peers and closed documents", async () => {
  const f = fixture(), doc = f.document();
  f.peers.delete("note"); assert.equal(f.coordinator.participateNativeSave(doc), undefined);
  f.peers.set("note", []); doc.isClosed = true;
  assert.equal(f.coordinator.participateNativeSave(doc), undefined);
  await assert.rejects(f.coordinator.saveDocument(doc), /closed during save synchronization/);
  f.coordinator.dispose();
});

void (async () => {
  let failed = 0;
  for (const c of cases) {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await Promise.race([
        c.run(),
        new Promise<never>((_, reject) => setImmediate(() => reject(new Error("test did not settle with controlled timers")))),
      ]);
      console.log("  ✓ " + c.name);
    }
    catch (error) { failed++; console.error("  ✗ " + c.name + "\n      " + (error as Error).stack); }
    finally { mock.timers.reset(); }
  }
  if (failed) process.exitCode = 1;
})();
