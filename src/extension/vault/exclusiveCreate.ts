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
