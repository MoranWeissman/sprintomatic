// server/atomic-write.ts
/**
 * Safe file writes: put the new bytes in a temp file next to the target, then
 * rename the temp file over the target. A rename inside one folder is atomic,
 * so a crash or a full disk in the middle of a write leaves either the whole
 * old file or the whole new one — never half of either.
 *
 * This started life inside server/archive.ts. It was lifted here so the
 * discovery and design documents — the user's own writing, and the only copy
 * of it — get the same protection instead of being overwritten in place.
 *
 * The `writer` parameter is only there so tests can make a write fail on
 * purpose; real callers leave it out.
 */
import { promises as fs, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/** The two filesystem steps an atomic write takes. Swappable for tests. */
export interface AtomicWriter {
  writeFile: (path: string, content: string) => void;
  rename: (from: string, to: string) => void;
}

const realWriter: AtomicWriter = {
  writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
  rename: (from, to) => renameSync(from, to),
};

/** Temp file name for a target. Same folder, so the rename stays atomic. */
function tmpPathFor(filePath: string): string {
  return `${filePath}.tmp`;
}

/**
 * Write `content` to `filePath` without ever leaving a half-written file
 * behind. Missing parent folders are created. If the write fails, the temp
 * file is cleaned up and the error is thrown on — the file that was already
 * there is left exactly as it was.
 */
export function writeFileAtomicSync(
  filePath: string,
  content: string,
  writer: AtomicWriter = realWriter,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = tmpPathFor(filePath);
  try {
    writer.writeFile(tmp, content);
    writer.rename(tmp, filePath);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Cleaning up the temp file is a courtesy; the real error is the one
      // below, and it must not be replaced by a failure to tidy up.
    }
    throw e;
  }
}

/** Same guarantee as `writeFileAtomicSync`, for callers already using promises. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmp = tmpPathFor(filePath);
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
