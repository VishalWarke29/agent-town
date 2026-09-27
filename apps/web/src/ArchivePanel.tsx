import { Orbit, Sparkles, LoaderCircle } from 'lucide-react';
import type { DbSchemaSnapshot } from '@agent-town/contracts';
import type { DbSchemaStatus } from './useDbSchema';

export type ArchiveMode = 'none' | 'solar' | 'constellation';
interface Props {
  status: DbSchemaStatus;
  snapshot: DbSchemaSnapshot | null;
  mode: ArchiveMode;
  onSetMode: (mode: ArchiveMode) => void;
}

/** The Archive's inspector: facts first, then the plain accessible list (tables, columns, foreign
 * keys, row counts) which is always shown regardless of the 3D view below, then two explicit,
 * separate 3D options — pick one to compare, or neither. This is Agent Town's own local database
 * only — never a connected project's database — which the copy below states plainly so it is never
 * mistaken for one. Row content is never fetched or shown here: structure and counts only. */
export function ArchivePanel({ status, snapshot, mode, onSetMode }: Props) {
  if (status === 'loading' || status === 'idle') return <p className="muted"><LoaderCircle className="spin" size={15} /> Reading the database structure…</p>;
  if (status === 'unavailable' || !snapshot) return <p className="empty">The database structure could not be read right now. This does not change any saved data.</p>;

  const tableCount = snapshot.groups.reduce((sum, group) => sum + group.tables.length, 0);
  const fkCount = snapshot.groups.reduce((sum, group) => sum + group.foreignKeys.length, 0);
  const toggle = (value: ArchiveMode) => onSetMode(mode === value ? 'none' : value);

  return <>
    <p className="house-lede" data-slot="facts">
      Agent Town's own local database — not any connected project's database. {tableCount} tables, {fkCount} foreign key{fkCount === 1 ? '' : 's'}
      {fkCount === 0 ? <strong> — no foreign keys yet, so neither 3D view has anything to draw a connecting line between</strong> : ''}. Scanned <span className="mono">{new Date(snapshot.scannedAt).toLocaleTimeString()}</span>. Click any table in either 3D view for its full column list.
    </p>
    <div className="segmented" role="group" aria-label="3D visualisation style" style={{ marginBottom: 12 }}>
      <button type="button" aria-pressed={mode === 'solar'} onClick={() => toggle('solar')}><Orbit size={15} />Solar system</button>
      <button type="button" aria-pressed={mode === 'constellation'} onClick={() => toggle('constellation')}><Sparkles size={15} />Constellation</button>
    </div>
    {mode !== 'none' && <p className="muted small" style={{ marginBottom: 12 }}>
      {mode === 'solar'
        ? 'Each database file is a sun; each table orbits it, or orbits the table it depends on (a foreign key) as a moon. Orbit distance shows dependency depth; size shows row count.'
        : 'Every table is a star; foreign keys pull related stars closer together, like a star chart. No hierarchy — useful when the connections matter more than which table is central.'}
    </p>}
    {snapshot.groups.map(group => <section key={group.fileKind} className="detail-section">
      <div className="section-summary"><h3>{group.label}</h3><span>{group.tables.length} tables</span></div>
      <table>
        <caption className="sr-only">Tables in {group.label}</caption>
        <thead><tr><th>Table</th><th>Columns</th><th>Foreign keys</th><th>Rows</th></tr></thead>
        <tbody>{group.tables.map(table => {
          const outgoing = group.foreignKeys.filter(fk => fk.fromTable === table.name);
          return <tr key={table.name}>
            <td data-label="Table"><strong className="mono">{table.name}</strong></td>
            <td data-label="Columns">{table.columns.map(column => column.name).join(', ')}{table.hiddenColumnCount > 0 && <small> · {table.hiddenColumnCount} hidden for privacy</small>}</td>
            <td data-label="Foreign keys">{outgoing.length ? outgoing.map(fk => `${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}`).join(', ') : '—'}</td>
            <td data-label="Rows">{table.rowCount === null ? 'Unavailable' : table.rowCount}</td>
          </tr>;
        })}</tbody>
      </table>
    </section>)}
  </>;
}
