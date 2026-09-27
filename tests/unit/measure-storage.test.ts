import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../../apps/service/src/store';
import { privateState } from '../../apps/service/src/workspaces';
import { measureWorkspaceDatabase } from '../../apps/service/src/ops/measure-storage';

// This proves the measurement TOOL works, against a small local fixture. It is
// explicitly NOT the real 100-repository measurement WS8-13/WS8-22 call for: no
// owner-supplied copy of a real workspace database exists in this environment.
// The tool's own `warning` field says so; this test checks that it does.
const roots: string[] = [];
function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agent-town-measure-'));
  roots.push(directory);
  return join(directory, 'town.sqlite');
}
afterEach(() => {
  for (const directory of roots.splice(0)) {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}agent-town-measure-`)) throw new Error('Unsafe fixture cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('storage measurement tool (WS8-13 / WS8-22)', () => {
  it('measures snapshot size, repository/instruction-file counts and JSON parse time honestly on a small fixture', () => {
    const path = temporaryDatabase();
    const workspace = { id: 'workspace-measure', name: 'Measure fixture', kind: 'personal' as const };
    const state = privateState(workspace);
    for (let index = 0; index < 3; index++) {
      state.repositories.push({
        id: `repo-${index}`, name: `Repo ${index}`, description: 'fixture', language: 'TypeScript', branch: 'main', color: '#123456', position: [index, 0],
        instructions: [{ path: 'AGENTS.md', tool: 'codex', scope: 'repository', size: 120, modifiedAt: new Date().toISOString(), hash: null, appliedToRun: false }],
      });
    }
    const store = new Store(path, state);
    try {
      const measurement = measureWorkspaceDatabase(path, 3);
      expect(measurement.repositoryCount).toBe(3);
      expect(measurement.instructionFileCount).toBe(3);
      expect(measurement.snapshotBytes).toBeGreaterThan(0);
      expect(measurement.databaseFileBytes).toBeGreaterThan(0);
      expect(measurement.jsonParseSampleCount).toBe(3);
      expect(measurement.jsonParseMillisMedian).toBeGreaterThanOrEqual(0);
      expect(measurement.perRepositoryBytesApprox).toBeCloseTo(measurement.snapshotBytes / 3, 5);
      expect(measurement.extrapolatedAt100RepositoriesBytesApprox).toBe(Math.round((measurement.snapshotBytes / 3) * 100));
      // Honesty gate: since this fixture has far fewer than 100 repositories, the tool must say so, not report a real 100-repository figure as measured.
      expect(measurement.warning).toContain('not 100');
      expect(measurement.warning).toContain('extrapolation');
      expect(measurement.streamFrameBytesApproximatesSnapshot).toBe(true);
    } finally { store.close(); }
  });

  it('refuses a database with no town_state table instead of guessing', () => {
    const path = temporaryDatabase();
    const database = new Database(path);
    database.exec('CREATE TABLE unrelated(id TEXT)');
    database.close();
    expect(() => measureWorkspaceDatabase(path)).toThrow('town_state');
  });

  it('rejects a missing file and an out-of-range repeat count', () => {
    expect(() => measureWorkspaceDatabase(join(tmpdir(), 'does-not-exist.sqlite'))).toThrow('No file at');
    const path = temporaryDatabase();
    const workspace = { id: 'workspace-measure-2', name: 'Measure fixture 2', kind: 'personal' as const };
    const store = new Store(path, privateState(workspace));
    try { expect(() => measureWorkspaceDatabase(path, 0)).toThrow('repeat must be between'); }
    finally { store.close(); }
  });
});
