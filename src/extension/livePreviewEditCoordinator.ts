import { ChangeSet } from "@codemirror/state";
import type { Update } from "@codemirror/collab";
import { CollaborationAuthority, decodeUpdates, encodeUpdates, extendsPendingUpdates } from "../shared/collaboration";
import { hostToCmOffset } from "../shared/ranges";
import type { DocChange, HostMsg, WebviewMsg } from "../shared/protocol";
import { SerialQueue } from "./serialQueue";

type EditDocument = { readonly uri: { toString(): string } };
type EditPeer = { readonly webview: { postMessage(message: HostMsg): boolean | PromiseLike<boolean> } };
type EditMessage = Extract<WebviewMsg, { type: "edit" }>;
export type DocumentSnapshot = { text: string; version: number; crlf: boolean };
/** Pre-event host coordinates, paired with a synchronously captured post-event snapshot. */
export type HostDocumentChange = {
  rangeOffset: number;
  rangeLength: number;
  startLine: number;
  endLine: number;
  text: string;
};
export type EditHost<Document> = {
  read(document: Document): DocumentSnapshot;
  apply(document: Document, changes: readonly DocChange[]): PromiseLike<boolean>;
};
type EditOptions<Document, Peer> = {
  editQueue: SerialQueue;
  host: EditHost<Document>;
  registeredPeers(key: string): readonly Peer[] | undefined;
  readyPeers(key: string): readonly Peer[] | undefined;
  notifyConflict(document: Document): void;
  notifyRecovery(key: string): void;
};
type BufferedChange = DocumentSnapshot & { changes: readonly HostDocumentChange[] };
type PendingApply = {
  updates: readonly Update[];
  expected: string;
  baseVersion: number;
  events: BufferedChange[];
};
const normalized = (text: string) => text.replace(/\r\n?|\n/g, "\n");

function docChanges(changes: readonly HostDocumentChange[], crlf: boolean): DocChange[] {
  return changes.map(c => ({
    from: crlf ? hostToCmOffset(c.rangeOffset, c.startLine) : c.rangeOffset,
    to: crlf ? hostToCmOffset(c.rangeOffset + c.rangeLength, c.endLine) : c.rangeOffset + c.rangeLength,
    insert: c.text,
  }));
}

/** Owns Live Preview edit synchronization (GLOSSARY.md). The caller supplies
 * the SAME queue as native commands and the Save barrier, and live peer lookups. */
export class LivePreviewEditCoordinator<Document extends EditDocument, Peer extends EditPeer> {
  private readonly authorities = new Map<string, CollaborationAuthority>();
  private readonly documents = new WeakMap<CollaborationAuthority, Document>();
  private readonly waiting = new Map<string, { peer: Peer; message: EditMessage; tail: Promise<unknown> }>();
  private readonly pending = new Map<string, PendingApply>();
  private readonly conflicts = new Map<string, Map<EditMessage, Peer>>();
  private readonly recoveryCopies = new Map<string, string[]>();

  constructor(private readonly options: EditOptions<Document, Peer>) {}

  async initialize(document: Document, deliver: (snapshot: { text: string; version: number; syncVersion: number }) => void): Promise<void> {
    const key = document.uri.toString();
    await this.options.editQueue.drain(key);
    const snapshot = this.options.host.read(document);
    const authority = this.authority(document, snapshot);
    // Delivery and caller readiness happen in this turn, without another await.
    deliver({ text: snapshot.text, version: snapshot.version, syncVersion: authority.version });
    if (this.hasConflicts(key)) this.options.notifyConflict(document);
  }

