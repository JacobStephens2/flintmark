import { noteLinkTarget, noteLinkCandidates } from "./noteLinkTarget";
import * as vscode from "vscode";
import { LivePreviewEditCoordinator } from "./livePreviewEditCoordinator";
import { LivePreviewEditHost, hostDocumentChanges } from "./livePreviewEditHost";
import { VaultIndexService } from "./vault";
import { ImageIndexService } from "./vault/imageIndexService";
import { DEFAULT_THEME_ID, findTheme } from "./themes";
import { openSourceWithSelection, triggerNativeAi, addSelectionToChat } from "./ai/aiBridge";
import { aiLog } from "./ai/aiLog";
import { clampOffsetRange, cmToHostOffsets } from "../shared/ranges";
import { DEFAULT_LINE_WIDTH, normalizeSettings } from "../shared/settings";
import { createNoteFolderCreation } from "./vault/noteFolderCreationHost";
import { SerialQueue } from "./serialQueue";
import { LivePreviewSaveCoordinator } from "./livePreviewSaveCoordinator";
import { createLivePreviewImagePublication } from "./livePreviewImageHost";
import type { LivePreviewImagePublication } from "./livePreviewImagePublication";
import type {
  HostMsg,
  WebviewMsg,
  Settings,
  ThemePayload,
} from "../shared/protocol";

