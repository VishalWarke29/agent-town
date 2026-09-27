import { rename } from 'node:fs/promises';

/** Renames `from` over `to`, retrying a transient Windows EPERM/EBUSY (the destination briefly held
 * open by a reader) up to `attempts` times spread over about `windowMs`. A rename is atomic on both
 * platforms — a concurrent reader always sees either the file fully before the swap or fully after
 * it, never a partial write — so this retry exists only for the rename call itself failing
 * transiently, never for partial content. A failure past the last attempt leaves `from` in place and
 * `to` untouched, so the caller can report a plain error without losing either file. */
export async function renameWithRetry(from, to, attempts = 3, windowMs = 1000) {
  for (let attempt = 1; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      if (attempt >= attempts || !['EPERM', 'EBUSY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, windowMs / attempts));
    }
  }
}
