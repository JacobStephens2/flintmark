// Pure-logic tests for the image/attachment resolver (no VS Code). This is the
// bulk of the "open an Obsidian vault → images resolve" correctness surface.
import assert from "node:assert";
import {
  parseEmbedInner,
  IMAGE_EXTS,
  ImageSnapshot,
} from "../../src/extension/vault/imageResolver";

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (e as Error).message);
  }
}

// helpers
const snap = (paths: string[]): ImageSnapshot => new ImageSnapshot(paths);
/** Resolve an EMBED (`![[pathPart]]`) → matched relPath or null. */
const embed = (s: ImageSnapshot, dir: string[], p: string): string | null =>
  s.resolve(dir, p, true)?.relPath ?? null;
/** Resolve a MARKDOWN src (`![](src)`) → matched relPath or null. */
const md = (s: ImageSnapshot, dir: string[], p: string): string | null =>
  s.resolve(dir, p, false)?.relPath ?? null;

test("path patches retain case-colliding candidates and their precedence", () => {
  const original = new ImageSnapshot(["assets/Logo.png", "assets/logo.png"]);
  const patched = original.patch(["unrelated.png"], []);
  for (const s of [original, patched]) {
    assert.equal(s.resolve(["notes"], "Logo.png", true)?.relPath, "assets/Logo.png");
    assert.equal(s.resolve(["notes"], "logo.png", true)?.relPath, "assets/logo.png");
    assert.equal(s.resolve([], "assets/Logo.png", true)?.relPath, "assets/logo.png");
  }
  const deleted = patched.patch([], ["assets/logo.png"]);
  assert.equal(deleted.resolve(["notes"], "logo.png", true)?.relPath, "assets/Logo.png");
  assert.equal(patched.resolve(["notes"], "logo.png", true)?.relPath, "assets/logo.png");
});

test("percent-spelling collisions survive unrelated additions and exact-spelling deletion", () => {
  for (const { paths, winner } of [
    { paths: ["assets/my pic.png", "assets/my%20pic.png"], winner: "assets/my%20pic.png" },
    { paths: ["assets/my%20pic.png", "assets/my pic.png"], winner: "assets/my pic.png" },
  ]) {
    const original = snap(paths);
    const patched = original.patch(["other.png"], []);
    for (const s of [original, patched]) {
      assert.equal(embed(s, [], "assets/my%20pic.png"), winner, "full-path last-entry precedence");
      assert.equal(embed(s, ["notes"], "my%20pic.png"), "assets/my pic.png", "exact decoded basename");
    }
    assert.equal(embed(patched.patch([], ["assets/my pic.png"]), [], "assets/my pic.png"), "assets/my%20pic.png");
    assert.equal(embed(patched.patch([], ["assets/my%20pic.png"]), [], "assets/my pic.png"), "assets/my pic.png");
    assert.equal(embed(original, [], "assets/my pic.png"), winner, "older snapshot stays unchanged");
  }
});

test("repeated additions and missing deletions preserve precedence; additions win overlaps", () => {
  const original = snap(["assets/logo.png", "assets/Logo.png"]);
  const repeated = original.patch(["assets/logo.png", "assets/logo.png"], ["assets/LOGO.png", "missing.png"]);
  assert.equal(embed(repeated, [], "assets/logo.png"), "assets/Logo.png");
  const overlap = repeated.patch(["assets/logo.png", "assets/logo.png"], ["assets/logo.png", "assets/logo.png"]);
  assert.equal(embed(overlap, [], "assets/Logo.png"), "assets/logo.png");
  assert.equal(embed(overlap, ["notes"], "Logo.png"), "assets/Logo.png");
  assert.equal(embed(repeated, [], "assets/logo.png"), "assets/Logo.png");
  assert.equal(embed(original, [], "assets/logo.png"), "assets/Logo.png");
  const removed = overlap.patch([], ["assets/logo.png", "assets/logo.png"]);
  assert.equal(embed(removed, [], "assets/logo.png"), "assets/Logo.png");
  assert.equal(embed(removed.patch([], ["assets/Logo.png"]), [], "logo.png"), null);
});

