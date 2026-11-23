import * as vscode from "vscode";
import { LivePreviewEditHost } from "../../../src/extension/livePreviewEditHost";
import { createLivePreviewSynchronization } from "../../../src/extension/livePreviewSynchronizationHost";
import type { LivePreviewSynchronizationOptions } from "../../../src/extension/livePreviewSynchronization";
import type { HostMsg } from "../../../src/shared/protocol";

export type Peer = { webview: { postMessage(message: HostMsg): boolean | PromiseLike<boolean> } };

/** Simulate panel transport while using the production TextDocument adapter. */
export function livePreviewFixture(
  document: vscode.TextDocument,
  subscriptions: vscode.Disposable[],
  executeHistory?: LivePreviewSynchronizationOptions<vscode.TextDocument>["executeHistory"],
) {
  const concrete = new LivePreviewEditHost();
  const host = { read: concrete.read.bind(concrete), apply: concrete.apply.bind(concrete) };
  const adapter = createLivePreviewSynchronization<Peer>({
    host,
    executeHistory,
    notifyConflict: () => {},
    notifyRecovery: () => {},
    reportError: error => { console.error("[integration] save failure", error); },
  });
  subscriptions.push(adapter);
  const { synchronization } = adapter;
  return {
    synchronization,
    host,
    async openPeer(peer: Peer) {
      synchronization.registerPeer(document, peer);
      await synchronization.initializePeer(document, peer, () => ({
        settings: {},
        theme: { id: "integration", cssUri: null },
      }));
    },
  };
}

export async function waitForSynchronization(accepted: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!accepted()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for " + description);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}