  submit(document: Document, peer: Peer, message: EditMessage): void {
    const key = document.uri.toString(), queue = this.options.editQueue;
    const waiting = this.waiting.get(key);
    if (waiting && waiting.peer === peer && waiting.tail === queue.idle(key) &&
        extendsPendingUpdates(waiting.message, message)) {
      waiting.message = message;
      return;
    }
    const batch = { peer, message, tail: queue.idle(key) };
    const queued = queue.run(key, async () => {
      if (this.waiting.get(key) === batch) this.waiting.delete(key);
      try {
        await this.applyInput(document, batch.message);
        this.clearAcknowledgedConflicts(key);
      } catch (error) {
        // Retain before the queue settles, so a drained Save barrier sees it.
        const conflicts = this.conflicts.get(key) ?? new Map();
        conflicts.set(batch.message, peer);
        this.conflicts.set(key, conflicts);
        console.error("[ofm] collaboration edit failed", error);
        if (this.options.registeredPeers(key)?.includes(peer)) {
          void Promise.resolve(peer.webview.postMessage({ type: "syncError", message: String(error) })).catch(() => undefined);
        }
        this.options.notifyConflict(document);
      } finally {
        if (!this.options.registeredPeers(key)?.length) this.lastPeerClosed(key);
      }
    });
    batch.tail = queued;
    this.waiting.set(key, batch);
  }

  observe(document: Document, changes: readonly HostDocumentChange[]): void {
    const key = document.uri.toString(), authority = this.authorities.get(key);
    const snapshot = this.options.host.read(document);
    if (authority) {
      if (!changes.length && authority.crlf === snapshot.crlf) return;
      const event = { ...snapshot, text: normalized(snapshot.text), changes: changes.map(change => ({ ...change })) };
      const pending = this.pending.get(key);
      if (pending) pending.events.push(event);
      else this.applyExternalChange(key, authority, event);
      return;
    }
    // Before init there is no collaboration history. Preserve the existing
    // incremental/full-replacement protocol for panels still starting up.
    const converted = docChanges(changes, snapshot.crlf);
    const hostTo = changes[0] && changes[0].rangeOffset + changes[0].rangeLength;
    const message: HostMsg = converted.length === 1 && converted[0].from === 0 &&
      (hostTo >= snapshot.text.length || converted[0].insert === snapshot.text)
      ? { type: "replaceAll", version: snapshot.version, text: snapshot.text }
      : { type: "applyEdit", version: snapshot.version, origin: "host", changes: converted };
    for (const peer of this.options.registeredPeers(key) ?? []) peer.webview.postMessage(message);
  }

  lastPeerClosed(key: string): void {
    const tail = this.options.editQueue.idle(key);
    const release = () => {
      if (this.options.editQueue.idle(key) !== tail) this.lastPeerClosed(key);
      else if (!this.options.registeredPeers(key)?.length && !this.hasConflicts(key)) this.authorities.delete(key);
    };
    void tail.then(release, release);
  }

  hasConflicts(key: string): boolean { return this.conflicts.has(key); }

  retry(document: Document): void {
    this.authority(document);
    for (const [message, peer] of this.conflicts.get(document.uri.toString()) ?? []) this.submit(document, peer, message);
  }

  recoveryTexts(key: string): readonly string[] {
    const texts = [...(this.recoveryCopies.get(key) ?? [])];
    if (this.hasConflicts(key)) texts.push(this.recoveryText(key));
    return [...new Set(texts)];
  }

  private authority(document: Document, snapshot = this.options.host.read(document)): CollaborationAuthority {
    const key = document.uri.toString();
    let authority = this.authorities.get(key);
    if (authority && this.documents.get(authority) !== document && this.hasConflicts(key) &&
        !this.pending.has(key) && authority.doc.toString() !== normalized(snapshot.text)) {
      this.recoveryCopies.set(key, [...(this.recoveryCopies.get(key) ?? []), this.recoveryText(key)]);
      this.conflicts.delete(key);
      this.authorities.delete(key);
      authority = undefined;
      this.options.notifyRecovery(key);
    }
    if (!authority) {
      authority = new CollaborationAuthority(snapshot.text, snapshot.crlf);
      this.authorities.set(key, authority);
    }
    if (this.documents.get(authority) !== document) authority.crlf = snapshot.crlf;
    this.documents.set(authority, document);
    return authority;
  }

  private broadcast(key: string, version: number, updates: readonly Update[]): void {
    const message: HostMsg = { type: "syncUpdates", version, updates: encodeUpdates(updates) };
    for (const peer of this.options.readyPeers(key) ?? []) peer.webview.postMessage(message);
  }

