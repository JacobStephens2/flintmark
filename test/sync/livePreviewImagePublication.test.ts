import assert from "node:assert/strict";
import { LivePreviewImagePublication } from "../../src/extension/livePreviewImagePublication";

let failed = 0;
function test(name: string, run: () => void): void {
  try {
    run();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name, error);
  }
}

function fixture() {
  let text = "";
  const maps: Record<string, string>[] = [];
  const indexed = new Map<string, string>();
  const publication = new LivePreviewImagePublication({
    readText: () => text,
    resolveIndexed: reference => indexed.get(reference),
    resolveLegacy: reference => `local:${reference}`,
    postMap: map => { maps.push(map); },
  });
  return { publication, maps, indexed, setText: (value: string) => { text = value; } };
}

test("refresh waits for ready and every ready offers a complete empty map", () => {
  const { publication, maps } = fixture();
  publication.refresh();
  assert.deepEqual(maps, []);
  publication.ready();
  assert.deepEqual(maps, [{}]);
  publication.refresh();
  assert.deepEqual(maps, [{}]);
  publication.ready();
  assert.deepEqual(maps, [{}, {}]);
});

test("ready reads live references, preserving raw keys, resolution order and Markdown precedence", () => {
  let text = "stale text";
  const maps: Record<string, string>[] = [];
  const publication = new LivePreviewImagePublication({
    readText: () => text,
    resolveIndexed: (reference, requireImageExt) => {
      if (reference === "shared.png") return requireImageExt ? "indexed:embed" : "indexed:markdown";
      if (reference === "picture.JPG") return "indexed:picture";
      return undefined;
    },
    resolveLegacy: reference => `local:${reference}`,
    postMap: map => { maps.push(map); },
  });
  text = `![[shared.png#heading|200]]
![same](shared.png) ![again](shared.png)
![encoded](dir/My%20Photo.png "title") ![no extension](README)
![secure](https://example.test/a.png) ![plain](http://example.test/a.png)
![inline](data:image/png;base64,AAAA) ![uppercase](HTTPS://example.test/a.png)
![[ picture.JPG #anchor|100x200|alias]] ![[picture.JPG|alias]]
![[note.md]] ![[document.pdf]] ![[no-extension]]`;
  publication.ready();
  assert.deepEqual(maps, [{
    "shared.png": "indexed:markdown",
    "dir/My%20Photo.png": "local:dir/My%20Photo.png",
    README: "local:README",
    "https://example.test/a.png": "https://example.test/a.png",
    "http://example.test/a.png": "http://example.test/a.png",
    "data:image/png;base64,AAAA": "data:image/png;base64,AAAA",
    "HTTPS://example.test/a.png": "local:HTTPS://example.test/a.png",
    "picture.JPG": "indexed:picture",
  }]);
});

test("equivalent and reordered references are suppressed while URI versions and removals publish", () => {
  const { publication, maps, indexed, setText } = fixture();
  setText("![[a.png]] ![b](b.png)");
  publication.refresh();
  indexed.set("a.png", "webview:/assets/a.png?ofmIndex=1");
  publication.ready();
  assert.deepEqual(maps, [{ "a.png": "webview:/assets/a.png?ofmIndex=1", "b.png": "local:b.png" }]);
  publication.refresh();
  setText("new prose ![b](b.png) ![[a.png#anchor|alias]] ![[a.png|200]]");
  publication.refresh();
  assert.equal(maps.length, 1);
  indexed.set("a.png", "webview:/assets/a.png?ofmIndex=2");
  publication.refresh();
  assert.deepEqual(maps.at(-1), { "a.png": "webview:/assets/a.png?ofmIndex=2", "b.png": "local:b.png" });
  assert.equal(maps.length, 2);
  indexed.clear();
  publication.refresh();
  assert.deepEqual(maps.at(-1), { "a.png": "local:a.png", "b.png": "local:b.png" });
  setText("no images");
  publication.refresh();
  assert.deepEqual(maps.at(-1), {});
  assert.equal(maps.length, 4);
  publication.refresh();
  assert.equal(maps.length, 4);
});

test("each ready resends the latest nonempty map and panels suppress independently", () => {
  const first = fixture();
  const second = fixture();
  for (const f of [first, second]) {
    f.setText("![[same.png]]");
    f.publication.ready();
    f.publication.refresh();
    assert.deepEqual(f.maps, [{ "same.png": "local:same.png" }]);
  }
  first.publication.ready();
  assert.equal(first.maps.length, 2);
  assert.equal(second.maps.length, 1);
  first.setText("![[latest.png]]");
  first.publication.ready();
  assert.deepEqual(first.maps.at(-1), { "latest.png": "local:latest.png" });
  second.indexed.set("same.png", "second-panel:same.png");
  second.publication.refresh();
  assert.deepEqual(second.maps.at(-1), { "same.png": "second-panel:same.png" });
  assert.equal(first.maps.length, 3);
});

test("image embeds retain the supported extension set and extension-required lookup", () => {
  const maps: Record<string, string>[] = [];
  const publication = new LivePreviewImagePublication({
    readText: () => "![[a.png]] ![[b.jpg]] ![[c.jpeg]] ![[d.GIF]] ![[e.svg]] ![[f.webp]] ![[g.bmp]] ![[h.avif]] ![[i.pdf]] ![[j.md]] ![[k.tiff]] ![[l.png?query]]",
    resolveIndexed: (_reference, requireImageExt) => requireImageExt ? "indexed:image" : "indexed:any",
    resolveLegacy: () => { throw new Error("indexed references must not fall back"); },
    postMap: map => { maps.push(map); },
  });
  publication.ready();
  assert.deepEqual(maps, [{
    "a.png": "indexed:image", "b.jpg": "indexed:image", "c.jpeg": "indexed:image", "d.GIF": "indexed:image",
    "e.svg": "indexed:image", "f.webp": "indexed:image", "g.bmp": "indexed:image", "h.avif": "indexed:image",
  }]);
});

test("remote references bypass both URI adapters", () => {
  const maps: Record<string, string>[] = [];
  const unexpected = () => { throw new Error("remote references must pass through"); };
  const publication = new LivePreviewImagePublication({
    readText: () => "![](https://example.test/a.png) ![](http://example.test/b.png) ![](data:image/png;base64,AAAA) ![[https://example.test/c.png|200]]",
    resolveIndexed: unexpected,
    resolveLegacy: unexpected,
    postMap: map => { maps.push(map); },
  });
  publication.refresh();
  assert.deepEqual(maps, []);
  publication.ready();
  assert.deepEqual(maps, [{
    "https://example.test/a.png": "https://example.test/a.png",
    "http://example.test/b.png": "http://example.test/b.png",
    "data:image/png;base64,AAAA": "data:image/png;base64,AAAA",
    "https://example.test/c.png": "https://example.test/c.png",
  }]);
});

test("disposal is terminal before or after ready and reopening has independent state", () => {
  for (const initialized of [false, true]) {
    const old = fixture();
    old.setText("![[photo.png]]");
    if (initialized) old.publication.ready();
    const offered = [...old.maps];
    old.publication.dispose();
    old.publication.dispose();
    old.setText("![[changed.png]]");
    old.publication.refresh();
    old.publication.ready();
    assert.deepEqual(old.maps, offered);
    const reopened = fixture();
    reopened.setText("![[photo.png]]");
    reopened.publication.refresh();
    assert.deepEqual(reopened.maps, []);
    reopened.publication.ready();
    assert.deepEqual(reopened.maps, [{ "photo.png": "local:photo.png" }]);
  }
});

if (failed) process.exitCode = 1;
