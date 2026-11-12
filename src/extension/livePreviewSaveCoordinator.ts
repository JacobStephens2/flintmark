import { SerialQueue } from "./serialQueue";
import type { HostMsg } from "../shared/protocol";

type SaveDocument = {
  readonly uri: { toString(): string };
  readonly isClosed: boolean;
  readonly isDirty: boolean;
  save(): PromiseLike<boolean>;
};
type SavePeer = {
  readonly webview: {
    postMessage(message: Extract<HostMsg, { type: "flush" }>): boolean | PromiseLike<boolean>;
  };
};
type SaveOptions<Document, Peer> = {
  editQueue: SerialQueue;
  /** Undefined means the provider has no panels for this document. */
  readyPeers(key: string): readonly Peer[] | undefined;
  hasConflicts(key: string): boolean;
  forceSave(document: Document): PromiseLike<unknown>;
  reportError(error: unknown): void;
};
type FlushWaiter<Peer> = {
  peer: Peer;
  receipt(): void;
  finish(error?: unknown): void;
};
type NativeSave = {
  pending: Promise<void>;
  synchronized: boolean;
  finishWait(): void;
};

/** Owns the Save barrier (GLOSSARY.md#save-barrier) and persistence lifecycle.
 * The adapter supplies the SAME edit queue used by collaboration, and the
 * current ready peers rather than a second readiness registry. */
export class LivePreviewSaveCoordinator<
  Document extends SaveDocument,
  Peer extends SavePeer,
> {
  private readonly saveQueue = new SerialQueue();
  private nextFlushId = 0;
  private readonly flushWaiters = new Map<number, FlushWaiter<Peer>>();
  private readonly saving = new Set<string>();
  private readonly nativeSaves = new Map<string, NativeSave>();
  private disposed = false;

  constructor(private readonly options: SaveOptions<Document, Peer>) {}

  /** Includes remote input even when the host document starts clean. */
  saveDocument(document: Document): Promise<boolean> {
    return this.persist(document, () => this.synchronize(document), () => document.save());
  }

  /** Return synchronously so the host can register waitUntil in its listener.
   * Yield at 1,000 ms, within the host's shared 1.5 second participant budget. */
  participateNativeSave(document: Document): Promise<void> | undefined {
    const key = document.uri.toString();
    if (this.disposed || document.isClosed || this.saving.has(key)) return;
    const peers = this.options.readyPeers(key);
    if (!peers) return;
    const pending = this.synchronize(document, peers);
    const record: NativeSave = { pending, synchronized: false, finishWait: () => {} };
    this.nativeSaves.set(key, record);
    return new Promise<void>(resolve => {
      let yielded = false;
      const timer = setTimeout(() => { yielded = true; resolve(); }, 1000);
      record.finishWait = () => { clearTimeout(timer); resolve(); };
      void pending.then(() => {
        // Completion during an already-started disk write does not establish
        // that its bytes include the synchronized input.
        if (!yielded) record.synchronized = true;
        record.finishWait();
      }, error => { this.options.reportError(error); record.finishWait(); });
    });
  }

  /** The host calls this only after its native disk write has completed. */
  async completeNativeSave(document: Document): Promise<void> {
    const key = document.uri.toString();
    const record = this.nativeSaves.get(key);
    if (!record) return;
    this.nativeSaves.delete(key);
    if (record.synchronized || this.disposed || document.isClosed) return;
    // Participation already reports barrier errors; report only write errors
    // here. Consume the record before the forced command emits native events.
    try { await record.pending; } catch { return; }
    if (this.disposed || document.isClosed) return;
    try {
      await this.persist(document, () => record.pending, async () => {
        // Older writes can clear dirty state with synchronized edits in memory.
        await this.options.forceSave(document);
        if (document.isDirty) throw new Error("The document was not saved.");
      });
    } catch (error) { this.options.reportError(error); }
  }

  acknowledge(peer: Peer, requestId: number): void {
    const waiter = this.flushWaiters.get(requestId);
    if (waiter?.peer === peer) waiter.receipt();
  }

  cancelPeer(peer: Peer): void {
    for (const waiter of this.flushWaiters.values()) {
      if (waiter.peer === peer) waiter.finish(new Error("Live Preview closed during save synchronization."));
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const waiter of this.flushWaiters.values()) {
      waiter.finish(new Error("The editor was disposed during save."));
    }
    for (const record of this.nativeSaves.values()) record.finishWait();
    this.nativeSaves.clear();
    // Keep queued chains ordered. A write already executing may settle; queued
    // work checks disposal before entering persistence. The edit queue is shared.
  }

  private assertOpen(document: Document): void {
    if (this.disposed) throw new Error("The editor was disposed during save.");
    if (document.isClosed) throw new Error("Live Preview closed during save synchronization.");
  }

  private persist<T>(document: Document, barrier: () => Promise<void>, write: () => PromiseLike<T>): Promise<T> {
    const key = document.uri.toString();
    return this.saveQueue.run(key, async () => {
      this.assertOpen(document);
      await barrier();
      // Later collaborative edits must stay behind the entire disk write.
      return this.options.editQueue.run(key, async () => {
        this.assertOpen(document);
        if (this.options.hasConflicts(key)) throw new Error("Live Preview has unsynchronized edits.");
        this.saving.add(key);
        try { return await write(); }
        finally { this.saving.delete(key); }
      });
    });
  }

  private async synchronize(document: Document, peers = this.options.readyPeers(document.uri.toString()) ?? []): Promise<void> {
    this.assertOpen(document);
    const requests = [...peers].map(peer => this.requestFlush(peer));
    try { await Promise.all(requests.map(request => request.pending)); }
    catch (error) {
      // A failed barrier owns and cancels its remaining requests too.
      for (const request of requests) request.finish(error);
      throw error;
    }
    await this.options.editQueue.drain(document.uri.toString());
    this.assertOpen(document);
    if (this.options.hasConflicts(document.uri.toString())) {
      throw new Error("Live Preview has unsynchronized edits. Retry synchronization or save a recovery copy.");
    }
  }

  private requestFlush(peer: Peer): { pending: Promise<void>; finish(error?: unknown): void } {
    const requestId = ++this.nextFlushId;
    let finish!: (error?: unknown) => void;
    const pending = new Promise<void>((resolve, reject) => {
      let settled = false, delivered = false, acknowledged = false;
      const timer = setTimeout(() => finish(new Error("A Live Preview did not respond to the save request. Your edits remain unsaved.")), 5000);
      finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.flushWaiters.delete(requestId);
        if (error !== undefined) reject(error); else resolve();
      };
      this.flushWaiters.set(requestId, {
        peer, finish,
        receipt: () => { acknowledged = true; if (delivered) finish(); },
      });
      try {
        Promise.resolve(peer.webview.postMessage({ type: "flush", requestId })).then(sent => {
          if (!sent) finish(new Error("Live Preview closed before confirming its pending edits."));
          else { delivered = true; if (acknowledged) finish(); }
        }, error => finish(error instanceof Error ? error : new Error(String(error))));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    return { pending, finish };
  }
}