  private async applyInput(document: Document, message: EditMessage): Promise<void> {
    const key = document.uri.toString(), deadline = Date.now() + 2000;
    for (let attempt = 0; ; attempt++) {
      const authority = this.authority(document);
      const updates = authority.prepare(message.syncVersion, decodeUpdates(message.updates));
      if (!updates.length) return;
      let combined = ChangeSet.empty(authority.doc.length);
      for (const update of updates) combined = combined.compose(update.changes);
      if (combined.empty) {
        authority.commit(updates);
        this.broadcast(key, this.options.host.read(document).version, updates);
        return;
      }
      const changes: DocChange[] = [];
      combined.iterChanges((from, to, _fromB, _toB, insert) => changes.push({ from, to, insert: insert.toString() }));
      const pending: PendingApply = {
        updates, expected: combined.apply(authority.doc).toString(),
        baseVersion: this.options.host.read(document).version, events: [],
      };
      this.pending.set(key, pending);
      let applied = false;
      try { applied = await this.options.host.apply(document, changes); }
      finally {
        this.pending.delete(key);
        this.reconcileApplyResult(key, authority, pending, applied, this.options.host.read(document).version);
      }
      if (applied) return;
      if (this.options.host.read(document).version === pending.baseVersion || Date.now() >= deadline) {
        throw new Error("VS Code could not apply your edit. Your local edits are still pending.");
      }
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(10 * (attempt + 1), 100)));
    }
  }

  private applyExternalChange(key: string, authority: CollaborationAuthority, event: BufferedChange): void {
    // An EOL-only full replacement must not rebase pending insertions to EOF.
    if (event.crlf !== authority.crlf && event.text === authority.doc.toString()) {
      authority.crlf = event.crlf;
      return;
    }
    const changes = ChangeSet.of(docChanges(event.changes, authority.crlf), authority.doc.length);
    authority.crlf = event.crlf;
    if (changes.empty) return;
    const updates = [{ clientID: "host", changes }];
    authority.commit(updates);
    this.broadcast(key, event.version, updates);
  }

  private reconcileApplyResult(key: string, authority: CollaborationAuthority, pending: PendingApply, applied: boolean, version: number): void {
    let acknowledged = false;
    for (const event of pending.events) {
      if (applied && !acknowledged && event.version === pending.baseVersion + 1 && event.text === pending.expected) {
        authority.commit(pending.updates);
        authority.crlf = event.crlf;
        this.broadcast(key, event.version, pending.updates);
        acknowledged = true;
      } else this.applyExternalChange(key, authority, event);
    }
    if (applied && !acknowledged) {
      if (!pending.events.length && authority.doc.toString() === pending.expected) {
        authority.commit(pending.updates);
        this.broadcast(key, version, pending.updates);
      } else throw new Error("The applied edit did not produce its expected document change.");
    }
  }

  private clearAcknowledgedConflicts(key: string): void {
    const conflicts = this.conflicts.get(key), authority = this.authorities.get(key);
    for (const failed of conflicts?.keys() ?? []) {
      try {
        if (authority && !authority.prepare(failed.syncVersion, decodeUpdates(failed.updates)).length) conflicts!.delete(failed);
      } catch (error) { console.error("[ofm] retained edit could not be checked for acknowledgment", error); }
    }
    if (conflicts && !conflicts.size) this.conflicts.delete(key);
  }

  private recoveryText(key: string): string {
    const authority = this.authorities.get(key);
    if (!authority) return this.recoveryCopies.get(key)?.at(-1) ?? "";
    const copy = new CollaborationAuthority(authority.doc.toString(), authority.crlf);
    copy.updates.push(...authority.updates);
    for (const message of this.conflicts.get(key)?.keys() ?? []) copy.commit(copy.prepare(message.syncVersion, decodeUpdates(message.updates)));
    return copy.crlf ? copy.doc.toString().replace(/\n/g, "\r\n") : copy.doc.toString();
  }
}
