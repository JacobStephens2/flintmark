import assert from "node:assert/strict";
import { mock } from "node:test";
import { EditorState, type ChangeSpec } from "@codemirror/state";
import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from "@codemirror/collab";
import { LivePreviewEditCoordinator, type HostDocumentChange } from "../../src/extension/livePreviewEditCoordinator";
import { LivePreviewSaveCoordinator } from "../../src/extension/livePreviewSaveCoordinator";
import { SerialQueue } from "../../src/extension/serialQueue";
import { decodeUpdates, encodeUpdates } from "../../src/shared/collaboration";
import { cmToHostOffsets } from "../../src/shared/ranges";
import type { DocChange, HostMsg } from "../../src/shared/protocol";

const cases: { name: string; run: () => Promise<void> }[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
const normalized = (text: string) => text.replace(/\r\n?|\n/g, "\n");

function fixture() {
  const editQueue = new SerialQueue();
  const peers = new Map<string, Peer[]>();
  const notices: string[] = [], recoveries: string[] = [], writes: string[] = [];
  const applied: { key: string; changes: readonly DocChange[] }[] = [];
  type Document = ReturnType<typeof document>;
  type Peer = ReturnType<typeof peer>;
  const host = {
    read: (doc: Document) => ({ text: doc.text, version: doc.version, crlf: doc.crlf }),
    apply: async (doc: Document, changes: readonly DocChange[]) => {
      applied.push({ key: doc.uri.toString(), changes });
      change(doc, changes);
      return true;
    },
  };
  const coordinator: LivePreviewEditCoordinator<Document, Peer> = new LivePreviewEditCoordinator({
    editQueue, host,
    registeredPeers: key => peers.get(key),
    readyPeers: key => peers.get(key)?.filter(p => p.ready),
    notifyConflict: doc => { notices.push(doc.uri.toString()); },
    notifyRecovery: key => { recoveries.push(key); },
  });
  const saves = new LivePreviewSaveCoordinator<Document, Peer>({
    editQueue, readyPeers: key => peers.get(key)?.filter(p => p.ready),
    hasConflicts: key => coordinator.hasConflicts(key),
    forceSave: doc => doc.save(), reportError: error => { throw error; },
  });
  function document(key = "note", text = "abc", version = 1) {
    const doc = {
      uri: { toString: () => key }, text, version, crlf: text.includes("\r\n"),
      isDirty: false, isClosed: false,
      save: async () => { writes.push(doc.text); doc.isDirty = false; return true; },
    };
    return doc;
  }
  function peer(doc: Document, id = "a") {
    const messages: HostMsg[] = [];
    const p = {
      ready: false, state: EditorState.create(), messages,
      webview: { postMessage: (message: HostMsg) => {
        messages.push(message);
        if (message.type === "syncUpdates") p.state = p.state.update(receiveUpdates(p.state, decodeUpdates(message.updates))).state;
        if (message.type === "flush") saves.acknowledge(p, message.requestId);
        return true;
      } },
      initialize: (): Promise<void> => coordinator.initialize(doc, snapshot => {
        p.state = EditorState.create({ doc: normalized(snapshot.text), extensions: [collab({ clientID: id, startVersion: snapshot.syncVersion })] });
        p.ready = true;
      }),
    };
    const key = doc.uri.toString();
    peers.set(key, [...(peers.get(key) ?? []), p]);
    return p;
  }
  function send(doc: Document, p: Peer, changes: ChangeSpec) {
    p.state = p.state.update({ changes }).state;
    const message = { type: "edit" as const, version: doc.version, syncVersion: getSyncedVersion(p.state), updates: encodeUpdates(sendableUpdates(p.state)) };
    coordinator.submit(doc, p, message);
    return message;
  }
  function change(doc: Document, changes: readonly DocChange[], crlf = doc.crlf) {
    const before = doc.text, cm = normalized(before);
    for (const ch of changes) assert.ok(ch.from >= 0 && ch.from <= ch.to && ch.to <= cm.length, "in-memory host receives valid ranges");
    const offsets = doc.crlf ? cmToHostOffsets(before, changes.flatMap(ch => [ch.from, ch.to])) : changes.flatMap(ch => [ch.from, ch.to]);
    const events: HostDocumentChange[] = changes.map((ch, i) => ({
      rangeOffset: offsets[2 * i], rangeLength: offsets[2 * i + 1] - offsets[2 * i],
      startLine: cm.slice(0, ch.from).split("\n").length - 1,
      endLine: cm.slice(0, ch.to).split("\n").length - 1, text: ch.insert,
    }));
    let text = cm;
    for (const ch of [...changes].sort((a, b) => b.from - a.from)) text = text.slice(0, ch.from) + normalized(ch.insert) + text.slice(ch.to);
    doc.crlf = crlf; doc.text = crlf ? text.replace(/\n/g, "\r\n") : text;
    doc.version++; doc.isDirty = true;
    coordinator.observe(doc, events);
    return events;
  }
  function close(doc: Document, p: Peer) {
    peers.set(doc.uri.toString(), peers.get(doc.uri.toString())!.filter(other => other !== p));
    coordinator.lastPeerClosed(doc.uri.toString());
  }
  return { coordinator, saves, editQueue, host, document, peer, send, change, close, peers, notices, recoveries, writes, applied };
}

test("accepted input reaches ready peers as minimal ranges and clears optimistic updates", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc), b = f.peer(doc, "b");
  await a.initialize(); await b.initialize();
  f.send(doc, a, { from: 1, insert: "X" });
  await f.editQueue.drain("note");
  assert.equal(doc.text, "aXbc");
  for (const p of [a, b]) { assert.equal(p.state.doc.toString(), "aXbc"); assert.equal(sendableUpdates(p.state).length, 0); }
  assert.deepEqual(f.applied, [{ key: "note", changes: [{ from: 1, to: 1, insert: "X" }] }]);
  assert.equal(f.coordinator.hasConflicts("note"), false);
});

