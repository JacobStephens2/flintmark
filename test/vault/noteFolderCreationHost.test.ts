import assert from "node:assert/strict";
import {
  lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync,
  renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";
import { createNoteFolderCreation } from "../../src/extension/vault/noteFolderCreationHost";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "flintmark-creation-adapter-"));
  const creation = createNoteFolderCreation();
  const image = { filename: "shot.png", mime: "image/png", dataBase64: Buffer.from("image bytes").toString("base64") };
  const local = join(root, "local");
  const disk = join(root, "provider");
  mkdirSync(local);
  mkdirSync(disk);
  const document = vscode.Uri.file(join(local, "Current.md"));
  // Same disk-backed provider behavior as the old host test: writes follow
  // links, and rename refuses occupied names when overwrite is false. Provider
  // paths deliberately differ from extension-host paths.
  const remoteDocument = new vscode.Uri("vscode-remote", "/notes/Current.md");
  let hideEntries = false;
  let renameFault: Error | undefined;
  let writeFault: Error | undefined;
  let cleanupFault: Error | undefined;
  const writes: string[] = [];
  const diskPath = (uri: vscode.Uri) => {
    assert.equal(uri.scheme, "vscode-remote");
    assert.equal(dirname(uri.path), "/notes");
    return join(disk, basename(uri.path));
  };
  vscode.workspace.fs.stat = async uri => {
    const path = diskPath(uri);
    if (hideEntries) throw new Error("missing");
    const st = lstatSync(path);
    return { type: st.isSymbolicLink() ? 65 : st.isDirectory() ? 2 : 1, ctime: 0, mtime: 0, size: st.size };
  };
  vscode.workspace.fs.writeFile = async (uri, bytes) => {
    const path = diskPath(uri);
    assert.match(basename(path), /^\.flintmark-[0-9a-f]{32}\.tmp$/);
    writes.push(path);
    if (writeFault) throw writeFault;
    writeFileSync(path, bytes);
  };
  vscode.workspace.fs.rename = async (from, to, options) => {
    const source = diskPath(from);
    const target = diskPath(to);
    if (renameFault) throw renameFault;
    assert.equal(options?.overwrite, false);
    let occupied = true;
    try { lstatSync(target); } catch { occupied = false; }
    if (occupied) throw new Error("EntryExists");
    renameSync(source, target);
  };
  vscode.workspace.fs.delete = async (uri, options) => {
    assert.equal(options?.useTrash, false);
    const path = diskPath(uri);
    if (cleanupFault) throw cleanupFault;
    rmSync(path, { force: true });
  };
  const leftovers = () => readdirSync(disk).filter(name => name.startsWith(".flintmark-"));

  try {
    for (const [doc, folder] of [[document, local], [remoteDocument, disk]] as const) {
      const note = await creation.createNote(doc, "Free note", async () => true);
      assert.equal(note.kind, "created");
      if (note.kind !== "created") throw new Error("expected created");
      assert.equal(note.uri.scheme, doc.scheme);
      assert.equal(readFileSync(join(folder, "Free note.md"), "utf8"), "# Free note\n\n");
      console.log(`  ✓ ${doc.scheme} note creation preserves bytes and URI scheme`);

      const freeImage = await creation.saveAttachment(doc, { ...image, filename: "free.png" });
      assert.equal(freeImage.kind, "saved");
      if (freeImage.kind !== "saved") throw new Error("expected saved");
      assert.equal(freeImage.embed, "free.png");
      assert.equal(freeImage.uri.scheme, doc.scheme);
      assert.equal(readFileSync(join(folder, "free.png"), "utf8"), "image bytes");
      console.log(`  ✓ ${doc.scheme} a free image name becomes a regular attachment`);

      mkdirSync(join(folder, "Directory.md"));
      const existing = await creation.createNote(doc, "Directory", async () => { throw new Error("must not confirm"); });
      assert.equal(existing.kind, "existing");
      assert.equal(lstatSync(join(folder, "Directory.md")).isDirectory(), true);
      mkdirSync(join(folder, "shot.png"));
      const attachment = await creation.saveAttachment(doc, image);
      assert.equal(attachment.kind, "saved");
      if (attachment.kind !== "saved") throw new Error("expected saved");
      assert.equal(attachment.embed, "shot-1.png");
      assert.equal(attachment.uri.scheme, doc.scheme);
      assert.equal(readFileSync(join(folder, "shot-1.png"), "utf8"), "image bytes");
      assert.equal(lstatSync(join(folder, "shot.png")).isDirectory(), true);
      console.log(`  ✓ ${doc.scheme} directories open as existing notes and occupy attachment names`);

      const secret = join(root, `${doc.scheme}-secret`);
      writeFileSync(secret, "retained");
      symlinkSync(secret, join(folder, "Linked.md"));
      symlinkSync(secret, join(folder, "linked.png"));
      const danglingTarget = join(root, `${doc.scheme}-absent`);
      symlinkSync(danglingTarget, join(folder, "Dangling.md"));
      for (const target of ["Linked", "Dangling"]) {
        assert.equal((await creation.createNote(doc, target, async () => false)).kind, "cancelled");
        assert.equal((await creation.createNote(doc, target, async () => true)).kind, "failed");
      }
      assert.equal((await creation.saveAttachment(doc, { ...image, filename: "linked.png" })).kind, "failed");
      assert.equal(readFileSync(secret, "utf8"), "retained");
      assert.equal(lstatSync(join(folder, "Linked.md")).isSymbolicLink(), true);
      assert.equal(lstatSync(join(folder, "Dangling.md")).isSymbolicLink(), true);
      assert.throws(() => lstatSync(danglingTarget));
      assert.deepEqual(leftovers(), []);
      console.log(`  ✓ ${doc.scheme} visible and dangling symlinks are refused after confirmation`);
    }
    assert.equal(new Set(writes).size, writes.length, "provider temporary names are fresh");

    // Hidden stat entries represent destinations taken after inspection.
    hideEntries = true;
    writeFileSync(join(disk, "Occupied.md"), "winner");
    assert.equal((await creation.createNote(remoteDocument, "Occupied", async () => true)).kind, "failed");
    assert.equal(readFileSync(join(disk, "Occupied.md"), "utf8"), "winner");
    const secret = join(root, "late-secret");
    writeFileSync(secret, "kept");
    symlinkSync(secret, join(disk, "late.png"));
    symlinkSync(secret, join(disk, "Late.md"));
    assert.equal((await creation.createNote(remoteDocument, "Late", async () => true)).kind, "failed");
    assert.equal((await creation.saveAttachment(remoteDocument, { ...image, filename: "late.png" })).kind, "failed");
    assert.equal(readFileSync(secret, "utf8"), "kept");
    assert.equal(lstatSync(join(disk, "late.png")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(disk, "Late.md")).isSymbolicLink(), true);
    assert.throws(() => lstatSync(join(disk, "late-1.png")));
    assert.deepEqual(leftovers(), []);
    console.log("  ✓ provider occupied names and late symlinks retain their files and clean temporary writes");

    renameFault = new Error("provider unavailable");
    assert.deepEqual(await creation.saveAttachment(remoteDocument, { ...image, filename: "unlucky.png" }), {
      kind: "failed", error: renameFault,
    });
    assert.deepEqual(await creation.createNote(remoteDocument, "Unlucky", async () => true), {
      kind: "failed", filename: "Unlucky.md", error: renameFault,
    });
    assert.throws(() => lstatSync(join(disk, "unlucky.png")));
    assert.throws(() => lstatSync(join(disk, "Unlucky.md")));
    assert.deepEqual(leftovers(), []);
    console.log("  ✓ failed provider creates retain the original rename error and remove temporary files");

    cleanupFault = new Error("cleanup failed");
    assert.deepEqual(await creation.saveAttachment(remoteDocument, { ...image, filename: "cleanup.png" }), {
      kind: "failed", error: renameFault,
    });
    const retainedTemps = leftovers();
    assert.ok(retainedTemps.length > 0);
    for (const temp of retainedTemps) assert.equal(readFileSync(join(disk, temp), "utf8"), "image bytes");
    writeFault = new Error("disk full");
    assert.deepEqual(await creation.createNote(remoteDocument, "Full", async () => true), {
      kind: "failed", filename: "Full.md", error: writeFault,
    });
    assert.deepEqual(leftovers(), retainedTemps);
    assert.throws(() => lstatSync(join(disk, "Full.md")));
    console.log("  ✓ cleanup failures preserve retained files and never replace the original write or rename error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error("  ✗ Note-folder creation adapter", error); process.exitCode = 1; });
