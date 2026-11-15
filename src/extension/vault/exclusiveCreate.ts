import { randomBytes } from "node:crypto";
import { lstat, open } from "node:fs/promises";

/** Create a new regular file at `uri` and write `bytes` into it.
 *
 * The bytes go through one exclusive create (`O_CREAT|O_EXCL`, flag `wx`).
 * An existing name, including a symlink, fails before that open. On Windows,
 * `CREATE_NEW` follows a dangling symlink and would create the target, so
 * the name is classified with `lstat` first. If a symlink still wins the
 * race, the open's handle is closed without writing. */
export async function exclusiveCreate(
  uri: { fsPath: string },
  bytes: Uint8Array
): Promise<void> {
  try {
    await lstat(uri.fsPath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    const handle = await open(uri.fsPath, "wx");
    try {
      if ((await lstat(uri.fsPath)).isSymbolicLink()) {
        throw alreadyExists(uri.fsPath);
      }
      await handle.writeFile(bytes);
      return;
    } finally {
      await handle.close();
    }
  }
  throw alreadyExists(uri.fsPath);
}

/** The parts of `vscode.workspace.fs` a provider create uses. */
export interface ProviderCreateFs<U> {
  writeFile(uri: U, bytes: Uint8Array): PromiseLike<void>;
  rename(source: U, target: U, options: { overwrite: boolean }): PromiseLike<void>;
  delete(uri: U, options: { useTrash: boolean }): PromiseLike<void>;
}

/** Create `uri` through a file-system provider without overwriting it.
 *
 * The public file API has no create-only write, and a provider's write
 * follows a symlink at the name. The bytes go to an unpredictable temporary
 * name in the same folder, `sibling(uri, name)`, then a rename with
 * overwrite off moves it to `uri`. A name taken after the caller's check,
 * including a symlink, fails the rename; a rename replaces names, not the
 * files a link points to. A failure deletes the temporary file and rethrows. */
export async function providerExclusiveCreate<U>(
  fs: ProviderCreateFs<U>,
  uri: U,
  bytes: Uint8Array,
  sibling: (uri: U, name: string) => U
): Promise<void> {
  const temp = sibling(uri, temporaryCreateName());
  try {
    await fs.writeFile(temp, bytes);
    await fs.rename(temp, uri, { overwrite: false });
  } catch (error) {
    try {
      await fs.delete(temp, { useTrash: false });
    } catch {
      // The temporary name was never written, or is already gone.
    }
    throw error;
  }
}

/** An unpredictable name for the temporary file of a provider create. It is
 * not a Markdown name, so the vault index does not pick it up. */
function temporaryCreateName(): string {
  return `.flintmark-${randomBytes(16).toString("hex")}.tmp`;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function alreadyExists(fsPath: string): NodeJS.ErrnoException {
  const error = new Error(`EEXIST: file already exists, open '${fsPath}'`) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  error.syscall = "open";
  error.path = fsPath;
  return error;
}
