import { readdir, readFile as readLocalFile, stat as statLocalPath } from "node:fs/promises";
import { homedir } from "node:os";
import type * as vscode from "vscode";
import {
  WorkspaceIndex,
  WorkspaceIndexBuildCancelled,
  type WorkspaceIndexDirectoryEntry,
  type WorkspaceIndexDisposable,
  type WorkspaceIndexEntryType,
  type WorkspaceIndexHost,
  type WorkspaceIndexStatType,
  type WorkspaceIndexUri,
} from "./workspaceIndexing";

export interface VscodeUriLike extends WorkspaceIndexUri {
  readonly fsPath: string;
}

export interface VscodeWorkspaceIndexApi<TUri extends VscodeUriLike = vscode.Uri> {
  readonly Uri: {
    file(path: string): TUri;
    joinPath(base: TUri, ...pathSegments: string[]): TUri;
  };
  readonly FileType: {
    readonly Unknown: number;
    readonly File: number;
    readonly Directory: number;
  };
  readonly RelativePattern: new (base: TUri, pattern: string) => vscode.RelativePattern;
  readonly CancellationTokenSource: new () => {
    readonly token: vscode.CancellationToken;
    cancel(): void;
    dispose(): void;
  };
  readonly window: {
    showInformationMessage(message: string): Thenable<string | undefined>;
  };
  readonly workspace: {
    readonly workspaceFolders: readonly { readonly uri: TUri }[] | undefined;
    readonly fs: {
      stat(uri: TUri): Thenable<{ readonly type: number }>;
      readDirectory(uri: TUri): Thenable<[string, number][]>;
      readFile(uri: TUri): Thenable<Uint8Array>;
    };
    findFiles(
      include: vscode.GlobPattern,
      exclude?: string | null,
      maxResults?: number,
      token?: vscode.CancellationToken
    ): Thenable<TUri[]>;
    getConfiguration(
      section?: string,
      scope?: vscode.ConfigurationScope | null
    ): {
      get<T>(section: string): T | undefined;
      get<T>(section: string, defaultValue: T): T;
    };
    createFileSystemWatcher(
      globPattern: vscode.GlobPattern,
      ignoreCreateEvents?: boolean,
      ignoreChangeEvents?: boolean,
      ignoreDeleteEvents?: boolean
    ): {
      onDidCreate: vscode.Event<TUri>;
      onDidChange: vscode.Event<TUri>;
      onDidDelete: vscode.Event<TUri>;
      dispose(): unknown;
    };
    onDidRenameFiles: vscode.Event<{
      readonly files: readonly { readonly oldUri: TUri; readonly newUri: TUri }[];
    }>;
    onDidCreateFiles: vscode.Event<{ readonly files: readonly TUri[] }>;
    onDidDeleteFiles: vscode.Event<{ readonly files: readonly TUri[] }>;
    onDidChangeWorkspaceFolders: vscode.Event<{
      readonly added: readonly { readonly uri: TUri }[];
      readonly removed: readonly { readonly uri: TUri }[];
    }>;
    onDidChangeConfiguration: vscode.Event<{
      affectsConfiguration(section: string): boolean;
    }>;
  };
}

const EXCLUSION_SECTIONS = [
  "ofm.workspaceIndex.exclude",
  "files.watcherExclude",
  "search.exclude",
] as const;

function loadVscode<TUri extends VscodeUriLike>(): VscodeWorkspaceIndexApi<TUri> {
  try {
    // Loaded dynamically so plain Node host tests can inject a fake runtime without vscode aliasing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("vscode") as VscodeWorkspaceIndexApi<TUri>;
  } catch {
    throw new Error("VS Code API is unavailable outside the extension host");
  }
}

function isMissingError(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "ENOENT" || code === "FileNotFound";
}

function classifyProviderType(
  fileType: number,
  fileTypes: { readonly File: number; readonly Directory: number }
): WorkspaceIndexEntryType {
  if ((fileType & fileTypes.Directory) !== 0) return "directory";
  if ((fileType & fileTypes.File) !== 0) return "file";
  return "unknown";
}

function disposeAll(disposables: readonly WorkspaceIndexDisposable[]): void {
  for (const disposable of disposables) disposable.dispose();
}

