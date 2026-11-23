import * as vscode from "vscode";
import type { EditHost, EditPeer } from "./livePreviewEditCoordinator";
import { LivePreviewEditHost, hostDocumentChanges } from "./livePreviewEditHost";
import { LivePreviewSynchronization } from "./livePreviewSynchronization";
import type { LivePreviewSynchronizationOptions } from "./livePreviewSynchronization";

type SynchronizationOptions = LivePreviewSynchronizationOptions<vscode.TextDocument>;
type HostOptions = Pick<SynchronizationOptions, "notifyConflict" | "notifyRecovery" | "reportError"> & {
  host?: EditHost<vscode.TextDocument>;
  executeHistory?: SynchronizationOptions["executeHistory"];
  beforeDocumentChange?(document: vscode.TextDocument): void;
};

/** Attach Live Preview synchronization to VS Code's TextDocument lifecycle. */
export function createLivePreviewSynchronization<Peer extends EditPeer>(options: HostOptions) {
  const synchronization = new LivePreviewSynchronization<vscode.TextDocument, Peer>({
    host: options.host ?? new LivePreviewEditHost(),
    executeHistory: options.executeHistory ?? (command => vscode.commands.executeCommand(command)),
    forceSave: document => vscode.commands.executeCommand("workbench.action.files.save", document.uri),
    notifyConflict: options.notifyConflict,
    notifyRecovery: options.notifyRecovery,
    reportError: options.reportError,
  });

  let disposed = false;
  const changeListener = vscode.workspace.onDidChangeTextDocument(event => {
    if (!disposed) options.beforeDocumentChange?.(event.document);
    synchronization.observeDocumentChange(event.document, hostDocumentChanges(event));
  });
  const willSaveListener = vscode.workspace.onWillSaveTextDocument(event => {
    const wait = synchronization.participateNativeSave(event.document);
    if (wait) event.waitUntil(wait.then(() => []));
  });
  const didSaveListener = vscode.workspace.onDidSaveTextDocument(document => {
    void synchronization.completeNativeSave(document);
  });
  return {
    synchronization,
    dispose() {
      if (disposed) return;
      disposed = true;
      willSaveListener.dispose();
      didSaveListener.dispose();
      // Already received edits still need their WorkspaceEdit events.
      void synchronization.dispose().then(() => changeListener.dispose());
    },
  };
}
