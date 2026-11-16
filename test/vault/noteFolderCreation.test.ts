import assert from "node:assert/strict";
import { NoteFolderCreation, NoteFolderStorage } from "../../src/extension/vault/noteFolderCreation";

function memoryFolder() {
  const files = new Map<string, Uint8Array>();
  const storage: NoteFolderStorage<string> = {
    sibling: (_uri, name) => `notes/${name}`,
    classify: async uri => files.has(uri) ? "present" : "absent",
    createNew: async (uri, bytes) => {
      if (files.has(uri)) throw new Error("occupied");
      files.set(uri, Buffer.from(bytes));
    },
  };
  return { files, storage, creation: new NoteFolderCreation(storage) };
}

async function main(): Promise<void> {
  async function test(name: string, run: () => Promise<void>) {
    await run();
    console.log("  ✓ " + name);
  }
  const document = "notes/Current.md";
  const image = { filename: "shot.png", mime: "image/png", dataBase64: "aW1hZ2U=" };
  const forbiddenStorage: NoteFolderStorage<string> = {
    sibling: () => { throw new Error("unexpected destination derivation"); },
    classify: async () => { throw new Error("unexpected filesystem inspection"); },
    createNew: async () => { throw new Error("unexpected write"); },
  };

  await test("note names normalize basenames, aliases, anchors and extensions with the exact stub", async () => {
    const cases = [
      ["Foo", "Foo.md"], ["My Great Note", "My Great Note.md"],
      ["  Foo  ", "Foo.md"], ["a/  Foo  ", "Foo.md"], ["Foo|Bar", "Foo.md"],
      ["Foo#Section", "Foo.md"], ["Foo#^block|Alias", "Foo.md"],
      ["Foo.md", "Foo.md"], ["Foo.markdown", "Foo.md"], ["Foo.MARKDOWN", "Foo.md"],
      ["a/b/Foo", "Foo.md"], ["a\\b\\Foo", "Foo.md"], ["../secret", "secret.md"],
    ];
    for (const [target, filename] of cases) {
      const { files, creation } = memoryFolder();
      const result = await creation.createNote(document, target, async () => true);
      assert.deepEqual(result, { kind: "created", uri: `notes/${filename}`, filename });
      assert.equal(new TextDecoder().decode(files.get(result.uri)), `# ${filename.slice(0, -3)}\n\n`);
    }
  });

  await test("invalid notes neither inspect storage nor ask for confirmation", async () => {
    const creation = new NoteFolderCreation(forbiddenStorage);
    for (const target of ["", "   ", ".", "..", ".md", "#Heading", 'a:b', 'a"b', "a?b", "a*b", "a<b", "a>b", "a\u0000b", "a\u001fb"]) {
      assert.deepEqual(await creation.createNote(document, target, async () => {
        throw new Error("unexpected confirmation");
      }), { kind: "invalid-target" });
    }
    for (const target of [undefined, 123]) {
      assert.deepEqual(await creation.createNote(document, target as unknown as string, async () => true), { kind: "invalid-target" });
    }
  });

  await test("a present destination returns existing without confirmation or replacement", async () => {
    const { storage, files, creation } = memoryFolder();
    files.set("notes/Foo.md", Buffer.from("retained"));
    // Present includes directories; classification deliberately has no file-only case.
    storage.createNew = async () => { throw new Error("must not write"); };
    assert.deepEqual(await creation.createNote(document, "Foo", async () => {
      throw new Error("must not confirm");
    }), { kind: "existing", uri: "notes/Foo.md", filename: "Foo.md" });
    assert.equal(Buffer.from(files.get("notes/Foo.md")!).toString(), "retained");
  });

  await test("missing and symlink destinations can be cancelled without creating", async () => {
    for (const kind of ["absent", "symlink"] as const) {
      const { storage, files, creation } = memoryFolder();
      storage.classify = async () => kind;
      assert.deepEqual(await creation.createNote(document, "Foo", async () => false), { kind: "cancelled" });
      assert.equal(files.size, 0);
    }
  });

  await test("a rejected confirmation rejects the operation", async () => {
    const { creation, files } = memoryFolder();
    const fault = new Error("dialog failed");
    await assert.rejects(creation.createNote(document, "Foo", async () => { throw fault; }), error => error === fault);
    assert.equal(files.size, 0);
  });

  await test("a symlink appearing during confirmation fails before persistence", async () => {
    const { storage, files, creation } = memoryFolder();
    const result = await creation.createNote(document, "Foo", async () => {
      storage.classify = async () => "symlink";
      return true;
    });
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") throw new Error("expected failure");
    assert.equal(result.filename, "Foo.md");
    assert.equal((result.error as Error).message, "destination is a symlink");
    assert.equal(files.size, 0);
  });

  await test("a note write failure retains its original error and filename", async () => {
    const { storage, creation } = memoryFolder();
    const fault = new Error("disk full");
    storage.createNew = async () => { throw fault; };
    assert.deepEqual(await creation.createNote(document, "Foo", async () => true), {
      kind: "failed", filename: "Foo.md", error: fault,
    });
  });

  await test("attachment names preserve supported formats, sanitization and extension precedence", async () => {
    const cases = [
      ["photo.png", "image/png", "photo.png"], ["pic.JPEG", "", "pic.jpg"],
      ["x", "image/jpeg", "x.jpg"], ["clip", "image/webp", "clip.webp"],
      ["  shot .png", "image/png", "shot.png"], ["foo.bar.png", "image/png", "foo.bar.png"],
      ["a/b/evil.png", "image/png", "evil.png"], ["a\\b\\evil.png", "image/png", "evil.png"],
      ["../../e.png", "image/png", "e.png"], ["a:b.png", "image/png", "ab.png"],
      ['a"b*c.png', "image/png", "abc.png"], ["diagram#1.png", "image/png", "diagram1.png"],
      ["a[b]^c.png", "image/png", "abc.png"], ["a|b?.png", "image/png", "ab.png"],
      ["pic.gif", "image/png", "pic.gif"], ["pic.png", "text/plain", "pic.png"],
      ["clip.pdf", "IMAGE/PNG", "clip.png"],
    ];
    for (const [filename, mime, embed] of cases) {
      const { files, creation } = memoryFolder();
      assert.deepEqual(await creation.saveAttachment(document, { ...image, filename, mime }), {
        kind: "saved", uri: `notes/${embed}`, embed,
      });
      assert.deepEqual(files.get(`notes/${embed}`), Buffer.from("image"));
    }
  });

  await test("all supported MIME types and extensions save through the operation", async () => {
    for (const [mime, ext] of [
      ["image/png", "png"], ["image/jpeg", "jpg"], ["image/jpg", "jpg"],
      ["image/gif", "gif"], ["image/webp", "webp"], ["image/svg+xml", "svg"],
      ["image/bmp", "bmp"], ["image/avif", "avif"],
    ]) {
      const { creation } = memoryFolder();
      assert.deepEqual(await creation.saveAttachment(document, { ...image, filename: "clip", mime }), {
        kind: "saved", uri: `notes/clip.${ext}`, embed: `clip.${ext}`,
      });
    }
    for (const ext of ["png", "jpg", "gif", "webp", "svg", "bmp", "avif"]) {
      const { creation } = memoryFolder();
      assert.equal((await creation.saveAttachment(document, { ...image, filename: `pic.${ext}`, mime: "" })).kind, "saved");
    }
  });

  await test("fallback image names use local date and time", async () => {
    const { storage, files } = memoryFolder();
    const creation = new NoteFolderCreation(storage, () => new Date(2026, 0, 2, 3, 4, 5));
    assert.deepEqual(await creation.saveAttachment(document, { ...image, filename: "" }), {
      kind: "saved", uri: "notes/Pasted image 20260102030405.png", embed: "Pasted image 20260102030405.png",
    });
    assert.deepEqual(files.get("notes/Pasted image 20260102030405.png"), Buffer.from("image"));
  });

  await test("unsupported images are rejected before decoding or filesystem operations", async () => {
    const creation = new NoteFolderCreation(forbiddenStorage);
    for (const [filename, mime] of [["doc.pdf", "application/pdf"], ["evil.exe", "application/octet-stream"], ["", "text/plain"]]) {
      const input = { filename, mime, get dataBase64(): string { throw new Error("must not decode"); } };
      assert.deepEqual(await creation.saveAttachment(document, input), { kind: "unsupported-image" });
    }
  });

  await test("decoding exceptions and invalid sizes do not touch the filesystem", async () => {
    const creation = new NoteFolderCreation(forbiddenStorage);
    const input = { ...image, get dataBase64(): string { throw new Error("decoding exception"); } };
    assert.deepEqual(await creation.saveAttachment(document, input), { kind: "decode-failed" });
    for (const dataBase64 of ["", "!!!", Buffer.alloc(24 * 1024 * 1024 + 1).toString("base64")]) {
      assert.deepEqual(await creation.saveAttachment(document, { ...image, dataBase64 }), { kind: "invalid-size" });
    }
  });

  await test("base64 remains permissive and the 24 MiB boundary is accepted", async () => {
    const { creation, files } = memoryFolder();
    assert.equal((await creation.saveAttachment(document, { ...image, dataBase64: "aW!1h Z2U" })).kind, "saved");
    assert.deepEqual(files.get("notes/shot.png"), Buffer.from("image"));
    const bytes = Buffer.alloc(24 * 1024 * 1024, 7);
    assert.equal((await creation.saveAttachment(document, { ...image, filename: "large.png", dataBase64: bytes.toString("base64") })).kind, "saved");
    assert.deepEqual(files.get("notes/large.png"), bytes);
  });

  await test("occupied attachment names retain their bytes and select a suffixed name", async () => {
    const { creation, files } = memoryFolder();
    files.set("notes/shot.png", Buffer.from("original"));
    files.set("notes/shot-1.png", Buffer.from("also original"));
    assert.deepEqual(await creation.saveAttachment(document, image), {
      kind: "saved", uri: "notes/shot-2.png", embed: "shot-2.png",
    });
    assert.deepEqual([...files.values()], [Buffer.from("original"), Buffer.from("also original"), Buffer.from("image")]);
  });

  await test("the final -999 candidate is usable; 1000 occupied candidates exhaust selection", async () => {
    const { creation, files } = memoryFolder();
    files.set("notes/shot.png", Buffer.from("kept"));
    for (let i = 1; i < 999; i++) files.set(`notes/shot-${i}.png`, Buffer.from("kept"));
    assert.deepEqual(await creation.saveAttachment(document, image), {
      kind: "saved", uri: "notes/shot-999.png", embed: "shot-999.png",
    });
    const before = new Map(files);
    assert.deepEqual(await creation.saveAttachment(document, image), { kind: "exhausted" });
    assert.deepEqual(files, before);
  });

  await test("a symlink stops attachment selection instead of being skipped", async () => {
    const { storage, files, creation } = memoryFolder();
    files.set("notes/shot.png", Buffer.from("kept"));
    storage.classify = async uri => uri.endsWith("shot.png") ? "present" : "symlink";
    const result = await creation.saveAttachment(document, image);
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") throw new Error("expected failure");
    assert.equal((result.error as Error).message, "destination is a symlink");
    assert.deepEqual([...files.keys()], ["notes/shot.png"]);
  });

  await test("an attachment taken during creation fails without retrying and retains the original error", async () => {
    const { storage, files, creation } = memoryFolder();
    const fault = new Error("EntryExists");
    storage.createNew = async uri => {
      files.set(uri, Buffer.from("race winner"));
      throw fault;
    };
    assert.deepEqual(await creation.saveAttachment(document, image), { kind: "failed", error: fault });
    assert.deepEqual([...files], [["notes/shot.png", Buffer.from("race winner")]]);
  });
}

void main().catch(error => { console.error("  ✗ Note-folder creation", error); process.exitCode = 1; });
