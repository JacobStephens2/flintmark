import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Minimatch } from "minimatch";
import {
  DEFAULT_INDEX_EXCLUDES,
  DEFAULT_MAX_FILES,
  relativePathFromRoot,
  WorkspaceIndex,
  WorkspaceIndexBuildCancelled,
  type WorkspaceIndexDisposable,
  type WorkspaceIndexFile,
  type WorkspaceIndexHost,
  type WorkspaceIndexNotice,
  type WorkspaceIndexRefreshEvent,
  type WorkspaceIndexSpecSink,
  type WorkspaceIndexUri,
  type WorkspaceIndexWorkspaceSink,
} from "../../src/extension/vault/workspaceIndexing";

interface TestUri extends WorkspaceIndexUri {
  readonly scheme: string;
  readonly path: string;
  toString(): string;
}

function makeUri(scheme: string, path: string): TestUri {
  return {
    scheme,
    path,
    toString() {
      return `${scheme}://${path}`;
    },
  };
}

const fileUri = (path: string) => makeUri("file", path);

class MemoryHost {
  nowMs = 100_000;
  private nextTimerId = 1;
  private readonly scheduled = new Map<number, { due: number; cb: () => void }>();
  private rootsList: TestUri[];
  private home?: TestUri;
  readonly files = new Map<string, { uri: TestUri; bytes: Uint8Array }>();
  readonly dirs = new Set<string>();
  readonly exclusionConfig = new Map<string, { excludes?: string[]; extra?: string[] }>();
  readonly notices: WorkspaceIndexNotice<TestUri>[] = [];
  readonly errors: { error: unknown; kind: string; root: TestUri; reason: string }[] = [];
  readonly findFilesCalls: {
    base: TestUri;
    include: string;
    exclude: string | undefined;
    maxResults: number;
    aborted: boolean;
  }[] = [];
  readonly statCalls: TestUri[] = [];
  readonly readDirectoryCalls: TestUri[] = [];
  readonly readFileCalls: TestUri[] = [];
  readonly watchedSpecs = new Map<
    string,
    { include: string; watchContent: boolean; sink: WorkspaceIndexSpecSink<TestUri>; disposed: boolean }
  >();
  workspaceSink?: WorkspaceIndexWorkspaceSink<TestUri>;
  workspaceWatcherDisposed = false;
  statError?: Error;
  readDirectoryError?: Error;
  findFilesError?: Error;
  private findGate?: { promise: Promise<void>; onEnter?: () => void };
  private statGate?: { promise: Promise<void>; onEnter?: () => void };
  private readGate?: { promise: Promise<void>; onEnter?: () => void };

  constructor(initialRoots: TestUri[] = []) {
    this.rootsList = [...initialRoots];
  }

  setRoots(roots: TestUri[]): void {
    this.rootsList = [...roots];
  }

  setHome(home: TestUri | undefined): void {
    this.home = home;
  }

  addFile(uri: TestUri, content = ""): void {
    this.files.set(this.key(uri), { uri, bytes: new TextEncoder().encode(content) });
  }

  removeFile(uri: TestUri): void {
    this.files.delete(this.key(uri));
  }

  addDir(uri: TestUri): void {
    this.dirs.add(this.key(uri));
  }

  removeDir(uri: TestUri): void {
    const dirKey = this.key(uri);
    this.dirs.delete(dirKey);
    const prefix = dirKey.replace(/\/$/, "") + "/";
    for (const k of [...this.files.keys()]) {
      if (k.startsWith(prefix)) this.files.delete(k);
    }
    for (const k of [...this.dirs]) {
      if (k.startsWith(prefix)) this.dirs.delete(k);
    }
  }

  holdFindFiles(): { entered: Promise<void>; release(): void; reject(err: unknown): void } {
    let enteredResolve!: () => void;
    let release!: () => void;
    let reject!: (err: unknown) => void;
    const entered = new Promise<void>((r) => { enteredResolve = r; });
    const promise = new Promise<void>((res, rej) => { release = res; reject = rej; });
    this.findGate = { promise, onEnter: enteredResolve };
    return {
      entered,
      release: () => { this.findGate = undefined; release(); },
      reject: (err) => { this.findGate = undefined; reject(err); },
    };
  }

  holdStat(): { entered: Promise<void>; release(): void; reject(err: unknown): void } {
    let enteredResolve!: () => void;
    let release!: () => void;
    let reject!: (err: unknown) => void;
    const entered = new Promise<void>((r) => { enteredResolve = r; });
    const promise = new Promise<void>((res, rej) => { release = res; reject = rej; });
    this.statGate = { promise, onEnter: enteredResolve };
    return {
      entered,
      release: () => { this.statGate = undefined; release(); },
      reject: (err) => { this.statGate = undefined; reject(err); },
    };
  }

  holdReadFile(): { entered: Promise<void>; release(): void; reject(err: unknown): void } {
    let enteredResolve!: () => void;
    let release!: () => void;
    let reject!: (err: unknown) => void;
    const entered = new Promise<void>((r) => { enteredResolve = r; });
    const promise = new Promise<void>((res, rej) => { release = res; reject = rej; });
    this.readGate = { promise, onEnter: enteredResolve };
    return {
      entered,
      release: () => { this.readGate = undefined; release(); },
      reject: (err) => { this.readGate = undefined; reject(err); },
    };
  }

  private key(uri: TestUri): string {
    const p =
      uri.scheme === "file"
        ? uri.path.replace(/^\/([A-Z]):(?=\/|$)/, (_, d: string) => `/${d.toLowerCase()}:`)
        : uri.path;
    return `${uri.scheme}\0${p}`;
  }

