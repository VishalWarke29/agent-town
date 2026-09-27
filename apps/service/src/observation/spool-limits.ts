export const SPOOL_EVENT_BYTES = 64000;
export const SPOOL_EVENT_LIMIT = 2000;
export const SPOOL_BYTE_LIMIT = 50 * 1024 * 1024;
export const SPOOL_DIRECTORY_LIMIT = 2200;
export const SPOOL_BATCH_LIMIT = 100;
/** A well-formed-but-future event is quarantined here (renamed, never deleted) until a service that
 * understands its format restarts and drains it. Bounded so an unbounded stream of newer events from a
 * far-ahead bridge cannot grow the spool without limit; overflow past either cap counts a loss instead
 * of silently discarding the file. */
export const SPOOL_NEWER_DIRECTORY_LIMIT = 200;
export const SPOOL_NEWER_BYTE_LIMIT = 2 * 1024 * 1024;
