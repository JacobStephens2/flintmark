import { writeFile } from "node:fs/promises";

/** Create a new regular file at `uri` and write `bytes` into it.
 *
 * Every destination uses one exclusive create (`O_CREAT|O_EXCL`, flag `wx`).
 * The create fails when that name already exists, including when it is a
 * symlink, and the write does not follow the link. */
export async function exclusiveCreate(
  uri: { fsPath: string },
  bytes: Uint8Array
): Promise<void> {
  await writeFile(uri.fsPath, bytes, { flag: "wx" });
}
