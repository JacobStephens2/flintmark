// Regression: creating an attachment or a new note must fail when the
// destination name is a symlink, and must not write the link's target.
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
import { exclusiveCreate } from "../../src/extension/vault/exclusiveCreate";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "flintmark-exclusive-"));
  const noteDir = join(root, "note");
  const outside = join(root, "outside");
  mkdirSync(noteDir);
  mkdirSync(outside);
  try {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "original-secret");
    const linked = join(noteDir, "photo.png");
    symlinkSync(secret, linked);
    const planted = Buffer.from("forged-image");
    await assert.rejects(
      exclusiveCreate({ scheme: "file", fsPath: linked }, planted),
    );
    assert.equal(readFileSync(secret, "utf8"), "original-secret");
    assert.equal(lstatSync(linked).isSymbolicLink(), true);
    console.log("  ✓ exclusive create fails when the destination name is a symlink and leaves the target untouched");

    const plantedPath = join(outside, "planted.md");
    const dangling = join(noteDir, "Planted.md");
    symlinkSync(plantedPath, dangling);
    await assert.rejects(
      exclusiveCreate({ scheme: "file", fsPath: dangling }, Buffer.from("# planted\n")),
    );
    assert.throws(() => lstatSync(plantedPath));
    assert.equal(lstatSync(dangling).isSymbolicLink(), true);
    console.log("  ✓ exclusive create fails when the destination name is a dangling symlink and does not create the target");

    const free = join(noteDir, "Free note.md");
    const noteBytes = Buffer.from("# Free note\n\n");
    await exclusiveCreate({ scheme: "file", fsPath: free }, noteBytes);
    assert.equal(lstatSync(free).isFile(), true);
    assert.deepEqual(readFileSync(free), noteBytes);
    console.log("  ✓ a free name becomes a new regular file in the note folder");

    const occupied = join(noteDir, "Occupied.md");
    writeFileSync(occupied, "kept");
    await assert.rejects(
      exclusiveCreate({ scheme: "file", fsPath: occupied }, Buffer.from("replaced")),
    );
    assert.equal(readFileSync(occupied, "utf8"), "kept");
    console.log("  ✓ exclusive create fails when the destination name is an existing file and leaves it unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("  ✗ exclusive create", error);
  process.exitCode = 1;
});