for (const outcome of ["false", "throw"] as const) test(outcome + " retains input before the Save barrier and successful retry permits persistence", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc);
  await a.initialize();
  const apply = f.host.apply;
  f.host.apply = async () => { if (outcome === "throw") throw new Error("host failure"); return false; };
  f.send(doc, a, { from: 1, insert: "X" });
  // Enter save immediately, without an extra promise continuation after drain.
  await assert.rejects(f.saves.saveDocument(doc), /unsynchronized/);
  assert.equal(f.coordinator.hasConflicts("note"), true);
  assert.equal(doc.text, "abc"); assert.equal(sendableUpdates(a.state).length, 1);
  assert.deepEqual(f.coordinator.recoveryTexts("note"), ["aXbc"]);
  assert.deepEqual(f.writes, []);
  assert.ok(a.messages.some(m => m.type === "syncError" && m.message.includes(outcome === "throw" ? "host failure" : "local edits are still pending")));
  f.host.apply = apply; f.coordinator.retry(doc);
  assert.equal(await f.saves.saveDocument(doc), true);
  assert.deepEqual(f.writes, ["aXbc"]);
  assert.equal(sendableUpdates(a.state).length, 0);
  assert.equal(f.coordinator.hasConflicts("note"), false);
  assert.deepEqual(f.coordinator.recoveryTexts("note"), []);
  f.saves.dispose();
});

for (const outcome of ["false", "throw"] as const) test(outcome + " cannot acknowledge coincident independent text and buffers immutable event facts", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc), b = f.peer(doc, "b"), blocked = gate();
  await a.initialize(); await b.initialize();
  const apply = f.host.apply;
  f.host.apply = async () => {
    const events = f.change(doc, [{ from: 1, to: 1, insert: "X" }]);
    // Mutating the emitter's objects cannot rewrite the buffered event.
    events[0].text = "WRONG"; events[0].rangeOffset = 99;
    await blocked.promise;
    if (outcome === "throw") throw new Error("apply threw after an independent change");
    return false;
  };
  f.send(doc, a, { from: 1, insert: "X" }); await settle();
  assert.equal(b.state.doc.toString(), "abc", "pending apply buffers host events");
  blocked.release(); await settle();
  assert.equal(doc.text, "aXbc");
  assert.equal(sendableUpdates(a.state).length, 1, "equal host text is independent input");
  assert.equal(b.state.doc.toString(), "aXbc");
  f.host.apply = apply;
  if (outcome === "false") { mock.timers.tick(10); await f.editQueue.drain("note"); }
  else { await f.editQueue.drain("note"); f.coordinator.retry(doc); await f.editQueue.drain("note"); }
  assert.equal(doc.text, "aXXbc"); assert.equal(a.state.doc.toString(), doc.text); assert.equal(b.state.doc.toString(), doc.text);
  assert.equal(sendableUpdates(a.state).length, 0);
});

