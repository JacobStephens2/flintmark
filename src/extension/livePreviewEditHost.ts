import * as vscode from "vscode";
import { cmToHostOffsets } from "../shared/ranges";
import type { DocChange } from "../shared/protocol";
import type { DocumentSnapshot, EditHost, HostDocumentChange } from "./livePreviewEditCoordinator";

/** Concrete TextDocument/WorkspaceEdit boundary, also used by real-host tests. */
export class LivePreviewEditHost implements EditHost<vscode.TextDocument> {
  read(document: vscode.TextDocument): DocumentSnapshot {
    return { text: document.getText(), version: document.version, crlf: document.eol === vscode.EndOfLine.CRLF };
  }

  async apply(document: vscode.TextDocument, changes: readonly DocChange[]): Promise<boolean> {
    const snapshot = this.read(document);
    const cmOffsets = changes.flatMap(change => [change.from, change.to]);
    const offsets = snapshot.crlf ? cmToHostOffsets(snapshot.text, cmOffsets) : cmOffsets;
    const edit = new vscode.WorkspaceEdit();
    changes.forEach((change, i) => edit.replace(document.uri, new vscode.Range(
      document.positionAt(offsets[2 * i]), document.positionAt(offsets[2 * i + 1]),
    ), change.insert));
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) console.warn("[ofm] WorkspaceEdit was not applied");
    return applied;
  }
}

export function hostDocumentChanges(event: vscode.TextDocumentChangeEvent): HostDocumentChange[] {
  return event.contentChanges.map(change => ({
    rangeOffset: change.rangeOffset, rangeLength: change.rangeLength,
    startLine: change.range.start.line, endLine: change.range.end.line, text: change.text,
  }));
}
