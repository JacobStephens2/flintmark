import { writeFile } from "node:fs/promises";

/** Create a new regular file at `uri` and write `bytes` into it.
 *
 * File-scheme destinations use one exclusive create (`O_CREAT|O_EXCL`, flag
 * `wx`). The create fails when that name already exists, including when it is
 * a symlink, and the write does not follow the link. Non-file schemes retain
 * their registered provider. */
export async function exclusiveCreate<T extends { scheme: string; fsPath: string }>(
  uri: T,
  bytes: Uint8Array,
  providerWrite: (uri: T, bytes: Uint8Array) => PromiseLike<void>
): Promise<void> {
  if (uri.scheme !== "file") {
    await providerWrite(uri, bytes);
    return;
  }
  await writeFile(uri.fsPath, bytes, { flag: "wx" });
}