// ---------------------------------------------------------------------------
// CSP nonce generator
// ---------------------------------------------------------------------------

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Read + normalize the user-facing editor settings (column width, prose/code
// fonts) into the payload pushed to the webview. Validation/clamping lives in the
// pure, unit-tested `normalizeSettings` (../shared/settings).
function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("ofm");
  return normalizeSettings({
    lineWidth: cfg.get<number>("lineWidth"),
    fontFamily: cfg.get<string>("fontFamily"),
    fontSize: cfg.get<number>("fontSize"),
    monospaceFontFamily: cfg.get<string>("monospaceFontFamily"),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The webview's offsets are CodeMirror's, where a CRLF is 1 character; the
// TextDocument counts it as 2. toHostOffsets maps the webview's offsets to the
// document's. Edit synchronization owns the reverse conversion for host events.
function isCrlf(document: vscode.TextDocument): boolean {
  return document.eol === vscode.EndOfLine.CRLF;
}

function toHostOffsets(document: vscode.TextDocument, offsets: number[]): number[] {
  if (!isCrlf(document)) return offsets;
  return cmToHostOffsets(document.getText(), offsets);
}

type PanelRecord = {
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
  imagePublication: LivePreviewImagePublication;
};

// ---------------------------------------------------------------------------
// CustomTextEditorProvider
// ---------------------------------------------------------------------------

export class OfmCustomTextEditorProvider
  implements vscode.CustomTextEditorProvider
{
  private readonly noteFolderCreation = createNoteFolderCreation();

  /**
   * Registry of active webview panels, keyed by document URI string. Each panel
   * owns its image publication lifetime, including while hidden.
   */
  private panels: Map<string, Map<vscode.WebviewPanel, PanelRecord>> =
    new Map();

  /** Serializes webview edits per URI — the concurrent-edit corruption guard. */
  private editQueue = new SerialQueue();
  private readonly edits = new LivePreviewEditCoordinator<vscode.TextDocument, vscode.WebviewPanel>({
    editQueue: this.editQueue,
    host: new LivePreviewEditHost(),
    registeredPeers: uri => this.panels.has(uri) ? [...this.panels.get(uri)!.keys()] : undefined,
    readyPeers: uri => this.readyPeers(uri),
    notifyConflict: document => this.notifyConflict(document),
    notifyRecovery: uri => {
      void vscode.window.showWarningMessage(
        "This file changed while closed. Flintmark preserved your unsynchronized edits in a recovery copy.",
        "Open Recovery Copy",
      ).then(action => { if (action) void this.openRecoveryCopy(uri); });
    },
  });
  private readonly saves = new LivePreviewSaveCoordinator<vscode.TextDocument, vscode.WebviewPanel>({
    editQueue: this.editQueue,
    readyPeers: uri => this.readyPeers(uri),
    hasConflicts: uri => this.edits.hasConflicts(uri),
    forceSave: document => vscode.commands.executeCommand("workbench.action.files.save", document.uri),
    reportError: error => this.reportSaveError(error),
  });

  /** Extension-owned saves must enter here, never call TextDocument.save()
   * before synchronization: that API skips clean host documents entirely. */
  async saveDocument(document: vscode.TextDocument): Promise<boolean> {
    return this.saves.saveDocument(document);
  }

  private reportSaveError(error: unknown): void {
    void vscode.window.showErrorMessage("Flintmark could not finish saving: " + String(error));
  }
  private conflictNotifications = new Set<string>();

  private readyPeers(uri: string): vscode.WebviewPanel[] | undefined {
    const panels = this.panels.get(uri);
    return panels && [...panels.keys()].filter(panel => this.readyPanels.has(panel));
  }

  /** Panels that completed the webview ready/init handshake. */
  private readyPanels = new WeakSet<vscode.WebviewPanel>();

  /** Last requested source position for a document whose webview is opening. */
  private pendingReveals = new Map<string, { line: number; character: number }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly vault?: VaultIndexService,
    private readonly imageIndex?: ImageIndexService
  ) {
    // Global listener: reconcile external document changes into webviews.
    this.context.subscriptions.push(
      this.saves,
      vscode.workspace.onDidChangeTextDocument((e) =>
        this.onDocumentChanged(e)
      ),
      vscode.workspace.onWillSaveTextDocument((e) => {
        const wait = this.saves.participateNativeSave(e.document);
        if (wait) e.waitUntil(wait.then(() => []));
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        void this.saves.completeNativeSave(document);
      })
    );

    // When the image index (re)builds — initial scan finishing, or an attachment
    // added/removed while a note's text is unchanged — recompute the image map
    // for every open editor so newly-resolved images appear without an edit.
    if (this.imageIndex) {
      this.context.subscriptions.push(
        this.imageIndex.onDidChange(() => {
          for (const { imagePublication } of this.allPanelRecords()) {
            imagePublication.refresh();
          }
        })
      );
    }

    // Vault index (re)built — push fresh autocomplete data (notes + tags) to
    // every open editor so `[[` / `#` completion stays current.
    if (this.vault) {
      this.context.subscriptions.push(
        this.vault.onDidChange(() => {
          const vault = this.vault!.getVaultData();
          const msg: HostMsg = { type: "vaultData", vault };
          for (const { panel } of this.allPanelRecords()) {
            panel.webview.postMessage(msg);
          }
        })
      );
    }

    // Live theme switching: re-push the active theme to every open editor.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ofm.theme")) {
          for (const { panel } of this.allPanelRecords()) {
            const msg: HostMsg = {
              type: "themeChanged",
              theme: this.buildThemePayload(panel.webview),
            };
            panel.webview.postMessage(msg);
          }
        }
        if (
          e.affectsConfiguration("ofm.lineWidth") ||
          e.affectsConfiguration("ofm.fontFamily") ||
          e.affectsConfiguration("ofm.fontSize") ||
          e.affectsConfiguration("ofm.monospaceFontFamily")
        ) {
          // Push the FULL settings object so the webview can revert a CLEARED
          // font (omitted field → CSS variable removed) live, not just apply new
          // values.
          const settings: Settings = readSettings();
          for (const { panel } of this.allPanelRecords()) {
            panel.webview.postMessage({ type: "settingsChanged", settings } as HostMsg);
          }
        }
      })
    );
  }

  /** Resolve the active theme (`ofm.theme` setting) to a webview CSS URI. */
  private buildThemePayload(webview: vscode.Webview): ThemePayload {
    const id =
      vscode.workspace.getConfiguration("ofm").get<string>("theme") ??
      DEFAULT_THEME_ID;
    const theme = findTheme(id) ?? findTheme(DEFAULT_THEME_ID);
    const cssUri = theme
      ? webview
          .asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, theme.file)
          )
          .toString()
      : null;
    return { id: theme?.id ?? id, cssUri };
  }

  private *allPanelRecords(): Iterable<PanelRecord> {
    for (const records of this.panels.values()) {
      for (const record of records.values()) {
        yield record;
      }
    }
  }

  // -----------------------------------------------------------------------
  // resolveCustomTextEditor — called when VS Code opens our editor
  // -----------------------------------------------------------------------

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const uri = document.uri.toString();

    // Register panel so we can route external changes to it.
    let panelsForUri = this.panels.get(uri);
    if (!panelsForUri) {
      panelsForUri = new Map();
      this.panels.set(uri, panelsForUri);
    }
    const imagePublication = createLivePreviewImagePublication(document, webviewPanel.webview, this.imageIndex);
    panelsForUri.set(webviewPanel, { document, panel: webviewPanel, imagePublication });
    webviewPanel.onDidDispose(() => {
      imagePublication.dispose();
      this.saves.cancelPeer(webviewPanel);
      const records = this.panels.get(uri);
      records?.delete(webviewPanel);
      if (records?.size === 0) {
        this.panels.delete(uri);
        this.edits.lastPeerClosed(uri);
      }
      this.readyPanels.delete(webviewPanel);
      if (records?.size === 0) this.pendingReveals.delete(uri);
    });

    // Configure webview
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.resourceRoots(document),
    };
    webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage(
      (msg: WebviewMsg) => this.onWebviewMessage(document, webviewPanel, msg),
      undefined,
      this.context.subscriptions
    );
  }

  // -----------------------------------------------------------------------
  // HTML generation with strict CSP
  // -----------------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "webview.js")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "webview.css")
    );
    const mermaidUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "mermaid.js")
    );
    // Initial paint only — the webview re-applies the full settings (incl. fonts)
    // from the `init` message onto the document root, which overrides this.
    // lineWidth 0 = fill the editor width (no cap); >0 = centered column of N rem.
    const lineWidth = readSettings().lineWidth ?? DEFAULT_LINE_WIDTH;
    const lineWidthRule =
      lineWidth > 0 ? `:root { --file-line-width: ${lineWidth}rem; }` : "";

    // CSP: scripts only from our nonce; styles inline (CM6 needs this);
    // images and fonts restricted to webview cspSource.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
  <style nonce="${nonce}">
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
      /* Driven by the active theme's Obsidian variables; VS Code as fallback. */
      background-color: var(--background-primary, var(--vscode-editor-background));
      color: var(--text-normal, var(--vscode-editor-foreground));
    }
    #editor {
      height: 100%;
    }
    /* NOTE: all .cm-* editor styling lives in the CM6 theme layer (markdownTheme,
       via EditorView.theme) — NOT here. A host stylesheet rule for .cm-content /
       .cm-scroller ties on specificity with CM6's own base theme but loses on
       order (CM6 injects later), so it would be silently overridden (that bug made
       the page read edge-to-edge). The host only owns the page container above and
       the dynamic readable-column variable below. */
    ${lineWidthRule}
  </style>
  <link rel="stylesheet" href="${cssUri}">
  <meta name="ofm-nonce" content="${nonce}">
  <meta name="ofm-mermaid-uri" content="${mermaidUri}">