test("accepted events and following independent events keep their own versions and snapshots", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc), b = f.peer(doc, "b");
  await a.initialize(); await b.initialize();
  const apply = f.host.apply;
  f.host.apply = async (doc, changes) => {
    const result = await apply(doc, changes);
    f.change(doc, [{ from: 4, to: 4, insert: "Y" }]);
    f.change(doc, [{ from: 0, to: 0, insert: "Z" }]);
    return result;
  };
  f.send(doc, a, { from: 1, insert: "X" }); await f.editQueue.drain("note");
  assert.equal(doc.text, "ZaXbcY");
  for (const p of [a, b]) assert.equal(p.state.doc.toString(), doc.text);
  assert.deepEqual(a.messages.filter(m => m.type === "syncUpdates").map(m => m.version), [2, 3, 4]);
  assert.equal(sendableUpdates(a.state).length, 0);
});

test("identical-text success without an event and empty composition both acknowledge input", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc);
  await a.initialize();
  let calls = 0;
  f.host.apply = async () => { calls++; return true; };
  f.send(doc, a, { from: 1, to: 2, insert: "b" }); await f.editQueue.drain("note");
  assert.equal(doc.version, 1); assert.equal(getSyncedVersion(a.state), 1); assert.equal(sendableUpdates(a.state).length, 0);
  const blocked = gate();
  const command = f.editQueue.run("note", () => blocked.promise);
  f.send(doc, a, { from: 1, insert: "X" });
  f.send(doc, a, { from: 1, to: 2 });
  blocked.release(); await command; await f.editQueue.drain("note");
  assert.equal(doc.text, "abc"); assert.equal(getSyncedVersion(a.state), 3);
  assert.equal(calls, 1, "empty composition must not invoke the host"); assert.equal(sendableUpdates(a.state).length, 0);
});

test("successful apply without its required event retains the optimistic input", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc);
  await a.initialize(); f.host.apply = async () => true;
  f.send(doc, a, { from: 1, insert: "X" }); await f.editQueue.drain("note");
  assert.equal(f.coordinator.hasConflicts("note"), true);
  assert.equal(doc.text, "abc"); assert.equal(sendableUpdates(a.state).length, 1);
});

for (const crlf of [false, true]) for (const conversionOnly of [false, true]) test(`host EOL conversion from ${crlf ? "CRLF" : "LF"}, text unchanged: ${conversionOnly}`, async () => {
  const f = fixture(), doc = f.document("note", crlf ? "a\r\nb\r\nc" : "a\nb\nc"), a = f.peer(doc), b = f.peer(doc, "b");
  await a.initialize(); await b.initialize();
  const apply = f.host.apply;
  let first = true;
  f.host.apply = async (doc, changes) => {
    if (!first) return apply(doc, changes);
    first = false;
    f.change(doc, conversionOnly ? [{ from: 0, to: 5, insert: "a\nb\nc" }] : [{ from: 4, to: 4, insert: "Y" }], !crlf);
    return false;
  };
  f.send(doc, a, { from: 3, insert: "X" }); await settle();
  mock.timers.tick(10); await f.editQueue.drain("note");
  const expected = conversionOnly ? "a\nbX\nc" : "a\nbX\nYc";
  assert.equal(doc.text, crlf ? expected : expected.replace(/\n/g, "\r\n"));
  for (const p of [a, b]) { assert.equal(p.state.doc.toString(), expected); assert.equal(sendableUpdates(p.state).length, 0); }
  assert.equal(getSyncedVersion(a.state), conversionOnly ? 1 : 2);
});

