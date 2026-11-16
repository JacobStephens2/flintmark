/** Storage effects for complete Note-folder creation operations. URI values
 * stay opaque so creation policy is independent of the editor and its host. */
export interface NoteFolderStorage<U> {
  sibling(uri: U, name: string): U;
  classify(uri: U): Promise<"symlink" | "present" | "absent">;
  createNew(uri: U, bytes: Uint8Array): Promise<void>;
}

export type NoteCreationOutcome<U> =
  | { kind: "invalid-target" | "cancelled" }
  | { kind: "existing" | "created"; uri: U; filename: string }
  | { kind: "failed"; filename: string; error: unknown };

export interface AttachmentInput {
  filename: string;
  mime: string;
  dataBase64: string;
}

export type AttachmentSaveOutcome<U> =
  | { kind: "saved"; uri: U; embed: string }
  | { kind: "unsupported-image" | "decode-failed" | "invalid-size" | "exhausted" }
  | { kind: "failed"; error: unknown };

const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

export class NoteFolderCreation<U> {
  constructor(
    private readonly storage: NoteFolderStorage<U>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createNote(
    documentUri: U,
    target: string,
    confirmCreate: () => Promise<boolean>,
  ): Promise<NoteCreationOutcome<U>> {
    const filename = resolveNewNoteName(target);
    if (!filename) return { kind: "invalid-target" };
    const uri = this.storage.sibling(documentUri, filename);
    if (await this.storage.classify(uri) === "present") {
      return { kind: "existing", uri, filename };
    }
    // A rejected confirmation is a host failure, not cancellation.
    if (!await confirmCreate()) return { kind: "cancelled" };
    const title = filename.replace(/\.md$/i, "");
    try {
      await this.create(uri, new TextEncoder().encode(`# ${title}\n\n`));
      return { kind: "created", uri, filename };
    } catch (error) {
      return { kind: "failed", filename, error };
    }
  }

  async saveAttachment(documentUri: U, input: AttachmentInput): Promise<AttachmentSaveOutcome<U>> {
    const name = attachmentName(input.filename, input.mime, timestamp(this.now()));
    if (!name) return { kind: "unsupported-image" };
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(input.dataBase64, "base64"));
    } catch {
      return { kind: "decode-failed" };
    }
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) return { kind: "invalid-size" };

    let finalName = name;
    let uri = this.storage.sibling(documentUri, finalName);
    for (let i = 1; i < 1000 && await this.storage.classify(uri) === "present"; i++) {
      finalName = dedupeName(name, i);
      uri = this.storage.sibling(documentUri, finalName);
    }
    if (await this.storage.classify(uri) === "present") return { kind: "exhausted" };
    try {
      await this.create(uri, bytes);
      return { kind: "saved", uri, embed: finalName };
    } catch (error) {
      return { kind: "failed", error };
    }
  }

  private async create(uri: U, bytes: Uint8Array): Promise<void> {
    if (await this.storage.classify(uri) === "symlink") throw new Error("destination is a symlink");
    await this.storage.createNew(uri, bytes);
  }
}

function timestamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/** Basename only: aliases, anchors and folder paths never create directories. */
function resolveNewNoteName(target: string): string | null {
  if (typeof target !== "string") return null;
  let name = target.split("|")[0].split("#")[0].trim();
  if (!name) return null;
  name = name.split(/[/\\]/).pop()!.trim();
  if (!name || name === "." || name === "..") return null;
  name = name.replace(/\.(md|markdown)$/i, "").trim();
  if (!name) return null;
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return null;
  return name + ".md";
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
  "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
  "image/bmp": "bmp", "image/avif": "avif",
};
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

function extensionFor(filename: string, mime: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(filename || "");
  if (m && IMAGE_EXTS.has(m[1].toLowerCase())) {
    return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  }
  return MIME_EXT[(mime || "").toLowerCase()] ?? null;
}

function attachmentName(filename: string, mime: string, stamp: string): string | null {
  const ext = extensionFor(filename, mime);
  if (!ext) return null;
  let base = (filename || "").replace(/\.[^.]*$/, "");
  base = (base.split(/[/\\]/).pop() ?? "").trim();
  // Wikilink-breaking characters must not change the embed's target.
  base = base.replace(/[<>:"/\\|?*#[\]^]/g, "").trim();
  if (!base) base = `Pasted image ${stamp}`;
  return `${base}.${ext}`;
}

function dedupeName(name: string, n: number): string {
  return name.replace(/(\.[^.]+)$/, `-${n}$1`);
}
