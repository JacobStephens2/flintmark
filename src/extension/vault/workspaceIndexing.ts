import { Minimatch } from "minimatch";
import { mapInCooperativeBatches } from "./cooperativeBatches";

export const DOCUMENT_READY_MAX_STALE_MS = 5_000;
export const DEFAULT_MAX_FILES = 100_000;
export const DEFAULT_INDEX_EXCLUDES = [
  "**/{.git,node_modules,.obsidian,.trash,.cache,Library,.claude,.codex,.npm,.cargo,.rustup,.vscode,__pycache__,.venv,dist,target}/**",
  "**/.local/share/**",
];

const TREE_EVENT_DEBOUNCE_MS = 50;
const FULL_RESCAN_INTERVAL_MS = 30_000;
const READ_BATCH_SIZE = 32;

export interface WorkspaceIndexUri {
  readonly scheme: string;
  readonly path: string;
  toString(): string;
}

export interface WorkspaceIndexDisposable {
  dispose(): void;
}

export interface WorkspaceIndexFile<TUri> {
  readonly uri: TUri;
  readonly relativePath: string;
}

export type WorkspaceIndexRefreshMode = "content" | "paths" | "full";

export type WorkspaceIndexPatch<TUri> =
  | { readonly mode: "content"; readonly changed: readonly WorkspaceIndexFile<TUri>[] }
  | {
      readonly mode: "paths";
      readonly changed: readonly WorkspaceIndexFile<TUri>[];
      readonly deleted: readonly WorkspaceIndexFile<TUri>[];
    };

export interface WorkspaceIndexRefreshEvent<TUri> {
  readonly kind: string;
  readonly root: TUri;
  readonly version: number;
  readonly reason: string;
  readonly mode: WorkspaceIndexRefreshMode;
  readonly changedUris: readonly TUri[];
}

export interface WorkspaceIndexBuildContext<TUri> {
  readonly generation: number;
  isCurrent(): boolean;
  yieldNow(): Promise<void>;
  readFile(uri: TUri): Promise<Uint8Array>;
}

export class WorkspaceIndexBuildCancelled extends Error {
  constructor() {
    super("Workspace index build cancelled");
    this.name = "WorkspaceIndexBuildCancelled";
  }
}

export interface WorkspaceIndexSpec<TSnapshot, TUri extends WorkspaceIndexUri> {
  readonly kind: string;
  readonly include: string;
  readonly exclude?: string;
  readonly matchesPath?: (relativePath: string) => boolean;
  readonly debounceMs?: number;
  readonly watchContent?: boolean;
  readonly maxFiles?: () => number | undefined;
  readonly notReady: () => TSnapshot;
  readonly build: (
    root: TUri,
    files: readonly WorkspaceIndexFile<TUri>[],
    context: WorkspaceIndexBuildContext<TUri>
  ) => Promise<TSnapshot>;
  readonly patchSnapshot?: (
    root: TUri,
    snapshot: TSnapshot,
    patch: WorkspaceIndexPatch<TUri>,
    context: WorkspaceIndexBuildContext<TUri>
  ) => Promise<TSnapshot | undefined>;
}

export interface WorkspaceIndexDocumentContext<TSnapshot, TUri> {
  readonly root: TUri;
  readonly relativePath: string;
  readonly snapshot: TSnapshot;
  readonly version: number;
}

export interface WorkspaceIndexEnsureFreshOptions {
  readonly force?: boolean;
}

export interface WorkspaceIndexHandle<TSnapshot, TUri extends WorkspaceIndexUri> {
  readonly kind: string;
  snapshot(root: TUri): TSnapshot | undefined;
  snapshots(): readonly { root: TUri; snapshot: TSnapshot; version: number }[];
  version(root: TUri): number;
  forDocument(documentUri: TUri): WorkspaceIndexDocumentContext<TSnapshot, TUri> | undefined;
  requestRefresh(root: TUri, reason: string, immediate?: boolean): void;
  ensureFresh(
    documentUri: TUri,
    reason: string,
    options?: WorkspaceIndexEnsureFreshOptions
  ): void;
  onDidRefresh(
    listener: (event: WorkspaceIndexRefreshEvent<TUri>) => void
  ): WorkspaceIndexDisposable;
  dispose(): void;
}

export type WorkspaceIndexEntryType = "file" | "directory" | "unknown";
export type WorkspaceIndexStatType = WorkspaceIndexEntryType | "missing";

export interface WorkspaceIndexDirectoryEntry<TUri> {
  readonly name: string;
  readonly uri: TUri;
  readonly type: WorkspaceIndexEntryType;
}

export interface WorkspaceIndexExclusionConfig {
  readonly excludes?: readonly string[];
  readonly extra?: readonly string[];
}

export interface WorkspaceIndexWorkspaceSink<TUri> {
  treeCreated(uri: TUri, reason?: string): void;
  treeDeleted(uri: TUri, reason?: string): void;
  rootsChanged(added: readonly TUri[], removed: readonly TUri[]): void;
  exclusionsChanged(): void;
}

export interface WorkspaceIndexSpecSink<TUri> {
  created(uri: TUri): void;
  deleted(uri: TUri): void;
  changed(uri: TUri): void;
}

export type WorkspaceIndexNotice<TUri> =
  | { readonly kind: "home-root"; readonly root: TUri }
  | { readonly kind: "cap-reached"; readonly root: TUri; readonly maxFiles: number };