for (const scenario of ["burst", "command", "peer", "closed", "rejected-prefix"] as const) test("cumulative waiting input preserves queue position: " + scenario, async () => {
  const f = fixture(), doc = f.document("note", "base\n"), a = f.peer(doc), b = f.peer(doc, "b"), blocked = gate();
  await a.initialize(); await b.initialize();
  const apply = f.host.apply;
  let calls = 0, commandText = "";
  f.host.apply = async (doc, changes) => {
    calls++;
    if (calls === 1) { await blocked.promise; if (scenario === "rejected-prefix") return false; }
    return apply(doc, changes);
  };
  const type = (text: string) => f.send(doc, a, { from: a.state.doc.length, insert: text });
  type("a"); await settle();
  for (const ch of "bcd") type(ch);
  if (scenario === "command") void f.editQueue.run("note", async () => { commandText = doc.text; });
  if (scenario === "peer") f.send(doc, b, { from: 5, insert: "FOREIGN" });
  for (const ch of "efghijklmnopqrstuvwxyz") type(ch);
  if (scenario === "closed") f.close(doc, a);
  blocked.release(); await f.editQueue.drain("note");
  assert.equal(doc.text.replace("FOREIGN", ""), "base\nabcdefghijklmnopqrstuvwxyz");
  assert.equal(calls, scenario === "command" ? 3 : scenario === "peer" ? 4 : 2);
  if (scenario === "command") assert.equal(commandText, "base\nabcd");
  if (scenario === "peer") assert.ok(doc.text.includes("FOREIGN"));
  assert.equal(b.state.doc.toString(), doc.text);
  if (scenario !== "closed") { assert.equal(a.state.doc.toString(), doc.text); assert.equal(sendableUpdates(a.state).length, 0); }
  assert.equal(f.coordinator.hasConflicts("note"), false);
});

test("input received during persistence stays behind the actual Save barrier queue entry", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc), blocked = gate(), writing = gate();
  await a.initialize();
  f.send(doc, a, { from: 3, insert: "a" }); await f.editQueue.drain("note");
  const save = doc.save;
  doc.save = async () => { writing.release(); await blocked.promise; return save(); };
  const saving = f.saves.saveDocument(doc);
  await writing.promise;
  f.send(doc, a, { from: 4, insert: "b" });
  f.send(doc, a, { from: 5, insert: "c" }); await settle();
  assert.equal(doc.text, "abca"); assert.deepEqual(f.writes, []);
  blocked.release(); await saving; await f.editQueue.drain("note");
  assert.deepEqual(f.writes, ["abca"]); assert.equal(doc.text, "abcabc");
  f.saves.dispose();
});

test("duplicate batches deduplicate and independent document queues keep moving", async () => {
  const f = fixture(), doc = f.document(), other = f.document("other", "second"), a = f.peer(doc), b = f.peer(other, "b"), blocked = gate();
  await a.initialize(); await b.initialize();
  const apply = f.host.apply;
  f.host.apply = async (document, changes) => { if (document === doc) await blocked.promise; return apply(document, changes); };
  const message = f.send(doc, a, { from: 3, insert: "X" });
  f.coordinator.submit(doc, a, message);
  f.send(other, b, { from: 6, insert: "Y" }); await f.editQueue.drain("other");
  assert.equal(other.text, "secondY"); assert.equal(doc.text, "abc");
  blocked.release(); await f.editQueue.drain("note");
  assert.equal(doc.text, "abcX"); assert.equal(f.applied.filter(item => item.key === "note").length, 1);
});

test("contention increases backoff to 100 ms and retains input when the two-second deadline expires", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc);
  await a.initialize();
  const times: number[] = [];
  f.host.apply = async () => { times.push(Date.now()); f.change(doc, [{ from: doc.text.length, to: doc.text.length, insert: "Y" }]); return false; };
  f.send(doc, a, { from: 1, insert: "X" }); await settle();
  for (let i = 0; i < 205 && !f.coordinator.hasConflicts("note"); i++) { mock.timers.tick(10); await settle(); }
  await f.editQueue.drain("note");
  assert.deepEqual(times.slice(0, 12), [0, 10, 30, 60, 100, 150, 210, 280, 360, 450, 550, 650]);
  assert.equal(times.at(-1), 2050);
  assert.equal(f.coordinator.hasConflicts("note"), true);
  assert.equal(sendableUpdates(a.state).length, 1);
  assert.deepEqual(f.coordinator.recoveryTexts("note"), ["aXbc" + "Y".repeat(times.length)]);
});

