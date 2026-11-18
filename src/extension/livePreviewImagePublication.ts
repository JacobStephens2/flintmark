import { IMAGE_EXTS, parseEmbedInner } from "./vault/imageResolver";

/** Synchronous host effects; publication policy never needs VS Code or I/O. */
export interface LivePreviewImageHost {
  readText(): string;
  resolveIndexed(reference: string, requireImageExt: boolean): string | undefined;
  resolveLegacy(reference: string): string;
  postMap(map: Record<string, string>): void;
}

/** Per-panel Live Preview image publication (GLOSSARY.md). */
export class LivePreviewImagePublication {
  private initialized = false;
  private disposed = false;
  private lastMap: string | undefined;

  constructor(private readonly host: LivePreviewImageHost) {}

  ready(): void {
    if (this.disposed) return;
    this.initialized = true;
    this.lastMap = undefined;
    this.refresh();
  }

  refresh(): void {
    if (this.disposed || !this.initialized) return;
    const text = this.host.readText();
    const map: Record<string, string> = {};
    const put = (reference: string, requireImageExt: boolean): void => {
      if (map[reference] !== undefined) return;
      map[reference] = /^(https?:|data:)/.test(reference)
        ? reference
        : this.host.resolveIndexed(reference, requireImageExt) ?? this.host.resolveLegacy(reference);
    };

    // Markdown keys remain the raw source, and win over duplicate embed keys.
    const markdown = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = markdown.exec(text)) !== null) put(match[1], false);

    const embeds = /!\[\[([^\]]+?)\]\]/g;
    while ((match = embeds.exec(text)) !== null) {
      const { pathPart } = parseEmbedInner(match[1]);
      const extension = /\.([^.]+)$/.exec(pathPart)?.[1].toLowerCase();
      if (extension && IMAGE_EXTS.has(extension)) put(pathPart, true);
    }

    // The entire resolved URI participates, including Image snapshot versions.
    const json = JSON.stringify(map, Object.keys(map).sort());
    if (json === this.lastMap) return;
    this.lastMap = json;
    this.host.postMap(map);
  }

  dispose(): void {
    this.disposed = true;
  }
}

