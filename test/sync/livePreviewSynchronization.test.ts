import assert from "node:assert/strict";
import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from "@codemirror/collab";
import { ChangeSet, EditorState, Text } from "@codemirror/state";
import type { ChangeSpec } from "@codemirror/state";
import { LivePreviewSynchronization } from "../../src/extension/livePreviewSynchronization";
import { decodeUpdates, encodeUpdates } from "../../src/shared/collaboration";
import type { DocChange, HostMsg } from "../../src/shared/protocol";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture() {
  const writes: string[] = [];
  const errors: unknown[] = [];
  const document = {
    uri: { toString: () => "file:///note.md" },
    text: "abc",
    version: 1,
    isClosed: false,
    isDirty: false,
    save: async () => {
      writes.push(document.text);
      document.isDirty = false;
      return true;
    },
  };
  const host = {
    read: () => ({ text: document.text, version: document.version, crlf: false }),
    apply: async (_document: typeof document, changes: readonly DocChange[]) => {
      change(changes);
      return true;
    },
  };
  const history = async (_command: "undo" | "redo", _document: typeof document) => {};
  const options = {
    host,
    executeHistory: history,
    forceSave: () => document.save(),
    notifyConflict: () => {},
    notifyRecovery: () => {},
    reportError: (error: unknown) => { errors.push(error); },
  };
  type Peer = ReturnType<typeof peer>;
  const sync = new LivePreviewSynchronization<typeof document, Peer>(options);

  function change(changes: readonly DocChange[]) {
    const before = Text.of(document.text.split("\n"));
    document.text = ChangeSet.of([...changes], before.length).apply(before).toString();
    document.version++;
    document.isDirty = true;
    sync.observeDocumentChange(document, changes.map(({ from, to, insert }) => ({
      rangeOffset: from,
      rangeLength: to - from,
      startLine: before.lineAt(from).number - 1,
      endLine: before.lineAt(to).number - 1,
      text: insert,
    })));
  }

  function peer(id: string, visible = true) {
    const messages: HostMsg[] = [];
    const registered = {
      visible,
      messages,
      state: EditorState.create(),
      onFlush: (requestId: number) => sync.acknowledgeFlush(registered, requestId),
      webview: { postMessage: (message: HostMsg) => {
        messages.push(message);
        if (message.type === "init") {
          registered.state = EditorState.create({
            doc: message.text,
            extensions: [collab({ clientID: id, startVersion: message.syncVersion })],
          });
        }
        if (message.type === "syncUpdates") {
          registered.state = registered.state.update(receiveUpdates(registered.state, decodeUpdates(message.updates))).state;
        }
        if (message.type === "flush") registered.onFlush(message.requestId);
        return true;
      } },
    };
    sync.registerPeer(document, registered);
    return registered;
  }

  function ready(peer: Peer, afterReady?: () => void) {
    return sync.initializePeer(document, peer, () => ({ settings: {}, theme: { id: "test", cssUri: null } }), afterReady);
  }

  function send(peer: Peer, changes: ChangeSpec) {
    peer.state = peer.state.update({ changes }).state;
    sync.submitEdit(document, peer, {
      type: "edit", version: document.version,
      syncVersion: getSyncedVersion(peer.state), updates: encodeUpdates(sendableUpdates(peer.state)),
    });
  }
  return { change, document, errors, host, options, peer, ready, send, sync, writes };
}

const cases: { name: string; run: () => Promise<void> }[] = [];
const test = (name: string, run: () => Promise<void>) => cases.push({ name, run });

