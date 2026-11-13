// Minimal vscode stand-in for the exclusive-create host regression.
// Stat is replaced by the test; a successful stat is not proof the name is a file.
import { dirname, join } from "node:path";

export class Uri {
  scheme: string;
  path: string;
  fsPath: string;
  constructor(scheme: string, path: string, fsPath?: string) {
    this.scheme = scheme;
    this.path = path;
    this.fsPath = fsPath ?? path;
  }
  static file(p: string): Uri {
    return new Uri("file", p, p);
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
  showInformationMessage: async (): Promise<string> => "Create note",
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
  },
  onDidChangeTextDocument: () => ({ dispose() {} }),
  onWillSaveTextDocument: () => ({ dispose() {} }),
  onDidSaveTextDocument: () => ({ dispose() {} }),
  getConfiguration: () => ({ get: () => undefined }),
};
