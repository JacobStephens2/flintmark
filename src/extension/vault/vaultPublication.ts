import {
  buildVaultIndex,
  buildVaultIndexCooperatively,
  VaultIndexBuildCancelled,
  type NoteEntry,
  type NoteInput,
  type VaultIndex,
} from "./vaultIndex";
import type { VaultData } from "../../shared/protocol";
import { copyVaultData } from "../../shared/vaultData";

/** Read-only view of an already published per-root note snapshot. URI values
 * remain opaque: only their exact string keys participate in graph queries. */
export interface VaultPublicationSnapshot<TUri> {
  readonly inputs: ReadonlyMap<string, NoteInput>;
  readonly uris: ReadonlyMap<string, TUri>;
}

export interface VaultPublicationSource<TUri> {
  snapshot(root: TUri): VaultPublicationSnapshot<TUri> | undefined;
  snapshots(): Iterable<VaultPublicationSnapshot<TUri>>;
  requestRefresh(root: TUri, reason: "content-patch-missing" | "content-patch-index-missing"): void;
}

export interface VaultPublicationOptions {
  onDidChange: () => void;
  onError: (error: unknown) => void;
  now?: () => number;
  yieldNow?: () => Promise<void>;
}

/** Orders refreshes into the last complete, globally queryable publication.
 * Active rebuilds finish before one coalesced follow-up reads the latest roots. */
export class VaultPublication<TUri> {
  private index = buildVaultIndex([]);
  private uris = new Map<string, TUri>();
  private vaultData: VaultData = { notes: [], tags: [] };
  private generation = 0;
  private activeBuild: number | undefined;
  private rebuildPending = false;
  private currentBuild: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly source: VaultPublicationSource<TUri>,
    private readonly options: VaultPublicationOptions
  ) {}

  requestRebuild(): void {
    if (this.disposed) return;
    if (this.activeBuild !== undefined) {
      this.rebuildPending = true;
      return;
    }
    const generation = ++this.generation;
    this.activeBuild = generation;
    this.currentBuild = this.rebuild(generation);
  }

  /** Capture this build once; later refresh traffic does not extend the wait. */
  waitForCurrentBuild(): Promise<void> {
    return this.currentBuild;
  }

  refreshContent(root: TUri, changedKeys: readonly string[]): void {
    if (this.disposed) return;
    const snapshot = this.source.snapshot(root);
    const inputs = changedKeys.flatMap((key) => {
      const input = snapshot?.inputs.get(key);
      return input ? [input] : [];
    });
    if (!snapshot || inputs.length !== changedKeys.length) {
      this.source.requestRefresh(root, "content-patch-missing");
      return;
    }
    if (this.activeBuild !== undefined) {
      this.requestRebuild();
      return;
    }
    // Validate the entire batch before changing any published note. Structural
    // work may have introduced notes absent from the last complete graph.
    this.generation++;
    if (inputs.some((input) => !this.index.getNote(input.path))) {
      this.source.requestRefresh(root, "content-patch-index-missing");
      return;
    }
    for (const input of inputs) this.index.replaceNoteContent(input);
    this.vaultData = makeVaultData(this.index);
    this.currentBuild = Promise.resolve();
    this.options.onDidChange();
  }

  getAllNotes(): NoteEntry[] { return this.index.getAllNotes(); }
  getBacklinks(path: string): string[] { return this.index.getBacklinks(path); }
  getOutgoingLinks(path: string): string[] { return this.index.getOutgoingLinks(path); }
  getUnresolvedLinks(path: string): string[] { return this.index.getUnresolvedLinks(path); }
  getTagged(tag: string): string[] { return this.index.getTagged(tag); }
  getAllTags(): string[] { return this.index.getAllTags(); }
  getVaultData(): VaultData { return copyVaultData(this.vaultData); }
  resolveLink(name: string): string | null { return this.index.resolveLink(name); }
  resolveLinkUri(name: string): TUri | undefined {
    const path = this.index.resolveLink(name);
    return path ? this.uris.get(path) : undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.rebuildPending = false;
  }

  private async rebuild(generation: number): Promise<void> {
    try {
      // Capture every root before the first await. Follow-ups capture again,
      // preserving input order/duplicates and last-wins URI keys.
      const inputs: NoteInput[] = [];
      const uris = new Map<string, TUri>();
      for (const snapshot of this.source.snapshots()) {
        inputs.push(...snapshot.inputs.values());
        for (const [key, uri] of snapshot.uris) uris.set(key, uri);
      }
      const index = await buildVaultIndexCooperatively(inputs, {
        now: this.options.now ?? monotonicNow,
        yieldNow: this.options.yieldNow ?? yieldImmediate,
        shouldCancel: () => this.disposed || generation !== this.generation,
        maxSliceMs: 8,
      });
      if (this.disposed || generation !== this.generation) return;
      const vaultData = makeVaultData(index);
      this.index = index;
      this.uris = uris;
      this.vaultData = vaultData;
      this.options.onDidChange();
    } catch (error) {
      if (!(error instanceof VaultIndexBuildCancelled)) this.options.onError(error);
    } finally {
      if (this.activeBuild === generation) this.activeBuild = undefined;
      if (!this.disposed && this.rebuildPending) {
        this.rebuildPending = false;
        this.requestRebuild();
      }
    }
  }
}

function makeVaultData(index: VaultIndex): VaultData {
  const notes = [
    ...new Set(index.getAllNotes().map((note) => note.name).filter((name) => name.length > 0)),
  ].sort();
  return { notes, tags: index.getAllTags() };
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function yieldImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