test("a rename replaces the path without changing older snapshots or resolved entries", () => {
  const original = snap(["assets/before.png"]);
  const entry = original.resolve(["assets"], "before.png", true);
  const renamed = original.patch(["assets/after.png"], ["assets/before.png"]);
  assert.equal(embed(renamed, ["assets"], "./before.png"), null);
  assert.equal(embed(renamed, ["assets"], "./after.png"), "assets/after.png");
  assert.equal(embed(original, ["assets"], "./before.png"), "assets/before.png");
  assert.equal(embed(original, ["assets"], "./after.png"), null);
  assert.deepEqual(entry, { relPath: "assets/before.png", segments: ["assets", "before.png"], basename: "before.png", ext: "png" });
});

test("resolved records and segments cannot corrupt later queries or patches", () => {
  const s = snap(["assets/Logo.png", "assets/logo.png"]);
  for (const ref of ["assets/Logo.png", "Logo.png", "logo.png"]) {
    const entry = s.resolve(["notes"], ref, true)!;
    const originalPath = entry.relPath;
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.segments));
    for (const field of ["relPath", "basename", "ext", "segments"]) {
      assert.equal(Reflect.set(entry, field, "corrupted"), false);
    }
    assert.equal(Reflect.set(entry.segments, "0", "corrupted"), false);
    assert.throws(() => Array.prototype.push.call(entry.segments, "corrupted"), TypeError);
    assert.equal(embed(s, ["notes"], ref), originalPath);
    assert.equal(embed(s.patch(["unrelated.png"], []), ["notes"], ref), originalPath);
  }
});

// --- bare basename / vault-wide -------------------------------------------

test("bare embed resolves vault-wide to an attachments-folder image", () => {
  const s = snap(["attachments/pic.png"]);
  assert.equal(embed(s, ["notes"], "pic.png"), "attachments/pic.png");
});

test("exact document-relative beats a vault-wide basename match", () => {
  const s = snap(["notes/pic.png", "attachments/pic.png"]);
  assert.equal(embed(s, ["notes"], "pic.png"), "notes/pic.png");
});

test("same-folder image for a nested note resolves (doc-relative exact)", () => {
  const s = snap(["a/b/pic.png"]);
  assert.equal(embed(s, ["a", "b"], "pic.png"), "a/b/pic.png");
});

test("markdown ![](bare.png) with no relative hit falls back to basename", () => {
  const s = snap(["attachments/pic.png"]);
  assert.equal(md(s, ["notes"], "pic.png"), "attachments/pic.png");
});

// --- path hints (foldered) -------------------------------------------------

test("a foldered reference resolves by path-hint (suffix), not arbitrary basename", () => {
  const s = snap(["a/sub/pic.png", "b/pic.png"]);
  assert.equal(embed(s, [], "sub/pic.png"), "a/sub/pic.png");
});

test("a foldered reference does NOT fall back to a bare basename match", () => {
  const s = snap(["x/pic.png"]); // no path ends with sub/pic.png
  assert.equal(embed(s, [], "sub/pic.png"), null);
});

// --- duplicate ranking -----------------------------------------------------

test("duplicate basenames: the shorter path wins", () => {
  const s = snap(["deep/folder/pic.png", "assets/pic.png"]);
  assert.equal(embed(s, ["notes"], "pic.png"), "assets/pic.png");
});

test("equal-length duplicate paths rank lexicographically regardless of construction order", () => {
  for (const paths of [["z/pic.png", "a/pic.png"], ["a/pic.png", "z/pic.png"]]) {
    assert.equal(embed(snap(paths), ["notes"], "pic.png"), "a/pic.png");
  }
});

test("duplicate basenames: exact-case basename beats a case-only match", () => {
  const s = snap(["a/Pic.png", "b/pic.png"]);
  assert.equal(embed(s, [], "pic.png"), "b/pic.png");
  assert.equal(embed(s, [], "Pic.png"), "a/Pic.png");
});

// --- spaces / percent-encoding --------------------------------------------

test("embed with raw spaces resolves", () => {
  const s = snap(["attachments/my pic.png"]);
  assert.equal(embed(s, ["notes"], "my pic.png"), "attachments/my pic.png");
});

test("markdown percent-encoded spaces resolve (decoded for lookup)", () => {
  const s = snap(["attachments/my pic.png"]);
  assert.equal(md(s, ["notes"], "my%20pic.png"), "attachments/my pic.png");
});

test("malformed escapes fall back to the original spelling", () => {
  const s = snap(["assets/bad%ZZ.png"]);
  assert.equal(md(s, ["notes"], "bad%ZZ.png"), "assets/bad%ZZ.png");
  assert.equal(embed(s, [], "assets/bad%ZZ.png"), "assets/bad%ZZ.png");
});

// --- extension rules -------------------------------------------------------

