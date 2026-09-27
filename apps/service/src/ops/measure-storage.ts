/**
 * WS8-13 / WS8-22 storage-budget measurement tool.
 *
 * Reads ONE workspace database (town.sqlite) and reports the numbers the storage
 * budgets in docs/records/storage-plan.md need: the current snapshot size (the
 * `town_state.data` column — the same JSON the browser event stream sends in full
 * per committed event, see app.ts's SSE handler and store.ts's `commit`), how long
 * it takes to JSON.parse, and how many repositories/instruction-file records it
 * holds. It prints only counts, byte sizes and durations — never repository
 * names, paths, report text or any other saved content.
 *
 * This tool is meant to run against a COPY of a real workspace database that has
 * grown to a realistic size (the plan calls for "100 repositories"). No such copy
 * exists in this environment: an owner has not supplied one. Running it against a
 * small or synthetic database produces real, honestly-labelled numbers for THAT
 * database — never a fabricated stand-in for the 100-repository measurement.
 * Extrapolation to 100 repositories is linear and clearly marked as an estimate,
 * not a measurement.
 *
 * Usage:
 *   node --import tsx apps/service/src/ops/measure-storage.ts <path-to-a-COPY-of-town.sqlite> [--json] [--repeat N]
 *
 * After a build:
 *   node apps/service/dist/ops/measure-storage.js <path-to-a-COPY-of-town.sqlite> [--json]
 */
import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

export interface StorageMeasurement {
  measuredAt: string;
  databaseFileBytes: number;
  repositoryCount: number;
  discoveryCandidateCount: number;
  instructionFileCount: number;
  snapshotBytes: number;
  /** The full-state SSE stream frame carries the same JSON as the snapshot (app.ts replay/subscribe path); this is not a separately measured quantity. */
  streamFrameBytesApproximatesSnapshot: true;
  jsonParseMillisMedian: number;
  jsonParseSampleCount: number;
  perRepositoryBytesApprox: number | null;
  extrapolatedAt100RepositoriesBytesApprox: number | null;
  warning: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Pure measurement function so a test can exercise it against a fixture without spawning the CLI. Opens the database READ-ONLY and never mutates it. */
export function measureWorkspaceDatabase(path: string, repeat = 5): StorageMeasurement {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`No file at ${resolved}.`);
  const info = lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a plain database file, not a symbolic link or directory.');
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 50) throw new Error('repeat must be between 1 and 50.');
  const database = new Database(resolved, { readonly: true, fileMustExist: true });
  try {
    database.pragma('trusted_schema = OFF');
    const hasTownState = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='town_state'").get();
    if (!hasTownState) throw new Error('This file has no town_state table. Point this tool at a workspace town.sqlite (not the identity, observation or telemetry database).');
    const row = database.prepare('SELECT data FROM town_state LIMIT 1').get() as { data: string } | undefined;
    if (!row) throw new Error('town_state has no row to measure.');
    const data = row.data;
    const snapshotBytes = Buffer.byteLength(data, 'utf8');
    const parseTimings: number[] = [];
    let state: { repositories?: unknown[]; discovery?: { candidates?: unknown[] } } = {};
    for (let index = 0; index < repeat; index++) {
      const start = process.hrtime.bigint();
      state = JSON.parse(data) as typeof state;
      parseTimings.push(Number(process.hrtime.bigint() - start) / 1_000_000);
    }
    const repositories = Array.isArray(state.repositories) ? state.repositories : [];
    const candidates = Array.isArray(state.discovery?.candidates) ? state.discovery!.candidates! : [];
    const instructionFileCount = [...repositories, ...candidates].reduce((sum: number, repository) => {
      const instructions = (repository as { instructions?: unknown[] })?.instructions;
      return sum + (Array.isArray(instructions) ? instructions.length : 0);
    }, 0);
    const perRepositoryBytesApprox = repositories.length > 0 ? snapshotBytes / repositories.length : null;
    return {
      measuredAt: new Date().toISOString(),
      databaseFileBytes: info.size,
      repositoryCount: repositories.length,
      discoveryCandidateCount: candidates.length,
      instructionFileCount,
      snapshotBytes,
      streamFrameBytesApproximatesSnapshot: true,
      jsonParseMillisMedian: median(parseTimings),
      jsonParseSampleCount: repeat,
      perRepositoryBytesApprox,
      extrapolatedAt100RepositoriesBytesApprox: perRepositoryBytesApprox !== null ? Math.round(perRepositoryBytesApprox * 100) : null,
      warning: repositories.length >= 100
        ? 'Measured directly at 100 or more repositories.'
        : `Measured at ${repositories.length} repositories, not 100. The 100-repository figures are a naive linear extrapolation (perRepositoryBytesApprox * 100), not a measurement, and do not account for baseline/overhead bytes that do not scale per repository. Do not treat them as a real 100-repository measurement.`,
    };
  } finally { database.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.find(arg => !arg.startsWith('--'));
  const asJson = args.includes('--json');
  const repeatIndex = args.indexOf('--repeat');
  const repeat = repeatIndex >= 0 && args[repeatIndex + 1] ? Number(args[repeatIndex + 1]) : 5;
  if (!positional) {
    process.stderr.write('Usage: measure-storage.ts <path-to-a-COPY-of-town.sqlite> [--json] [--repeat N]\n');
    process.stderr.write('Point this at a COPY of a real workspace database, never the live one. It opens read-only and changes nothing.\n');
    process.exitCode = 1;
    return;
  }
  try {
    const measurement = measureWorkspaceDatabase(positional, repeat);
    if (asJson) process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`);
    else {
      process.stdout.write(`Database file: ${measurement.databaseFileBytes.toLocaleString()} bytes\n`);
      process.stdout.write(`Repositories: ${measurement.repositoryCount} (+ ${measurement.discoveryCandidateCount} discovery candidates)\n`);
      process.stdout.write(`Instruction file records: ${measurement.instructionFileCount}\n`);
      process.stdout.write(`Current snapshot / stream-frame size: ${measurement.snapshotBytes.toLocaleString()} bytes\n`);
      process.stdout.write(`JSON.parse median over ${measurement.jsonParseSampleCount} runs: ${measurement.jsonParseMillisMedian.toFixed(2)} ms\n`);
      if (measurement.perRepositoryBytesApprox !== null) process.stdout.write(`Approx bytes per repository: ${measurement.perRepositoryBytesApprox.toFixed(0)}\n`);
      if (measurement.extrapolatedAt100RepositoriesBytesApprox !== null) process.stdout.write(`Naive extrapolation at 100 repositories: ${measurement.extrapolatedAt100RepositoriesBytesApprox.toLocaleString()} bytes\n`);
      process.stdout.write(`${measurement.warning}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Measurement failed.'}\n`);
    process.exitCode = 1;
  }
}

// Only run as a CLI when invoked directly (not when imported by a test importing measureWorkspaceDatabase).
if (typeof process.argv[1] === 'string' && /measure-storage\.(ts|js|mjs|cjs)$/u.test(process.argv[1])) await main();