  async advanceBy(ms: number): Promise<void> {
    await this.flushMicrotasks();
    const target = this.nowMs + ms;
    while (true) {
      let nextId: number | undefined;
      let nextDue = Infinity;
      for (const [id, entry] of this.scheduled) {
        if (entry.due <= target && entry.due < nextDue) {
          nextDue = entry.due;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const entry = this.scheduled.get(nextId)!;
      this.scheduled.delete(nextId);
      if (entry.due > this.nowMs) this.nowMs = entry.due;
      entry.cb();
      await this.flushMicrotasks();
    }
    this.nowMs = target;
    await this.flushMicrotasks();
  }

  async flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  }

  host(): WorkspaceIndexHost<TestUri> {
    return {
      workspaceFolders: () => this.rootsList,
      homeDirectory: () => this.home,
      exclusions: (root) => this.exclusionConfig.get(this.key(root)),
      now: () => this.nowMs,
      yieldNow: async () => { await Promise.resolve(); },
      timers: {
        setTimeout: (cb, ms) => {
          const id = this.nextTimerId++;
          this.scheduled.set(id, { due: this.nowMs + Math.max(0, ms), cb });
          return id;
        },
        clearTimeout: (handle) => {
          this.scheduled.delete(handle as number);
        },
      },
      stat: async (uri) => {
        this.statCalls.push(uri);
        if (this.statGate) {
          this.statGate.onEnter?.();
          await this.statGate.promise;
        }
        if (this.statError) throw this.statError;
        const k = this.key(uri);
        if (this.dirs.has(k)) return "directory";
        if (this.files.has(k)) return "file";
        const prefix = k.replace(/\/$/, "") + "/";
        for (const fk of this.files.keys()) {
          if (fk.startsWith(prefix)) return "directory";
        }
        return "missing";
      },
      readDirectory: async (uri) => {
        this.readDirectoryCalls.push(uri);
        if (this.readDirectoryError) throw this.readDirectoryError;
        const k = this.key(uri);
        const prefix = k.replace(/\/$/, "") + "/";
        let exists = this.dirs.has(k);
        const entries = new Map<string, { name: string; uri: TestUri; type: "file" | "directory" }>();
        const basePath = uri.path.replace(/\/$/, "");
        for (const [fk, rec] of this.files) {
          if (!fk.startsWith(prefix)) continue;
          exists = true;
          const rest = rec.uri.path.slice(basePath.length + 1);
          const slash = rest.indexOf("/");
          const name = slash >= 0 ? rest.slice(0, slash) : rest;
          entries.set(name, {
            name,
            uri: makeUri(uri.scheme, `${basePath}/${name}`),
            type: slash >= 0 ? "directory" : "file",
          });
        }
        for (const dk of this.dirs) {
          if (!dk.startsWith(prefix)) continue;
          exists = true;
          const rel = dk.slice(prefix.length);
          const name = rel.split("/")[0];
          if (name) {
            entries.set(name, {
              name,
              uri: makeUri(uri.scheme, `${basePath}/${name}`),
              type: "directory",
            });
          }
        }
        if (!exists) return "missing";
        return [...entries.values()];
      },
      findFiles: async (base, include, exclude, maxResults, signal) => {
        const record = { base, include, exclude, maxResults, aborted: signal.aborted };
        this.findFilesCalls.push(record);
        signal.addEventListener("abort", () => { record.aborted = true; }, { once: true });
        const snapshotEntries = [...this.files.values()];
        if (this.findGate) {
          this.findGate.onEnter?.();
          await this.findGate.promise;
        }
        if (signal.aborted) throw new WorkspaceIndexBuildCancelled();
        if (this.findFilesError) throw this.findFilesError;
        const matcher = new Minimatch(include, { dot: true, nocase: true });
        const exMatcher = exclude
          ? new Minimatch(exclude, { dot: true, nonegate: true, nocomment: true, noext: true })
          : undefined;
        const out: TestUri[] = [];
        for (const rec of snapshotEntries) {
          if (rec.uri.scheme !== base.scheme) continue;
          const baseComp = this.key(base).split("\0")[1].replace(/\/$/, "");
          const fileComp = this.key(rec.uri).split("\0")[1];
          const prefix = baseComp === "" ? "/" : baseComp + "/";
          if (!fileComp.startsWith(prefix)) continue;
          const rel = rec.uri.path.slice(prefix.length);
          if (!matcher.match(rel)) continue;
          if (exMatcher && exMatcher.match(rel)) continue;
          out.push(rec.uri);
          if (out.length >= maxResults) break;
        }
        return out;
      },
      readFile: async (uri) => {
        this.readFileCalls.push(uri);
        if (this.readGate) {
          this.readGate.onEnter?.();
          await this.readGate.promise;
        }
        const rec = this.files.get(this.key(uri));
        if (!rec) {
          const err = new Error(`ENOENT: ${uri.path}`) as Error & { code: string };
          err.code = "ENOENT";
          throw err;
        }
        return rec.bytes;
      },
      watchWorkspace: (sink) => {
        this.workspaceSink = sink;
        return { dispose: () => { this.workspaceWatcherDisposed = true; } };
      },
      watchSpec: (spec, sink): WorkspaceIndexDisposable => {
        const rec = {
          include: spec.include,
          watchContent: spec.watchContent,
          sink,
          disposed: false,
        };
        this.watchedSpecs.set(spec.kind, rec);
        return { dispose: () => { rec.disposed = true; } };
      },
      onNotice: (notice) => { this.notices.push(notice); },
      onError: (error, context) => { this.errors.push({ error, ...context }); },
    };
  }
}

let failures = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}`, error);
  }
}

async function main(): Promise<void> {
  await test("workspaceIndexing.ts has zero vscode, node:fs, or node:os imports", () => {
    const source = readFileSync(
      resolve("src/extension/vault/workspaceIndexing.ts"),
      "utf8"
    );
    assert.equal(/\bfrom\s+["'](?:vscode|node:fs|fs|node:os|os)(?:\/[^"']*)?["']/.test(source), false);
    assert.equal(DEFAULT_MAX_FILES, 100_000);
    assert.ok(DEFAULT_INDEX_EXCLUDES.length >= 2);
  });

  await test("initializes multi-root index, preserves original TUri tokens, and passes WorkspaceIndexFile and context.readFile", async () => {
    const rootA = fileUri("/C:/VaultA");
    const rootB = makeUri("custom", "/VaultB");
    const noteA = fileUri("/c:/VaultA/notes/Alpha.md");
    const noteB = makeUri("custom", "/VaultB/Beta.markdown");
    const mem = new MemoryHost([rootA, rootB]);
    mem.addFile(noteA, "# Alpha");
    mem.addFile(noteB, "# Beta");
    const index = new WorkspaceIndex(mem.host());
    const events: WorkspaceIndexRefreshEvent<TestUri>[] = [];
    const seenFiles: WorkspaceIndexFile<TestUri>[] = [];
    const readContents = new Map<string, string>();
    const handle = index.register({
      kind: "note",
      include: "**/*.{md,markdown}",
      notReady: () => [] as string[],
      build: async (_root, files, context) => {
        const paths: string[] = [];
        for (const f of files) {
          seenFiles.push(f);
          const bytes = await context.readFile(f.uri);
          readContents.set(f.relativePath, new TextDecoder().decode(bytes));
          paths.push(f.relativePath);
        }
        return paths;
      },
    });
    handle.onDidRefresh((e) => events.push(e));
    assert.equal(handle.snapshot(rootA), undefined);
    assert.equal(handle.version(rootA), 0);
    await index.initialize();
    assert.deepEqual(handle.snapshot(rootA), ["notes/Alpha.md"]);
    assert.deepEqual(handle.snapshot(rootB), ["Beta.markdown"]);
    assert.equal(handle.version(rootA), 1);
    assert.equal(handle.version(rootB), 1);
    assert.equal(handle.snapshots().length, 2);
    assert.equal(readContents.get("notes/Alpha.md"), "# Alpha");
    assert.equal(readContents.get("Beta.markdown"), "# Beta");
    assert.equal(seenFiles.find((f) => f.relativePath === "notes/Alpha.md")?.uri, noteA);
    assert.equal(events[0].root, rootA);
    assert.equal(events[1].root, rootB);
    const docCtx = handle.forDocument(fileUri("/C:/VaultA/notes/Other.md"));
    assert.equal(docCtx?.root, rootA);
    assert.equal(docCtx?.relativePath, "notes/Other.md");
    assert.deepEqual(docCtx?.snapshot, ["notes/Alpha.md"]);
    assert.equal(docCtx?.version, 1);
    index.dispose();
  });

  await test("Windows drive-letter normalization, segment boundaries, nested roots, and non-file case sensitivity", async () => {
    for (const rootDrive of ["C", "c"]) {
      for (const fileDrive of ["C", "c"]) {
        for (const slash of ["", "/"]) {
          assert.equal(
            relativePathFromRoot(
              fileUri(`/${rootDrive}:/Notes${slash}`),
              fileUri(`/${fileDrive}:/Notes/assets/Photo.PNG`)
            ),
            "assets/Photo.PNG"
          );
        }
      }
    }
    assert.equal(
      relativePathFromRoot(fileUri("/C:/My Notes"), fileUri("/c:/My Notes/assets/画像 Photo.SVG")),
      "assets/画像 Photo.SVG"
    );
    assert.equal(relativePathFromRoot(fileUri("/D:/"), fileUri("/d:/Photo.png")), "Photo.png");
    assert.equal(relativePathFromRoot(fileUri("/D:"), fileUri("/d:/Photo.png")), "Photo.png");
    assert.equal(
      relativePathFromRoot(fileUri("/C:/Notes"), fileUri("/c:/Notes-archive/photo.png")),
      "c:/Notes-archive/photo.png"
    );
    assert.equal(
      relativePathFromRoot(fileUri("/C:/Notes"), fileUri("/d:/Notes/photo.png")),
      "d:/Notes/photo.png"
    );
    assert.equal(relativePathFromRoot(fileUri("/vault"), fileUri("/vault/Photo.PNG")), "Photo.PNG");
    assert.equal(relativePathFromRoot(fileUri("/vault"), fileUri("/Vault/Photo.PNG")), "Vault/Photo.PNG");
    assert.equal(relativePathFromRoot(fileUri("/"), fileUri("/vault/Photo.PNG")), "vault/Photo.PNG");
    assert.equal(relativePathFromRoot(fileUri("/C:/Notes"), fileUri("/c:/notes/Photo.PNG")), "c:/notes/Photo.PNG");
    for (const scheme of ["custom", "vscode-remote", "memfs"]) {
      assert.equal(
        relativePathFromRoot(makeUri(scheme, "/C:/Notes"), makeUri(scheme, "/c:/Notes/photo.png")),
        "c:/Notes/photo.png"
      );
      assert.equal(
        relativePathFromRoot(makeUri(scheme, "/C:/Notes"), makeUri(scheme, "/C:/Notes/photo.png")),
        "photo.png"
      );
    }

    // Nested workspace roots: longest matching root wins in forDocument.
    const parentRoot = fileUri("/C:/Workspace");
    const childRoot = fileUri("/c:/Workspace/packages/docs");
    const mem = new MemoryHost([parentRoot, childRoot]);
    mem.addFile(fileUri("/c:/Workspace/top.md"), "top");
    mem.addFile(fileUri("/C:/Workspace/packages/docs/nested.md"), "nested");
    const index = new WorkspaceIndex(mem.host());
    const handle = index.register({
      kind: "note",
      include: "**/*.md",
      notReady: () => [] as string[],
      build: async (_r, files) => files.map((f) => f.relativePath),
    });
    await index.initialize();
    const nestedDoc = handle.forDocument(fileUri("/c:/Workspace/packages/docs/guide.md"));
    assert.equal(nestedDoc?.root, childRoot);
    assert.equal(nestedDoc?.relativePath, "guide.md");
    const parentDoc = handle.forDocument(fileUri("/c:/Workspace/packages/other.md"));
    assert.equal(parentDoc?.root, parentRoot);
    assert.equal(parentDoc?.relativePath, "packages/other.md");
    index.dispose();
  });

  await test("generic spec routing with Minimatch + matchesPath, overlapping specs, late register, and handle.dispose()", async () => {
    const root = fileUri("/work");
    const mem = new MemoryHost([root]);
    mem.addFile(fileUri("/work/docs/guide.md"), "guide");
    mem.addFile(fileUri("/work/docs/draft.md"), "draft");
    mem.addFile(fileUri("/work/notes/other.md"), "other");
    mem.addFile(fileUri("/work/assets/pic.PNG"), "png");
    const index = new WorkspaceIndex(mem.host());

    const allMd = index.register({
      kind: "all-md",
      include: "**/*.md",
      debounceMs: 10,
      notReady: () => [] as string[],
      build: async (_r, files) => files.map((f) => f.relativePath).sort(),
    });
    const docsPublished = index.register({
      kind: "docs-published",
      include: "docs/**/*.md",
      matchesPath: (rel) => !rel.endsWith("draft.md"),
      debounceMs: 10,
      notReady: () => [] as string[],
      build: async (_r, files) => files.map((f) => f.relativePath).sort(),
    });
    await index.initialize();
    assert.deepEqual(allMd.snapshot(root), ["docs/draft.md", "docs/guide.md", "notes/other.md"]);
    assert.deepEqual(docsPublished.snapshot(root), ["docs/guide.md"]);

    // Overlapping treeCreated routes to all matching specs, filtered by matchesPath.
    const newGuide = fileUri("/work/docs/new.md");
    const newDraft = fileUri("/work/docs/new-draft.md");
    mem.addFile(newGuide, "new");
    mem.addFile(newDraft, "draft");
    mem.workspaceSink!.treeCreated(newGuide);
    mem.workspaceSink!.treeCreated(newDraft);
    await mem.advanceBy(10);
    await index.whenSettled();
    assert.deepEqual(allMd.snapshot(root), [
      "docs/draft.md",
      "docs/guide.md",
      "docs/new-draft.md",
      "docs/new.md",
      "notes/other.md",
    ]);
    assert.deepEqual(docsPublished.snapshot(root), ["docs/guide.md", "docs/new.md"]);

    // Late register after initialize starts watching and scans existing roots.
    const lateImages = index.register({
      kind: "custom-img",
      include: "**/*.{png,jpg}",
      matchesPath: (rel) => /\.png$/i.test(rel),
      debounceMs: 10,
      notReady: () => [] as string[],
      build: async (_r, files) => files.map((f) => f.relativePath),
    });
    assert.ok(mem.watchedSpecs.has("custom-img"));
    await mem.advanceBy(0);
    await index.whenSettled();
    assert.deepEqual(lateImages.snapshot(root), ["assets/pic.PNG"]);

    // Single-spec handle.dispose() detaches its watcher and leaves siblings running.
    docsPublished.dispose();
    assert.equal(mem.watchedSpecs.get("docs-published")?.disposed, true);
    assert.equal(docsPublished.snapshot(root), undefined);
    assert.deepEqual(docsPublished.snapshots(), []);
    assert.equal(docsPublished.version(root), 0);
    assert.equal(docsPublished.forDocument(newGuide), undefined);

    const siblingNote = fileUri("/work/docs/after-dispose.md");
    mem.addFile(siblingNote, "after");
    mem.workspaceSink!.treeCreated(siblingNote);
    await mem.advanceBy(10);
    await index.whenSettled();
    assert.ok(allMd.snapshot(root)!.includes("docs/after-dispose.md"));

    // Re-registering the disposed kind works cleanly.
    const reRegistered = index.register({
      kind: "docs-published",
      include: "docs/**/*.md",
      debounceMs: 10,
      notReady: () => [] as string[],
      build: async (_r, files) => files.map((f) => f.relativePath).sort(),
    });
    await mem.advanceBy(0);
    await index.whenSettled();
    assert.ok(reRegistered.snapshot(root)!.includes("docs/after-dispose.md"));
    // Disposing the old handle again must not touch the new registration.
    docsPublished.dispose();
    assert.ok(reRegistered.snapshot(root)!.includes("docs/after-dispose.md"));
    index.dispose();
  });

  await test("busy-workspace survival, monotonic mode coalescing, and leading-edge debounce deadline", async () => {
    const root = fileUri("/busy");
    const mem = new MemoryHost([root]);
    const oldNote = fileUri("/busy/old.md");
    mem.addFile(oldNote, "old");
    const findGate = mem.holdFindFiles();
    const index = new WorkspaceIndex(mem.host());
    const events: WorkspaceIndexRefreshEvent<TestUri>[] = [];
    const handle = index.register({
      kind: "note",
      include: "**/*.md",
      debounceMs: 50,
      watchContent: true,
      notReady: () => [] as string[],
      build: async (_r, files) => files.map((f) => f.relativePath).sort(),
      patchSnapshot: async (_r, snap, patch) => {
        if (patch.mode === "content") return [...snap, `content:${patch.changed[0].relativePath}`];
        const next = new Set(snap);
        for (const d of patch.deleted) next.delete(d.relativePath);
        for (const c of patch.changed) next.add(c.relativePath);
        return [...next].sort();
      },
    });
    handle.onDidRefresh((e) => events.push(e));

    const initPromise = index.initialize();
    await findGate.entered;

    // Emit tree dir creates, leaf creates/deletes, and content changes while initial scan is in flight.
    for (let i = 0; i < 4; i++) {
      const dir = fileUri(`/busy/tmp-${i}`);
      mem.addDir(dir);
      mem.workspaceSink!.treeCreated(dir);
      const added = fileUri(`/busy/new-${i}.md`);
      mem.addFile(added, "new");
      mem.watchedSpecs.get("note")!.sink.created(added);
      mem.watchedSpecs.get("note")!.sink.changed(added);
    }
    mem.removeFile(oldNote);
    mem.watchedSpecs.get("note")!.sink.deleted(oldNote);
    await mem.flushMicrotasks();

    assert.equal(
      mem.findFilesCalls.some((c) => c.aborted),
      false,
      "busy traffic must never abort an in-flight initial scan"
    );
    findGate.release();
    await initPromise;
    assert.equal(events.length, 1);
    assert.deepEqual(handle.snapshot(root), ["old.md"]);

    // Advance debounce for the single coalesced follow-up.
    await mem.advanceBy(50);
    await index.whenSettled();
    assert.equal(events.length, 2, "all in-flight events coalesce into one deferred follow-up");
    assert.equal(events[1].mode, "paths", "content + paths coalesce monotonically to paths");
    assert.deepEqual(handle.snapshot(root), ["new-0.md", "new-1.md", "new-2.md", "new-3.md"]);
    assert.equal(mem.findFilesCalls.length, 1, "direct-file/leaf follow-up needed no second findFiles");

    // Leading-edge debounce deadline preserved under continuous traffic.
    const beforeContinuous = events.length;
    for (let t = 0; t < 3; t++) {
      const continuous = fileUri(`/busy/cont-${t}.md`);
      mem.addFile(continuous, "c");
      mem.watchedSpecs.get("note")!.sink.created(continuous);
      if (t < 2) {
        await mem.advanceBy(20);
        assert.equal(events.length, beforeContinuous);
      }
    }
    // Now at +40ms (last event just arrived 0ms ago); +10ms reaches the +50ms leading-edge deadline.
    await mem.advanceBy(10);
    await index.whenSettled();
    assert.equal(events.length, beforeContinuous + 1, "leading-edge deadline is not starved by continuous traffic");
    assert.ok(handle.snapshot(root)!.includes("cont-2.md"));
    index.dispose();
  });

  await test("scan serialization, ABA-safe removeRoot+addRoot, AbortSignal propagation, and cooperative cancellation", async () => {
    const root = fileUri("/aba");
    const otherRoot = fileUri("/other");
    const mem = new MemoryHost([root, otherRoot]);
    mem.addFile(fileUri("/aba/a.md"), "a");
    mem.addFile(fileUri("/other/o.md"), "o");
    const index = new WorkspaceIndex(mem.host());

    let inFlightForAba = 0;
    let peakForAba = 0;
    let buildCalls = 0;
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    const enteredPromise = new Promise<void>((r) => { firstEntered = r; });
    let cancelledThrown = false;

    const handle = index.register({
      kind: "note",
      include: "**/*.md",
      debounceMs: 10,
      notReady: () => [] as string[],
      build: async (r, files, context) => {
        if (r === root) {
          buildCalls++;
          inFlightForAba++;
          peakForAba = Math.max(peakForAba, inFlightForAba);
          try {
            if (buildCalls === 1) {
              firstEntered();
              await firstGate;
              if (!context.isCurrent()) {
                cancelledThrown = true;
                throw new WorkspaceIndexBuildCancelled();
              }
            }
          } finally {
            inFlightForAba--;
          }
        }
        return files.map((f) => f.relativePath);
      },
    });

    const init = index.initialize();
    await enteredPromise;

    // Remove and immediately re-add the same root while old build is in flight.
    mem.workspaceSink!.rootsChanged([], [root]);
    mem.addFile(fileUri("/aba/b.md"), "b");
    mem.workspaceSink!.rootsChanged([root], []);
    await mem.advanceBy(0);

    // Wait until new incarnation finishes (old build was still blocked until releaseFirst).
    // Note: ScanQueue serializes per (kind, root), so new build waits for old build to yield/finish.
    assert.equal(peakForAba, 1);
    releaseFirst();
    await init;
    await index.whenSettled();
    assert.equal(cancelledThrown, true, "superseded build sees isCurrent() === false and throws WorkspaceIndexBuildCancelled");
    assert.equal(peakForAba, 1, "scans serialize per (kind, root)");
    assert.deepEqual(handle.snapshot(root), ["a.md", "b.md"]);
    assert.equal(handle.version(root), 1, "superseded old build must not bump version or publish");

    // AbortSignal propagation on findFiles and cooperative batch cancellation on handle.dispose() / removeRoot.
    await mem.advanceBy(30_000);
    const findGate = mem.holdFindFiles();
    handle.requestRefresh(root, "abort-check", true);
    await mem.advanceBy(0);
    await findGate.entered;
    const activeCall = mem.findFilesCalls.at(-1)!;
    assert.equal(activeCall.aborted, false);
    handle.dispose();
    assert.equal(activeCall.aborted, true, "dispose aborts in-flight findFiles AbortSignal");
    findGate.release();
    await index.whenSettled();
    assert.deepEqual(mem.errors, [], "cancelled scans never report errors");
    index.dispose();
  });

  await test("incremental paths reconciliation: direct-file fast path, subtree findFiles, missing entries, exclusions, no-ops, and indexedDirs", async () => {
    const root = fileUri("/C:/work");
    const mem = new MemoryHost([root]);
    mem.addFile(fileUri("/c:/work/docs.md/pixel.png"), "p");
    mem.addFile(fileUri("/c:/work/assets/keep.png"), "k");
    mem.addFile(fileUri("/c:/work/notes/base.md"), "b");
    mem.exclusionConfig.set("file\0/c:/work", {
      extra: ["**/ignored-extra/**"],
    });

    const index = new WorkspaceIndex(mem.host());
    const note = index.register({
      kind: "note",
      include: "**/*.md",
      exclude: "**/spec-only-skip/**",
      debounceMs: 5,
      notReady: () => [] as string[],
      build: async (_r, files) => files.map((f) => f.relativePath).sort(),
    });
    const image = index.register({
      kind: "image",
      include: "**/*.{png,jpg}",
      matchesPath: (rel) => /\.(png|jpe?g)$/i.test(rel),
      debounceMs: 5,
      notReady: () => [] as string[],
      build: async (_r, files) => files.map((f) => f.relativePath).sort(),
      patchSnapshot: async (_r, snap, patch) => {
        if (patch.mode === "content") return snap;
        const set = new Set(snap);
        for (const d of patch.deleted) set.delete(d.relativePath);
        for (const c of patch.changed) set.add(c.relativePath);
        return [...set].sort();
      },
    });

    await index.initialize();
    const initialFinds = mem.findFilesCalls.length;
    assert.deepEqual(image.snapshot(root), ["assets/keep.png", "docs.md/pixel.png"]);

    // 1. Direct-file directory fast path skips findFiles.
    const flatDir = fileUri("/C:/work/flat");
    mem.addDir(flatDir);
    mem.addFile(fileUri("/C:/work/flat/one.png"), "1");
    mem.addFile(fileUri("/C:/work/flat/note.md"), "n");
    mem.workspaceSink!.treeCreated(flatDir);
    await mem.advanceBy(5);
    await index.whenSettled();
    assert.equal(mem.findFilesCalls.length, initialFinds, "direct-file directory skips findFiles");
    assert.ok(image.snapshot(root)!.includes("flat/one.png"));
    assert.ok(note.snapshot(root)!.includes("flat/note.md"));

    // 2. Nested directory invokes subtree findFiles.
    const nestedDir = fileUri("/C:/work/nested");
    mem.addDir(nestedDir);
    mem.addDir(fileUri("/C:/work/nested/sub"));
    mem.addFile(fileUri("/C:/work/nested/sub/deep.md"), "d");
    mem.workspaceSink!.treeCreated(nestedDir);
    await mem.advanceBy(5);
    await index.whenSettled();
    assert.ok(mem.findFilesCalls.length > initialFinds, "nested directory invokes subtree findFiles");
    assert.ok(note.snapshot(root)!.includes("nested/sub/deep.md"));

    // 3. Empty/excluded directory or unrelated file causes zero snapshot/version churn.
    const beforeNoteVer = note.version(root);
    const beforeImageVer = image.version(root);
    const beforeNoteSnap = note.snapshot(root);
    const emptyDir = fileUri("/C:/work/empty-dir");
    mem.addDir(emptyDir);
    mem.workspaceSink!.treeCreated(emptyDir);
    mem.workspaceSink!.treeCreated(fileUri("/C:/work/.git/config.md"));
    mem.workspaceSink!.treeCreated(fileUri("/C:/work/ignored-extra/x.md"));
    mem.workspaceSink!.treeCreated(fileUri("/C:/work/spec-only-skip/x.md"));
    mem.addFile(fileUri("/C:/work/spec-only-skip/x.png"), "x");
    mem.watchedSpecs.get("image")!.sink.created(fileUri("/C:/work/spec-only-skip/x.png"));
    await mem.advanceBy(5);
    await index.whenSettled();
    assert.equal(note.version(root), beforeNoteVer, "no-op keeps note version");
    assert.equal(note.snapshot(root), beforeNoteSnap, "no-op keeps exact snapshot reference");
    assert.equal(image.version(root), beforeImageVer + 1, "spec.exclude applies only to that spec");
    assert.ok(image.snapshot(root)!.includes("spec-only-skip/x.png"));

    // 4. Directory named docs.md/ deleted with uppercase drive letter still invalidates image via indexedDirs!
    mem.removeDir(fileUri("/c:/work/docs.md"));
    mem.workspaceSink!.treeDeleted(fileUri("/C:/work/docs.md"));
    await mem.advanceBy(5);
    await index.whenSettled();
    assert.equal(image.snapshot(root)!.includes("docs.md/pixel.png"), false);

    // 5. Missing stat entry during paths reconciliation removes stale files cleanly without error.
    const vanished = fileUri("/C:/work/flat/note.md");
    mem.removeFile(vanished);
    mem.watchedSpecs.get("note")!.sink.created(vanished);
    await mem.advanceBy(5);
    await index.whenSettled();
    assert.equal(note.snapshot(root)!.includes("flat/note.md"), false);
    assert.deepEqual(mem.errors, []);

    // 6. exclusionsChanged clears cached exclusion policy and refreshes after cooldown/debounce.
    mem.addFile(fileUri("/C:/work/.git/now-included.md"), "g");
    mem.exclusionConfig.set("file\0/c:/work", { excludes: [] });
    mem.workspaceSink!.exclusionsChanged();
    await mem.advanceBy(30_000);
    await index.whenSettled();
    assert.ok(note.snapshot(root)!.includes(".git/now-included.md"));

    // 7. Unrelated treeDeleted after first scan is ignored; handle.kind and listener.dispose() work.
    assert.equal(note.kind, "note");
    const listenerEvents: WorkspaceIndexRefreshEvent<TestUri>[] = [];
    const sub = note.onDidRefresh((e) => listenerEvents.push(e));
    sub.dispose();
    const noteVerBeforeUnrelated = note.version(root);
    mem.workspaceSink!.treeDeleted(fileUri("/C:/work/unrelated.txt"));
    await mem.advanceBy(5);
    await index.whenSettled();
    assert.equal(note.version(root), noteVerBeforeUnrelated);
    assert.equal(listenerEvents.length, 0);
    index.dispose();
  });

  await test("paths patchSnapshot returning undefined falls back to spec.build without root findFiles, and pre-scan unavailable deletions stay conservative", async () => {
    const root = fileUri("/conservative");
    const mem = new MemoryHost([root]);
    mem.addFile(fileUri("/conservative/keep.md"), "k");
    const goneInDir = fileUri("/conservative/transient-dir/gone.md");
    mem.addFile(goneInDir, "g");
    const gate = mem.holdFindFiles();
    const index = new WorkspaceIndex(mem.host());
    let buildCalls = 0;
    const handle = index.register({
      kind: "note",
      include: "**/*.md",
      debounceMs: 5,
      notReady: () => [] as string[],
      build: async (_r, files) => {
        buildCalls++;
        return files.map((f) => f.relativePath).sort();
      },
      patchSnapshot: async () => undefined,
    });
    const init = index.initialize();
    await gate.entered;
    // Deletion of a directory before first scan completes queues conservative follow-up without cancelling initial scan.
    mem.removeDir(fileUri("/conservative/transient-dir"));
    mem.workspaceSink!.treeDeleted(fileUri("/conservative/transient-dir"));
    assert.equal(mem.findFilesCalls[0].aborted, false);
    gate.release();
    await init;
    assert.deepEqual(handle.snapshot(root), ["keep.md", "transient-dir/gone.md"]);
    await mem.advanceBy(5);
    await index.whenSettled();
    assert.equal(buildCalls, 2);
    assert.deepEqual(handle.snapshot(root), ["keep.md"]);

    // Subsequent paths event whose patchSnapshot returns undefined rebuilds via spec.build with zero extra findFiles.
    const findsBeforePatchFallback = mem.findFilesCalls.length;
    const extra = fileUri("/conservative/extra.md");
    mem.addFile(extra, "e");
    mem.watchedSpecs.get("note")!.sink.created(extra);
    await mem.advanceBy(5);
    await index.whenSettled();
    assert.equal(mem.findFilesCalls.length, findsBeforePatchFallback);
    assert.deepEqual(handle.snapshot(root), ["extra.md", "keep.md"]);
    index.dispose();
  });

  await test("30s full-scan rate limiting (incl. content fallback), 5s ensureFresh + force, error recovery, notices, and whenSettled", async () => {
    const root = fileUri("/home/alice");
    const mem = new MemoryHost([root]);
    mem.setHome(fileUri("/home/alice"));
    mem.addFile(fileUri("/home/alice/a.md"), "a");
    mem.addFile(fileUri("/home/alice/b.md"), "b");
    mem.addFile(fileUri("/home/alice/c.md"), "c");

    const index = new WorkspaceIndex(mem.host());
    let failNextBuild = false;
    let contentReturnsUndefined = true;
    let maxFilesLimit = 100;
    const handle = index.register({
      kind: "note",
      include: "**/*.md",
      debounceMs: 10,
      watchContent: true,
      maxFiles: () => maxFilesLimit,
      notReady: () => [] as string[],
      build: async (_r, files) => {
        if (failNextBuild) throw new Error("boom");
        return files.map((f) => f.relativePath).sort();
      },
      patchSnapshot: async (_r, snap, patch) => {
        if (patch.mode === "content" && contentReturnsUndefined) return undefined;
        if (patch.mode === "content") return ["patched"];
        const set = new Set(snap);
        for (const d of patch.deleted) set.delete(d.relativePath);
        for (const c of patch.changed) set.add(c.relativePath);
        return [...set].sort();
      },
    });

    await index.initialize();
    assert.equal(mem.notices.length, 1);
    assert.deepEqual(mem.notices[0], { kind: "home-root", root });
    const findsAfterInit = mem.findFilesCalls.length;
    assert.equal(findsAfterInit, 1);

    // Content patch returning undefined falls back to full scan, rate-limited at 30_000ms.
    mem.watchedSpecs.get("note")!.sink.changed(fileUri("/home/alice/a.md"));
    await mem.advanceBy(10);
    // whenSettled must NOT hang on the 30s cooldown timer!
    await index.whenSettled();
    assert.equal(mem.findFilesCalls.length, 1, "patch-fallback respects 30s rate limit");

    // Repeated manual full refreshes coalesce onto the one trailing timer.
    handle.requestRefresh(root, "manual-1", true);
    handle.requestRefresh(root, "manual-2", true);
    await mem.advanceBy(29_989);
    assert.equal(mem.findFilesCalls.length, 1);
    await mem.advanceBy(1);
    await index.whenSettled();
    assert.equal(mem.findFilesCalls.length, 2, "one coalesced full scan runs at 30_000ms boundary");

    // ensureFresh 5s staleness window + explicit force.
    handle.ensureFresh(fileUri("/home/alice/a.md"), "webview-ready");
    await mem.advanceBy(10);
    await index.whenSettled();
    assert.equal(mem.findFilesCalls.length, 2, "fresh snapshot within 5s skips");

    await mem.advanceBy(5_000);
    // Inside 30s full-scan cooldown, ensureFresh schedules onto cooldown; advance remaining 25s to verify it fired.
    handle.ensureFresh(fileUri("/home/alice/a.md"), "webview-ready");
    await mem.advanceBy(25_000);
    await index.whenSettled();
    assert.equal(mem.findFilesCalls.length, 3, "stale snapshot >= 5s refreshes");

    // Error recovery: unexpected error transitions to failed, retains prior snapshot/version, calls onError, and recovers.
    await mem.advanceBy(30_000);
    const priorSnap = handle.snapshot(root);
    const priorVer = handle.version(root);
    failNextBuild = true;
    handle.requestRefresh(root, "fail-me", true);
    await mem.advanceBy(0);
    await index.whenSettled();
    assert.equal(mem.errors.length, 1);
    assert.equal(handle.snapshot(root), priorSnap, "failed build keeps prior snapshot");
    assert.equal(handle.version(root), priorVer, "failed build keeps prior version");

    // Recovery via ensureFresh (status === "failed" bypasses 5s window).
    failNextBuild = false;
    mem.addFile(fileUri("/home/alice/d.md"), "d");
    handle.ensureFresh(fileUri("/home/alice/a.md"), "recover");
    await mem.advanceBy(10);
    await index.whenSettled();
    assert.deepEqual(handle.snapshot(root), ["a.md", "b.md", "c.md", "d.md"]);

    // Force ensureFresh during flight queues one follow-up, non-force dedupes.
    await mem.advanceBy(30_000);
    const hold = mem.holdFindFiles();
    handle.requestRefresh(root, "held", true);
    await mem.advanceBy(0);
    await hold.entered;
    handle.ensureFresh(fileUri("/home/alice/a.md"), "non-force-dedupe");
    handle.ensureFresh(fileUri("/home/alice/a.md"), "forced-followup", { force: true });
    hold.release();
    await index.whenSettled();
    // Since full scan 6 just completed, forced follow-up waits 30s cooldown.
    await mem.advanceBy(30_000);
    await index.whenSettled();
    assert.equal(mem.findFilesCalls.length, 7);

    // Cap-reached notice on a separate root: capped partial snapshot stays ready and skips future ensureFresh retries.
    maxFilesLimit = 5;
    const cappedRoot = fileUri("/capped");
    mem.addFile(fileUri("/capped/1.md"), "1");
    mem.addFile(fileUri("/capped/2.md"), "2");
    mem.addFile(fileUri("/capped/3.md"), "3");
    mem.addFile(fileUri("/capped/4.md"), "4");
    mem.addFile(fileUri("/capped/5.md"), "5");
    mem.addFile(fileUri("/capped/6.md"), "6");
    mem.workspaceSink!.rootsChanged([cappedRoot], []);
    await mem.advanceBy(0);
    await index.whenSettled();
    assert.equal(handle.snapshot(cappedRoot)?.length, 5);
    assert.deepEqual(mem.notices.at(-1), { kind: "cap-reached", root: cappedRoot, maxFiles: 5 });
    const noticeCountBeforeDuplicate = mem.notices.length;
    // Register a second spec that also hits cap on /capped -> still only once-per-root notice.
    const secondCapSpec = index.register({
      kind: "note-copy",
      include: "**/*.md",
      maxFiles: () => 5,
      notReady: () => [] as string[],
      build: async (_r, files) => files.map((f) => f.relativePath),
    });
    await mem.advanceBy(0);
    await index.whenSettled();
    assert.equal(mem.notices.length, noticeCountBeforeDuplicate, "notices remain once-per-root across specs");
    secondCapSpec.dispose();
    const findsBeforeCappedEnsure = mem.findFilesCalls.length;
    await mem.advanceBy(40_000);
    handle.ensureFresh(fileUri("/capped/1.md"), "attachment-saved", { force: true });
    await mem.advanceBy(100);
    await index.whenSettled();
    assert.equal(mem.findFilesCalls.length, findsBeforeCappedEnsure, "capped root skips future ensureFresh retries");

    // Re-adding home root does not re-emit home-root notice.
    maxFilesLimit = 100;
    const noticesBeforeReAddHome = mem.notices.length;
    mem.workspaceSink!.rootsChanged([], [root]);
    mem.workspaceSink!.rootsChanged([root], []);
    await mem.advanceBy(0);
    await index.whenSettled();
    assert.equal(mem.notices.length, noticesBeforeReAddHome, "home-root notice remains once-per-root");

    // Unexpected stat error in paths reconciliation fails cleanly, calls onError, keeps snapshot, and recovers.
    const snapBeforeStatErr = handle.snapshot(root);
    const verBeforeStatErr = handle.version(root);
    mem.statError = new Error("EACCES");
    mem.watchedSpecs.get("note")!.sink.created(fileUri("/home/alice/err.md"));
    await mem.advanceBy(10);
    await index.whenSettled();
    assert.equal(mem.errors.length, 2);
    assert.equal(handle.snapshot(root), snapBeforeStatErr);
    assert.equal(handle.version(root), verBeforeStatErr);
    mem.statError = undefined;
    mem.addFile(fileUri("/home/alice/recovered.md"), "ok");
    mem.watchedSpecs.get("note")!.sink.created(fileUri("/home/alice/recovered.md"));
    await mem.advanceBy(10);
    await index.whenSettled();
    assert.ok(handle.snapshot(root)!.includes("recovered.md"));

    // whenSettled awaits active routeCreatedUri (stat gate) before resolving.
    const statGate = mem.holdStat();
    const slowFile = fileUri("/home/alice/slow.md");
    mem.addFile(slowFile, "s");
    mem.workspaceSink!.treeCreated(slowFile);
    let settledFlag = false;
    const settledP = index.whenSettled().then(() => { settledFlag = true; });
    await statGate.entered;
    await mem.flushMicrotasks();
    assert.equal(settledFlag, false, "whenSettled waits on active stat routing");
    statGate.release();
    await mem.advanceBy(20);
    await settledP;
    assert.equal(settledFlag, true);
    assert.ok(handle.snapshot(root)!.includes("slow.md"));

    index.dispose();
  });

  await test("directory deletion and rename routing matrix across drive casing, segment boundaries, and non-file schemes", async () => {
    const matrix = [
      { name: "same-case directory", scan: "/C:/work/assets", event: "/C:/work/assets", affected: true },
      { name: "lowercase scan + uppercase deletion", scan: "/c:/work/assets", event: "/C:/work/assets", affected: true },
      { name: "uppercase scan + lowercase deletion", scan: "/C:/work/assets", event: "/c:/work/assets", affected: true },
      { name: "ancestor deletion", scan: "/c:/work/assets/nested", event: "/C:/work/assets", affected: true },
      { name: "unrelated deletion", scan: "/c:/work/assets", event: "/C:/work/other", affected: false },
      { name: "segment boundary", scan: "/c:/work/assets-extra", event: "/C:/work/assets", affected: false },
      { name: "directory case preserved", scan: "/C:/work/Assets", event: "/c:/work/assets", affected: false },
      { name: "custom scheme matching case", scheme: "custom", root: "/", scan: "/C:/work/assets", event: "/C:/work/assets", affected: true },
      { name: "custom scheme drive case preserved", scheme: "custom", root: "/", scan: "/C:/work/assets", event: "/c:/work/assets", affected: false },
    ];

    for (const c of matrix) {
      const uri = (p: string) => makeUri(c.scheme ?? "file", p);
      const root = uri(c.root ?? "/C:/work");
      const mem = new MemoryHost([root]);
      const target = uri(`${c.scan}/pixel.png`);
      mem.addFile(target, "img");
      const index = new WorkspaceIndex(mem.host());
      const handle = index.register({
        kind: "image",
        include: "**/*.png",
        debounceMs: 5,
        notReady: () => [] as string[],
        build: async (_r, files) => files.map((f) => f.relativePath),
      });
      await index.initialize();
      assert.equal(handle.snapshot(root)?.length, 1, c.name);
      const beforeVer = handle.version(root);
      const beforeFinds = mem.findFilesCalls.length;
      mem.removeDir(uri(c.event));
      mem.workspaceSink!.treeDeleted(uri(c.event), "tree-delete");
      await mem.advanceBy(5);
      await index.whenSettled();
      assert.equal(mem.findFilesCalls.length, beforeFinds, `${c.name}: deletion needs no findFiles`);
      assert.equal(handle.snapshot(root)?.length, c.affected ? 0 : 1, c.name);
      assert.equal(handle.version(root), c.affected ? beforeVer + 1 : beforeVer, c.name);
      index.dispose();
    }
  });

  await test("regression guards: subtree globs, watchSpec matchesPath filtering, cancellation after subtree findFiles, unstranded cooldowns, and exact maxFiles fit", async () => {
    // 1. Subtree findFiles preserves root-relative spec.include & matchesPath, and watchSpec changed ignores matchesPath misses.
    {
      const root = fileUri("/work");
      const mem = new MemoryHost([root]);
      mem.addFile(fileUri("/work/docs/a.md"), "a");
      mem.addFile(fileUri("/work/docs/draft.md"), "draft");
      mem.addFile(fileUri("/work/root.md"), "r");
      const index = new WorkspaceIndex(mem.host());
      let docsBuilds = 0;
      let patchCalls = 0;
      const docs = index.register({
        kind: "docs",
        include: "docs/**/*.md",
        matchesPath: (rel) => !rel.endsWith("draft.md"),
        watchContent: true,
        debounceMs: 10,
        notReady: () => [] as string[],
        build: async (_r, files) => {
          docsBuilds++;
          return files.map((f) => f.relativePath).sort();
        },
        patchSnapshot: async (_r, snap, patch) => {
          patchCalls++;
          if (patch.mode === "content") {
            for (const f of patch.changed) if (!snap.includes(f.relativePath)) return undefined;
            return [...snap];
          }
          const next = new Set(snap);
          for (const d of patch.deleted) next.delete(d.relativePath);
          for (const c of patch.changed) next.add(c.relativePath);
          return [...next].sort();
        },
      });
      const rootOnly = index.register({
        kind: "root-only",
        include: "*.md",
        debounceMs: 10,
        notReady: () => [] as string[],
        build: async (_r, files) => files.map((f) => f.relativePath).sort(),
      });
      await index.initialize();
      assert.deepEqual(docs.snapshot(root), ["docs/a.md"]);
      assert.deepEqual(rootOnly.snapshot(root), ["root.md"]);

      mem.addDir(fileUri("/work/docs/nested"));
      mem.addDir(fileUri("/work/docs/nested/sub"));
      mem.addFile(fileUri("/work/docs/nested/sub/guide.md"), "g");
      mem.workspaceSink!.treeCreated(fileUri("/work/docs/nested"));
      mem.addDir(fileUri("/work/nested"));
      mem.addDir(fileUri("/work/nested/sub"));
      mem.addFile(fileUri("/work/nested/leak.md"), "l");
      mem.workspaceSink!.treeCreated(fileUri("/work/nested"));
      await mem.advanceBy(10);
      await index.whenSettled();
      assert.deepEqual(docs.snapshot(root), ["docs/a.md", "docs/nested/sub/guide.md"]);
      assert.deepEqual(rootOnly.snapshot(root), ["root.md"]);

      const verBefore = docs.version(root);
      await mem.advanceBy(30_000);
      mem.watchedSpecs.get("docs")!.sink.changed(fileUri("/work/docs/draft.md"));
      await mem.advanceBy(10);
      await index.whenSettled();
      assert.equal(patchCalls, 1, "changed draft.md must not enter content patchSnapshot");
      assert.equal(docsBuilds, 1, "changed draft.md must not trigger full rebuild");
      assert.equal(docs.version(root), verBefore);
      index.dispose();
    }

    // 2. Aborting subtree findFiles during reconcilePaths does not treat cancellation as no-op or invoke stale build.
    {
      const root = fileUri("/work");
      let wsSink!: WorkspaceIndexWorkspaceSink<TestUri>;
      let releaseFind!: () => void;
      let enteredFind!: () => void;
      const findGate = new Promise<void>((r) => { releaseFind = r; });
      const findEntered = new Promise<void>((r) => { enteredFind = r; });
      let phase: "init" | "reconcile" = "init";
      let buildCalls = 0;
      const index = new WorkspaceIndex({
        workspaceFolders: () => [root],
        stat: async (uri) => (uri.path === "/work/dir" ? "directory" : "missing"),
        readDirectory: async () => [{ name: "sub", uri: fileUri("/work/dir/sub"), type: "directory" }],
        findFiles: async (_b, _i, _e, _m, signal) => {
          if (phase === "init") return [fileUri("/work/dir/sub/old.md")];
          enteredFind();
          await findGate;
          // Resolve [] on cancel just like VS Code workspace.findFiles.
          return signal.aborted ? [] : [fileUri("/work/dir/sub/old.md")];
        },
        readFile: async () => new Uint8Array(),
        watchWorkspace: (s) => { wsSink = s; return { dispose() {} }; },
      });
      const handle = index.register({
        kind: "note",
        include: "**/*.md",
        debounceMs: 1,
        notReady: () => [] as string[],
        build: async (_r, files) => {
          buildCalls++;
          return files.map((f) => f.relativePath);
        },
      });
      await index.initialize();
      phase = "reconcile";
      wsSink.treeCreated(fileUri("/work/dir"));
      await findEntered;
      handle.dispose();
      releaseFind();
      await index.whenSettled();
      assert.equal(buildCalls, 1);
      index.dispose();
    }

    // 3. Forced full refresh arriving mid-flight after cooldown does not strand "full" in pending.
    {
      const root = fileUri("/work");
      const mem = new MemoryHost([root]);
      mem.addFile(fileUri("/work/a.md"), "a");
      const index = new WorkspaceIndex(mem.host());
      const handle = index.register({
        kind: "note",
        include: "**/*.md",
        debounceMs: 10,
        notReady: () => [] as string[],
        build: async (_r, files) => files.map((f) => f.relativePath).sort(),
      });
      await index.initialize();
      await mem.advanceBy(30_000);
      const hold = mem.holdFindFiles();
      handle.requestRefresh(root, "held", true);
      await mem.advanceBy(0);
      await hold.entered;
      handle.ensureFresh(fileUri("/work/a.md"), "forced", { force: true });
      hold.release();
      await index.whenSettled();
      mem.addFile(fileUri("/work/new-during-cooldown.md"), "new");
      mem.watchedSpecs.get("note")!.sink.created(fileUri("/work/new-during-cooldown.md"));
      await mem.advanceBy(10);
      await index.whenSettled();
      assert.deepEqual(handle.snapshot(root), ["a.md", "new-during-cooldown.md"]);
      const findsBeforeCooldown = mem.findFilesCalls.length;
      await mem.advanceBy(30_000);
      await index.whenSettled();
      assert.equal(mem.findFilesCalls.length, findsBeforeCooldown + 1);
      index.dispose();
    }

    // 4. Exact maxFiles fit (count === cap) does not trigger cap-reached notice or suppress ensureFresh.
    {
      const root = fileUri("/work");
      const mem = new MemoryHost([root]);
      mem.addFile(fileUri("/work/1.md"), "1");
      mem.addFile(fileUri("/work/2.md"), "2");
      const index = new WorkspaceIndex(mem.host());
      const handle = index.register({
        kind: "note",
        include: "**/*.md",
        maxFiles: () => 2,
        notReady: () => [] as string[],
        build: async (_r, files) => files.map((f) => f.relativePath).sort(),
      });
      await index.initialize();
      assert.deepEqual(mem.notices, []);
      assert.deepEqual(handle.snapshot(root), ["1.md", "2.md"]);
      await mem.advanceBy(30_000);
      handle.ensureFresh(fileUri("/work/1.md"), "attachment-saved", { force: true });
      await mem.advanceBy(100);
      await index.whenSettled();
      assert.equal(mem.findFilesCalls.length, 2);
      index.dispose();
    }
  });

  finished = true;
  if (failures > 0) process.exitCode = 1;
}

let finished = false;
process.on("beforeExit", () => {
  if (!finished) {
    console.error("  ✗ workspaceIndexing tests hung / exited early before finishing all cases");
    process.exitCode = 1;
  }
});

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