test("initialization drains newly appended work and delivers text and both versions synchronously", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc), blocked = gate();
  await a.initialize();
  void f.editQueue.run("note", async () => { await blocked.promise; f.change(doc, [{ from: 3, to: 3, insert: "X" }]); });
  const b = f.peer(doc, "b");
  let delivered = false;
  const initializing = f.coordinator.initialize(doc, snapshot => {
    assert.deepEqual(snapshot, { text: "abcXY", version: 3, syncVersion: 2 });
    b.state = EditorState.create({ doc: snapshot.text, extensions: [collab({ clientID: "b", startVersion: snapshot.syncVersion })] });
    b.ready = true; delivered = true;
    queueMicrotask(() => f.change(doc, [{ from: 5, to: 5, insert: "Z" }]));
  });
  void f.editQueue.run("note", async () => { f.change(doc, [{ from: 4, to: 4, insert: "Y" }]); });
  await settle(); assert.equal(delivered, false);
  blocked.release(); await initializing; await settle();
  assert.equal(b.state.doc.toString(), "abcXYZ"); assert.equal(getSyncedVersion(b.state), 3);
});

for (const crlf of [false, true]) test("closed failed peers retain received work and read-only recovery with original " + (crlf ? "CRLF" : "LF"), async () => {
  const f = fixture(), doc = f.document("note", crlf ? "a\r\nb" : "a\nb"), a = f.peer(doc), blocked = gate();
  await a.initialize();
  f.host.apply = async () => { await blocked.promise; return false; };
  f.send(doc, a, { from: 3, insert: "X" }); await settle();
  f.close(doc, a); blocked.release(); await f.editQueue.drain("note"); await settle();
  assert.equal(f.coordinator.hasConflicts("note"), true);
  assert.equal(a.messages.some(m => m.type === "syncError"), false, "closed origins do not receive error messages");
  const expected = crlf ? "a\r\nbX" : "a\nbX";
  assert.deepEqual(f.coordinator.recoveryTexts("note"), [expected]);
  assert.deepEqual(f.coordinator.recoveryTexts("note"), [expected]);
  assert.deepEqual(f.writes, []);
  const b = f.peer(doc, "b"); await b.initialize();
  assert.equal(getSyncedVersion(b.state), 0);
  assert.equal(b.state.doc.toString(), "a\nb", "recovery projection must not mutate accepted text");
});

test("same-text reopening preserves collaboration history and adopts the new EOL mode", async () => {
  const f = fixture(), doc = f.document("note", "a\r\nb"), a = f.peer(doc);
  await a.initialize();
  f.change(doc, [{ from: 3, to: 3, insert: "H" }]);
  const apply = f.host.apply; f.host.apply = async () => false;
  f.send(doc, a, { from: 3, insert: "X" }); await f.editQueue.drain("note"); f.close(doc, a); await settle();
  const current = f.document("note", "a\nbH", 20), b = f.peer(current, "b");
  await b.initialize();
  assert.equal(getSyncedVersion(b.state), 1); assert.equal(current.version, 20);
  assert.deepEqual(f.coordinator.recoveryTexts("note"), ["a\nbXH"]);
  assert.deepEqual(f.recoveries, []);
  f.host.apply = apply; f.coordinator.retry(current); await f.editQueue.drain("note");
  assert.equal(current.text, "a\nbXH"); assert.equal(b.state.doc.toString(), current.text);
  assert.equal(getSyncedVersion(b.state), 2); assert.equal(current.version, 21);
  assert.equal(f.coordinator.hasConflicts("note"), false);
});

test("changed-text reopening preserves old recovery separately and resets current history", async () => {
  const f = fixture(), doc = f.document("note", "a\r\nb"), a = f.peer(doc);
  await a.initialize();
  f.host.apply = async () => false;
  f.send(doc, a, { from: 3, insert: "X" }); await f.editQueue.drain("note");
  f.close(doc, a); await settle();
  const current = f.document("note", "different\ntext", 30), b = f.peer(current, "b"); await b.initialize();
  assert.equal(getSyncedVersion(b.state), 0); assert.equal(b.state.doc.toString(), "different\ntext");
  assert.equal(f.coordinator.hasConflicts("note"), false);
  assert.deepEqual(f.coordinator.recoveryTexts("note"), ["a\r\nbX"]);
  assert.deepEqual(f.recoveries, ["note"]);
  f.coordinator.retry(current); await f.editQueue.drain("note");
  assert.equal(current.text, "different\ntext"); assert.deepEqual(f.writes, []);
});