test("extensionless embed ![[Photo]] is NOT guessed to an image", () => {
  const s = snap(["attachments/Photo.png"]);
  assert.equal(embed(s, [], "Photo"), null);
});

test("a non-image embed extension (.md/.pdf) is not resolved as an image", () => {
  const s = snap(["attachments/doc.md", "attachments/file.pdf"]);
  assert.equal(embed(s, [], "doc.md"), null);
  assert.equal(embed(s, [], "file.pdf"), null);
});

test("the supported image extension set is exactly Obsidian's", () => {
  assert.deepEqual(
    [...IMAGE_EXTS].sort(),
    ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]
  );
});

// --- relative markers ------------------------------------------------------

test("./ and ../ are relative-ONLY (no vault-wide fallback)", () => {
  const s = snap(["notes/sub/pic.png", "attachments/pic.png"]);
  assert.equal(embed(s, ["notes"], "./sub/pic.png"), "notes/sub/pic.png");
  assert.equal(embed(s, ["notes"], "../attachments/pic.png"), "attachments/pic.png");
  assert.equal(embed(s, ["notes"], "./missing.png"), null); // relative miss → null, NOT basename
});

// --- Windows-style stored paths -------------------------------------------

test("entries with backslash separators normalize correctly", () => {
  const s = snap(["a\\b\\pic.png"]);
  assert.equal(embed(s, [], "pic.png"), "a/b/pic.png");
  assert.equal(embed(s, [], "a\\b\\pic.png"), "a/b/pic.png");
});

// --- embed inner parsing (#anchor / |size) --------------------------------

test("parseEmbedInner pulls the path part and |WxH dimensions", () => {
  assert.deepEqual(parseEmbedInner("img.png"), { pathPart: "img.png", width: undefined, height: undefined });
  assert.deepEqual(parseEmbedInner("img.png|200"), { pathPart: "img.png", width: 200, height: undefined });
  assert.deepEqual(parseEmbedInner("img.png|100x145"), { pathPart: "img.png", width: 100, height: 145 });
  assert.deepEqual(parseEmbedInner("img.png#anchor|200"), { pathPart: "img.png", width: 200, height: undefined });
  // a non-numeric alias is not a size; path part still extracted
  assert.equal(parseEmbedInner("img.png|alt text").pathPart, "img.png");
  assert.equal(parseEmbedInner("sub/img.png#x").pathPart, "sub/img.png");
});

test("an absolute path is never vault-resolved (POSIX / Windows / UNC)", () => {
  const s = snap(["attachments/logo.png"]);
  assert.equal(md(s, ["notes"], "/tmp/logo.png"), null); // POSIX
  assert.equal(embed(s, ["notes"], "/var/logo.png"), null);
  assert.equal(md(s, ["notes"], "C:/Users/me/logo.png"), null); // Windows drive
  assert.equal(md(s, ["notes"], "\\\\server\\share\\logo.png"), null); // UNC
});

// --- snapshot status -------------------------------------------------------

test("a non-ready snapshot resolves nothing (caller uses legacy fallback)", () => {
  for (const status of ["notReady", "overCap", "disabled"] as const) {
    const s = new ImageSnapshot(["attachments/pic.png"], status);
    assert.equal(s.status, status);
    assert.equal(Reflect.set(s, "status", "ready"), false);
    assert.equal(embed(s, ["notes"], "pic.png"), null);
    assert.equal(md(s, ["attachments"], "pic.png"), null);
    const patched = s.patch(["attachments/other.png"], []);
    assert.equal(patched.status, "ready");
    assert.equal(embed(patched, ["notes"], "pic.png"), "attachments/pic.png");
    assert.equal(embed(patched, ["notes"], "other.png"), "attachments/other.png");
    assert.equal(s.status, status);
    assert.equal(embed(s, ["notes"], "other.png"), null);
  }
});

test("construction and empty patches default to ready and copy their input paths", () => {
  const paths = ["assets/pic.png"];
  const original = snap(paths);
  paths[0] = "changed.png";
  const patched = original.patch([], []);
  assert.notEqual(patched, original);
  for (const s of [original, patched]) {
    assert.equal(s.status, "ready");
    assert.equal(Reflect.set(s, "status", "disabled"), false);
    assert.equal(embed(s, [], "pic.png"), "assets/pic.png");
    assert.equal(embed(s, [], "changed.png"), null);
  }
});

if (failed > 0) {
  console.error(`\n${failed} imageResolver test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll imageResolver tests passed");