test("ready sees queued edits and publishes init before its same-turn follow-up", async () => {
  const { change, document, host, peer, ready, send, sync } = fixture();
  const editing = peer("editing");
  await ready(editing);
  const apply = host.apply;
  const held = gate(), started = gate();
  host.apply = async (doc, changes) => {
    started.release();
    await held.promise;
    return apply(doc, changes);
  };
  send(editing, { from: 3, insert: "X" });
  await started.promise;

  const newcomer = peer("newcomer");
  const closing = peer("closing");
  const init = ready(newcomer, () => {
    assert.equal(newcomer.messages.at(-1)?.type, "init");
    assert.equal(sync.isReady(document.uri.toString(), newcomer), true);
    change([{ from: 5, to: 5, insert: "Z" }]);
  });
  const staleInit = ready(closing, () => assert.fail("Closed peer ran its ready follow-up"));
  send(editing, { from: 4, insert: "Y" });
  sync.unregisterPeer(document, closing);
  sync.registerPeer(document, closing);
  assert.equal(newcomer.messages.length, 0);
  held.release();
  await Promise.all([init, staleInit]);

  const initMessage = newcomer.messages.find(message => message.type === "init");
  assert.deepEqual(initMessage && [initMessage.text, initMessage.version, initMessage.syncVersion], ["abcXY", 3, 2]);
  assert.equal(newcomer.state.doc.toString(), "abcXYZ");
  assert.equal(closing.messages.length, 0);
  assert.equal(sync.isReady(document.uri.toString(), closing), false);
  await ready(newcomer);
  assert.equal(newcomer.messages.filter(message => message.type === "init").length, 2);
  await sync.dispose();
});

test("hidden ready peers receive changes and flush while registered unready peers only keep native save participating", async () => {
  const { change, document, host, peer, ready, send, sync } = fixture();
  assert.equal(sync.participateNativeSave(document), undefined);

  const hidden = peer("hidden", false);
  const opening = peer("opening");
  await ready(hidden);
  change([{ from: 3, to: 3, insert: "X" }]);
  assert.equal(hidden.state.doc.toString(), "abcX");
  assert.equal(opening.messages.length, 0);

  const apply = host.apply;
  const held = gate(), started = gate();
  host.apply = async (doc, changes) => {
    started.release();
    await held.promise;
    return apply(doc, changes);
  };
  send(hidden, { from: 4, insert: "Y" });
  await started.promise;
  const repeated = ready(hidden);
  let requestId: number | undefined;
  hidden.onFlush = id => { requestId = id; };
  const waitingForHidden = sync.participateNativeSave(document);
  assert.ok(waitingForHidden);
  assert.ok(requestId, "a hidden peer remains eligible during repeated ready");
  assert.equal(opening.messages.length, 0);
  sync.acknowledgeFlush(hidden, requestId);
  held.release();
  await waitingForHidden;
  await repeated;
  await sync.completeNativeSave(document);
  assert.equal(hidden.state.doc.toString(), "abcXY");

  const next = gate();
  host.apply = async (doc, changes) => {
    await next.promise;
    return apply(doc, changes);
  };
  send(hidden, { from: 5, insert: "Z" });
  sync.unregisterPeer(document, hidden);
  const draining = sync.participateNativeSave(document);
  assert.ok(draining, "a registered but unready peer still makes native save drain");
  let finished = false;
  void draining.then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(opening.messages.length, 0);
  next.release();
  await draining;
  assert.equal(document.text, "abcXYZ");
  await sync.dispose();
});

