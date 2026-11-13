// Host regression: a symlink already visible to stat is not opened and is not
// saved around. The create fails, and a free name is still a regular file.
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { OfmCustomTextEditorProvider } from "../../src/extension/customTextEditorProvider";

type NoteHost = {
  offerCreateNote(document: { uri: vscode.Uri }, target: string): Promise<void>;
  handleSaveAttachment(
    document: { uri: vscode.Uri },
    panel: { webview: { postMessage(msg: unknown): void }; posted?: unknown },
    msg: {
      type: "saveAttachment";
      requestId: string;
      filename: string;
      mime: string;
      dataBase64: string;
    }
  ): Promise<void>;
};

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "flintmark-exclusive-host-"));
  const noteDir = join(root, "notes");
  const outside = join(root, "outside");
  mkdirSync(noteDir);
  mkdirSync(outside);
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "original-secret");
  const live = join(noteDir, "Linked.md");
  symlinkSync(secret, live);
  const planted = join(outside, "planted.md");
  const dangling = join(noteDir, "Dangling.md");
  symlinkSync(planted, dangling);
  const photoSecret = join(outside, "photo-secret.bin");
  writeFileSync(photoSecret, "original-photo");
  const photo = join(noteDir, "shot.png");
  symlinkSync(photoSecret, photo);

  vscode.workspace.fs.stat = async (uri: { fsPath: string }) => {
    const st = lstatSync(uri.fsPath);
    return { type: st.isSymbolicLink() ? 64 : 1, ctime: 0, mtime: 0, size: st.size };
  };

  const provider = Object.create(OfmCustomTextEditorProvider.prototype) as NoteHost;
  const doc = { uri: vscode.Uri.file(join(noteDir, "Current.md")) };

  try {
    vscode.window.errors.length = 0;
    vscode.commands.calls.length = 0;
    await provider.offerCreateNote(doc, "Linked");
    assert.equal(readFileSync(secret, "utf8"), "original-secret");
    assert.equal(lstatSync(live).isSymbolicLink(), true);
    assert.ok(
      vscode.window.errors.some((m: string) => /couldn't create/i.test(m)),
      JSON.stringify(vscode.commands.calls)
    );
    console.log("  ✓ creating a note fails when the destination name is a symlink to a file");

    vscode.window.errors.length = 0;
    vscode.commands.calls.length = 0;
    await provider.offerCreateNote(doc, "Dangling");
    assert.throws(() => lstatSync(planted));
    assert.equal(lstatSync(dangling).isSymbolicLink(), true);
    assert.ok(
      vscode.window.errors.some((m: string) => /couldn't create/i.test(m)),
      JSON.stringify(vscode.commands.calls.map((c: unknown[]) => c[0]))
    );
    console.log("  ✓ creating a note fails when the destination name is a dangling symlink");

    vscode.window.errors.length = 0;
    const panel: { webview: { postMessage(msg: unknown): void }; posted?: unknown } = {
      webview: { postMessage(msg) { panel.posted = msg; } },
    };
    await provider.handleSaveAttachment(doc, panel, {
      type: "saveAttachment",
      requestId: "r1",
      filename: "shot.png",
      mime: "image/png",
      dataBase64: Buffer.from("forged-image").toString("base64"),
    });
    assert.equal(readFileSync(photoSecret, "utf8"), "original-photo");
    assert.equal(lstatSync(photo).isSymbolicLink(), true);
    assert.equal(panel.posted, undefined);
    assert.ok(vscode.window.errors.some((m: string) => /couldn't save attachment/i.test(m)));
    console.log("  ✓ saving an image fails when the destination name is a symlink");

    vscode.window.errors.length = 0;
    vscode.commands.calls.length = 0;
    await provider.offerCreateNote(doc, "Free note");
    const free = join(noteDir, "Free note.md");
    assert.equal(lstatSync(free).isFile(), true);
    assert.equal(readFileSync(free, "utf8"), "# Free note\n\n");
    console.log("  ✓ a free note name becomes a new regular file in the note folder");

    const taken = join(noteDir, "taken.png");
    writeFileSync(taken, "taken-bytes");
    const saved: { posted?: { embed?: string } } = {};
    const takenPanel = {
      webview: { postMessage(msg: unknown) { saved.posted = msg as { embed?: string }; } },
    };
    await provider.handleSaveAttachment(doc, takenPanel, {
      type: "saveAttachment",
      requestId: "r2",
      filename: "taken.png",
      mime: "image/png",
      dataBase64: Buffer.from("new-image").toString("base64"),
    });
    assert.equal(readFileSync(taken, "utf8"), "taken-bytes");
    const deduped = join(noteDir, "taken-1.png");
    assert.equal(lstatSync(deduped).isFile(), true);
    assert.equal(saved.posted?.embed, "taken-1.png");
    console.log("  ✓ an existing image name still saves a new regular file beside it");

    const remoteDir = join(root, "remote-view");
    mkdirSync(remoteDir);
    const remoteDest = join(remoteDir, "Linked.md");
    vscode.workspace.fs.stat = async (uri: { fsPath: string }) => {
      if (uri.fsPath.endsWith("/Linked.md")) {
        return { type: vscode.FileType.SymbolicLink, ctime: 0, mtime: 0, size: 0 };
      }
      throw new Error("missing");
    };
    vscode.window.errors.length = 0;
    const remoteDoc = {
      uri: new vscode.Uri("vscode-remote", join(remoteDir, "Current.md"), join(remoteDir, "Current.md")),
    };
    await provider.offerCreateNote(remoteDoc, "Linked");
    assert.ok(
      vscode.window.errors.some((m: string) => /couldn't create/i.test(m)),
      JSON.stringify(vscode.window.errors)
    );
    assert.throws(() => lstatSync(remoteDest));
    console.log("  ✓ a non-file symlink fails the note create and does not write the extension-host path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("  ✗ exclusive create host", error);
  process.exitCode = 1;
});
