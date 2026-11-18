// Minimal vscode stand-in for Note-folder creation adapter and editor tests.
// The fs methods are replaced by the test; a successful stat is not proof the
// name is a file.
import { dirname, join } from "node:path";
import type { TextDocumentChangeEvent } from "vscode";

export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();
  readonly event = (listener: (event: T) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(event: T): void {
    for (const listener of this.listeners) listener(event);
  }
  dispose(): void { this.listeners.clear(); }
}

export const documentChanges = new EventEmitter<TextDocumentChangeEvent>();

export class Uri {
  scheme: string;
  path: string;
  fsPath: string;
  query = "";
  constructor(scheme: string, path: string, fsPath?: string) {
    this.scheme = scheme;
    this.path = path;
    this.fsPath = fsPath ?? path;
  }
  static file(p: string): Uri {
    return new Uri("file", p, p);
  }
  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ""}`;
  }
  with(change: { query?: string }): Uri {
    const uri = new Uri(this.scheme, this.path, this.fsPath);
    uri.query = change.query ?? this.query;
    return uri;
  }
  // The real Uri.joinPath uses the platform separator. A slash-only join
  // leaves `C:\notes\Current.md/Free note.md` on Windows, so the create
  // misses the note folder.
  static joinPath(base: Uri, ...parts: string[]): Uri {
    let p = base.fsPath;
    for (const part of parts) {
      if (part === "..") p = dirname(p);
      else if (part !== ".") p = join(p, part);
    }
    return new Uri(base.scheme, p, p);
  }
}

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
export const EndOfLine = { LF: 1, CRLF: 2 };
export const ViewColumn = { Beside: 2 };
export const TextEditorRevealType = { InCenterIfOutsideViewport: 2 };
export class Range {
  constructor(public start: unknown, public end: unknown) {}
}
export class Selection extends Range {}
export class WorkspaceEdit {
  replace(): void {}
}
export class TabInputText {}
export class TabInputCustom {}
export const env = { appName: "test", openExternal: async () => false };

export const window = {
  errors: [] as string[],
  warnings: [] as string[],
  information: [] as string[],
  choice: "Create note" as string | undefined,
  showInformationMessage: async (message: string): Promise<string | undefined> => {
    window.information.push(message);
    return window.choice;
  },
  showErrorMessage: async (m: string): Promise<void> => {
    window.errors.push(m);
  },
  showWarningMessage: async (m: string): Promise<void> => {
    window.warnings.push(m);
  },
};

export const commands = {
  calls: [] as unknown[][],
  executeCommand: async (...args: unknown[]): Promise<void> => {
    commands.calls.push(args);
  },
};

export const workspace = {
  fs: {
    stat: async (_uri: Uri): Promise<never> => {
      throw new Error("stat");
    },
    writeFile: async (): Promise<void> => {
      throw new Error("write");
    },
    rename: async (): Promise<void> => {
      throw new Error("rename");
    },
    delete: async (): Promise<void> => {
      throw new Error("delete");
    },
  },
  onDidChangeTextDocument: documentChanges.event,
  onWillSaveTextDocument: () => ({ dispose() {} }),
  onDidSaveTextDocument: () => ({ dispose() {} }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
  getWorkspaceFolder: () => undefined,
  workspaceFolders: [],
  findFiles: async () => [],
  getConfiguration: () => ({ get: () => undefined }),
};
