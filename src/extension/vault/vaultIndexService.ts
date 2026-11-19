// Vault Index · thin VS Code adapter (MAY import vscode).
//
// Publication ordering and queries live in vaultPublication.ts; WorkspaceIndex
// owns scanning and watching. This adapter reads/patches root note snapshots
// and converts VS Code query arguments to opaque URI strings.
// Typical use:
//   const svc = new VaultIndexService();
//   await svc.initialize();
//   context.subscriptions.push(svc);
//   const uri = svc.resolveLinkUri("Some Note");

import * as vscode from "vscode";
import type { NoteEntry, NoteInput } from "./vaultIndex";
import { VaultPublication } from "./vaultPublication";
import type { VaultData } from "../../shared/protocol";
import { waitForVaultBuildGate } from "./vaultBuildGate";
import { mapInCooperativeBatches } from "./cooperativeBatches";
import { patchNoteSnapshot, type NoteSnapshot } from "./vaultSnapshot";
import {
  WorkspaceIndex,
  WorkspaceIndexBuildCancelled,
  type WorkspaceIndexBuildContext,
  type WorkspaceIndexDisposable,
  type WorkspaceIndexFile,
  type WorkspaceIndexHandle,
  type WorkspaceIndexPatch,
} from "./workspaceIndexing";
import { createVscodeWorkspaceIndex } from "./workspaceIndexHost";

const MD_GLOB = "**/*.{md,markdown}";
const REBUILD_DEBOUNCE_MS = 50;
const READ_CONCURRENCY = 32;

type VaultRootSnapshot = NoteSnapshot<vscode.Uri>;

function emptyRootSnapshot(): VaultRootSnapshot {
  return { inputs: new Map(), uris: new Map() };
}

export class VaultIndexService implements vscode.Disposable {
  private readonly index: WorkspaceIndex<vscode.Uri>;
  private readonly ownsIndex: boolean;
  private readonly handle: WorkspaceIndexHandle<VaultRootSnapshot, vscode.Uri>;
  private readonly publication: VaultPublication<vscode.Uri>;
  private readonly refreshSub: WorkspaceIndexDisposable;
  private readonly decoder = new TextDecoder();

  /** Fires after every publication so views can refresh (e.g. push
   *  fresh autocomplete data to webviews). */
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(index?: WorkspaceIndex<vscode.Uri>) {
    this.index = index ?? createVscodeWorkspaceIndex();
    this.ownsIndex = index === undefined;
    this.handle = this.index.register<VaultRootSnapshot>({
      kind: "note",
      include: MD_GLOB,
      debounceMs: REBUILD_DEBOUNCE_MS,
      watchContent: true,
      notReady: emptyRootSnapshot,
      build: (root, files, context) => this.buildSnapshot(root, files, context),
      patchSnapshot: (_root, snapshot, patch, context) =>
        this.patchSnapshot(snapshot, patch, context),
    });
    this.publication = new VaultPublication({
      snapshot: (root) => this.handle.snapshot(root),
      snapshots: () => this.handle.snapshots().map(({ snapshot }) => snapshot),
      requestRefresh: (root, reason) => this.handle.requestRefresh(root, reason, true),
    }, {
      onDidChange: () => this._onDidChange.fire(),
      onError: (error) => console.error("[ofm] vault index rebuild failed", error),
    });
    this.refreshSub = this.handle.onDidRefresh((event) => {
      if (event.mode === "content") {
        this.publication.refreshContent(event.root, event.changedUris.map((uri) => uri.toString()));
      } else this.publication.requestRebuild();
    });
  }

  /** Scan the workspace and start watching. Safe to await once at activation. */
  async initialize(): Promise<void> {
    await this.index.initialize();
    await this.publication.waitForCurrentBuild();
  }

  // ----- queries (delegate straight to the pure core) --------------------

  getAllNotes(): NoteEntry[] {
    return this.publication.getAllNotes();
  }
  getBacklinks(uri: vscode.Uri): string[] {
    return this.publication.getBacklinks(uri.toString());
  }
  getOutgoingLinks(uri: vscode.Uri): string[] {
    return this.publication.getOutgoingLinks(uri.toString());
  }
  getUnresolvedLinks(uri: vscode.Uri): string[] {
    return this.publication.getUnresolvedLinks(uri.toString());
  }
  getTagged(tag: string): string[] {
    return this.publication.getTagged(tag);
  }
  getAllTags(): string[] {
    return this.publication.getAllTags();
  }

  /** Compact data for webview autocomplete: deduped note names + all tags. */
  getVaultData(): VaultData {
    return this.publication.getVaultData();
  }

  /** Resolve a wikilink target name → Note path string, or null. */
  resolveLink(name: string): string | null {
    return this.publication.resolveLink(name);
  }

  /** Resolve a wikilink target name → openable Uri, or undefined. */
  resolveLinkUri(name: string): vscode.Uri | undefined {
    return this.publication.resolveLinkUri(name);
  }

  private async buildSnapshot(
    _root: vscode.Uri,
    files: readonly WorkspaceIndexFile<vscode.Uri>[],
    context: WorkspaceIndexBuildContext<vscode.Uri>
  ): Promise<VaultRootSnapshot> {
    await waitForVaultBuildGate(process.env.FLINTMARK_TEST_VAULT_BUILD_GATE);
    if (!context.isCurrent()) throw new WorkspaceIndexBuildCancelled();
    const inputs = new Map<string, NoteInput>();
    const uris = new Map<string, vscode.Uri>();
    const results = await mapInCooperativeBatches(
      files,
      READ_CONCURRENCY,
      async ({ uri }): Promise<{ input: NoteInput; uri: vscode.Uri } | undefined> => {
        try {
          const bytes = await context.readFile(uri);
          const key = uri.toString();
          return { input: { path: key, text: this.decoder.decode(bytes) }, uri };
        } catch {
          // Unreadable/deleted mid-scan: omit it from this reconciled snapshot.
          return undefined;
        }
      },
      {
        assertCurrent: () => {
          if (!context.isCurrent()) throw new WorkspaceIndexBuildCancelled();
        },
        // readFile already yields for I/O, but this explicit macrotask boundary
        // prevents a hot cache from becoming one long microtask train.
        yieldNow: context.yieldNow,
      }
    );
    for (const result of results) {
      if (!result) continue;
      inputs.set(result.input.path, result.input);
      uris.set(result.input.path, result.uri);
    }
    return { inputs, uris };
  }

  private async patchSnapshot(
    snapshot: VaultRootSnapshot,
    patch: WorkspaceIndexPatch<vscode.Uri>,
    context: WorkspaceIndexBuildContext<vscode.Uri>
  ): Promise<VaultRootSnapshot | undefined> {
    return patchNoteSnapshot(
      snapshot,
      patch,
      (uri) => uri.toString(),
      async (uri) => this.decoder.decode(await context.readFile(uri)),
      () => {
        if (!context.isCurrent()) throw new WorkspaceIndexBuildCancelled();
      }
    );
  }

  dispose(): void {
    this.publication.dispose();
    this.refreshSub.dispose();
    this.handle.dispose();
    this._onDidChange.dispose();
    if (this.ownsIndex) this.index.dispose();
  }
}