export interface WorkspaceIndexTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WorkspaceIndexHost<TUri extends WorkspaceIndexUri> {
  workspaceFolders(): readonly TUri[];
  homeDirectory?(): TUri | undefined;
  exclusions?(root: TUri): WorkspaceIndexExclusionConfig | undefined;
  stat(uri: TUri): Promise<WorkspaceIndexStatType>;
  readDirectory(uri: TUri): Promise<readonly WorkspaceIndexDirectoryEntry<TUri>[] | "missing">;
  findFiles(
    base: TUri,
    include: string,
    exclude: string | undefined,
    maxResults: number,
    signal: AbortSignal
  ): Promise<readonly TUri[]>;
  readFile(uri: TUri): Promise<Uint8Array>;
  watchWorkspace?(sink: WorkspaceIndexWorkspaceSink<TUri>): WorkspaceIndexDisposable;
  watchSpec?(
    spec: { readonly kind: string; readonly include: string; readonly watchContent: boolean },
    sink: WorkspaceIndexSpecSink<TUri>
  ): WorkspaceIndexDisposable;
  onNotice?(notice: WorkspaceIndexNotice<TUri>): void;
  onError?(
    error: unknown,
    context: { readonly kind: string; readonly root: TUri; readonly reason: string }
  ): void;
  now?: () => number;
  yieldNow?: () => Promise<void>;
  timers?: WorkspaceIndexTimers;
}

type IndexSnapshotStatus = "notReady" | "building" | "ready" | "failed" | "cancelled";

interface RuntimeState {
  status: IndexSnapshotStatus;
  lastSuccessAt: number | undefined;
  dirtyEpoch: number;
  completedEpoch: number;
  inFlight: boolean;
  inFlightGeneration: number | undefined;
  lastFullScanAt?: number;
  capped?: boolean;
}

interface PendingRefreshBatch<TUri extends WorkspaceIndexUri> {
  mode: WorkspaceIndexRefreshMode;
  uris: Map<string, TUri>;
}

interface SpecRegistration<TUri extends WorkspaceIndexUri> {
  readonly spec: WorkspaceIndexSpec<unknown, TUri>;
  readonly matcher: Minimatch;
  readonly listeners: Set<(event: WorkspaceIndexRefreshEvent<TUri>) => void>;
  watchDisposable?: WorkspaceIndexDisposable;
  disposed: boolean;
}

/** VS Code can preserve /C:/ on a workspace root but return /c:/ from findFiles.
 *  Canonicalize only the drive letter for file: URIs; directory, filename, and
 *  non-file scheme casing must survive unchanged. */