/** Create the VS Code + local `file:` filesystem host adapter for WorkspaceIndex. */
export function createVscodeWorkspaceIndexHost<TUri extends VscodeUriLike = vscode.Uri>(
  api?: VscodeWorkspaceIndexApi<TUri>
): WorkspaceIndexHost<TUri> {
  const runtime = api ?? loadVscode<TUri>();

  return {
    workspaceFolders: () => (runtime.workspace.workspaceFolders ?? []).map((folder) => folder.uri),
    homeDirectory: () => runtime.Uri.file(homedir()),
    exclusions: (root) => {
      const configuration = runtime.workspace.getConfiguration(
        undefined,
        root as unknown as vscode.ConfigurationScope
      );
      const configured = configuration.get<unknown>("ofm.workspaceIndex.exclude");
      const extra: string[] = [];
      for (const section of ["files.watcherExclude", "search.exclude"] as const) {
        const excludes = configuration.get<Record<string, unknown>>(section, {});
        if (!excludes) continue;
        for (const [pattern, enabled] of Object.entries(excludes)) {
          if (enabled === true) extra.push(pattern);
        }
      }
      return {
        excludes: Array.isArray(configured)
          ? configured.filter((pattern): pattern is string => typeof pattern === "string")
          : undefined,
        extra,
      };
    },
    stat: async (uri): Promise<WorkspaceIndexStatType> => {
      try {
        if (uri.scheme === "file") {
          const st = await statLocalPath(uri.fsPath);
          return st.isDirectory() ? "directory" : st.isFile() ? "file" : "unknown";
        }
        const st = await runtime.workspace.fs.stat(uri);
        return classifyProviderType(st.type, runtime.FileType);
      } catch (error) {
        if (isMissingError(error)) return "missing";
        throw error;
      }
    },
    readDirectory: async (uri): Promise<readonly WorkspaceIndexDirectoryEntry<TUri>[] | "missing"> => {
      try {
        if (uri.scheme === "file") {
          const entries = await readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => ({
            name: entry.name,
            uri: runtime.Uri.joinPath(uri, entry.name),
            type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unknown",
          }));
        }
        const entries = await runtime.workspace.fs.readDirectory(uri);
        return entries.map(([name, fileType]) => ({
          name,
          uri: runtime.Uri.joinPath(uri, name),
          type: classifyProviderType(fileType, runtime.FileType),
        }));
      } catch (error) {
        if (isMissingError(error)) return "missing";
        throw error;
      }
    },
    findFiles: async (base, include, exclude, maxResults, signal) => {
      if (signal.aborted) throw new WorkspaceIndexBuildCancelled();
      const cancellation = new runtime.CancellationTokenSource();
      const onAbort = (): void => cancellation.cancel();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await runtime.workspace.findFiles(
          new runtime.RelativePattern(base, include),
          exclude,
          maxResults,
          cancellation.token
        );
      } finally {
        signal.removeEventListener("abort", onAbort);
        cancellation.dispose();
      }
    },
    readFile: async (uri) =>
      uri.scheme === "file" ? readLocalFile(uri.fsPath) : runtime.workspace.fs.readFile(uri),
    watchWorkspace: (sink) => {
      const treeWatcher = runtime.workspace.createFileSystemWatcher("**/*", false, true, false);
      const disposables: WorkspaceIndexDisposable[] = [
        { dispose: () => treeWatcher.dispose() },
        treeWatcher.onDidCreate((uri) => sink.treeCreated(uri, "tree-create")),
        treeWatcher.onDidDelete((uri) => sink.treeDeleted(uri, "tree-delete")),
        runtime.workspace.onDidRenameFiles((event) => {
          for (const file of event.files) {
            sink.treeDeleted(file.oldUri, "rename-old");
            sink.treeCreated(file.newUri, "rename-new");
          }
        }),
        runtime.workspace.onDidCreateFiles((event) => {
          for (const uri of event.files) sink.treeCreated(uri, "operation-create");
        }),
        runtime.workspace.onDidDeleteFiles((event) => {
          for (const uri of event.files) sink.treeDeleted(uri, "operation-delete");
        }),
        runtime.workspace.onDidChangeWorkspaceFolders((event) => {
          sink.rootsChanged(
            event.added.map((folder) => folder.uri),
            event.removed.map((folder) => folder.uri)
          );
        }),
        runtime.workspace.onDidChangeConfiguration((event) => {
          if (EXCLUSION_SECTIONS.some((section) => event.affectsConfiguration(section))) {
            sink.exclusionsChanged();
          }
        }),
      ];
      return { dispose: () => disposeAll(disposables) };
    },
    watchSpec: (spec, sink) => {
      const watcher = runtime.workspace.createFileSystemWatcher(
        spec.include,
        false,
        !spec.watchContent,
        false
      );
      const disposables: WorkspaceIndexDisposable[] = [
        { dispose: () => watcher.dispose() },
        watcher.onDidCreate((uri) => sink.created(uri)),
        watcher.onDidDelete((uri) => sink.deleted(uri)),
      ];
      if (spec.watchContent) {
        disposables.push(watcher.onDidChange((uri) => sink.changed(uri)));
      }
      return { dispose: () => disposeAll(disposables) };
    },
    onNotice: (notice) => {
      const detail =
        notice.kind === "home-root"
          ? "Indexing your home folder can be expensive."
          : `The workspace index reached its ${notice.maxFiles}-file limit; the partial index remains available.`;
      void runtime.window.showInformationMessage(
        `Flintmark: ${detail} Consider opening a narrower folder for note and image indexing.`
      );
    },
    onError: (error) => {
      console.error("[ofm] workspace index scan failed", error);
    },
  };
}

/** Construct a WorkspaceIndex wired to the VS Code + local-FS host adapter. */
export function createVscodeWorkspaceIndex<TUri extends VscodeUriLike = vscode.Uri>(
  api?: VscodeWorkspaceIndexApi<TUri>
): WorkspaceIndex<TUri> {
  return new WorkspaceIndex<TUri>(createVscodeWorkspaceIndexHost(api));
}
