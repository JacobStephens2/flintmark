import type { HostMsg } from "../shared/protocol";
import { LivePreviewEditCoordinator } from "./livePreviewEditCoordinator";
import type { EditHost, EditMessage, EditPeer, HostDocumentChange } from "./livePreviewEditCoordinator";
import { LivePreviewSaveCoordinator } from "./livePreviewSaveCoordinator";
import type { SaveDocument } from "./livePreviewSaveCoordinator";
import { SerialQueue } from "./serialQueue";

type InitPresentation = Pick<Extract<HostMsg, { type: "init" }>, "settings" | "theme" | "vault">;
type HistoryCommand = "undo" | "redo";
type PeerRegistration = { ready: boolean };

export type LivePreviewSynchronizationOptions<Document> = {
  host: EditHost<Document>;
  executeHistory(command: HistoryCommand, document: Document): PromiseLike<unknown>;
  forceSave(document: Document): PromiseLike<unknown>;
  notifyConflict(document: Document): void;
  notifyRecovery(uri: string): void;
  reportError(error: unknown): void;
};

/** Owns peer lifetime and ordering for Live Preview synchronization. */
export class LivePreviewSynchronization<Document extends SaveDocument, Peer extends EditPeer> {
  private readonly editQueue = new SerialQueue();
  private readonly peers = new Map<string, Map<Peer, PeerRegistration>>();
  private readonly edits: LivePreviewEditCoordinator<Document, Peer>;
  private readonly saves: LivePreviewSaveCoordinator<Document, Peer>;
  private disposal?: Promise<void>;

  constructor(private readonly options: LivePreviewSynchronizationOptions<Document>) {
    const readyPeers = (uri: string) => {
      const registrations = this.peers.get(uri);
      // Native save distinguishes no registered peers from an empty ready set.
      return registrations && [...registrations.keys()].filter(peer => this.isReady(uri, peer));
    };
    this.edits = new LivePreviewEditCoordinator({
      editQueue: this.editQueue,
      host: options.host,
      registeredPeers: uri => {
        const registrations = this.peers.get(uri);
        return registrations && [...registrations.keys()];
      },
      readyPeers,
      notifyConflict: options.notifyConflict,
      notifyRecovery: options.notifyRecovery,
    });
    this.saves = new LivePreviewSaveCoordinator({
      editQueue: this.editQueue,
      readyPeers,
      hasConflicts: uri => this.edits.hasConflicts(uri),
      forceSave: options.forceSave,
      reportError: options.reportError,
    });
  }

  registerPeer(document: Document, peer: Peer): void {
    if (this.disposal) return;
    const uri = document.uri.toString();
    let registrations = this.peers.get(uri);
    if (!registrations) {
      registrations = new Map();
      this.peers.set(uri, registrations);
    }
    if (!registrations.has(peer)) registrations.set(peer, { ready: false });
  }

  unregisterPeer(document: Document, peer: Peer): void {
    const uri = document.uri.toString();
    const registrations = this.peers.get(uri);
    if (!registrations?.delete(peer)) return;
    this.saves.cancelPeer(peer);
    if (registrations.size === 0) {
      this.peers.delete(uri);
      this.edits.lastPeerClosed(uri);
    }
  }

  isReady(uri: string, peer: Peer): boolean {
    return this.peers.get(uri)?.get(peer)?.ready ?? false;
  }

  async initializePeer(
    document: Document,
    peer: Peer,
    presentation: () => InitPresentation,
    afterReady?: () => void,
  ): Promise<void> {
    const uri = document.uri.toString();
    const registration = this.peers.get(uri)?.get(peer);
    if (!registration) return;
    const isCurrent = () => this.peers.get(uri)?.get(peer) === registration;
    await this.edits.initialize(document, snapshot => {
      const details = presentation();
      if (!isCurrent()) return;
      peer.webview.postMessage({ type: "init", uri, ...snapshot, ...details });
      if (!isCurrent()) return;
      registration.ready = true;
      afterReady?.();
    }, isCurrent);
  }

  submitEdit(document: Document, peer: Peer, message: EditMessage): void {
    if (this.peers.get(document.uri.toString())?.has(peer)) this.edits.submit(document, peer, message);
  }

  observeDocumentChange(document: Document, changes: readonly HostDocumentChange[]): void {
    this.edits.observe(document, changes);
  }

  async runHistoryCommand(document: Document, command: HistoryCommand): Promise<void> {
    if (this.disposal) return;
    await this.editQueue.run(document.uri.toString(), async () => {
      await this.options.executeHistory(command, document);
    });
  }

  saveDocument(document: Document): Promise<boolean> {
    return this.saves.saveDocument(document);
  }

  acknowledgeFlush(peer: Peer, requestId: number): void {
    this.saves.acknowledge(peer, requestId);
  }

  participateNativeSave(document: Document): Promise<void> | undefined {
    return this.saves.participateNativeSave(document);
  }

  completeNativeSave(document: Document): Promise<void> {
    return this.saves.completeNativeSave(document);
  }

  retry(document: Document): void {
    if (!this.disposal) this.edits.retry(document);
  }

  recoveryTexts(uri: string): readonly string[] {
    return this.edits.recoveryTexts(uri);
  }

  /** Keep observing document changes until received edits have settled. */
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposal = this.editQueue.drainAll();
      this.saves.dispose();
      const uris = [...this.peers.keys()];
      this.peers.clear();
      for (const uri of uris) this.edits.lastPeerClosed(uri);
    }
    return this.disposal;
  }
}
