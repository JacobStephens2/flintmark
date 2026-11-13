import * as vscode from "vscode";
import { LivePreviewEditCoordinator } from "../../../src/extension/livePreviewEditCoordinator";
import { LivePreviewEditHost, hostDocumentChanges } from "../../../src/extension/livePreviewEditHost";
import { LivePreviewSaveCoordinator } from "../../../src/extension/livePreviewSaveCoordinator";
import { SerialQueue } from "../../../src/extension/serialQueue";
import type { HostMsg } from "../../../src/shared/protocol";

type Peer = { webview: { postMessage(message: HostMsg): boolean | PromiseLike<boolean> } };

/** Simulate only panel transport; keep the concrete host, queue and both protocols. */
export function livePreviewFixture(document: vscode.TextDocument, subscriptions: vscode.Disposable[]) {
  const queue = new SerialQueue(), peers = new Set<Peer>();
  const concrete = new LivePreviewEditHost();
  const host = {
    read: (doc: vscode.TextDocument) => concrete.read(doc),
    apply: (doc: vscode.TextDocument, changes: Parameters<LivePreviewEditHost["apply"]>[1]) => concrete.apply(doc, changes),
  };
  const currentPeers = (key: string) => key === document.uri.toString() ? [...peers] : undefined;
  const edits = new LivePreviewEditCoordinator<vscode.TextDocument, Peer>({
    editQueue: queue, host, registeredPeers: currentPeers, readyPeers: currentPeers,
    notifyConflict: () => {}, notifyRecovery: () => {},
  });
  const saves = new LivePreviewSaveCoordinator<vscode.TextDocument, Peer>({
    editQueue: queue, readyPeers: currentPeers, hasConflicts: key => edits.hasConflicts(key),
    forceSave: doc => vscode.commands.executeCommand("workbench.action.files.save", doc.uri),
    reportError: error => { console.error("[integration] save failure", error); },
  });
  subscriptions.push(saves,
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === document) edits.observe(event.document, hostDocumentChanges(event));
    }),
    vscode.workspace.onWillSaveTextDocument(event => {
      if (event.document !== document) return;
      const wait = saves.participateNativeSave(event.document);
      if (wait) event.waitUntil(wait.then(() => []));
    }),
    vscode.workspace.onDidSaveTextDocument(doc => { if (doc === document) void saves.completeNativeSave(doc); }),
  );
  return {
    edits, saves, host, queue,
    addPeer: (peer: Peer) => { peers.add(peer); },
    closePeer: (peer: Peer) => {
      peers.delete(peer); saves.cancelPeer(peer);
      if (!peers.size) edits.lastPeerClosed(document.uri.toString());
    },
  };
}