test("last close cancels its flush and preserves failed input until retry, then releases successful history", async () => {
  const { document, host, peer, ready, send, sync, writes } = fixture();
  const closing = peer("closing");
  await ready(closing);
  const apply = host.apply;
  const held = gate(), flush = gate();
  host.apply = async () => {
    await held.promise;
    return false;
  };
  send(closing, { from: 3, insert: "X" });
  closing.onFlush = flush.release;
  const save = assert.rejects(sync.saveDocument(document), /closed during save synchronization/);
  await flush.promise;
  sync.unregisterPeer(document, closing);
  assert.equal(sync.participateNativeSave(document), undefined);
  await save;
  held.release();

  await assert.rejects(sync.saveDocument(document), /unsynchronized/);
  assert.deepEqual(writes, []);
  assert.deepEqual(sync.recoveryTexts(document.uri.toString()), ["abcX"]);
  const retrying = peer("retrying");
  await ready(retrying);
  host.apply = apply;
  sync.retry(document);
  assert.equal(await sync.saveDocument(document), true);
  assert.deepEqual(writes, ["abcX"]);
  assert.deepEqual(sync.recoveryTexts(document.uri.toString()), []);
  assert.equal(getSyncedVersion(retrying.state), 1);

  sync.unregisterPeer(document, retrying);
  await new Promise<void>(resolve => setImmediate(resolve));
  const reopened = peer("reopened");
  await ready(reopened);
  assert.equal(reopened.state.doc.toString(), "abcX");
  assert.equal(getSyncedVersion(reopened.state), 0);
  await sync.dispose();
});

test("received edits and native history commands stay ordered across a command and a disk write", async () => {
  const { document, options, peer, ready, send, sync, writes } = fixture();
  const editing = peer("editing");
  await ready(editing);
  const commandStarted = gate(), releaseCommand = gate();
  const writeStarted = gate(), releaseWrite = gate();
  const flush = gate();
  const history: string[] = [];
  options.executeHistory = async (command, doc) => {
    history.push(command + " " + doc.text);
    if (command === "undo") {
      commandStarted.release();
      await releaseCommand.promise;
    }
  };
  const write = document.save;
  document.save = async () => {
    writeStarted.release();
    await releaseWrite.promise;
    return write();
  };
  editing.onFlush = id => {
    sync.acknowledgeFlush(editing, id);
    flush.release();
  };

  send(editing, { from: 3, insert: "X" });
  const undo = sync.runHistoryCommand(document, "undo");
  await commandStarted.promise;
  const save = sync.saveDocument(document);
  await flush.promise;
  send(editing, { from: 4, insert: "Y" });
  assert.equal(document.text, "abcX");
  releaseCommand.release();
  await undo;
  await writeStarted.promise;

  send(editing, { from: 5, insert: "Z" });
  const redo = sync.runHistoryCommand(document, "redo");
  assert.equal(document.text, "abcXY");
  releaseWrite.release();
  assert.equal(await save, true);
  await redo;
  assert.deepEqual(writes, ["abcXY"]);
  assert.deepEqual(history, ["undo abcX", "redo abcXYZ"]);
  assert.equal(document.text, "abcXYZ");
  assert.equal(document.isDirty, true);
  await sync.dispose();
});

test("disposal settles a pending save and lets received edits finish in order", async () => {
  const { document, host, peer, ready, send, sync, writes } = fixture();
  const editing = peer("editing");
  await ready(editing);
  const apply = host.apply;
  const held = gate(), started = gate(), flush = gate();
  host.apply = async (doc, changes) => {
    started.release();
    await held.promise;
    return apply(doc, changes);
  };
  send(editing, { from: 3, insert: "X" });
  await started.promise;
  send(editing, { from: 4, insert: "Y" });
  editing.onFlush = flush.release;
  const save = assert.rejects(sync.saveDocument(document), /disposed during save/);
  await flush.promise;
  const disposal = sync.dispose();
  await save;
  held.release();
  await disposal;

  assert.equal(document.text, "abcXY");
  assert.equal(sync.isReady(document.uri.toString(), editing), false);
  assert.equal(sync.participateNativeSave(document), undefined);
  assert.deepEqual(sync.recoveryTexts(document.uri.toString()), []);
  assert.deepEqual(writes, []);
});

async function main() {
  let failures = 0;
  for (const { name, run } of cases) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Synchronization did not settle")), 2000);
      });
      await Promise.race([run(), timeout]);
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures++;
      console.error(`  ✗ ${name}`, error);
    } finally {
      clearTimeout(timer);
    }
  }
  if (failures) process.exitCode = 1;
}

void main();
