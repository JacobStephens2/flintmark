// Image/attachment index · thin VS Code adapter (MAY import vscode).
//
// Per workspace ROOT, it builds a PATH-ONLY snapshot of image files (no bytes
// read) so the editor hot path can resolve `![[img.png]]` / `![](img.png)`
// SYNCHRONOUSLY (see imageResolver.ts). Async work is confined to the initial
// build and the FileSystemWatcher-driven rescans; resolution itself never does
// I/O. On any (re)build it fires onDidChange so the provider can refresh open
// panels. In any non-"ready" state the provider falls back to legacy
// document-relative resolution (no regression for same-folder images).

import * as vscode from "vscode";
import { hasImageExtension, ImageSnapshot } from "./imageResolver";
import {
  DEFAULT_MAX_FILES,
  WorkspaceIndex,
  type WorkspaceIndexDisposable,
  type WorkspaceIndexHandle,
} from "./workspaceIndexing";
import { createVscodeWorkspaceIndex } from "./workspaceIndexHost";

const IMAGE_GLOB = "**/*.{png,jpg,jpeg,gif,svg,webp,bmp,avif}";
const RESCAN_DEBOUNCE_MS = 150;

export class ImageIndexService implements vscode.Disposable {
  private readonly index: WorkspaceIndex<vscode.Uri>;
  private readonly ownsIndex: boolean;
  private readonly handle: WorkspaceIndexHandle<ImageSnapshot, vscode.Uri>;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly refreshSub: WorkspaceIndexDisposable;

  /** Fires after any root's snapshot is (re)built. */
  readonly onDidChange = this.emitter.event;

  constructor(index?: WorkspaceIndex<vscode.Uri>) {
    this.index = index ?? createVscodeWorkspaceIndex();
    this.ownsIndex = index === undefined;
    this.handle = this.index.register<ImageSnapshot>({
      kind: "image",
      include: IMAGE_GLOB,
      matchesPath: hasImageExtension,
      debounceMs: RESCAN_DEBOUNCE_MS,
      // Content changes do not alter the path index, but a refresh event lets
      // open webviews re-request image URIs if the host reports a replacement.
      watchContent: true,
      maxFiles: () => this.maxFiles(),
      notReady: () => new ImageSnapshot([], "notReady"),
      build: async (_root, files) =>
        new ImageSnapshot(files.map((f) => f.relativePath)),
      patchSnapshot: async (_root, snapshot, patch) => {
        if (patch.mode === "content") return snapshot;
        return snapshot.patch(
          patch.changed.map((f) => f.relativePath),
          patch.deleted.map((f) => f.relativePath)
        );
      },
    });
    this.refreshSub = this.handle.onDidRefresh(() => this.emitter.fire());
  }

  private maxFiles(): number {
    return (
      vscode.workspace.getConfiguration("ofm").get<number>("imageIndex.maxFiles") ??
      DEFAULT_MAX_FILES
    );
  }

  /** Scan all workspace roots and start watching. Non-blocking at activation. */
  async initialize(): Promise<void> {
    await this.index.initialize();
  }

  /**
   * Resolve a raw image ref for a document to a file Uri inside its workspace
   * root, or null (caller falls back to legacy doc-relative). SYNCHRONOUS.
   */
  resolveImage(
    documentUri: vscode.Uri,
    rawPath: string,
    requireImageExt: boolean
  ): vscode.Uri | undefined {
    const resolved = this.handle.forDocument(documentUri);
    if (!resolved) return undefined; // single-file / outside any root → legacy
    const docDir = resolved.relativePath.split("/").slice(0, -1).filter((s) => s.length > 0);
    const entry = resolved.snapshot.resolve(docDir, rawPath, requireImageExt);
    if (!entry) return undefined;
    const uri = vscode.Uri.joinPath(resolved.root, ...entry.segments);
    return resolved.version > 0 ? uri.with({ query: `ofmIndex=${resolved.version}` }) : uri;
  }

  /** Open/ready documents ask for a fresh reconciliation asynchronously. This
   *  covers external directory moves or bulk creates that watchers may fold or
   *  miss; resolution itself remains synchronous and I/O-free. */
  ensureFreshForDocument(documentUri: vscode.Uri, reason = "document-ready"): void {
    this.handle.ensureFresh(documentUri, reason, {
      force: reason === "attachment-saved",
    });
  }

  dispose(): void {
    this.refreshSub.dispose();
    this.handle.dispose();
    this.emitter.dispose();
    if (this.ownsIndex) this.index.dispose();
  }
}
