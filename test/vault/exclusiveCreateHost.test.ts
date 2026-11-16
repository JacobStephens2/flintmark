// Editor wiring only: construct the real editor, resolve a panel, and deliver
// messages through the callback registered on its public VS Code entry point.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { OfmCustomTextEditorProvider } from "../../src/extension/customTextEditorProvider";
import type { ImageIndexService } from "../../src/extension/vault/imageIndexService";
import type { HostMsg, WebviewMsg } from "../../src/shared/protocol";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "flintmark-creation-editor-"));
  const document = { uri: vscode.Uri.file(join(root, "Current.md")) } as vscode.TextDocument;
  const subscriptions: vscode.Disposable[] = [];
  const context = { extensionUri: vscode.Uri.file(root), subscriptions } as vscode.ExtensionContext;
  const freshness: [vscode.Uri, string][] = [];
  const imageIndex = {
    onDidChange: () => ({ dispose() {} }),
    ensureFreshForDocument: (uri: vscode.Uri, reason: string) => { freshness.push([uri, reason]); },
  } as unknown as ImageIndexService;
  const editor = new OfmCustomTextEditorProvider(context, undefined, imageIndex);
  let receive: ((msg: WebviewMsg) => Promise<void>) | undefined;
  const replies: HostMsg[] = [];
  const panel = {
    onDidDispose: () => ({ dispose() {} }),
    webview: {
      cspSource: "test:",
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: (msg: HostMsg) => { replies.push(msg); return Promise.resolve(true); },
      onDidReceiveMessage: (callback: typeof receive) => { receive = callback; return { dispose() {} }; },
    },
  } as unknown as vscode.WebviewPanel;
  const image = { type: "saveAttachment" as const, requestId: 41, filename: "shot.png", mime: "image/png", dataBase64: Buffer.from("image").toString("base64") };
  try {
    await editor.resolveCustomTextEditor(document, panel, {} as vscode.CancellationToken);
    assert.ok(receive, "editor must register the panel's message receiver");
    const send = receive;
    await send({ type: "openLink", target: "folder/New.markdown#Heading|Alias" });
    assert.equal(readFileSync(join(root, "New.md"), "utf8"), "# New\n\n");
    const [command, uri, view] = vscode.commands.calls.at(-1)!;
    assert.equal(command, "vscode.openWith");
    assert.equal((uri as vscode.Uri).fsPath, join(root, "New.md"));
    assert.equal(view, "ofm.livePreview");
    assert.deepEqual(vscode.window.information, ['"folder/New.markdown" doesn\'t exist yet. Create it?']);
    console.log("  ✓ unresolved-link messages confirm, create the exact note stub and open the returned URI");

    vscode.window.information.length = 0;
    await send({ type: "openLink", target: "New" });
    assert.deepEqual(vscode.window.information, []);
    assert.equal((vscode.commands.calls.at(-1)![1] as vscode.Uri).fsPath, join(root, "New.md"));
    vscode.commands.calls.length = 0;
    vscode.window.choice = undefined;
    await send({ type: "openLink", target: "Cancelled" });
    assert.equal(readdirSync(root).includes("Cancelled.md"), false);
    assert.deepEqual(vscode.commands.calls, []);
    vscode.window.choice = "Create note";
    await send({ type: "openLink", target: "bad:name" });
    assert.equal(vscode.window.information.at(-1), "Could not find note: bad:name");
    const secret = join(root, "secret");
    writeFileSync(secret, "kept");
    symlinkSync(secret, join(root, "Linked.md"));
    await send({ type: "openLink", target: "Linked" });
    assert.equal(vscode.window.errors.at(-1), "Flintmark: couldn't create Linked.md: destination is a symlink");
    assert.equal(readFileSync(secret, "utf8"), "kept");
    assert.deepEqual(vscode.commands.calls, []);
    assert.deepEqual(freshness, []);
    assert.deepEqual(replies, []);
    console.log("  ✓ existing, cancelled, invalid and failed notes preserve opening and notification behavior");

    await send({ ...image, filename: "doc.pdf", mime: "application/pdf" });
    assert.equal(vscode.window.warnings.at(-1), "Flintmark: only image attachments can be pasted.");
    await send({ ...image, dataBase64: "" });
    assert.equal(vscode.window.warnings.at(-1), "Flintmark: attachment is empty or too large (max 24 MB).");
    const notifications = [...vscode.window.warnings, ...vscode.window.errors];
    await send({ ...image, get dataBase64(): string { throw new Error("decode failed"); } });
    assert.deepEqual([...vscode.window.warnings, ...vscode.window.errors], notifications);
    symlinkSync(secret, join(root, "linked.png"));
    await send({ ...image, filename: "linked.png" });
    assert.equal(vscode.window.errors.at(-1), "Flintmark: couldn't save attachment: destination is a symlink");
    assert.deepEqual(freshness, []);
    assert.deepEqual(replies, []);
    console.log("  ✓ invalid and failed image messages preserve notifications and produce no freshness or embed reply");

    for (let i = 0; i < 1000; i++) writeFileSync(join(root, i === 0 ? "full.png" : `full-${i}.png`), "kept");
    await send({ ...image, filename: "full.png" });
    assert.equal(vscode.window.errors.at(-1), "Flintmark: too many attachments with that name — rename and retry.");
    assert.deepEqual(freshness, []);
    assert.deepEqual(replies, []);

    writeFileSync(join(root, "shot.png"), "original");
    await send(image);
    assert.equal(readFileSync(join(root, "shot.png"), "utf8"), "original");
    assert.equal(readFileSync(join(root, "shot-1.png"), "utf8"), "image");
    assert.deepEqual(freshness, [[document.uri, "attachment-saved"]]);
    assert.deepEqual(replies, [{ type: "attachmentSaved", requestId: 41, embed: "shot-1.png" }]);
    console.log("  ✓ only a completed image save requests freshness and posts the numeric correlated embed reply");
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error("  ✗ Note-folder creation editor", error); process.exitCode = 1; });
