import { hasImageExtension, parseEmbedInner } from "./vault/imageResolver";

const LPAREN = 40; // (
const RPAREN = 41; // )
const RBRACKET = 93; // ]

function isWhitespace(code: number): boolean {
  if (code <= 0x20) return code === 32 || (code >= 9 && code <= 13);
  if (code < 0xa0) return false;
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isRemoteReference(reference: string): boolean {
  return (
    reference.startsWith("https:") ||
    reference.startsWith("http:") ||
    reference.startsWith("data:")
  );
}

/** Scan `![alt](src)` in linear time by advancing past each unmatched `]`. */
function scanMarkdownImages(text: string, onMatch: (src: string) => void): void {
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("![", pos);
    if (open < 0) break;
    const close = text.indexOf("]", open + 2);
    if (close < 0 || close + 1 >= text.length) break;
    if (text.charCodeAt(close + 1) !== LPAREN) {
      // Any earlier `![` before `close` hits this same `]`, so skip past it.
      pos = close + 1;
      continue;
    }
    let srcStart = close + 2;
    while (srcStart < text.length && isWhitespace(text.charCodeAt(srcStart))) {
      srcStart++;
    }
    if (srcStart >= text.length) break;
    if (text.charCodeAt(srcStart) === RPAREN) {
      pos = srcStart + 1;
      continue;
    }
    let srcEnd = srcStart + 1;
    while (
      srcEnd < text.length &&
      text.charCodeAt(srcEnd) !== RPAREN &&
      !isWhitespace(text.charCodeAt(srcEnd))
    ) {
      srcEnd++;
    }
    onMatch(text.slice(srcStart, srcEnd));
    pos = srcEnd;
  }
}

/** Scan `![[inner]]` in linear time by advancing past each unmatched `]`. */
function scanImageEmbeds(text: string, onMatch: (inner: string) => void): void {
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("![[", pos);
    if (open < 0) break;
    const close = text.indexOf("]", open + 3);
    if (close < 0 || close + 1 >= text.length) break;
    if (text.charCodeAt(close + 1) !== RBRACKET) {
      // Non-greedy `[^\]]+?` never crosses a single `]`; resume right after it.
      pos = close + 1;
      continue;
    }
    if (close > open + 3) onMatch(text.slice(open + 3, close));
    pos = close + 2;
  }
}

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
      map[reference] = isRemoteReference(reference)
        ? reference
        : this.host.resolveIndexed(reference, requireImageExt) ?? this.host.resolveLegacy(reference);
    };

    // Markdown keys remain the raw source, and win over duplicate embed keys.
    scanMarkdownImages(text, (src) => put(src, false));
    scanImageEmbeds(text, (inner) => {
      const { pathPart } = parseEmbedInner(inner);
      if (hasImageExtension(pathPart)) put(pathPart, true);
    });

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

