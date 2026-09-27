import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolDisplayName } from '@agent-town/contracts';
import { describe, expect, it } from 'vitest';
import * as houseCopy from '../../apps/web/src/houseCopy';
import {
  ASSIGN_SLOT_INTERIM_LINE, BACKGROUND_CHECK_SENTENCE, EMPTY_HOUSE_LINE_1, EMPTY_HOUSE_LINE_2, HOUSE_BANNED_WORDS,
  NO_SESSIONS_SCANNED_LINE, PROJECT_INSPECTOR_LEDE, RESIDENTS_EMPTY_LINE_1, RESIDENTS_EMPTY_LINE_2, RESIDENTS_HEADING,
  RESIDENT_STOPPED_LABEL, TOOL_CHECK_SENTENCES, TOOL_STATE_WORDS, connectedProjectNotice, watchingLede,
} from '../../apps/web/src/houseCopy';

const project = resolve(__dirname, '../..');

/** Every plain string houseCopy.ts exports, plus every string its text-producing functions can return,
 * gathered generically (mirrors first-run-copy.test.ts's allCopyStrings) so a new export is checked
 * automatically instead of only when someone remembers to add it here. */
function allCopyStrings(): string[] {
  const strings: string[] = [];
  for (const [key, value] of Object.entries(houseCopy)) {
    if (key === 'HOUSE_BANNED_WORDS') continue; // the banned-word list names its own banned words by definition
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) { for (const item of value) if (typeof item === 'string') strings.push(item); }
    else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) if (typeof item === 'string') strings.push(item);
    }
  }
  strings.push(watchingLede(['codex']), watchingLede(['claude', 'codex']), watchingLede(['claude', 'codex', 'cursor', 'copilot-cli']));
  strings.push(connectedProjectNotice('payments-api'));
  return strings;
}

