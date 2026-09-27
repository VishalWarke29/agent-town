import { readFileSync, opendirSync, writeFileSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeCustomEvent, normalizeHook } from './normalize.js';
import { SPOOL_BYTE_LIMIT, SPOOL_DIRECTORY_LIMIT, SPOOL_EVENT_BYTES, SPOOL_EVENT_LIMIT } from './spool-limits.js';
import { bridgeConfigSchema, gateEventForCapability, normalizeBridgePaths, readServiceCapabilities, resolveHookSource, type SourceDiagnostic } from './source-binding.js';
import { normalizeObservationPath, safeHookProjectPath } from './paths.js';

const args = process.argv.slice(2);
const configPath = args[args.indexOf('--config') + 1];
const eventName = args[args.indexOf('--event') + 1] ?? '';
const normalizedMode = args.includes('--normalized');
let bytes = 0;
const chunks: Buffer[] = [];
const timer = setTimeout(() => { process.stdout.write('{}'); process.exit(0); }, 3000);
process.stdin.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 1024 * 1024) chunks.push(chunk); });
process.stdin.on('end', () => {
  clearTimeout(timer);
  let safeSpool: string | null = null;
  let diagnosticRecorded = false;
  const markGap = () => {
    if (!safeSpool) return;
    // Coalesce failures without pretending this marker contains an exact count.
    try { writeFileSync(join(safeSpool, 'coverage-gap'), '1', { flag: 'wx', mode: 0o600, flush: true }); } catch { /* An existing marker already records a coverage gap. */ }
  };
  const markSourceDiagnostic = (code: SourceDiagnostic) => {
    if (!safeSpool) return;
    diagnosticRecorded = true;
    try { writeFileSync(join(safeSpool, `source-diagnostic-${code}`), '1', { flag: 'wx', mode: 0o600, flush: true }); } catch { /* Bounded coalesced diagnostic. */ }
  };
  try {
    const normalizedConfigPath = configPath && normalizeObservationPath(configPath);
    if (!normalizedConfigPath || !safeHookProjectPath(dirname(normalizedConfigPath), normalizedConfigPath)) throw new Error('Unsupported input');
    const metadata = lstatSync(normalizedConfigPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1 || metadata.size > 16384) throw new Error('Invalid config');
    const config = normalizeBridgePaths(bridgeConfigSchema.parse(JSON.parse(readFileSync(normalizedConfigPath, 'utf8'))));
    if (!config || !safeHookProjectPath(config.spoolPath, config.spoolPath) || !lstatSync(config.spoolPath).isDirectory()) throw new Error('Invalid path');
    safeSpool = config.spoolPath;
    if (bytes > 1024 * 1024) { markSourceDiagnostic('malformed-payload'); throw new Error('Unsupported input'); }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { markSourceDiagnostic('malformed-payload'); throw new Error('Unsupported input'); }
    const source: ReturnType<typeof resolveHookSource> = normalizedMode && config.provider === 'custom' ? { fields: {}, blocked: false } : resolveHookSource(config, input);
    if (source.diagnostic) markSourceDiagnostic(source.diagnostic);
    let normalized = normalizedMode ? config.provider === 'custom' && config.version === 2 && config.nativeSourceId
      ? normalizeCustomEvent(input, config.nativeSourceId, config.sourceRevision ?? 1, markSourceDiagnostic) : null
      : source.blocked || config.provider === 'custom' ? null : normalizeHook(config.provider, eventName, input, config.repoPath, undefined, markSourceDiagnostic);
    if (normalized && source.fields.nativeSourceId && (!normalized.nativeSessionId || normalized.parentSessionId && !normalized.nativeChildId)) {
      markSourceDiagnostic(!normalized.nativeSessionId ? 'missing-session-id' : 'missing-child-id'); normalized = null;
    }
    if (normalized) {
      const merged = { ...normalized, ...source.fields };
      // Reads fresh every invocation — this process has no memory between hook events. Absent,
      // unreadable or older than a gated field's required value, this stays null and every optional
      // field below stays at the baseline every service build has always understood.
      const capability = readServiceCapabilities(config.spoolPath);
      const gated = gateEventForCapability(merged, capability);
      if (gated) {
        const serialized = JSON.stringify(config.version === 2 ? { version: 2, event: gated } : gated), eventBytes = Buffer.byteLength(serialized, 'utf8');
        let entries = 0, scanned = 0, total = 0, limited = false;
        const directory = opendirSync(config.spoolPath);
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (++scanned > SPOOL_DIRECTORY_LIMIT) { limited = true; break; }
            if (!/^[a-f0-9-]{36}\.(?:json|tmp)$/.test(entry.name)) continue;
            const info = lstatSync(join(config.spoolPath, entry.name));
            if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) { limited = true; break; }
            entries++; total += info.size;
            if (entries >= SPOOL_EVENT_LIMIT || total + eventBytes > SPOOL_BYTE_LIMIT) { limited = true; break; }
          }
        } finally { directory.closeSync(); }
        const full = limited || eventBytes > SPOOL_EVENT_BYTES;
        if (full) markGap();
        else {
          const id = randomUUID(), temporary = join(config.spoolPath, `${id}.tmp`);
          try {
            writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600, flush: true });
            renameSync(temporary, join(config.spoolPath, `${id}.json`));
          } finally { try { unlinkSync(temporary); } catch { /* A successful rename removed the temporary file. */ } }
        }
      }
      // else: this service build doesn't understand this event's kind yet. Nothing is written — not
      // a failure and not a coverage gap, the same as if the native tool had stayed quiet; a future
      // service build sees fresh native activity once it restarts with a newer capability file.
    } else if (!source.blocked && !diagnosticRecorded) markGap();
  } catch { if (!diagnosticRecorded) markGap(); /* Observation never changes a native agent's decision. */ }
  process.stdout.write('{}');
});
process.stdin.on('error', () => { clearTimeout(timer); process.stdout.write('{}'); });
