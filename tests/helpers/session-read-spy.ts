/**
 * sessionReadSpy(): counts calls to discoverNativeSessions (apps/service/src/native-discovery/index.ts), the MAIN door
 * through which the service reads another tool's saved sessions (Codex, Claude Code, Cursor, Copilot CLI). "Connecting a tool
 * reads no session; only an explicit scan does" is checked by count() staying 0 until the scan.
 *
 * It is NOT the only reader, so a passing count is not proof that nothing was read. A second one exists today:
 * detectedTools() (apps/service/src/observation/native-api.ts) calls codexVersion(), which opens Codex's state_5.sqlite with
 * better-sqlite3 and reads the newest cli_version from its threads table, only to show a version string. detectedTools() runs
 * on GET native-setup, the connect screen, and in observation/service.ts. sessionReadSpy cannot see that read. Only
 * isolatedProfile() stands in its way, and only by accident: better-sqlite3's JavaScript wrapper calls fs.existsSync on the
 * database's folder first, and the native open after it is invisible to any fs patch. So a spec that claims "connecting reads
 * no session store" pairs this spy with isolatedProfile() and with a real fixture profile check, and does not lean on this spy
 * alone. (Whether connecting should open a session-store database at all is a product question for the H0 owner.)
 *
 * By default the real reader is replaced by a stub that answers 'unavailable', so a flow that reaches for a session store
 * neither starts the metadata helper process nor touches any profile folder. Pass { passThrough: true } to record the call
 * and still run the real reader (for a test that owns a fixture profile).
 *
 * It works by spying on the module's export, so it sees every caller that imports the function from that module (the scan
 * route and the project tool-detection route both do). Limits are the ones in ./index.ts: it does not see a caller that
 * reads a session store some other way (plain file reads, or codexVersion() above), which is what isolatedProfile()'s
 * folder guard is for.
 */
import { vi, type MockInstance } from 'vitest';
import * as nativeDiscovery from '../../apps/service/src/native-discovery/index';
import type { NativeDiscoveryInput, NativeDiscoveryResult } from '../../apps/service/src/native-discovery/index';

export interface SessionRead {
  provider: NativeDiscoveryInput['provider'];
  homePath: string;
  repoPath: string;
  includeOlder: boolean;
  hasCursor: boolean;
}

export interface SessionReadSpy {
  readonly reads: readonly SessionRead[];
  count(): number;
  /** Throws when any session read was attempted. */
  expectNone(): void;
  /** Puts the real function back. */
  restore(): void;
}

export function sessionReadSpy(options: { passThrough?: boolean; result?: NativeDiscoveryResult } = {}): SessionReadSpy {
  const reads: SessionRead[] = [];
  const real = nativeDiscovery.discoverNativeSessions;
  const stub: NativeDiscoveryResult = options.result ?? { sessions: [], nextCursor: null, status: 'unavailable', message: 'sessionReadSpy: no session store was read.' };
  const spy: MockInstance<typeof real> = vi.spyOn(nativeDiscovery, 'discoverNativeSessions').mockImplementation(async input => {
    reads.push({ provider: input.provider, homePath: input.homePath, repoPath: input.repoPath, includeOlder: !!input.includeOlder, hasCursor: !!input.cursor });
    return options.passThrough ? real(input) : stub;
  });
  return {
    get reads() { return [...reads]; },
    count: () => reads.length,
    expectNone: () => {
      if (reads.length) throw new Error(`Expected no native session read, but ${reads.length} were attempted: ${reads.map(read => read.provider).join(', ')}`);
    },
    restore: () => spy.mockRestore(),
  };
}
