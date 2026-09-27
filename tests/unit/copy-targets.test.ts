import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * UX-05 (Gap 8): a copy-target guard.
 *
 * A "pointer" sentence sends the reader to another named part of this app ("Scroll down in Connections to
 * Let your agents find their town"). When the app changes and the named text is removed, renamed or never
 * existed, the pointer becomes a dead end: it sends a first-time owner looking for something that is not
 * there. This file catches that class of bug two ways:
 *
 * 1. `findDeadPointers` scans a block of copy for a sentence naming one of the app's own real drawer
 *    sections ("in Connections", "under Tasks", ...) followed by "to <phrase>", and flags the named phrase
 *    when it is not one of the real headings, summaries or labels this build actually renders anywhere.
 *    The real-heading corpus (`collectKnownUiText`) is built fresh from the live source on every run —
 *    only literal text (no `{expression}`) can be read this way, the same limit copy-registry.test.ts
 *    documents for its own scan — so it can never silently drift from what a later item renames.
 * 2. A flat "scroll down" ban: this app's drawers never require scrolling to find the next step, so telling
 *    someone to scroll down is itself a smell even when the destination it names is real.
 *
 * SCOPE. The pointer scan runs only over the files UX-05 owns and can fix (App.tsx, WorkflowPanel.tsx,
 * WorkspaceSetup.tsx); the known-heading corpus is read from the whole web app so a heading that lives in
 * another file is still found. A future item adding a new pointer-bearing file adds it to OWNED_FILES.
 */

const WEB_SRC = resolve(__dirname, '..', '..', 'apps', 'web', 'src');
const OWNED_FILES = ['App.tsx', 'WorkflowPanel.tsx', 'WorkspaceSetup.tsx'];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const HEADING_TAG = /<(h[1-4]|summary|legend|caption)\b[^>]*>([^<{]+)<\/\1>/g;
const LABEL_ATTR = /\b(?:aria-label|label|title)="([^"{]+)"/g;

/** Every literal heading, summary, legend, caption, aria-label, label and title string this build
 * actually authors somewhere in the web app. */
export function collectKnownUiText(root: string): ReadonlySet<string> {
  const known = new Set<string>();
  for (const file of listSourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(HEADING_TAG)) known.add(match[2].trim());
    for (const match of text.matchAll(LABEL_ATTR)) known.add(match[1].trim());
  }
  return known;
}

/** The real internal locations a pointer sentence can name ("in Connections", "under Tasks"), read
 * straight from App.tsx's own `sections` array so a renamed or removed section leaves no stale entry. */
export function collectSectionLabels(root: string): readonly string[] {
  const source = readFileSync(join(root, 'App.tsx'), 'utf8');
  const labels = [...source.matchAll(/\{ id: '[^']+', label: '([^']+)'/g)].map(match => match[1]);
  if (labels.length < 5) throw new Error('Expected to read the sections array labels from App.tsx; found too few to trust the pointer scan.');
  return labels;
}

/** Finds every pointer in `text` naming one of `sectionLabels` followed by "to <phrase>", and returns the
 * named phrases that are not in `known` — a dead pointer. Case-sensitive: these section names are always
 * capitalized when they name the real drawer, which keeps the scan from tripping on an unrelated ordinary
 * use of the same common word ("...active connections between agents...") in unrelated prose. */
export function findDeadPointers(text: string, sectionLabels: readonly string[], known: ReadonlySet<string>): string[] {
  const dead: string[] = [];
  for (const label of sectionLabels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(String.raw`\b(?:in|under)\s+${escaped}\b[^.!?]{0,60}?\bto\s+([^,.!?]{3,80})`, 'g');
    for (const match of text.matchAll(pattern)) {
      const named = match[1].trim();
      if (!known.has(named)) dead.push(named);
    }
  }
  return dead;
}

describe('copy targets: a pointer must name text this build really renders', () => {
  it('flags a pointer to a heading this build does not render', () => {
    const known = new Set(['Reports at the desk']);
    const found = findDeadPointers('Scroll down in Connections to Let your agents find their town, then choose Claude Code.', ['Connections'], known);
    expect(found).toEqual(['Let your agents find their town']);
  });

  it('allows a pointer whose named heading really exists', () => {
    const known = new Set(['Reports at the desk']);
    const found = findDeadPointers('See it in Connections, then open to Reports at the desk.', ['Connections'], known);
    expect(found).toEqual([]);
  });

  it('leaves an unrelated, lowercase use of the same word alone', () => {
    const known = new Set(['Reports at the desk']);
    const found = findDeadPointers('Discovery reads the connections between agents, not what they said to each other.', ['Connections'], known);
    expect(found).toEqual([]);
  });

  it('never tells the owner to scroll down, and never sends them to a heading this build does not render', () => {
    const known = collectKnownUiText(WEB_SRC);
    const sectionLabels = collectSectionLabels(WEB_SRC);
    for (const file of OWNED_FILES) {
      const text = readFileSync(join(WEB_SRC, file), 'utf8');
      expect({ file, hasScrollDown: text.toLowerCase().includes('scroll down') }).toEqual({ file, hasScrollDown: false });
      expect({ file, deadPointers: findDeadPointers(text, sectionLabels, known) }).toEqual({ file, deadPointers: [] });
    }
  });
});