describe('house copy (H0-05): plain, truthful wording for the houses-first screens', () => {
  it('never makes a promise this build cannot back up, and never says the owner\'s rejected tracking word', () => {
    for (const text of allCopyStrings()) {
      const lower = text.toLowerCase();
      for (const banned of HOUSE_BANNED_WORDS) expect(lower, `"${banned}" appears in house copy: "${text}"`).not.toContain(banned.toLowerCase());
    }
  });

  it('is registered with the copy registry (FD-07) using the very banned list enforced above, and its registered text functions cover every function-built sentence checked above', () => {
    const { bannedWords, textFunctions } = houseCopy.COPY_REGISTRATION;
    expect(bannedWords).toBe(HOUSE_BANNED_WORDS);
    const registered = Object.values(textFunctions).flatMap(produce => produce());
    expect(registered).toContain(watchingLede(['codex']));
    expect(registered).toContain(watchingLede(['claude', 'codex']));
    expect(registered).toContain(connectedProjectNotice('payments-api'));
  });

  // ACC: "No copy says 'nothing was scanned': it says 'No sessions were scanned' and names the
  // background folder and Git check in one plain sentence."
  describe('"No sessions were scanned", never "nothing was scanned" (D38)', () => {
    it('pins the exact line and the background-check sentence that follows it', () => {
      expect(NO_SESSIONS_SCANNED_LINE).toBe('No sessions were scanned and no agent has started.');
      expect(BACKGROUND_CHECK_SENTENCE).toMatch(/folder and its git status in the background/i);
      expect(PROJECT_INSPECTOR_LEDE).toBe(`${NO_SESSIONS_SCANNED_LINE} ${BACKGROUND_CHECK_SENTENCE}`);
    });

    it('never says "nothing was scanned" anywhere in this module', () => {
      const NOTHING_SCANNED = /\bnothing(?:['’]s)?\s+(?:(?:was|were|is|are|gets|got|has|have|had|will|would|been|being|be|yet|ever|so\s+far)\s+)*scanned\b/gi;
      for (const text of allCopyStrings()) expect(text, text).not.toMatch(NOTHING_SCANNED);
      // Regression fixture: proves the pattern above is non-vacuous (it would catch the banned phrase).
      expect('Nothing was scanned.').toMatch(NOTHING_SCANNED);
    });

    it('the Residents empty state and the empty-house lines both say who can appear, never anything about an approved or assigned task (D41)', () => {
      expect(RESIDENTS_HEADING).toBe('Residents');
      expect(RESIDENTS_EMPTY_LINE_1).toBe('No sessions are being watched. No sessions were scanned.');
      expect(RESIDENTS_EMPTY_LINE_2).toBe('Only sessions you choose to watch appear here.');
      expect(EMPTY_HOUSE_LINE_1).toBe('No one lives here yet.');
      // DES-02: the room/List empty state's second line is "reused from RS-1", so the two must literally agree.
      expect(EMPTY_HOUSE_LINE_2).toBe(RESIDENTS_EMPTY_LINE_2);
      for (const text of [RESIDENTS_EMPTY_LINE_1, RESIDENTS_EMPTY_LINE_2, EMPTY_HOUSE_LINE_1, EMPTY_HOUSE_LINE_2]) {
        expect(text.toLowerCase()).not.toContain('approved');
        expect(text.toLowerCase()).not.toContain('assigned');
      }
    });
  });

  // ACC: "Residents and lede copy never imply Agent Town starts, runs or assigns a task (D41); the lede
  // is conditional once a hook exists."
  describe('the interim Assign slot line and the conditional watching lede (D41)', () => {
    it('pins the exact interim Assign-slot line (DES-02 section 2): no button, just this one line', () => {
      expect(ASSIGN_SLOT_INTERIM_LINE).toBe('Task hand-off: planned, not built yet');
    });

    it('watchingLede names the watched tools and denies starting, running or assigning anything', () => {
      expect(watchingLede(['codex'])).toBe('Agent Town is watching sessions you start in this folder with Codex. It does not start, run or assign anything.');
      expect(watchingLede(['claude', 'codex'])).toBe('Agent Town is watching sessions you start in this folder with Claude Code and Codex. It does not start, run or assign anything.');
      expect(watchingLede(['claude', 'codex', 'cursor'])).toBe('Agent Town is watching sessions you start in this folder with Claude Code, Codex and Cursor. It does not start, run or assign anything.');
    });

    it('watchingLede refuses an empty tool list instead of printing a lede for nothing', () => {
      expect(() => watchingLede([])).toThrow(/at least one watched tool/);
    });

    it('the lede is conditional: PROJECT_INSPECTOR_LEDE and watchingLede never say the other state\'s claim', () => {
      expect(PROJECT_INSPECTOR_LEDE).not.toContain('watching');
      expect(watchingLede(['codex'])).not.toContain('No sessions were scanned');
      expect(watchingLede(['codex'])).not.toContain('no agent has started');
    });
  });

  // ACC: "One state-word table (Receiving, Waiting for first activity, Needs attention, Stopped)
  // everywhere; never 'Hook applied' for a prepared-only connection."
  describe('one state-word table, everywhere (DES-02 section 3)', () => {
    it('pins the exact four per-tool words', () => {
      expect(TOOL_STATE_WORDS).toEqual({
        receiving: 'Receiving',
        waitingForFirstActivity: 'Waiting for first activity',
        needsAttention: 'Needs attention',
        stopped: 'Stopped',
      });
    });

    it('a resident of a stopped connection reads the longer phrase, distinct from the per-tool word', () => {
      expect(RESIDENT_STOPPED_LABEL).toBe('Stopped watching');
      expect(RESIDENT_STOPPED_LABEL).not.toBe(TOOL_STATE_WORDS.stopped);
      expect(RESIDENT_STOPPED_LABEL).toContain(TOOL_STATE_WORDS.stopped);
    });

    it('never says "Hook applied" for a prepared-only connection', () => {
      for (const text of allCopyStrings()) expect(text).not.toContain('Hook applied');
    });
  });

  // ACC + VER: "Per-tool lines match metadata-worker.mjs: Codex read-only (may leave -wal/-shm), Claude
  // SDK reads session files, Cursor SDK its agents file, Copilot CLI starts a runtime." / "Reviewer
  // re-reads metadata-worker.mjs lines 144-210 against each per-tool sentence."
  describe('"What the check reads": one sentence per tool, pinned against metadata-worker.mjs', () => {
    const workerSource = readFileSync(resolve(project, 'apps/service/src/native-discovery/metadata-worker.mjs'), 'utf8');

    it('pins the exact four sentences', () => {
      expect(TOOL_CHECK_SENTENCES).toEqual({
        codex: 'Codex opens its session database read-only (it may leave -wal and -shm files behind).',
        claude: "Claude Code's SDK reads saved session files.",
        cursor: "Cursor's SDK reads its agents file.",
        'copilot-cli': 'Copilot CLI starts its own runtime.',
      });
    });

    it('every AutoDetectSurface tool has exactly one sentence, keyed by the same tool ids the worker reads request.provider as', () => {
      expect(Object.keys(TOOL_CHECK_SENTENCES).sort()).toEqual(['claude', 'codex', 'copilot-cli', 'cursor']);
    });

    it('Codex: reads what metadata-worker.mjs\'s codex branch actually opens (a read-only session database)', () => {
      expect(workerSource).toMatch(/request\.provider === 'codex'/);
      expect(workerSource).toContain("new Database(join(request.homePath, 'state_5.sqlite'), { readonly: true");
      expect(TOOL_CHECK_SENTENCES.codex).toContain('read-only');
      expect(TOOL_CHECK_SENTENCES.codex.toLowerCase()).toContain('-wal');
      expect(TOOL_CHECK_SENTENCES.codex.toLowerCase()).toContain('-shm');
    });

    it('Claude Code: reads what metadata-worker.mjs\'s claude branch actually calls (the SDK\'s listSessions)', () => {
      expect(workerSource).toMatch(/request\.provider === 'claude'/);
      expect(workerSource).toContain("await import('@anthropic-ai/claude-agent-sdk')");
      expect(workerSource).toContain('listSessions');
      expect(TOOL_CHECK_SENTENCES.claude).toContain('SDK');
      expect(TOOL_CHECK_SENTENCES.claude.toLowerCase()).toContain('saved session files');
    });

    it('Cursor: reads what metadata-worker.mjs\'s cursor branch actually opens (the SDK\'s agents file)', () => {
      expect(workerSource).toMatch(/request\.provider === 'cursor'/);
      expect(workerSource).toContain("await import('@cursor/sdk')");
      expect(workerSource).toContain("join(request.homePath, 'agents.ndjson')");
      expect(TOOL_CHECK_SENTENCES.cursor).toContain('SDK');
      expect(TOOL_CHECK_SENTENCES.cursor.toLowerCase()).toContain('agents file');
    });

    it('Copilot CLI: reads what metadata-worker.mjs\'s copilot-cli branch actually does (starts its own runtime, never "read-only")', () => {
      expect(workerSource).toMatch(/request\.provider === 'copilot-cli'/);
      expect(workerSource).toContain("await import('@github/copilot-sdk')");
      expect(workerSource).toContain('await client.start();');
      expect(TOOL_CHECK_SENTENCES['copilot-cli']).toBe('Copilot CLI starts its own runtime.');
      // "read-only" would be false for Copilot CLI (H0-05's own "Why"): it starts a real runtime, unlike
      // the other three, which only open a file or a saved store.
      expect(TOOL_CHECK_SENTENCES['copilot-cli'].toLowerCase()).not.toContain('read-only');
    });

    it('every sentence names the tool it describes, using the same display name the app uses elsewhere', () => {
      for (const tool of ['codex', 'claude', 'cursor', 'copilot-cli'] as const) {
        const name = toolDisplayName[tool];
        expect(TOOL_CHECK_SENTENCES[tool], `${tool} sentence should name "${name}"`).toContain(name);
      }
    });
  });

  // ACC: "The copy test also rejects 'sync', 'syncing' and 'synced' in every UI string." / VER: "a
  // banned-word case for sync, syncing and synced across houseCopy.ts and every string the new screens
  // render (test names, routes and file names are not UI strings)."
  describe('never "sync", "syncing" or "synced" (D38: the owner\'s word is "watch")', () => {
    const SYNC_WORD = /\bsync(?:ing|ed)?\b/i;

    it('houseCopy.ts itself', () => {
      for (const text of allCopyStrings()) expect(text, text).not.toMatch(SYNC_WORD);
    });

    it('the raw source of the two screens this item rewrites (RepositoriesPanel.tsx, RepositoryAgents.tsx)', () => {
      for (const file of ['apps/web/src/RepositoriesPanel.tsx', 'apps/web/src/RepositoryAgents.tsx']) {
        const source = readFileSync(resolve(project, file), 'utf8');
        expect(source, file).not.toMatch(SYNC_WORD);
      }
    });

    it('the regex actually catches every inflection (a non-vacuous check)', () => {
      for (const word of ['sync', 'Sync', 'SYNC', 'syncing', 'Syncing', 'synced', 'Synced']) expect(word).toMatch(SYNC_WORD);
      // Words that merely contain the letters must not be caught (word-boundary, not substring).
      for (const word of ['synchronize', 'synchronous', 'asynchronous']) expect(word).not.toMatch(SYNC_WORD);
    });
  });

  describe('connectedProjectNotice: the post-connect notice replaces "set up live tracking" with the owner\'s word', () => {
    it('names the connected project, the house it now has, and a real entry point, without "live tracking"', () => {
      const text = connectedProjectNotice('payments-api');
      expect(text).toBe('payments-api is connected and has a house in town. Open it and choose Repository details to set up watching this project.');
      expect(text.toLowerCase()).not.toContain('live tracking');
      expect(text).toContain('Repository details');
    });

    // Review finding #1 (major): the first version of this line named "Watch sessions (optional)", a
    // control that does not exist in the running app yet (H0-08, not built, is what relabels "Set up
    // tracking" to that link). This is a lightweight, general cross-check against that whole class of
    // forward-reference drift: any UI-entry-point phrase this notice quotes must be real, rendered text
    // somewhere under apps/web/src today, not just a planned future label.
    it('never names a UI entry point that is not real, rendered text somewhere under apps/web/src today', () => {
      const text = connectedProjectNotice('payments-api');
      expect(text).not.toContain('Watch sessions (optional)');
      const project = resolve(__dirname, '../..');
      const appSource = readFileSync(resolve(project, 'apps/web/src/App.tsx'), 'utf8');
      expect(appSource, 'apps/web/src/App.tsx').toContain('Repository details');
    });
  });
});
