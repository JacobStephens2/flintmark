// Regression: creating an attachment or a new note must fail when the
// destination name is a symlink, and must not write the link's target. The
// provider create writes a temporary file and renames it without overwrite.
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
import {
  exclusiveCreate,
  providerExclusiveCreate,
  temporaryCreateName,
} from "../../src/extension/vault/exclusiveCreate";

type Call = [string, ...unknown[]];

function recordingFs(fault?: { on: "writeFile" | "rename" | "delete"; error: Error }) {
  const calls: Call[] = [];
  const step = async (name: "writeFile" | "rename" | "delete", ...args: unknown[]) => {
    calls.push([name, ...args]);
    if (fault?.on === name) throw fault.error;
  };
  return {
    calls,
    fs: {
      writeFile: (uri: string, bytes: Uint8Array) => step("writeFile", uri, bytes),
      rename: (from: string, to: string, options: { overwrite: boolean }) =>
        step("rename", from, to, options),
      delete: (uri: string, options: { useTrash: boolean }) => step("delete", uri, options),
    },
  };
}

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

    const bytes = Buffer.from("# Note\n\n");
    const ok = recordingFs();
    await providerExclusiveCreate(ok.fs, "dir/Note.md", "dir/.tmp", bytes);
    assert.deepEqual(ok.calls, [
      ["writeFile", "dir/.tmp", bytes],
      ["rename", "dir/.tmp", "dir/Note.md", { overwrite: false }],
    ]);
    console.log("  ✓ a provider create writes the temporary name, then renames it without overwrite");

    const taken = new Error("EntryExists");
    const clash = recordingFs({ on: "rename", error: taken });
    await assert.rejects(providerExclusiveCreate(clash.fs, "dir/Note.md", "dir/.tmp", bytes), taken);
    assert.deepEqual(clash.calls.at(-1), ["delete", "dir/.tmp", { useTrash: false }]);
    console.log("  ✓ a failed provider rename deletes the temporary file and rethrows");

    const down = new Error("write failed");
    const cleanupFails = recordingFs({ on: "writeFile", error: down });
    cleanupFails.fs.delete = async () => {
      throw new Error("missing");
    };
    await assert.rejects(providerExclusiveCreate(cleanupFails.fs, "dir/Note.md", "dir/.tmp", bytes), down);
    assert.equal(cleanupFails.calls.some((c) => c[0] === "rename"), false);
    console.log("  ✓ a failed provider write rethrows its own error, even when cleanup fails");

    const names = new Set(Array.from({ length: 64 }, temporaryCreateName));
    assert.equal(names.size, 64);
    for (const name of names) assert.match(name, /^\.flintmark-[0-9a-f]{32}\.tmp$/);
    console.log("  ✓ temporary create names are random and never Markdown names");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("  ✗ exclusive create", error);
  process.exitCode = 1;
});
