import type { InstructionFile, ObservationConnection } from '@agent-town/contracts';
import { SKILLS_GROUP_HEADING, SKILLS_GROUP_NOTE } from './skillsCopy';

const toolLabel: Record<string, string> = { shared: 'Shared (AGENTS.md)', claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', copilot: 'GitHub Copilot' };

/** Mirrors the config path apps/service/src/observation/setup.ts's observationSetup() writes for each
 * provider. Duplicated here as a read-only, informational label only (this never writes a file, and
 * that service module stays the sole owner of what actually gets written) — keep the two in step if
 * a provider's tracking file location changes. Returns null for a provider (custom) that writes no
 * native hook file at all. */
function trackingConfigPath(provider: ObservationConnection['provider'], connectionId: string): string | null {
  switch (provider) {
    case 'claude': return '.claude/settings.local.json';
    case 'codex': return '.codex/hooks.json';
    case 'cursor': return '.cursor/hooks.json';
    case 'copilot-vscode': case 'copilot-cli': return `.github/hooks/agent-town-${connectionId}.json`;
    default: return null;
  }
}

/** True for both an active and a revoked connection: the file Agent Town wrote stays labelled even
 * after tracking is revoked, since it is still the same file on disk. */
function trackingLabel(file: InstructionFile, repoId: string, connections: readonly ObservationConnection[]): string | null {
  const target = file.path.replaceAll('\\', '/').toLowerCase();
  const wrote = connections.some(connection => connection.repoId === repoId && trackingConfigPath(connection.provider, connection.id)?.toLowerCase() === target);
  return wrote ? 'Added by Agent Town (Watch sessions)' : null;
}

function FileRow({ file, repoId, connections }: { file: InstructionFile; repoId: string; connections: readonly ObservationConnection[] }) {
  const tracking = trackingLabel(file, repoId, connections);
  return <article className="instruction-card">
    <code>{file.path}</code>
    <small>{toolLabel[file.tool] ?? file.tool} · {file.scope}</small>
    <small>{file.size.toLocaleString()} bytes · updated {new Date(file.modifiedAt).toLocaleDateString()}</small>
    {tracking && <small className="instruction-tracking-tag">{tracking}</small>}
  </article>;
}

/**
 * Groups a repository's scanned instruction and tool-configuration files by their kind, so Agent
 * Town's own tracking files (hooks, tool settings) are never shown alongside real agent guidance.
 *
 * A file with no `kind` (a record saved before this field existed) is shown under "Other files" until
 * the project is scanned again; it is never guessed into a group.
 */
export function InstructionFiles({ files, repoId, connections = [] }: { files: InstructionFile[]; repoId: string; connections?: readonly ObservationConnection[] }) {
  const instructions = files.filter(file => file.kind === 'instructions' || file.kind === 'rules' || file.kind === 'agent');
  const settings = files.filter(file => file.kind === 'settings' || file.kind === 'hooks');
  const skills = files.filter(file => file.kind === 'skill');
  const other = files.filter(file => !file.kind);
  return <div className="instruction-groups">
    <section aria-label="Instructions your tools read">
      <h4>Instructions your tools read</h4>
      {instructions.length ? instructions.map(file => <FileRow key={file.path} file={file} repoId={repoId} connections={connections} />) : <p className="muted small">No instruction files were found in the scanned scope.</p>}
    </section>
    <section aria-label="Tool settings, not instructions">
      <h4>Tool settings <span className="muted">(not instructions)</span></h4>
      {settings.length ? settings.map(file => <FileRow key={file.path} file={file} repoId={repoId} connections={connections} />) : <p className="muted small">No tool-settings or hook files were found.</p>}
    </section>
    {!!skills.length && <section aria-label={SKILLS_GROUP_HEADING}>
      <h4>{SKILLS_GROUP_HEADING}</h4>
      <p className="muted small">{SKILLS_GROUP_NOTE}</p>
      {skills.map(file => <FileRow key={file.path} file={file} repoId={repoId} connections={connections} />)}
    </section>}
    {!!other.length && <section aria-label="Other files">
      <h4>Other files</h4>
      <p className="muted small">Scanned before Agent Town recorded each file's kind. Scan again to sort these into the groups above.</p>
      {other.map(file => <FileRow key={file.path} file={file} repoId={repoId} connections={connections} />)}
    </section>}
  </div>;
}