</head>
<body>
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // -----------------------------------------------------------------------
  // Webview message dispatch
  // -----------------------------------------------------------------------

  private async onWebviewMessage(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    msg: WebviewMsg
  ): Promise<void> {
    switch (msg.type) {
      case "flushed": {
        this.saves.acknowledge(panel, msg.requestId);
        return;
      }
      case "ready":
        return this.edits.initialize(document, snapshot => this.handleReady(document, panel, snapshot));

      case "edit":
        // Serialize: never apply concurrently (fast typing would race/corrupt).
        this.edits.submit(document, panel, msg);
        return;

      case "requestSave":
        try {
          if (!await this.saveDocument(document)) throw new Error("The document was not saved.");
        } catch (error) { this.reportSaveError(error); }
        return;

      case "requestUndo":
        await this.editQueue.run(document.uri.toString(), async () => {
          await vscode.commands.executeCommand("undo");
        });
        return;

      case "requestRedo":
        await this.editQueue.run(document.uri.toString(), async () => {
          await vscode.commands.executeCommand("redo");
        });
        return;

      case "selectionChanged":
        // Slice 1: receive but do nothing (Selection Bridge seat).
        return;

      case "toggleTask":
        return this.handleToggleTask(document, msg.from, msg.to);

      case "openLink":
        return this.handleOpenLink(document, msg.target);

      case "saveAttachment":
        return this.handleSaveAttachment(document, panel, msg);

      case "aiEditSelection":
        aiLog(
          `▶ aiEditSelection received from webview: mode=${msg.mode} from=${msg.from} to=${msg.to}`
        );
        return this.handleAiEditSelection(document, msg.from, msg.to, msg.mode);

      case "log":
        console.log(`[webview:${msg.level}] ${msg.msg}`);
        return;

      case "warn":
        vscode.window.showWarningMessage(`Flintmark: ${msg.message}`);
        return;
    }
  }

  // -----------------------------------------------------------------------
  // Handle ready → send init with full document text
  // -----------------------------------------------------------------------

  private handleReady(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    snapshot: { text: string; version: number; syncVersion: number },
  ): void {
    const settings: Settings = readSettings();
    const theme = this.buildThemePayload(panel.webview);

    const initMsg: HostMsg = {
      type: "init",
      syncVersion: snapshot.syncVersion,
      uri: document.uri.toString(),
      version: snapshot.version,
      text: snapshot.text,
      settings,
      theme,
      vault: this.vault?.getVaultData(),
    };

    panel.webview.postMessage(initMsg);
    this.readyPanels.add(panel);
    const pendingReveal = this.pendingReveals.get(document.uri.toString());
    if (pendingReveal) {
      this.pendingReveals.delete(document.uri.toString());
      this.postReveal(panel, pendingReveal.line, pendingReveal.character);
    }
    this.imageIndex?.ensureFreshForDocument(document.uri, "webview-ready");
    this.panels.get(document.uri.toString())?.get(panel)?.imagePublication.ready();
  }

  private async openRecoveryCopy(uri: string): Promise<void> {
    for (const text of this.edits.recoveryTexts(uri)) {
      const copy = await vscode.workspace.openTextDocument({ language: "markdown", content: text });
      await vscode.window.showTextDocument(copy, { preview: false });
    }
  }

  private async retryConflicts(document: vscode.TextDocument): Promise<void> {
    const current = document.isClosed ? await vscode.workspace.openTextDocument(document.uri) : document;
    this.edits.retry(current);
  }

  private notifyConflict(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    if (this.conflictNotifications.has(uri)) return;
    this.conflictNotifications.add(uri);
    void vscode.window.showErrorMessage(
      "Flintmark could not synchronize all edits. Native saves include only synchronized text. Retry or save a recovery copy before closing the application.",
      "Retry",
      "Open Recovery Copy",
    ).then(action => {
      this.conflictNotifications.delete(uri);
      if (action === "Retry") void this.retryConflicts(document);
      else if (action === "Open Recovery Copy") void this.openRecoveryCopy(uri);
    });
  }

  // -----------------------------------------------------------------------
  // Legacy host-side task toggles; current webviews submit versioned edits.
  // -----------------------------------------------------------------------
  // Handle toggleTask — flip [ ] <-> [x] at the marker range
  // -----------------------------------------------------------------------

  private async handleToggleTask(
    document: vscode.TextDocument,
    from: number,
    to: number
  ): Promise<void> {
    const [hostFrom, hostTo] = toHostOffsets(document, [from, to]);
    const range = new vscode.Range(
      document.positionAt(hostFrom),
      document.positionAt(hostTo)
    );
    const marker = document.getText(range);
    const toggled = /\[[xX]\]/.test(marker) ? "[ ]" : "[x]";
    if (toggled === marker) return;

    // Do NOT suppress: this host-originated change must echo back to the webview
    // so the checkbox re-renders from the new source.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, toggled);
    await vscode.workspace.applyEdit(edit);
  }

  // -----------------------------------------------------------------------
  // Handle openLink — naive filename match in workspace (Slice 1)
  // -----------------------------------------------------------------------

  private async handleOpenLink(
    document: vscode.TextDocument,
    target: string
  ): Promise<void> {
    if (!target) return;

    // External links ([text](https://…), <mailto:…>, autolinks): open in the
    // OS browser / mail client rather than trying to resolve a vault note.
    if (/^(https?:|mailto:|tel:|vscode:)/i.test(target)) {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(target));
      } catch {
        vscode.window.showWarningMessage(`Could not open link: ${target}`);
      }
      return;
    }

    // A wikilink target may carry a heading anchor (`#…`), a block anchor
    // (`#^id` or the bare `^id`), and/or an alias (`|…`) — strip them all before
    // resolving so `[[Foo#Section]]` / `[[Foo^abc]]` resolve to Foo (not searched
    // as `Foo#Section.md`, which would miss and wrongly offer to create a
    // duplicate). An anchor-only `[[#heading]]` / `[[^id]]` has no note to open.
    const note = noteLinkTarget(target);
    if (!note) return;

    // Markdown paths are relative to the current document, not a workspace
    // basename search. Resolve them first, including explicit .md extensions
    // and percent-encoded names; Uri keeps remote workspace schemes intact.
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
    const base = note.startsWith("/") && workspaceRoot
      ? workspaceRoot
      : vscode.Uri.joinPath(document.uri, "..");
    for (const candidate of noteLinkCandidates(note.replace(/^\/+/, ""))) {
      const uri = vscode.Uri.joinPath(base, candidate);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) === 0) continue;
      } catch {
        continue;
      }
      await vscode.commands.executeCommand("vscode.openWith", uri, "ofm.livePreview");
      return;
    }

    // Prefer the Vault Index (case-insensitive basename match, alias-aware).
    const viaIndex = this.vault?.resolveLinkUri(note);
    if (viaIndex) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        viaIndex,
        "ofm.livePreview"
      );
      return;
    }

    // Fallback: naive workspace filename match — both supported extensions, so
    // an existing `Foo.markdown` isn't treated as missing (the index scans .md).
    const files = await vscode.workspace.findFiles(
      `**/${note.replace(/\.(md|markdown)$/i, "")}.{md,markdown}`,
      undefined,
      1
    );
    if (files.length > 0) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        files[0],
        "ofm.livePreview"
      );
      return;
    }

    // Unresolved: offer to create the note next to the current one (Obsidian-like).
    await this.offerCreateNote(document, note);
  }

  /** Present confirmation and map completed Note-folder creation outcomes. */
  private async offerCreateNote(
    document: vscode.TextDocument,
    target: string
  ): Promise<void> {
    const result = await this.noteFolderCreation.createNote(document.uri, target, async () => {
      const CREATE = "Create note";
      return await vscode.window.showInformationMessage(
        `"${target}" doesn't exist yet. Create it?`, CREATE
      ) === CREATE;
    });
    switch (result.kind) {
      case "invalid-target":
        vscode.window.showInformationMessage(`Could not find note: ${target}`);
        return;
      case "cancelled":
        return;
      case "failed":
        vscode.window.showErrorMessage(
          `Flintmark: couldn't create ${result.filename}: ${(result.error as Error).message}`
        );
        return;
      case "existing":
      case "created":
        await vscode.commands.executeCommand("vscode.openWith", result.uri, "ofm.livePreview");
    }
  }

  private async handleSaveAttachment(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    msg: Extract<WebviewMsg, { type: "saveAttachment" }>
  ): Promise<void> {
    const result = await this.noteFolderCreation.saveAttachment(document.uri, msg);
    switch (result.kind) {
      case "unsupported-image":
        vscode.window.showWarningMessage("Flintmark: only image attachments can be pasted.");
        return;
      case "decode-failed":
        return;
      case "invalid-size":
        vscode.window.showWarningMessage("Flintmark: attachment is empty or too large (max 24 MB).");
        return;
      case "exhausted":
        vscode.window.showErrorMessage(
          "Flintmark: too many attachments with that name — rename and retry."
        );
        return;
      case "failed":
        vscode.window.showErrorMessage(
          `Flintmark: couldn't save attachment: ${(result.error as Error).message}`
        );
        return;
      case "saved": {
        this.imageIndex?.ensureFreshForDocument(document.uri, "attachment-saved");
        const reply: HostMsg = { type: "attachmentSaved", requestId: msg.requestId, embed: result.embed };
        panel.webview.postMessage(reply);
      }
    }
  }

  // -----------------------------------------------------------------------
  // AI Selection Bridge: relocate the Live Preview selection into the real
  // source editor, then hand off to the host's native AI (see ai/aiBridge.ts).
  // Every node degrades gracefully: a failed flip warns; a missing AI command
  // just leaves the user in source with the selection set.
  // -----------------------------------------------------------------------

  private async handleAiEditSelection(
    document: vscode.TextDocument,
    from: number,
    to: number,
    mode: "edit" | "chat"
  ): Promise<void> {
    // Node 1+2: clamp offsets to the document (selection == source offsets,
    // once mapped from CodeMirror's to the document's).
    const len = document.getText().length;
    const [hostFrom, hostTo] = toHostOffsets(document, [from, to]);
    const { from: a, to: bClamped } = clampOffsetRange(hostFrom, hostTo, len);
    const sel = new vscode.Selection(
      document.positionAt(a),
      document.positionAt(bClamped)
    );

    const cfg = vscode.workspace.getConfiguration("ofm");
    const selText = document.getText(sel);
    aiLog(
      `handle: mode=${mode}, selection ${selText.length} chars: ${JSON.stringify(selText.slice(0, 60))}${selText.length > 60 ? "…" : ""}`
    );
    aiLog(
      `handle: config chatBridge=${cfg.get("ai.chatBridge") ?? "split"} sourceLayout=${cfg.get("ai.sourceLayout") ?? "replace"} trigger=${cfg.get("ai.trigger") ?? "auto"} chatCommand=${cfg.get("ai.chatCommand") || "—"} triggerCommand=${cfg.get("ai.triggerCommand") || "—"}`
    );

    if (mode === "chat") {
      const inplace = cfg.get<string>("ai.chatBridge") === "inplace";
      const chatCmd = cfg.get<string>("ai.chatCommand") || undefined;
      if (inplace) {
        // In-place: flip THIS tab to source (no side split), add to chat, flip
        // back to Live. Trade-off: returning to Live recreates the webview (a
        // brief re-render).
        const ed = await openSourceWithSelection(document, sel, "replace");
        if (!ed) {
          vscode.window.showWarningMessage("Flintmark: couldn't open the source for AI.");
          return;
        }
        const ok = await addSelectionToChat(chatCmd);
        await vscode.commands.executeCommand("vscode.openWith", document.uri, "ofm.livePreview");
        if (!ok) {
          vscode.window.setStatusBarMessage(
            "Flintmark: couldn't add to chat — open your AI chat and retry.",
            5000
          );
        }
        return;
      }
      // split (default): keep the Live Preview tab UNTOUCHED (no re-render) by
      // opening a transient SIDE editor just long enough to give the native chat
      // a real selection, then closing it.
      const editor = await openSourceWithSelection(document, sel, "beside");
      if (!editor) {
        vscode.window.showWarningMessage("Flintmark: couldn't open the source for AI.");
        return;
      }
      const ok = await addSelectionToChat(chatCmd);
      await this.closeTextEditorsFor(document.uri);
      if (!ok) {
        vscode.window.setStatusBarMessage(
          "Flintmark: couldn't add to chat — open your AI chat and retry.",
          5000
        );
      }
      return;
    }

    // Edit mode: the user needs to stay in source to interact with the inline AI,
    // so replace the tab (configurable to a side split).
    const layout = cfg.get<string>("ai.sourceLayout") === "beside" ? "beside" : "replace";
    const editor = await openSourceWithSelection(document, sel, layout);
    if (!editor) {
      vscode.window.showWarningMessage(
        "Flintmark: couldn't open the Markdown source for AI."
      );
      return;
    }

    // Node 4 (edit): hand off to native inline AI (auto-detect, with fallbacks).
    const trigger = cfg.get<string>("ai.trigger") === "manual" ? "manual" : "auto";
    const preferred = cfg.get<string>("ai.triggerCommand") || undefined;
    await triggerNativeAi(trigger, preferred);

    // Node 5: offer a one-click "accept & return" / "return" (we cannot observe
    // the host's internal Accept, so we expose explicit controls).
    void this.offerReturnControls(document.uri, "edit");
  }

  /** Close any plain TEXT editor tabs for `uri` (used to remove the transient
   *  source split opened for Add-to-Chat). Leaves our custom-editor tab intact. */
  private async closeTextEditorsFor(uri: vscode.Uri): Promise<void> {
    const target = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && input.uri.toString() === target) {
          try {
            await vscode.window.tabGroups.close(tab);
          } catch {
            /* best-effort */
          }
        }
      }
    }
  }

  private async offerReturnControls(
    uri: vscode.Uri,
    mode: "edit" | "chat"
  ): Promise<void> {
    const RETURN = "↩ Return to preview";
    if (mode === "chat") {
      const choice = await vscode.window.showInformationMessage(
        "Flintmark: selection added to chat.",
        RETURN
      );
      if (choice === RETURN) {
        await vscode.commands.executeCommand("ofm.returnToLivePreview");
      }
      return;
    }
    const ACCEPT = "✓ Accept & return to preview";
    const choice = await vscode.window.showInformationMessage(
      "Flintmark: editing the Markdown source with AI.",
      ACCEPT,
      RETURN
    );
    if (choice === ACCEPT) {
      await vscode.commands.executeCommand("ofm.acceptAiAndReturn");
    } else if (choice === RETURN) {
      await vscode.commands.executeCommand("ofm.returnToLivePreview");
    }
  }

  /**
   * Reveal a source position in the matching Live Preview. When the document is
   * not open yet, retain the request until its webview completes init so the
   * message cannot be dropped during startup.
   */
  public async revealPositionInDocument(
    uri: vscode.Uri,
    line: number,
    character: number
  ): Promise<void> {
    const key = uri.toString();
    const records = [...(this.panels.get(key)?.values() ?? [])];
    const hasLiveTab = vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === "ofm.livePreview" && tab.input.uri.toString() === key),
    );
    // Switching to source can leave a valid preview tab hidden. Reveal that
    // existing tab; disposing it races the host closing/reopening the same tab.
    const record = hasLiveTab ? (
      records.find((candidate) => candidate.panel.active) ??
      records.find((candidate) => candidate.panel.visible) ?? records[0]
    ) : undefined;

    if (record) {
      record.panel.reveal(record.panel.viewColumn, false);
      if (this.readyPanels.has(record.panel)) {
        this.postReveal(record.panel, line, character);
      } else {
        this.pendingReveals.set(key, { line, character });
      }
      return;
    }

    // A Live → Code replacement can leave a non-visible WebviewPanel record
    // alive even though no tab can reveal it. supportsMultipleEditors=false
    // then prevents openWith from creating the replacement. Dispose only these
    // orphaned/hidden records before reopening the requested document.
    for (const hidden of records) hidden.panel.dispose();
    if (records.length > 0) {
      // WebviewPanel disposal is reported asynchronously by some VS Code hosts.
      // Let that event drain before openWith, otherwise the host can still see
      // supportsMultipleEditors=false ownership and silently swallow the open.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    this.pendingReveals.set(key, { line, character });
    try {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (
        active instanceof vscode.TabInputText &&
        active.uri.toString() === key
      ) {
        await vscode.commands.executeCommand("ofm.openAsLivePreview");
      } else {
        await vscode.commands.executeCommand("vscode.openWith", uri, "ofm.livePreview");
      }
      // Live → Code can leave a ready but hidden panel record briefly alive.
      // `openWith` may reveal/reuse it without another ready handshake, so drain
      // the pending request here when handleReady did not already consume it.
      const pending = this.pendingReveals.get(key);
      if (pending) {
        const opened = [...(this.panels.get(key)?.values() ?? [])].find(
          (candidate) => candidate.panel.active || candidate.panel.visible
        );
        if (opened && this.readyPanels.has(opened.panel)) {
          this.pendingReveals.delete(key);
          this.postReveal(opened.panel, pending.line, pending.character);
        }
      }
    } catch (error) {
      this.pendingReveals.delete(key);
      throw error;
    }
  }

  private postReveal(
    panel: vscode.WebviewPanel,
    line: number,
    character: number
  ): void {
    const msg: HostMsg = { type: "revealPosition", line, character };
    void panel.webview.postMessage(msg);
  }

  /** The webview panel for the active Live Preview tab (or the sole panel). */
  private activePanel(): vscode.WebviewPanel | undefined {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    let uri: string | undefined;
    if (active instanceof vscode.TabInputCustom && active.viewType === "ofm.livePreview") {
      uri = active.uri.toString();
    }
    const records = uri
      ? [...(this.panels.get(uri)?.values() ?? [])]
      : [...this.allPanelRecords()];
    if (records.length === 0) return undefined;
    return (
      records.find((record) => record.panel.active)?.panel ??
      records.find((record) => record.panel.visible)?.panel ??
      records[0].panel
    );
  }

  /** Palette/command entry: ask the active Live Preview panel for its selection
   *  so the host can run the bridge. Returns true if a panel was messaged. */
  public requestAiEditOnActivePanel(mode: "edit" | "chat"): boolean {
    const panel = this.activePanel();
    if (!panel) return false;
    const msg: HostMsg = { type: "requestAiEdit", mode };
    void panel.webview.postMessage(msg);
    return true;
  }

  /**
   * Mod-F with focus outside the webview (Explorer single-click keeps focus in
   * the tree). VS Code's own Find runs for any open text editor, but never
   * reaches a custom editor, so focus the active Live Preview and open its find.
   */
  public async openFindOnActivePanel(): Promise<boolean> {
    const panel = this.activePanel();
    if (!panel) return false;
    // reveal() is a no-op for the already-active panel, so it can't pull focus
    // out of the Explorer; focusing the editor group moves it into the webview.
    if (panel.active) {
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    } else {
      panel.reveal(undefined, false);
    }
    const msg: HostMsg = { type: "openFind" };
    void panel.webview.postMessage(msg);
    return true;
  }

  // -----------------------------------------------------------------------
  // Webview resource roots
  // -----------------------------------------------------------------------

  private resourceRoots(document: vscode.TextDocument): vscode.Uri[] {
    // MUST include the extension URI, or out/webview.js can no longer load
    // (setting localResourceRoots overrides the permissive default).
    const roots: vscode.Uri[] = [
      this.context.extensionUri,
      vscode.Uri.joinPath(document.uri, ".."),
    ];
    for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri);
    return roots;
  }

  // -----------------------------------------------------------------------
  // onDidChangeTextDocument → reconcile external changes into webview
  // -----------------------------------------------------------------------

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const uri = e.document.uri.toString();
    const records = [...(this.panels.get(uri)?.values() ?? [])];

    // Refresh image resolution on every change (images can be typed/edited);
    // Publication suppresses equivalent complete maps independently per panel.
    for (const { imagePublication } of records) {
      imagePublication.refresh();
    }

    this.edits.observe(e.document, hostDocumentChanges(e));
  }
}
