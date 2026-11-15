// Host regression: a symlink already visible to stat is not opened and is not
// saved around. The create fails, and a free name is still a regular file. On
// non-file schemes, a symlink planted after the check is not written through:
// the bytes go to a temporary file renamed onto the name without overwrite.
// Image saves share that path: a free name becomes a regular attachment, and a
// failed save shows the error and leaves no temporary file.
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";
import { OfmCustomTextEditorProvider } from "../../src/extension/customTextEditorProvider";

type NoteHost = {
  offerCreateNote(document: { uri: vscode.Uri }, target: string): Promise<void>;
  handleSaveAttachment(
    document: { uri: vscode.Uri },
    panel: { webview: { postMessage(msg: unknown): void } },
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

  /** Paste `text` as a PNG named `filename` beside `document`, and return the
   * reply the webview was sent, if any. */
  const saveImage = async (
    document: { uri: vscode.Uri },
    requestId: string,
    filename: string,
    text: string
  ): Promise<{ type?: string; requestId?: string; embed?: string } | undefined> => {
    const reply: { posted?: { type?: string; requestId?: string; embed?: string } } = {};
    const panel = {
      webview: { postMessage(msg: unknown) { reply.posted = msg as typeof reply.posted; } },
    };
    await provider.handleSaveAttachment(document, panel, {
      type: "saveAttachment",
      requestId,
      filename,
      mime: "image/png",
      dataBase64: Buffer.from(text).toString("base64"),
    });
    return reply.posted;
  };

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
    const posted = await saveImage(doc, "r1", "shot.png", "forged-image");
    assert.equal(readFileSync(photoSecret, "utf8"), "original-photo");
    assert.equal(lstatSync(photo).isSymbolicLink(), true);
    assert.equal(posted, undefined);
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
    const takenReply = await saveImage(doc, "r2", "taken.png", "new-image");
    assert.equal(readFileSync(taken, "utf8"), "taken-bytes");
    const deduped = join(noteDir, "taken-1.png");
    assert.equal(lstatSync(deduped).isFile(), true);
    assert.equal(takenReply?.embed, "taken-1.png");
    console.log("  ✓ an existing image name still saves a new regular file beside it");

    const remoteDir = join(root, "remote-view");
    mkdirSync(remoteDir);
    const remoteDest = join(remoteDir, "Linked.md");
    vscode.workspace.fs.stat = async (uri: { fsPath: string }) => {
      if (basename(uri.fsPath) === "Linked.md") {
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

    // A provider over the real disk: writeFile follows a symlink, as the
    // disk provider does, and rename refuses an occupied name unless told to
    // overwrite. Stat always misses, so a symlink planted after the check is
    // what the create meets.
    const lateDir = join(root, "late-view");
    mkdirSync(lateDir);
    const lateSecret = join(outside, "late-secret.txt");
    writeFileSync(lateSecret, "original-late");
    const lateLink = join(lateDir, "Late.md");
    symlinkSync(lateSecret, lateLink);
    const writes: string[] = [];
    let renameFault: Error | undefined;
    vscode.workspace.fs.stat = async () => {
      throw new Error("missing");
    };
    vscode.workspace.fs.writeFile = async (uri: { fsPath: string }, bytes: Uint8Array) => {
      writes.push(uri.fsPath);
      writeFileSync(uri.fsPath, bytes);
    };
    vscode.workspace.fs.rename = async (
      from: { fsPath: string },
      to: { fsPath: string },
      options?: { overwrite?: boolean }
    ) => {
      if (renameFault) throw renameFault;
      let occupied = true;
      try {
        lstatSync(to.fsPath);
      } catch {
        occupied = false;
      }
      if (occupied && !options?.overwrite) throw new Error("EntryExists");
      renameSync(from.fsPath, to.fsPath);
    };
    vscode.workspace.fs.delete = async (uri: { fsPath: string }) => {
      rmSync(uri.fsPath, { force: true });
    };
    const lateDoc = {
      uri: new vscode.Uri("vscode-remote", join(lateDir, "Current.md"), join(lateDir, "Current.md")),
    };
    const tempLeftovers = () => readdirSync(lateDir).filter((n) => /^\.flintmark-.*\.tmp$/.test(n));

    vscode.window.errors.length = 0;
    vscode.commands.calls.length = 0;
    await provider.offerCreateNote(lateDoc, "Late");
    assert.equal(readFileSync(lateSecret, "utf8"), "original-late");
    assert.equal(lstatSync(lateLink).isSymbolicLink(), true);
    assert.ok(
      vscode.window.errors.some((m: string) => /couldn't create Late\.md/i.test(m)),
      JSON.stringify(vscode.window.errors)
    );
    assert.equal(vscode.commands.calls.length, 0);
    assert.deepEqual(tempLeftovers(), []);
    assert.ok(writes.length > 0 && writes.every((w) => dirname(w) === lateDir && w !== lateLink));
    console.log("  ✓ a non-file note create does not write through a symlink planted after the check");

    vscode.window.errors.length = 0;
    vscode.commands.calls.length = 0;
    await provider.offerCreateNote(lateDoc, "Remote free");
    const remoteFree = join(lateDir, "Remote free.md");
    assert.equal(lstatSync(remoteFree).isFile(), true);
    assert.equal(readFileSync(remoteFree, "utf8"), "# Remote free\n\n");
    assert.deepEqual(vscode.window.errors, []);
    const opened = vscode.commands.calls[0] as [string, { scheme: string; fsPath: string }, string];
    assert.equal(opened[0], "vscode.openWith");
    assert.equal(opened[1].scheme, "vscode-remote");
    assert.equal(opened[1].fsPath, remoteFree);
    assert.deepEqual(tempLeftovers(), []);
    // Each create picks a fresh temporary name, and none is the destination.
    assert.equal(writes.length, 2);
    assert.notEqual(writes[0], writes[1]);
    assert.ok(!writes.includes(remoteFree));
    console.log("  ✓ a free non-file note name becomes a regular file and opens");

    const lateShotSecret = join(outside, "late-shot.bin");
    writeFileSync(lateShotSecret, "original-shot");
    const lateShot = join(lateDir, "late.png");
    symlinkSync(lateShotSecret, lateShot);
    vscode.window.errors.length = 0;
    const lateReply = await saveImage(lateDoc, "r3", "late.png", "forged-image");
    assert.equal(readFileSync(lateShotSecret, "utf8"), "original-shot");
    assert.equal(lstatSync(lateShot).isSymbolicLink(), true);
    assert.equal(lateReply, undefined);
    assert.ok(vscode.window.errors.some((m: string) => /couldn't save attachment/i.test(m)));
    assert.deepEqual(tempLeftovers(), []);
    console.log("  ✓ a non-file image save does not write through a symlink planted after the check");

    writes.length = 0;
    vscode.window.errors.length = 0;
    const freeReply = await saveImage(lateDoc, "r4", "free.png", "free-image");
    const freeShotPath = join(lateDir, "free.png");
    assert.deepEqual(vscode.window.errors, []);
    assert.equal(lstatSync(freeShotPath).isFile(), true);
    assert.equal(readFileSync(freeShotPath, "utf8"), "free-image");
    assert.deepEqual(freeReply, { type: "attachmentSaved", requestId: "r4", embed: "free.png" });
    assert.equal(writes.length, 1);
    assert.ok(dirname(writes[0]) === lateDir && writes[0] !== freeShotPath);
    assert.deepEqual(tempLeftovers(), []);
    console.log("  ✓ a free non-file image name becomes a regular attachment and the embed is inserted");

    renameFault = new Error("provider unavailable");
    vscode.window.errors.length = 0;
    vscode.commands.calls.length = 0;
    await provider.offerCreateNote(lateDoc, "Unlucky");
    assert.ok(
      vscode.window.errors.some((m: string) => /couldn't create Unlucky\.md: provider unavailable/.test(m)),
      JSON.stringify(vscode.window.errors)
    );
    assert.equal(vscode.commands.calls.length, 0);
    assert.throws(() => lstatSync(join(lateDir, "Unlucky.md")));
    assert.deepEqual(tempLeftovers(), []);
    console.log("  ✓ a failed non-file note create shows the error and leaves no temporary file");

    vscode.window.errors.length = 0;
    // The rename fails after the temporary file is written.
    renameFault = new Error("provider unavailable");
    writes.length = 0;
    const failedReply = await saveImage(lateDoc, "r5", "unlucky.png", "unlucky-image");
    assert.ok(
      vscode.window.errors.some((m: string) =>
        /couldn't save attachment: provider unavailable/.test(m)
      ),
      JSON.stringify(vscode.window.errors)
    );
    assert.equal(failedReply, undefined);
    assert.equal(writes.length, 1);
    assert.ok(dirname(writes[0]) === lateDir && writes[0] !== join(lateDir, "unlucky.png"));
    assert.throws(() => lstatSync(join(lateDir, "unlucky.png")));
    assert.deepEqual(tempLeftovers(), []);
    console.log("  ✓ a failed non-file image save shows the error and leaves no temporary file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("  ✗ exclusive create host", error);
  process.exitCode = 1;
});
