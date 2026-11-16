import { lstat } from "node:fs/promises";
import * as vscode from "vscode";
import { exclusiveCreate, providerExclusiveCreate } from "./exclusiveCreate";
import { NoteFolderCreation, NoteFolderStorage } from "./noteFolderCreation";

const storage: NoteFolderStorage<vscode.Uri> = {
  sibling: (uri, name) => vscode.Uri.joinPath(uri, "..", name),
  async classify(uri) {
    // Provider URIs must never be inspected on the extension host filesystem.
    try {
      if (uri.scheme === "file") {
        const st = await lstat(uri.fsPath);
        return st.isSymbolicLink() ? "symlink" : "present";
      }
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.SymbolicLink) !== 0 ? "symlink" : "present";
    } catch {
      return "absent";
    }
  },
  async createNew(uri, bytes) {
    if (uri.scheme === "file") {
      await exclusiveCreate(uri, bytes);
      return;
    }
    await providerExclusiveCreate(vscode.workspace.fs, uri, bytes, storage.sibling);
  },
};

/** Expose complete operations to the editor, keeping raw storage private. */
export function createNoteFolderCreation(): NoteFolderCreation<vscode.Uri> {
  return new NoteFolderCreation(storage);
}
