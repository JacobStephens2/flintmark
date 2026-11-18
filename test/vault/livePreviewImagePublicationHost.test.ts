import assert from "node:assert/strict";
import { join } from "node:path";
import * as vscode from "vscode";
import { documentChanges, EventEmitter } from "../fixtures/exclusiveCreateVscode";
import { OfmCustomTextEditorProvider } from "../../src/extension/customTextEditorProvider";
import type { ImageIndexService } from "../../src/extension/vault/imageIndexService";
import type { HostMsg, WebviewMsg } from "../../src/shared/protocol";

async function main(): Promise<void> {
  let text = "![[indexed.png]] ![relative](my%20pic.png) ![absolute](/outside.png)";
  const folder = join(process.cwd(), "notes");
  const document = {
    uri: vscode.Uri.file(join(folder, "Current.md")),
    version: 1,
    eol: vscode.EndOfLine.LF,
    getText: () => text,
  } as vscode.TextDocument;
  const subscriptions: vscode.Disposable[] = [];
  const context = { extensionUri: vscode.Uri.file(process.cwd()), subscriptions } as vscode.ExtensionContext;
  const changed = new EventEmitter<void>();
  let version = 1;
  const freshness: string[] = [];
  const indexedUri = () => vscode.Uri.file(join(process.cwd(), "assets", "indexed.png")).with({ query: `ofmIndex=${version}` });
  const imageIndex = {
    onDidChange: changed.event,
    resolveImage: (_document: vscode.Uri, reference: string) => reference === "indexed.png" ? indexedUri() : undefined,
    ensureFreshForDocument: (_document: vscode.Uri, reason: string) => { freshness.push(reason); },
  } as unknown as ImageIndexService;
  const provider = new OfmCustomTextEditorProvider(context, undefined, imageIndex);

  async function openPanel(id: string) {
    const messages: HostMsg[] = [];
    let receive: ((message: WebviewMsg) => Promise<void>) | undefined;
    const disposed = new EventEmitter<void>();
    const panel = {
      visible: false,
      onDidDispose: disposed.event,
      webview: {
        cspSource: "test:",
        asWebviewUri: (uri: vscode.Uri) => ({ toString: () => `${id}:${uri.toString()}` }),
        postMessage: (message: HostMsg) => { messages.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; },
      },
    } as unknown as vscode.WebviewPanel;
    await provider.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
    assert.ok(receive, "the public editor entry point registers its receiver");
    return { messages, send: receive, dispose: () => disposed.fire() };
  }

  try {
    const first = await openPanel("first");
    changed.fire();
    assert.deepEqual(first.messages, [], "index refresh before ready must offer no image map");
    await first.send({ type: "ready" });
    assert.deepEqual(first.messages.map(message => message.type), ["init", "imageMap"]);
    const expectedFirst = {
      "indexed.png": `first:file:${join(process.cwd(), "assets", "indexed.png")}?ofmIndex=1`,
      "my%20pic.png": `first:file:${join(folder, "my%20pic.png")}`,
      "/outside.png": "first:file:/outside.png",
    };
    assert.deepEqual(first.messages[1], { type: "imageMap", map: expectedFirst });
    assert.deepEqual(freshness, ["webview-ready"]);
    changed.fire();
    assert.equal(first.messages.length, 2);
    await first.send({ type: "ready" });
    assert.deepEqual(first.messages.map(message => message.type), ["init", "imageMap", "init", "imageMap"]);
    assert.deepEqual(first.messages[3], { type: "imageMap", map: expectedFirst });
    console.log("  ✓ init precedes each forced map; pre-ready and equivalent index refreshes are suppressed");

    const second = await openPanel("second");
    await second.send({ type: "ready" });
    assert.deepEqual(second.messages[1], { type: "imageMap", map: {
      "indexed.png": `second:file:${join(process.cwd(), "assets", "indexed.png")}?ofmIndex=1`,
      "my%20pic.png": `second:file:${join(folder, "my%20pic.png")}`,
      "/outside.png": "second:file:/outside.png",
    } });
    first.messages.length = 0;
    second.messages.length = 0;
    version = 2;
    changed.fire();
    for (const [id, peer] of [["first", first], ["second", second]] as const) {
      assert.equal(peer.messages.length, 1);
      const map = peer.messages[0];
      assert.equal(map.type, "imageMap");
      if (map.type !== "imageMap") throw new Error("expected image map");
      assert.equal(map.map["indexed.png"], `${id}:file:${join(process.cwd(), "assets", "indexed.png")}?ofmIndex=2`);
    }
    console.log("  ✓ index version changes reach hidden registered panels using each panel's URI conversion");

    first.messages.length = 0;
    second.messages.length = 0;
    const prior = text;
    text = "no images";
    documentChanges.fire({ document, contentChanges: [{
      rangeOffset: 0, rangeLength: prior.length, text,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: prior.length } },
    }] } as vscode.TextDocumentChangeEvent);
    for (const peer of [first, second]) {
      assert.deepEqual(peer.messages[0], { type: "imageMap", map: {} });
      assert.equal(peer.messages[1]?.type, "syncUpdates", "image refresh precedes edit observation");
    }
    console.log("  ✓ document callbacks publish empty replacements before edit synchronization");

    first.dispose();
    first.messages.length = 0;
    second.dispose();
    second.messages.length = 0;
    text = "![[indexed.png]]";
    version = 3;
    changed.fire();
    documentChanges.fire({ document, contentChanges: [] } as unknown as vscode.TextDocumentChangeEvent);
    assert.deepEqual(first.messages, []);
    assert.deepEqual(second.messages, []);
    const reopened = await openPanel("reopened");
    changed.fire();
    assert.deepEqual(reopened.messages, []);
    await reopened.send({ type: "ready" });
    assert.deepEqual(reopened.messages.map(message => message.type), ["init", "imageMap"]);
    assert.deepEqual(reopened.messages[1], { type: "imageMap", map: {
      "indexed.png": `reopened:file:${join(process.cwd(), "assets", "indexed.png")}?ofmIndex=3`,
    } });
    reopened.dispose();
    console.log("  ✓ disposal unregisters publication and a reopened panel initializes independently");
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    changed.dispose();
  }
}

void main().catch(error => { console.error("  ✗ Live Preview image publication host", error); process.exitCode = 1; });