for (const source of ["xyz", "longer source\ntext"]) test("source events before preview initialization preserve recovery with source length " + source.length, async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc);
  await a.initialize(); f.host.apply = async () => false;
  f.send(doc, a, { from: 1, insert: "X" }); await f.editQueue.drain("note");
  f.close(doc, a); await settle();
  const reopened = f.document("note", source, 20);
  f.change(reopened, [{ from: source.length, to: source.length, insert: "!" }]);
  assert.deepEqual(f.coordinator.recoveryTexts("note"), ["aXbc"]);
  const b = f.peer(reopened, "b"); await b.initialize();
  assert.equal(b.state.doc.toString(), source + "!"); assert.equal(getSyncedVersion(b.state), 0);
  assert.equal(f.coordinator.hasConflicts("note"), false);
  assert.deepEqual(f.recoveries, ["note"]); assert.deepEqual(f.writes, []);
});

for (const crlf of [false, true]) test("same-text reopened source EOL conversion preserves pending positions from " + (crlf ? "CRLF" : "LF"), async () => {
  const f = fixture(), doc = f.document("note", crlf ? "a\r\nb" : "a\nb"), a = f.peer(doc);
  await a.initialize();
  const apply = f.host.apply; f.host.apply = async () => false;
  f.send(doc, a, { from: 1, insert: "X" }); await f.editQueue.drain("note"); f.close(doc, a); await settle();
  const current = f.document("note", doc.text, 20);
  f.change(current, [{ from: 0, to: 3, insert: "a\nb" }], !crlf);
  const b = f.peer(current, "b"); await b.initialize();
  assert.equal(getSyncedVersion(b.state), 0); assert.deepEqual(f.recoveries, []);
  assert.deepEqual(f.coordinator.recoveryTexts("note"), [crlf ? "aX\nb" : "aX\r\nb"]);
  f.host.apply = apply; f.coordinator.retry(current); await f.editQueue.drain("note");
  assert.equal(b.state.doc.toString(), "aX\nb"); assert.equal(sendableUpdates(b.state).length, 0);
  assert.equal(f.coordinator.hasConflicts("note"), false);
});

test("recovery retrieval deduplicates saved texts across document incarnations", async () => {
  const f = fixture(); f.host.apply = async () => false;
  for (let i = 0; i < 2; i++) {
    const doc = f.document("note", "a\r\nb"), a = f.peer(doc, "a" + i); await a.initialize();
    f.send(doc, a, { from: 3, insert: "X" }); await f.editQueue.drain("note"); f.close(doc, a); await settle();
    const changed = f.document("note", "different"), b = f.peer(changed, "b" + i); await b.initialize();
    f.close(changed, b); await settle();
  }
  assert.deepEqual(f.coordinator.recoveryTexts("note"), ["a\r\nbX"]);
});

test("successful history releases only after stable idle and no registered peers", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc);
  await a.initialize(); f.send(doc, a, { from: 3, insert: "X" }); await f.editQueue.drain("note");
  f.close(doc, a);
  const blocked = gate();
  const rejectedCommand = f.editQueue.run("note", async () => { await blocked.promise; throw new Error("command failed"); });
  void rejectedCommand.catch(() => {});
  await settle();
  const b = f.peer(doc, "b"), initializing = b.initialize();
  blocked.release(); await initializing;
  assert.equal(getSyncedVersion(b.state), 1, "newer work and a registered peer preserve history even after rejection");
  f.close(doc, b); await settle();
  const c = f.peer(doc, "c"); await c.initialize();
  assert.equal(c.state.doc.toString(), "abcX"); assert.equal(getSyncedVersion(c.state), 0);
});

test("pre-init host changes preserve incremental and full-replacement messages", async () => {
  const f = fixture(), doc = f.document(), a = f.peer(doc);
  f.change(doc, [{ from: 1, to: 1, insert: "X" }]);
  assert.deepEqual(a.messages[0], { type: "applyEdit", origin: "host", version: 2, changes: [{ from: 1, to: 1, insert: "X" }] });
  f.change(doc, [{ from: 0, to: 4, insert: "reloaded" }]);
  assert.deepEqual(a.messages[1], { type: "replaceAll", version: 3, text: "reloaded" });
  await a.initialize(); assert.equal(a.state.doc.toString(), "reloaded");
});

void (async () => {
  let failed = 0;
  for (const { name, run } of cases) {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    try { await run(); console.log("  ✓ " + name); }
    catch (error) { failed++; console.error("  ✗ " + name, error); }
    finally { mock.timers.reset(); }
  }
  if (failed) process.exitCode = 1;
})();
