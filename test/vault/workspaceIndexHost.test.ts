import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import {
  createVscodeWorkspaceIndex,
  createVscodeWorkspaceIndexHost,
  type VscodeWorkspaceIndexApi,
} from "../../src/extension/vault/workspaceIndexHost";

interface FakeUri {
  readonly scheme: string;
  readonly path: string;
  readonly fsPath: string;
  toString(): string;
}

function makeFakeUri(scheme: string, path: string, fsPath = path): FakeUri {
  return {
    scheme,
    path,
    fsPath,
    toString() {
      return `${scheme}://${path}`;
    },
  };
}

class FakeEventEmitter<T> {
  private readonly listeners = new Set<(e: T) => void>();
  readonly event: vscode.Event<T> = (listener) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeRelativePattern {
  constructor(readonly base: FakeUri, readonly pattern: string) {}
}

class FakeCancellationTokenSource {
  cancelled = false;
  disposed = false;
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: new FakeEventEmitter<unknown>().event,
  } as unknown as vscode.CancellationToken;
  cancel(): void {
    this.cancelled = true;
    (this.token as { isCancellationRequested: boolean }).isCancellationRequested = true;
  }
  dispose(): void {
    this.disposed = true;
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
  const root = mkdtempSync(join(tmpdir(), "flintmark-host-"));
  try {
    await test("file: scheme uses local node:fs/promises for stat, readDirectory, and readFile without provider IPC", async () => {
      let providerCalls = 0;
      const messages: string[] = [];
      const api: VscodeWorkspaceIndexApi<FakeUri> = {
        Uri: {
          file: (p) => makeFakeUri("file", p, p),
          joinPath: (base, ...parts) =>
            makeFakeUri(
              base.scheme,
              `${base.path.replace(/\/$/, "")}/${parts.join("/")}`,
              join(base.fsPath, ...parts)
            ),
        },
        FileType: { Unknown: 0, File: 1, Directory: 2 },
        RelativePattern: FakeRelativePattern as unknown as VscodeWorkspaceIndexApi<FakeUri>["RelativePattern"],
        CancellationTokenSource: FakeCancellationTokenSource as unknown as VscodeWorkspaceIndexApi<FakeUri>["CancellationTokenSource"],
        window: {
          showInformationMessage: async (msg) => {
            messages.push(msg);
            return undefined;
          },
        },
        workspace: {
          workspaceFolders: [],
          fs: {
            stat: async () => {
              providerCalls++;
              throw new Error("provider stat must not run for file:");
            },
            readDirectory: async () => {
              providerCalls++;
              throw new Error("provider readDirectory must not run for file:");
            },
            readFile: async () => {
              providerCalls++;
              throw new Error("provider readFile must not run for file:");
            },
          },
          findFiles: async () => [],
          getConfiguration: () => ({ get: () => undefined }),
          createFileSystemWatcher: () => ({
            onDidCreate: new FakeEventEmitter<FakeUri>().event,
            onDidChange: new FakeEventEmitter<FakeUri>().event,
            onDidDelete: new FakeEventEmitter<FakeUri>().event,
            dispose: () => {},
          }),
          onDidRenameFiles: new FakeEventEmitter<{ readonly files: readonly { readonly oldUri: FakeUri; readonly newUri: FakeUri }[] }>().event,
          onDidCreateFiles: new FakeEventEmitter<{ readonly files: readonly FakeUri[] }>().event,
          onDidDeleteFiles: new FakeEventEmitter<{ readonly files: readonly FakeUri[] }>().event,
          onDidChangeWorkspaceFolders: new FakeEventEmitter<{ readonly added: readonly { readonly uri: FakeUri }[]; readonly removed: readonly { readonly uri: FakeUri }[] }>().event,
          onDidChangeConfiguration: new FakeEventEmitter<{ affectsConfiguration(section: string): boolean }>().event,
        },
      };

      const localDir = join(root, "local-vault");
      const subDir = join(localDir, "sub");
      mkdirSync(subDir, { recursive: true });
      const file = join(localDir, "note % space-λ.md");
      const bytes = Buffer.from("# Note\r\n\r\nUnicode: λ\r\n\0", "utf8");
      writeFileSync(file, bytes);

      const host = createVscodeWorkspaceIndexHost(api);
      assert.equal(await host.stat(makeFakeUri("file", localDir, localDir)), "directory");
      assert.equal(await host.stat(makeFakeUri("file", file, file)), "file");
      assert.equal(await host.stat(makeFakeUri("file", join(localDir, "missing.md"))), "missing");

      const entries = await host.readDirectory(makeFakeUri("file", localDir, localDir));
      assert.notEqual(entries, "missing");
      if (entries === "missing") throw new Error("expected entries");
      const byName = new Map(entries.map((e) => [e.name, e]));
      assert.equal(byName.get("sub")?.type, "directory");
      assert.equal(byName.get("note % space-λ.md")?.type, "file");
      assert.equal(byName.get("note % space-λ.md")?.uri.fsPath, file);
      assert.equal(await host.readDirectory(makeFakeUri("file", join(localDir, "nope"))), "missing");
      await assert.rejects(host.readDirectory(makeFakeUri("file", file, file)), { code: "ENOTDIR" });

      const actualBytes = await host.readFile(makeFakeUri("file", file, file));
      assert.deepEqual(Buffer.from(actualBytes), bytes);
      await assert.rejects(host.readFile(makeFakeUri("file", join(localDir, "missing.md"))), { code: "ENOENT" });
      assert.equal(providerCalls, 0);
      assert.equal(host.homeDirectory?.()?.fsPath, homedir());
    });

    await test("non-file schemes dispatch to provider fs, map FileNotFound/ENOENT to missing, and propagate unexpected errors", async () => {
      const localDecoy = join(root, "decoy.md");
      writeFileSync(localDecoy, "local decoy");
      const remoteBytes = Uint8Array.from([239, 187, 191, 65, 13, 10]);
      const unexpectedErr = new Error("provider offline");
      let mode: "ok" | "file-not-found" | "enoent" | "error" = "ok";

      const api: VscodeWorkspaceIndexApi<FakeUri> = {
        Uri: {
          file: (p) => makeFakeUri("file", p, p),
          joinPath: (base, ...parts) =>
            makeFakeUri(base.scheme, `${base.path.replace(/\/$/, "")}/${parts.join("/")}`),
        },
        FileType: { Unknown: 0, File: 1, Directory: 2 },
        RelativePattern: FakeRelativePattern as unknown as VscodeWorkspaceIndexApi<FakeUri>["RelativePattern"],
        CancellationTokenSource: FakeCancellationTokenSource as unknown as VscodeWorkspaceIndexApi<FakeUri>["CancellationTokenSource"],
        window: { showInformationMessage: async () => undefined },
        workspace: {
          workspaceFolders: [],
          fs: {
            stat: async (uri) => {
              assert.notEqual(uri.scheme, "file");
              if (mode === "file-not-found") throw Object.assign(new Error("missing"), { code: "FileNotFound" });
              if (mode === "enoent") throw Object.assign(new Error("missing"), { code: "ENOENT" });
              if (mode === "error") throw unexpectedErr;
              return { type: uri.path.endsWith(".md") ? 1 : 2 };
            },
            readDirectory: async (uri) => {
              assert.notEqual(uri.scheme, "file");
              if (mode === "file-not-found") throw Object.assign(new Error("missing"), { code: "FileNotFound" });
              if (mode === "enoent") throw Object.assign(new Error("missing"), { code: "ENOENT" });
              if (mode === "error") throw unexpectedErr;
              return [["child.md", 1], ["sub", 2], ["link", 0]];
            },
            readFile: async (uri) => {
              assert.notEqual(uri.scheme, "file");
              if (mode === "error") throw unexpectedErr;
              return remoteBytes;
            },
          },
          findFiles: async () => [],
          getConfiguration: () => ({ get: () => undefined }),
          createFileSystemWatcher: () => ({
            onDidCreate: new FakeEventEmitter<FakeUri>().event,
            onDidChange: new FakeEventEmitter<FakeUri>().event,
            onDidDelete: new FakeEventEmitter<FakeUri>().event,
            dispose: () => {},
          }),
          onDidRenameFiles: new FakeEventEmitter<{ readonly files: readonly { readonly oldUri: FakeUri; readonly newUri: FakeUri }[] }>().event,
          onDidCreateFiles: new FakeEventEmitter<{ readonly files: readonly FakeUri[] }>().event,
          onDidDeleteFiles: new FakeEventEmitter<{ readonly files: readonly FakeUri[] }>().event,
          onDidChangeWorkspaceFolders: new FakeEventEmitter<{ readonly added: readonly { readonly uri: FakeUri }[]; readonly removed: readonly { readonly uri: FakeUri }[] }>().event,
          onDidChangeConfiguration: new FakeEventEmitter<{ affectsConfiguration(section: string): boolean }>().event,
        },
      };

      const host = createVscodeWorkspaceIndexHost(api);
      for (const scheme of ["vscode-remote", "memfs", "custom"]) {
        const fileUri = makeFakeUri(scheme, localDecoy, localDecoy);
        const dirUri = makeFakeUri(scheme, root, root);
        mode = "ok";
        assert.equal(await host.stat(fileUri), "file");
        assert.equal(await host.stat(dirUri), "directory");
        const entries = await host.readDirectory(dirUri);
        assert.deepEqual(
          entries === "missing" ? [] : entries.map((e) => [e.name, e.type, e.uri.scheme]),
          [
            ["child.md", "file", scheme],
            ["sub", "directory", scheme],
            ["link", "unknown", scheme],
          ]
        );
        assert.equal(await host.readFile(fileUri), remoteBytes);

        mode = "file-not-found";
        assert.equal(await host.stat(fileUri), "missing");
        assert.equal(await host.readDirectory(dirUri), "missing");

        mode = "enoent";
        assert.equal(await host.stat(fileUri), "missing");
        assert.equal(await host.readDirectory(dirUri), "missing");

        mode = "error";
        await assert.rejects(host.stat(fileUri), (err) => err === unexpectedErr);
        await assert.rejects(host.readDirectory(dirUri), (err) => err === unexpectedErr);
        await assert.rejects(host.readFile(fileUri), (err) => err === unexpectedErr);
      }
    });

    await test("findFiles bridges AbortSignal, exclusions read VS Code config, notices format cleanly, and watchers subscribe/dispose", async () => {
      const folderUri = makeFakeUri("file", root);
      const tokenSources: FakeCancellationTokenSource[] = [];
      class TrackingCts extends FakeCancellationTokenSource {
        constructor() {
          super();
          tokenSources.push(this);
        }
      }
      const notices: string[] = [];
      const watcherDisposed: string[] = [];
      const treeCreated = new FakeEventEmitter<FakeUri>();
      const treeDeleted = new FakeEventEmitter<FakeUri>();
      const specCreated = new FakeEventEmitter<FakeUri>();
      const specChanged = new FakeEventEmitter<FakeUri>();
      const specDeleted = new FakeEventEmitter<FakeUri>();
      const renamed = new FakeEventEmitter<{ readonly files: readonly { readonly oldUri: FakeUri; readonly newUri: FakeUri }[] }>();
      const createdFiles = new FakeEventEmitter<{ readonly files: readonly FakeUri[] }>();
      const deletedFiles = new FakeEventEmitter<{ readonly files: readonly FakeUri[] }>();
      const foldersChanged = new FakeEventEmitter<{ readonly added: readonly { readonly uri: FakeUri }[]; readonly removed: readonly { readonly uri: FakeUri }[] }>();
      const configChanged = new FakeEventEmitter<{ affectsConfiguration(section: string): boolean }>();

      let releaseFind!: () => void;
      const findGate = new Promise<void>((r) => { releaseFind = r; });

      const api: VscodeWorkspaceIndexApi<FakeUri> = {
        Uri: {
          file: (p) => makeFakeUri("file", p, p),
          joinPath: (base, ...parts) =>
            makeFakeUri(base.scheme, `${base.path.replace(/\/$/, "")}/${parts.join("/")}`),
        },
        FileType: { Unknown: 0, File: 1, Directory: 2 },
        RelativePattern: FakeRelativePattern as unknown as VscodeWorkspaceIndexApi<FakeUri>["RelativePattern"],
        CancellationTokenSource: TrackingCts as unknown as VscodeWorkspaceIndexApi<FakeUri>["CancellationTokenSource"],
        window: {
          showInformationMessage: async (msg) => {
            notices.push(msg);
            return undefined;
          },
        },
        workspace: {
          workspaceFolders: [{ uri: folderUri }],
          fs: {
            stat: async () => ({ type: 1 }),
            readDirectory: async () => [],
            readFile: async () => new Uint8Array(),
          },
          findFiles: async (pattern, exclude, maxResults, token) => {
            assert.ok(pattern instanceof FakeRelativePattern);
            assert.equal(exclude, "**/skip/**");
            assert.equal(maxResults, 10);
            assert.equal(token?.isCancellationRequested, false);
            await findGate;
            assert.equal(token?.isCancellationRequested, true);
            return [];
          },
          getConfiguration: (_section, scope) => {
            assert.equal(scope, folderUri);
            return {
              get: (key: string, fallback?: unknown) => {
                if (key === "ofm.workspaceIndex.exclude") return ["private/**"];
                if (key === "files.watcherExclude") return { "**/generated/**": true, "**/allowed/**": false };
                if (key === "search.exclude") return { "**/search-hidden/**": true };
                return fallback;
              },
            };
          },
          createFileSystemWatcher: (glob) => {
            if (glob === "**/*") {
              return {
                onDidCreate: treeCreated.event,
                onDidChange: new FakeEventEmitter<FakeUri>().event,
                onDidDelete: treeDeleted.event,
                dispose: () => { watcherDisposed.push("**/*"); },
              };
            }
            return {
              onDidCreate: specCreated.event,
              onDidChange: specChanged.event,
              onDidDelete: specDeleted.event,
              dispose: () => { watcherDisposed.push(String(glob)); },
            };
          },
          onDidRenameFiles: renamed.event,
          onDidCreateFiles: createdFiles.event,
          onDidDeleteFiles: deletedFiles.event,
          onDidChangeWorkspaceFolders: foldersChanged.event,
          onDidChangeConfiguration: configChanged.event,
        },
      };

      const host = createVscodeWorkspaceIndexHost(api);
      assert.deepEqual(host.workspaceFolders(), [folderUri]);
      assert.deepEqual(host.exclusions?.(folderUri), {
        excludes: ["private/**"],
        extra: ["**/generated/**", "**/search-hidden/**"],
      });

      host.onNotice?.({ kind: "home-root", root: folderUri });
      host.onNotice?.({ kind: "cap-reached", root: folderUri, maxFiles: 123 });
      assert.match(notices[0], /home folder.*narrower folder/i);
      assert.match(notices[1], /123-file limit.*narrower folder/i);

      const abortController = new AbortController();
      const findPromise = host.findFiles(folderUri, "**/*.md", "**/skip/**", 10, abortController.signal);
      abortController.abort();
      releaseFind();
      await findPromise;
      assert.equal(tokenSources.length, 1);
      assert.equal(tokenSources[0].cancelled, true);
      assert.equal(tokenSources[0].disposed, true);

      const events: string[] = [];
      const wsSub = host.watchWorkspace?.({
        treeCreated: (u, r) => events.push(`tc:${r}:${u.path}`),
        treeDeleted: (u, r) => events.push(`td:${r}:${u.path}`),
        rootsChanged: (a, r) => events.push(`rc:+${a.length}:-${r.length}`),
        exclusionsChanged: () => events.push("ex"),
      });
      const specSub = host.watchSpec?.(
        { kind: "note", include: "**/*.md", watchContent: true },
        {
          created: (u) => events.push(`sc:${u.path}`),
          deleted: (u) => events.push(`sd:${u.path}`),
          changed: (u) => events.push(`sm:${u.path}`),
        }
      );

      treeCreated.fire(makeFakeUri("file", "/a"));
      treeDeleted.fire(makeFakeUri("file", "/b"));
      createdFiles.fire({ files: [makeFakeUri("file", "/c")] });
      deletedFiles.fire({ files: [makeFakeUri("file", "/d")] });
      renamed.fire({ files: [{ oldUri: makeFakeUri("file", "/e"), newUri: makeFakeUri("file", "/f") }] });
      foldersChanged.fire({ added: [folderUri], removed: [] });
      configChanged.fire({ affectsConfiguration: (s) => s === "editor.tabSize" });
      configChanged.fire({ affectsConfiguration: (s) => s === "search.exclude" });
      specCreated.fire(makeFakeUri("file", "/g.md"));
      specChanged.fire(makeFakeUri("file", "/h.md"));
      specDeleted.fire(makeFakeUri("file", "/i.md"));

      assert.deepEqual(events, [
        "tc:tree-create:/a",
        "td:tree-delete:/b",
        "tc:operation-create:/c",
        "td:operation-delete:/d",
        "td:rename-old:/e",
        "tc:rename-new:/f",
        "rc:+1:-0",
        "ex",
        "sc:/g.md",
        "sm:/h.md",
        "sd:/i.md",
      ]);

      wsSub?.dispose();
      specSub?.dispose();
      assert.deepEqual(watcherDisposed, ["**/*", "**/*.md"]);
      assert.equal(treeCreated.listenerCount, 0);
      assert.equal(specCreated.listenerCount, 0);
      assert.equal(configChanged.listenerCount, 0);

      // Smoke check createVscodeWorkspaceIndex wiring.
      const index = createVscodeWorkspaceIndex(api);
      index.dispose();
    });

    if (failures > 0) process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let finished = false;
process.on("beforeExit", () => {
  if (!finished) {
    console.error("  ✗ workspaceIndexHost tests exited early");
    process.exitCode = 1;
  }
});

void main()
  .then(() => { finished = true; })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