function indexComparisonPath(uri: WorkspaceIndexUri): string {
  return uri.scheme === "file"
    ? uri.path.replace(/^\/([A-Z]):(?=\/|$)/, (_, drive: string) => `/${drive.toLowerCase()}:`)
    : uri.path;
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function canonicalRootKey(uri: WorkspaceIndexUri): string {
  return uri.scheme === "file"
    ? `file\0${trimTrailingSlash(indexComparisonPath(uri))}`
    : uri.toString();
}

function comparisonUriKey(uri: WorkspaceIndexUri): string {
  return uri.scheme === "file"
    ? `file\0${indexComparisonPath(uri)}`
    : uri.toString();
}

function containmentMatch(
  root: WorkspaceIndexUri,
  target: WorkspaceIndexUri
): { rootLength: number; exact: boolean; baseLength: number } | undefined {
  if (root.scheme !== target.scheme) return undefined;
  const rootTrimmed = trimTrailingSlash(indexComparisonPath(root));
  const targetPath = indexComparisonPath(target);
  if (targetPath === rootTrimmed) {
    return { rootLength: rootTrimmed.length, exact: true, baseLength: rootTrimmed.length };
  }
  const base = rootTrimmed === "/" ? "/" : rootTrimmed + "/";
  return targetPath.startsWith(base)
    ? { rootLength: rootTrimmed.length, exact: false, baseLength: base.length }
    : undefined;
}

/** Strip a folder's path prefix off a contained file Uri -> root-relative path.
 *  Requires a path-segment boundary so root `/a/b` never matches `/a/bc/x`. */
export function relativePathFromRoot<TUri extends WorkspaceIndexUri>(
  root: TUri,
  file: TUri
): string {
  const match = containmentMatch(root, file);
  if (match) return match.exact ? "" : file.path.slice(match.baseLength);
  return file.path.replace(/^\/+/, "");
}

function directoriesHoldingFiles(
  filePaths: Iterable<string>,
  rootPath: string
): Set<string> {
  const root = rootPath === "/" ? "" : trimTrailingSlash(rootPath);
  const dirs = new Set<string>();
  for (const path of filePaths) {
    for (let dir = path.slice(0, path.lastIndexOf("/")); dir.length > root.length; ) {
      if (dirs.has(dir)) break;
      dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  return dirs;
}

function mergeRefreshInvalidation<TUri extends WorkspaceIndexUri>(
  current: PendingRefreshBatch<TUri> | undefined,
  mode: WorkspaceIndexRefreshMode,
  changedUri?: TUri
): PendingRefreshBatch<TUri> {
  if (current?.mode === "full" || mode === "full") {
    return { mode: "full", uris: new Map() };
  }
  const uris = new Map(current?.uris);
  if (changedUri) uris.set(comparisonUriKey(changedUri), changedUri);
  return { mode: current?.mode === "paths" || mode === "paths" ? "paths" : "content", uris };
}

function subtreeIncludeGlob(include: string, relDir: string): string {
  if (relDir === "" || /^\*\*\/[^/]+$/.test(include)) return include;
  const prefixed = /^([^*?[\]{}()!]+)\/(\*\*\/[^/]+)$/.exec(include);
  if (prefixed) {
    const [, prefix, tail] = prefixed;
    if (relDir === prefix || relDir.startsWith(prefix + "/")) return tail;
  }
  return "**/*";
}

class ExclusionPolicy {
  readonly glob: string | undefined;
  private readonly matchers: Minimatch[];

  constructor(patterns: readonly string[]) {
    const unique = [...new Set(patterns.filter((pattern) => pattern.length > 0))];
    this.glob =
      unique.length === 0
        ? undefined
        : unique.length === 1
          ? unique[0]
          : `{${unique.join(",")}}`;
    this.matchers = unique.map(
      (pattern) =>
        new Minimatch(pattern, {
          dot: true,
          nonegate: true,
          nocomment: true,
          noext: true,
        })
    );
  }

  excludes(relativePath: string): boolean {
    for (let path = relativePath; path; path = path.slice(0, Math.max(0, path.lastIndexOf("/")))) {
      if (this.matchers.some((matcher) => matcher.match(path) || matcher.match(path + "/"))) {
        return true;
      }
    }
    return false;
  }
}

/** Lifetime generation clock; keys survive root/spec removals so re-adds cannot ABA. */
class GenerationClock {
  private readonly generations = new Map<string, number>();

  bump(key: string): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  invalidate(key: string): void {
    this.bump(key);
  }

  invalidateAll(): void {
    for (const key of this.generations.keys()) this.bump(key);
  }

  isCurrent(key: string, generation: number): boolean {
    return this.generations.get(key) === generation;
  }
}

class ScanQueue {
  private readonly flights = new Map<string, Promise<void>>();

  async run(key: string, isCurrent: () => boolean, scan: () => Promise<void>): Promise<void> {
    const previous = this.flights.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (isCurrent()) await scan();
      });
    this.flights.set(key, next);
    try {
      await next;
    } finally {
      if (this.flights.get(key) === next) this.flights.delete(key);
    }
  }
}

function defaultYieldNow(): Promise<void> {
  if (typeof setImmediate === "function") {
    return new Promise((resolve) => setImmediate(resolve));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const defaultTimers: WorkspaceIndexTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function stateIsBuilding(state: RuntimeState): boolean {
  return state.inFlight || state.status === "building";
}

function toIndexFiles<TUri extends WorkspaceIndexUri>(
  root: TUri,
  uris: Iterable<TUri>
): WorkspaceIndexFile<TUri>[] {
  const files: WorkspaceIndexFile<TUri>[] = [];
  for (const uri of uris) {
    files.push({ uri, relativePath: relativePathFromRoot(root, uri) });
  }
  return files;
}

/** Multi-root, multi-spec workspace index coordinator behind one host port. */
export class WorkspaceIndex<TUri extends WorkspaceIndexUri> implements WorkspaceIndexDisposable {
  private readonly specs = new Map<string, SpecRegistration<TUri>>();
  private readonly snapshots = new Map<string, Map<string, unknown>>();
  private readonly versions = new Map<string, Map<string, number>>();
  private readonly roots = new Map<string, TUri>();
  private readonly timers = new Map<string, unknown>();
  private readonly fullRefreshTimers = new Map<string, unknown>();
  private readonly pending = new Map<string, PendingRefreshBatch<TUri>>();
  private readonly generations = new GenerationClock();
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly scanQueue = new ScanQueue();
  private readonly indexedDirs = new Map<string, Set<string>>();
  private readonly indexedFiles = new Map<string, Map<string, TUri>>();
  private readonly exclusions = new Map<string, ExclusionPolicy>();
  private readonly notifiedRoots = new Set<string>();
  private readonly scanCancellations = new Map<string, AbortController>();
  private readonly activeRouting = new Set<Promise<void>>();
  private readonly activeScans = new Set<Promise<void>>();
  private readonly settledWaiters = new Set<() => void>();
  private readonly nowFn: () => number;
  private readonly yieldNowFn: () => Promise<void>;
  private readonly timerApi: WorkspaceIndexTimers;
  private workspaceWatcher?: WorkspaceIndexDisposable;
  private initializePromise: Promise<void> | undefined;
  private initializingCount = 0;
  private initialized = false;
  private disposed = false;

  constructor(private readonly host: WorkspaceIndexHost<TUri>) {
    this.nowFn = host.now ?? (() => Date.now());
    this.yieldNowFn = host.yieldNow ?? defaultYieldNow;
    this.timerApi = host.timers ?? defaultTimers;
  }

  register<TSnapshot>(
    spec: WorkspaceIndexSpec<TSnapshot, TUri>
  ): WorkspaceIndexHandle<TSnapshot, TUri> {
    if (this.disposed) {
      throw new Error(`Workspace index is disposed: ${spec.kind}`);
    }
    if (this.specs.has(spec.kind)) {
      throw new Error(`Workspace index spec already registered: ${spec.kind}`);
    }
    const registration: SpecRegistration<TUri> = {
      spec: spec as WorkspaceIndexSpec<unknown, TUri>,
      matcher: new Minimatch(spec.include, { dot: true, nocase: true }),
      listeners: new Set(),
      disposed: false,
    };
    this.specs.set(spec.kind, registration);
    this.snapshots.set(spec.kind, new Map());
    this.versions.set(spec.kind, new Map());

    for (const root of this.roots.values()) {
      this.setSnapshot(spec.kind, root, spec.notReady(), 0);
    }

    if (this.initialized) {
      this.attachSpecWatcher(registration);
      for (const root of this.roots.values()) {
        this.requestRefresh(spec.kind, root, "spec-registered", true, true);
      }
    }

    return this.createHandle<TSnapshot>(registration);
  }

  private createHandle<TSnapshot>(
    registration: SpecRegistration<TUri>
  ): WorkspaceIndexHandle<TSnapshot, TUri> {
    const { kind } = registration.spec;
    const isActive = (): boolean =>
      !this.disposed && !registration.disposed && this.specs.get(kind) === registration;

    return {
      kind,
      snapshot: (root: TUri): TSnapshot | undefined =>
        isActive()
          ? (this.snapshots.get(kind)?.get(canonicalRootKey(root)) as TSnapshot | undefined)
          : undefined,
      snapshots: (): readonly { root: TUri; snapshot: TSnapshot; version: number }[] => {
        if (!isActive()) return [];
        const out: { root: TUri; snapshot: TSnapshot; version: number }[] = [];
        const byRoot = this.snapshots.get(kind);
        const versions = this.versions.get(kind);
        if (!byRoot) return out;
        for (const [rootKey, snapshot] of byRoot) {
          const root = this.roots.get(rootKey);
          if (!root) continue;
          out.push({
            root,
            snapshot: snapshot as TSnapshot,
            version: versions?.get(rootKey) ?? 0,
          });
        }
        return out;
      },
      version: (root: TUri): number =>
        isActive() ? this.versions.get(kind)?.get(canonicalRootKey(root)) ?? 0 : 0,
      forDocument: (
        documentUri: TUri
      ): WorkspaceIndexDocumentContext<TSnapshot, TUri> | undefined => {
        if (!isActive()) return undefined;
        const root = this.resolveRoot(documentUri);
        if (!root) return undefined;
        const rootKey = canonicalRootKey(root);
        const byRoot = this.snapshots.get(kind);
        if (!byRoot?.has(rootKey)) return undefined;
        return {
          root,
          relativePath: relativePathFromRoot(root, documentUri),
          snapshot: byRoot.get(rootKey) as TSnapshot,
          version: this.versions.get(kind)?.get(rootKey) ?? 0,
        };
      },
      requestRefresh: (root: TUri, reason: string, immediate = false): void => {
        if (!isActive()) return;
        this.requestRefresh(kind, root, reason, immediate, true);
      },
      ensureFresh: (
        documentUri: TUri,
        reason: string,
        options?: WorkspaceIndexEnsureFreshOptions
      ): void => {
        if (!isActive()) return;
        const root = this.resolveRootForEnsureFresh(documentUri);
        if (root) this.ensureFresh(kind, root, reason, options?.force ?? false);
      },
      onDidRefresh: (
        listener: (event: WorkspaceIndexRefreshEvent<TUri>) => void
      ): WorkspaceIndexDisposable => {
        if (!isActive()) return { dispose: () => {} };
        registration.listeners.add(listener);
        return {
          dispose: () => {
            registration.listeners.delete(listener);
          },
        };
      },
      dispose: (): void => {
        this.disposeSpec(registration);
      },
    };
  }

  async initialize(): Promise<void> {
    if (this.disposed) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeOnce();
    return this.initializePromise;
  }

  whenSettled(): Promise<void> {
    if (this.isSettled()) return Promise.resolve();
    return new Promise((resolve) => {
      this.settledWaiters.add(resolve);
    });
  }

  private async initializeOnce(): Promise<void> {
    this.initializingCount++;
    try {
      this.attachWorkspaceWatcher();
      for (const registration of this.specs.values()) {
        this.attachSpecWatcher(registration);
      }
      for (const folder of this.host.workspaceFolders()) {
        this.addRoot(folder);
      }
      this.initialized = true;
      const scans: Promise<void>[] = [];
      for (const root of this.roots.values()) {
        for (const registration of this.specs.values()) {
          const generation = this.invalidate(registration.spec.kind, root);
          scans.push(
            this.trackScan(
              this.rescan(registration, root, "initial-scan", generation, {
                mode: "full",
                uris: new Map(),
              })
            )
          );
        }
      }
      await Promise.all(scans);
    } finally {
      this.initializingCount--;
      this.checkSettled();
    }
  }

  private attachWorkspaceWatcher(): void {
    if (this.disposed || this.workspaceWatcher || !this.host.watchWorkspace) return;
    this.workspaceWatcher = this.host.watchWorkspace({
      treeCreated: (uri, reason = "tree-create") => {
        this.trackRouting(this.routeCreatedUri(uri, reason));
      },
      treeDeleted: (uri, reason = "tree-delete") => {
        this.routeUnavailableUri(uri, reason);
      },
      rootsChanged: (added, removed) => {
        for (const root of removed) this.removeRoot(root);
        for (const root of added) {
          this.addRoot(root);
          this.requestAll(root, "workspace-folder-added", true);
        }
      },
      exclusionsChanged: () => {
        this.exclusions.clear();
        for (const root of this.roots.values()) {
          this.requestAll(root, "exclusions-changed", false);
        }
      },
    });
  }

  private attachSpecWatcher(registration: SpecRegistration<TUri>): void {
    if (this.disposed || registration.disposed || registration.watchDisposable || !this.host.watchSpec) {
      return;
    }
    const { kind, include, watchContent } = registration.spec;
    registration.watchDisposable = this.host.watchSpec(
      { kind, include, watchContent: Boolean(watchContent) },
      {
        created: (uri) => this.scheduleForUri(kind, uri, "spec-create", "paths"),
        deleted: (uri) => this.scheduleForUri(kind, uri, "spec-delete", "paths"),
        changed: (uri) => {
          if (watchContent) this.scheduleForUri(kind, uri, "spec-change", "content");
        },
      }
    );
  }

  private addRoot(root: TUri): TUri {
    const key = canonicalRootKey(root);
    const stored = this.roots.get(key) ?? root;
    if (!this.roots.has(key)) this.roots.set(key, stored);

    const home = this.host.homeDirectory?.();
    if (
      home &&
      stored.scheme === home.scheme &&
      trimTrailingSlash(indexComparisonPath(stored)) === trimTrailingSlash(indexComparisonPath(home))
    ) {
      this.notifyLargeRoot(stored, { kind: "home-root", root: stored });
    }
    for (const registration of this.specs.values()) {
      const byRoot = this.snapshots.get(registration.spec.kind);
      if (!byRoot?.has(key)) {
        this.setSnapshot(registration.spec.kind, stored, registration.spec.notReady(), 0);
      }
    }
    return stored;
  }

  private removeRoot(root: TUri): void {
    const key = canonicalRootKey(root);
    this.roots.delete(key);
    for (const kind of this.specs.keys()) {
      this.snapshots.get(kind)?.delete(key);
      this.versions.get(kind)?.delete(key);
      this.clearScanState(this.scanKey(kind, key));
    }
    this.checkSettled();
  }

  private disposeSpec(registration: SpecRegistration<TUri>): void {
    const { kind } = registration.spec;
    if (registration.disposed || this.specs.get(kind) !== registration) return;
    registration.disposed = true;
    registration.watchDisposable?.dispose();
    registration.watchDisposable = undefined;
    registration.listeners.clear();
    this.specs.delete(kind);
    this.snapshots.delete(kind);
    this.versions.delete(kind);
    for (const rootKey of this.roots.keys()) {
      this.clearScanState(this.scanKey(kind, rootKey));
    }
    this.checkSettled();
  }

  private clearScanState(scanKey: string): void {
    const timer = this.timers.get(scanKey);
    if (timer !== undefined) this.timerApi.clearTimeout(timer);
    this.timers.delete(scanKey);
    const fullTimer = this.fullRefreshTimers.get(scanKey);
    if (fullTimer !== undefined) this.timerApi.clearTimeout(fullTimer);
    this.fullRefreshTimers.delete(scanKey);
    this.generations.invalidate(scanKey);
    this.cancelScan(scanKey);
    this.indexedDirs.delete(scanKey);
    this.indexedFiles.delete(scanKey);
    this.exclusions.delete(scanKey);
    this.runtime.delete(scanKey);
    this.pending.delete(scanKey);
  }

  private longestContainingRoot(roots: Iterable<TUri>, uri: TUri): TUri | undefined {
    let bestRoot: TUri | undefined;
    let bestLength = -1;
    for (const root of roots) {
      const match = containmentMatch(root, uri);
      if (match && match.rootLength > bestLength) {
        bestLength = match.rootLength;
        bestRoot = root;
      }
    }
    return bestRoot;
  }

  private resolveRoot(uri: TUri): TUri | undefined {
    return this.longestContainingRoot(this.roots.values(), uri);
  }

  private resolveRootForEnsureFresh(uri: TUri): TUri | undefined {
    const existing = this.resolveRoot(uri);
    if (existing || this.initialized) return existing;
    return this.longestContainingRoot(this.host.workspaceFolders(), uri);
  }

  private scheduleForUri(
    kind: string,
    uri: TUri,
    reason: string,
    mode: WorkspaceIndexRefreshMode = "paths"
  ): void {
    if (this.disposed) return;
    const registration = this.specs.get(kind);
    if (!registration || registration.disposed) return;
    const root = this.resolveRoot(uri);
    if (!root) return;
    const rel = relativePathFromRoot(root, uri);
    if (this.exclusionPolicy(kind, root).excludes(rel)) return;
    if (mode === "content" && !this.matchesSpec(registration, rel)) return;
    this.requestRefresh(kind, root, reason, false, true, mode, uri);
  }

  private requestAll(root: TUri, reason: string, immediate: boolean): void {
    for (const kind of this.specs.keys()) {
      this.requestRefresh(kind, root, reason, immediate, true);
    }
  }

  private requestRefresh(
    kind: string,
    rootInput: TUri,
    reason: string,
    immediate: boolean,
    markDirty: boolean,
    mode: WorkspaceIndexRefreshMode = "full",
    changedUri?: TUri
  ): void {
    if (this.disposed) return;
    const registration = this.specs.get(kind);
    if (!registration || registration.disposed) return;
    const root = this.addRoot(rootInput);
    const rootKey = canonicalRootKey(root);
    const scanKey = this.scanKey(kind, rootKey);
    const state = this.runtimeState(kind, rootKey);

    if (mode === "full" && state.lastFullScanAt !== undefined) {
      const remaining = state.lastFullScanAt + FULL_RESCAN_INTERVAL_MS - this.nowFn();
      if (remaining > 0) {
        if (markDirty) state.dirtyEpoch++;
        if (!this.fullRefreshTimers.has(scanKey)) {
          this.fullRefreshTimers.set(
            scanKey,
            this.timerApi.setTimeout(() => {
              this.fullRefreshTimers.delete(scanKey);
              this.requestRefresh(kind, root, reason, true, false);
            }, remaining)
          );
        }
        return;
      }
    }

    if (markDirty) state.dirtyEpoch++;
    this.pending.set(
      scanKey,
      mergeRefreshInvalidation(this.pending.get(scanKey), mode, mode !== "full" ? changedUri : undefined)
    );

    // Queue hints without cancelling an active scan, and keep the leading-edge
    // timer deadline so continuous traffic cannot starve publication.
    if (stateIsBuilding(state) || this.timers.has(scanKey)) return;
    const delay = immediate ? 0 : registration.spec.debounceMs ?? TREE_EVENT_DEBOUNCE_MS;
    this.timers.set(
      scanKey,
      this.timerApi.setTimeout(() => {
        this.timers.delete(scanKey);
        if (this.disposed || registration.disposed || this.specs.get(kind) !== registration) {
          this.checkSettled();
          return;
        }
        if (stateIsBuilding(this.runtimeState(kind, rootKey))) {
          this.checkSettled();
          return;
        }
        const batch = this.pending.get(scanKey) ?? { mode: "full", uris: new Map<string, TUri>() };
        this.pending.delete(scanKey);
        const generation = this.bumpGeneration(scanKey);
        void this.trackScan(this.rescan(registration, root, reason, generation, batch));
      }, delay)
    );
  }

  private ensureFresh(kind: string, rootInput: TUri, reason: string, force: boolean): void {
    if (this.disposed) return;
    const root = this.addRoot(rootInput);
    const state = this.runtimeState(kind, canonicalRootKey(root));
    if (state.capped) return;
    if (state.inFlight) {
      if (!force) return;
    } else if (!force) {
      if (
        state.status === "ready" &&
        state.dirtyEpoch === state.completedEpoch &&
        state.lastSuccessAt !== undefined &&
        this.nowFn() - state.lastSuccessAt < DOCUMENT_READY_MAX_STALE_MS
      ) {
        return;
      }
    }
    this.requestRefresh(kind, root, reason, false, true);
  }

  private async rescan(
    registration: SpecRegistration<TUri>,
    root: TUri,
    reason: string,
    generation: number,
    batch: PendingRefreshBatch<TUri>
  ): Promise<void> {
    const kind = registration.spec.kind;
    const rootKey = canonicalRootKey(root);
    const scanKey = this.scanKey(kind, rootKey);
    const isCurrent = (): boolean =>
      !this.disposed &&
      !registration.disposed &&
      this.specs.get(kind) === registration &&
      this.roots.has(rootKey) &&
      this.generations.isCurrent(scanKey, generation);

    try {
      await this.scanQueue.run(scanKey, isCurrent, () =>
        this.buildSnapshot(registration, root, reason, generation, batch)
      );
    } finally {
      if (isCurrent() && !stateIsBuilding(this.runtimeState(kind, rootKey)) && this.pending.has(scanKey)) {
        const pending = this.pending.get(scanKey)!;
        // Clear full batches before rescheduling so cooldown deferral does not
        // strand "full" in pending and swallow subsequent incremental updates.
        if (pending.mode === "full") this.pending.delete(scanKey);
        this.requestRefresh(kind, root, "deferred-events", false, false, pending.mode);
      }
    }
  }

  private finishBuildState(
    state: RuntimeState,
    status: Exclude<IndexSnapshotStatus, "notReady" | "building">,
    completedEpoch?: number,
    lastSuccessAt?: number
  ): void {
    state.status = status;
    if (completedEpoch !== undefined) state.completedEpoch = completedEpoch;
    if (lastSuccessAt !== undefined) state.lastSuccessAt = lastSuccessAt;
    state.inFlight = false;
    state.inFlightGeneration = undefined;
  }

  private async buildSnapshot(
    registration: SpecRegistration<TUri>,
    root: TUri,
    reason: string,
    myGen: number,
    batch: PendingRefreshBatch<TUri>
  ): Promise<void> {
    const spec = registration.spec;
    const kind = spec.kind;
    const rootKey = canonicalRootKey(root);
    const scanKey = this.scanKey(kind, rootKey);
    const state = this.runtimeState(kind, rootKey);
    const startedEpoch = state.dirtyEpoch;
    state.status = "building";
    state.inFlight = true;
    state.inFlightGeneration = myGen;

    const isCurrent = (): boolean =>
      !this.disposed &&
      !registration.disposed &&
      this.specs.get(kind) === registration &&
      this.roots.has(rootKey) &&
      this.generations.isCurrent(scanKey, myGen);

    const cancellation = new AbortController();
    this.cancelScan(scanKey);
    this.scanCancellations.set(scanKey, cancellation);

    let snapshot: unknown;
    let completedMode: WorkspaceIndexRefreshMode = batch.mode;
    let changedUris: readonly TUri[] = [];
    let scannedFiles: readonly TUri[] | undefined;

    try {
      const context: WorkspaceIndexBuildContext<TUri> = {
        generation: myGen,
        isCurrent,
        yieldNow: this.yieldNowFn,
        readFile: (uri) => this.host.readFile(uri),
      };

      if (batch.mode === "paths" && this.indexedFiles.has(scanKey)) {
        const result = await this.reconcilePaths(
          registration,
          root,
          scanKey,
          state,
          batch.uris,
          context,
          cancellation.signal,
          isCurrent
        );
        if (!isCurrent()) throw new WorkspaceIndexBuildCancelled();
        if (result === "no-op") {
          this.finishBuildState(state, "ready", startedEpoch);
          return;
        }
        snapshot = result.snapshot;
        changedUris = result.changedUris;
        scannedFiles = result.scannedFiles;
      } else if (batch.mode === "content" && spec.patchSnapshot) {
        changedUris = [...batch.uris.values()];
        const current = this.snapshots.get(kind)?.get(rootKey);
        if (current !== undefined && changedUris.length > 0) {
          snapshot = await spec.patchSnapshot(
            root,
            current,
            { mode: "content", changed: toIndexFiles(root, changedUris) },
            context
          );
        }
        if (snapshot === undefined) completedMode = "full";
      } else {
        completedMode = "full";
      }

      if (completedMode === "full") {
        if (
          state.lastFullScanAt !== undefined &&
          this.nowFn() - state.lastFullScanAt < FULL_RESCAN_INTERVAL_MS
        ) {
          this.requestRefresh(kind, root, "patch-fallback", false, true);
          this.finishBuildState(state, "ready");
          return;
        }
        changedUris = [];
        const cap = spec.maxFiles?.() ?? DEFAULT_MAX_FILES;
        const policy = this.exclusionPolicy(kind, root);
        const found = await this.host.findFiles(
          root,
          spec.include,
          policy.glob,
          cap + 1,
          cancellation.signal
        );
        if (!isCurrent()) throw new WorkspaceIndexBuildCancelled();
        const filtered = found.filter((file) => {
          const rel = relativePathFromRoot(root, file);
          return !policy.excludes(rel) && this.matchesSpec(registration, rel);
        });
        state.capped = filtered.length > cap;
        if (state.capped) {
          this.notifyLargeRoot(root, { kind: "cap-reached", root, maxFiles: cap });
        }
        scannedFiles = filtered.slice(0, cap);
        snapshot = await spec.build(root, toIndexFiles(root, scannedFiles), context);
        if (!isCurrent()) throw new WorkspaceIndexBuildCancelled();
        state.lastFullScanAt = this.nowFn();
      }
    } catch (error) {
      if (!isCurrent() || error instanceof WorkspaceIndexBuildCancelled || cancellation.signal.aborted) {
        if (state.inFlightGeneration === myGen) {
          this.finishBuildState(state, "cancelled");
        }
        return;
      }
      if (state.inFlightGeneration === myGen) {
        this.finishBuildState(state, "failed");
      }
      this.host.onError?.(error, { kind, root, reason });
      return;
    } finally {
      if (this.scanCancellations.get(scanKey) === cancellation) {
        this.scanCancellations.delete(scanKey);
      }
    }

    if (!isCurrent()) {
      if (state.inFlightGeneration === myGen) {
        this.finishBuildState(state, "cancelled");
      }
      return;
    }

    const version = this.bumpVersion(kind, rootKey);
    this.setSnapshot(kind, root, snapshot, version);
    if (completedMode === "full") this.indexedDirs.delete(scanKey);
    if (scannedFiles) {
      this.indexedFiles.set(
        scanKey,
        new Map(scannedFiles.map((file) => [indexComparisonPath(file), file]))
      );
      this.indexedDirs.set(
        scanKey,
        directoriesHoldingFiles(scannedFiles.map(indexComparisonPath), indexComparisonPath(root))
      );
    }
    this.finishBuildState(state, "ready", startedEpoch, this.nowFn());

    const event: WorkspaceIndexRefreshEvent<TUri> = {
      kind,
      root,
      version,
      reason,
      mode: completedMode,
      changedUris,
    };
    for (const listener of [...registration.listeners]) listener(event);
  }

  private async reconcilePaths(
    registration: SpecRegistration<TUri>,
    root: TUri,
    scanKey: string,
    state: RuntimeState,
    batchUris: ReadonlyMap<string, TUri>,
    context: WorkspaceIndexBuildContext<TUri>,
    signal: AbortSignal,
    isCurrent: () => boolean
  ): Promise<
    "no-op" | { snapshot: unknown; changedUris: readonly TUri[]; scannedFiles: readonly TUri[] }
  > {
    const spec = registration.spec;
    const kind = spec.kind;
    const rootKey = canonicalRootKey(root);
    const originalFiles = this.indexedFiles.get(scanKey)!;
    let files = originalFiles;
    const mutableFiles = (): Map<string, TUri> => {
      if (files === originalFiles) files = new Map(originalFiles);
      return files;
    };
    const updated = new Map<string, TUri>();
    const removed = new Map<string, TUri>();
    const cap = spec.maxFiles?.() ?? DEFAULT_MAX_FILES;
    const policy = this.exclusionPolicy(kind, root);

    const changes = await mapInCooperativeBatches(
      [...batchUris.values()],
      READ_BATCH_SIZE,
      async (uri): Promise<{ uri: TUri; found?: readonly TUri[] }> => {
        const statType = await this.host.stat(uri);
        if (statType === "missing") return { uri, found: [] };
        if (statType !== "directory") {
          const rel = relativePathFromRoot(root, uri);
          return { uri, found: this.matchesSpec(registration, rel) ? [uri] : [] };
        }
        const children = await this.host.readDirectory(uri);
        if (children === "missing") return { uri, found: [] };
        // Empty or direct-file directories skip subtree findFiles.
        if (children.every((entry) => entry.type === "file")) {
          return {
            uri,
            found: children
              .filter((entry) => this.matchesSpec(registration, relativePathFromRoot(root, entry.uri)))
              .map((entry) => entry.uri),
          };
        }
        return { uri };
      },
      {
        assertCurrent: () => {
          if (!isCurrent()) throw new WorkspaceIndexBuildCancelled();
        },
        yieldNow: this.yieldNowFn,
      }
    );

    for (const { uri, found: directFiles } of changes) {
      const path = trimTrailingSlash(indexComparisonPath(uri));
      const old = files.get(path);
      if (old) {
        removed.set(path, old);
        updated.delete(path);
        mutableFiles().delete(path);
      }
      const prefix = path === "/" ? "/" : path + "/";
      if (
        this.indexedDirs.get(scanKey)?.has(path) ||
        [...updated.keys()].some((key) => key.startsWith(prefix))
      ) {
        for (const [key, oldDescendant] of files) {
          if (!key.startsWith(prefix)) continue;
          removed.set(key, oldDescendant);
          updated.delete(key);
          mutableFiles().delete(key);
        }
      }

      let found = directFiles;
      if (!found) {
        const includePattern = subtreeIncludeGlob(spec.include, relativePathFromRoot(root, uri));
        const discovered = await this.host.findFiles(
          uri,
          includePattern,
          policy.glob,
          cap + 1,
          signal
        );
        if (!isCurrent()) throw new WorkspaceIndexBuildCancelled();
        found = discovered.filter((file) =>
          this.matchesSpec(registration, relativePathFromRoot(root, file))
        );
      }

      for (const file of found) {
        const rel = relativePathFromRoot(root, file);
        if (policy.excludes(rel)) continue;
        const key = indexComparisonPath(file);
        if (!files.has(key) && files.size >= cap) {
          state.capped = true;
          this.notifyLargeRoot(root, { kind: "cap-reached", root, maxFiles: cap });
          continue;
        }
        mutableFiles().set(key, file);
        updated.set(key, file);
        removed.delete(key);
      }
    }

    if (updated.size === 0 && removed.size === 0) return "no-op";

    const changedUris = [...updated.values()];
    const deletedUris = [...removed.values()];
    const current = this.snapshots.get(kind)?.get(rootKey);
    let snapshot: unknown;
    if (spec.patchSnapshot && current !== undefined) {
      snapshot = await spec.patchSnapshot(
        root,
        current,
        {
          mode: "paths",
          changed: toIndexFiles(root, changedUris),
          deleted: toIndexFiles(root, deletedUris),
        },
        context
      );
      if (!isCurrent()) throw new WorkspaceIndexBuildCancelled();
    }
    if (snapshot === undefined) {
      snapshot = await spec.build(root, toIndexFiles(root, files.values()), context);
      if (!isCurrent()) throw new WorkspaceIndexBuildCancelled();
    }
    return { snapshot, changedUris, scannedFiles: [...files.values()] };
  }

  private async routeCreatedUri(uri: TUri, reason: string): Promise<void> {
    if (this.disposed) return;
    const root = this.resolveRoot(uri);
    if (!root) return;
    const relPath = relativePathFromRoot(root, uri);
    if (this.specsForPath(root, relPath).length === 0) return;

    let statType: WorkspaceIndexStatType;
    try {
      statType = await this.host.stat(uri);
    } catch {
      this.routeUnavailableUri(uri, `${reason}-unavailable`);
      return;
    }
    if (this.disposed) return;
    if (statType === "missing") {
      this.routeUnavailableUri(uri, `${reason}-unavailable`);
      return;
    }

    const activeRoot = this.resolveRoot(uri);
    if (!activeRoot) return;
    const activeRel = relativePathFromRoot(activeRoot, uri);
    for (const registration of this.specsForPath(activeRoot, activeRel)) {
      if (statType === "file" && !this.matchesSpec(registration, activeRel)) continue;
      this.requestRefresh(
        registration.spec.kind,
        activeRoot,
        reason,
        false,
        true,
        "paths",
        uri
      );
    }
  }

  private routeUnavailableUri(uri: TUri, reason: string): void {
    if (this.disposed) return;
    const root = this.resolveRoot(uri);
    if (!root) return;
    const rootKey = canonicalRootKey(root);
    const relPath = relativePathFromRoot(root, uri);
    const comparisonPath = trimTrailingSlash(indexComparisonPath(uri));
    const candidates = this.specsForPath(root, relPath);
    if (candidates.length === 0) return;

    const anyMatchesLeaf = candidates.some((reg) => this.matchesSpec(reg, relPath));
    for (const registration of candidates) {
      const { kind } = registration.spec;
      const scanKey = this.scanKey(kind, rootKey);
      const dirs = this.indexedDirs.get(scanKey);
      const matchesLeaf = this.matchesSpec(registration, relPath);
      const holdsDir = dirs?.has(comparisonPath) ?? false;
      const conservativeUnscanned = dirs === undefined && !anyMatchesLeaf;
      if (matchesLeaf || holdsDir || conservativeUnscanned) {
        this.requestRefresh(kind, root, reason, false, true, "paths", uri);
      }
    }
  }

  private specsForPath(root: TUri, relPath: string): SpecRegistration<TUri>[] {
    const out: SpecRegistration<TUri>[] = [];
    for (const registration of this.specs.values()) {
      if (!this.exclusionPolicy(registration.spec.kind, root).excludes(relPath)) {
        out.push(registration);
      }
    }
    return out;
  }

  private matchesSpec(registration: SpecRegistration<TUri>, relPath: string): boolean {
    if (!registration.matcher.match(relPath)) return false;
    return !registration.spec.matchesPath || registration.spec.matchesPath(relPath);
  }

  private invalidate(kind: string, root: TUri): number {
    const rootKey = canonicalRootKey(root);
    const state = this.runtimeState(kind, rootKey);
    state.dirtyEpoch++;
    return this.bumpGeneration(this.scanKey(kind, rootKey));
  }

  private notifyLargeRoot(root: TUri, notice: WorkspaceIndexNotice<TUri>): void {
    const key = canonicalRootKey(root);
    if (this.notifiedRoots.has(key)) return;
    this.notifiedRoots.add(key);
    this.host.onNotice?.(notice);
  }

  private exclusionPolicy(kind: string, root: TUri): ExclusionPolicy {
    const rootKey = canonicalRootKey(root);
    const scanKey = this.scanKey(kind, rootKey);
    let policy = this.exclusions.get(scanKey);
    if (!policy) {
      const config = this.host.exclusions?.(root);
      const base = config?.excludes ?? DEFAULT_INDEX_EXCLUDES;
      const extra = config?.extra ?? [];
      const specExclude = this.specs.get(kind)?.spec.exclude;
      const patterns = specExclude ? [...base, ...extra, specExclude] : [...base, ...extra];
      policy = new ExclusionPolicy(patterns);
      this.exclusions.set(scanKey, policy);
    }
    return policy;
  }

  private bumpGeneration(scanKey: string): number {
    this.cancelScan(scanKey);
    return this.generations.bump(scanKey);
  }

  private cancelScan(scanKey: string): void {
    const cancellation = this.scanCancellations.get(scanKey);
    if (!cancellation) return;
    this.scanCancellations.delete(scanKey);
    cancellation.abort();
  }

  private runtimeState(kind: string, rootKey: string): RuntimeState {
    const scanKey = this.scanKey(kind, rootKey);
    let state = this.runtime.get(scanKey);
    if (!state) {
      state = {
        status: "notReady",
        lastSuccessAt: undefined,
        dirtyEpoch: 0,
        completedEpoch: 0,
        inFlight: false,
        inFlightGeneration: undefined,
      };
      this.runtime.set(scanKey, state);
    }
    return state;
  }

  private setSnapshot(kind: string, root: TUri, snapshot: unknown, version: number): void {
    const rootKey = canonicalRootKey(root);
    this.snapshots.get(kind)?.set(rootKey, snapshot);
    this.versions.get(kind)?.set(rootKey, version);
  }

  private bumpVersion(kind: string, rootKey: string): number {
    const byRoot = this.versions.get(kind);
    const next = (byRoot?.get(rootKey) ?? 0) + 1;
    byRoot?.set(rootKey, next);
    return next;
  }

  private scanKey(kind: string, rootKey: string): string {
    return `${kind}\0${rootKey}`;
  }

  private trackRouting(promise: Promise<void>): void {
    this.activeRouting.add(promise);
    void promise.finally(() => {
      this.activeRouting.delete(promise);
      this.checkSettled();
    });
  }

  private trackScan(promise: Promise<void>): Promise<void> {
    this.activeScans.add(promise);
    void promise.finally(() => {
      this.activeScans.delete(promise);
      this.checkSettled();
    });
    return promise;
  }

  private isSettled(): boolean {
    return (
      this.initializingCount === 0 &&
      this.activeRouting.size === 0 &&
      this.timers.size === 0 &&
      this.activeScans.size === 0
    );
  }

  private checkSettled(): void {
    if (!this.isSettled()) return;
    for (const resolve of [...this.settledWaiters]) {
      this.settledWaiters.delete(resolve);
      resolve();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generations.invalidateAll();
    for (const key of [...this.scanCancellations.keys()]) this.cancelScan(key);
    for (const timer of this.timers.values()) this.timerApi.clearTimeout(timer);
    for (const timer of this.fullRefreshTimers.values()) this.timerApi.clearTimeout(timer);
    this.timers.clear();
    this.fullRefreshTimers.clear();
    this.pending.clear();
    this.workspaceWatcher?.dispose();
    this.workspaceWatcher = undefined;
    for (const registration of this.specs.values()) {
      registration.disposed = true;
      registration.watchDisposable?.dispose();
      registration.watchDisposable = undefined;
      registration.listeners.clear();
    }
    this.checkSettled();
  }
}
