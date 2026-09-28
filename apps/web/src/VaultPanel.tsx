import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, LoaderCircle, ShieldAlert } from 'lucide-react';
import type { TownState, VaultBackupSummary, VaultManifest, VaultRestoreOperationView, VaultRestorePreviewResult, VaultScanResult, VaultStatus } from '@agent-town/contracts';

type RequestFn = <T,>(path: string, body?: unknown, signal?: AbortSignal, method?: 'GET' | 'POST' | 'PATCH') => Promise<T>;
const bytesText = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
const timeText = (value: string) => new Date(value).toLocaleString();
/** Backup/restore can move up to 4 GiB of local, encrypted file data — the shared 20s client default
 * (useIdentity.ts) is tuned for ordinary API calls and is not enough for that; a client-side timeout
 * here must never be mistaken for the server-side restore having failed (it keeps running either way). */
const LONG_TIMEOUT_MS = 300_000;
type VaultOperation = 'enable' | 'scan' | 'backup' | 'loadBackups' | 'loadOperations' | 'preview' | 'restore' | 'resume';

/** PV-05: a plain-English sentence for every scan issue code the service can return (vault/scan.ts),
 * so a partial scan is never silently dropped from what the owner is shown. Kept in this file (not a
 * *Copy.ts module) since it is a small, fixed, non-registered mapping local to this one panel. */
const SCAN_ISSUE_TEXT: Record<string, string> = {
  'time-limit': 'The scan stopped early after its time limit. Some files may be missing from this list.',
  'scan-limit': 'The scan stopped early after reaching its file/entry limit. Some files may be missing from this list.',
  'unreadable-directory': 'Some folders could not be read and are not included.',
  'ignore-rule-limit': 'A .gitignore file was too large to apply in full; some of its rules were skipped.',
  'unreadable-ignore-rules': 'A .gitignore file could not be read, so its rules were not applied.',
  'linked-path-excluded': 'Linked (symlinked) files or folders are excluded from backup.',
  'depth-limit': 'Some deeply nested folders were not scanned.',
  'unsafe-file-excluded': 'Some files with more than one hard link were excluded for safety.',
  'unreadable-file': 'Some files could not be read and could not be checked for secrets.',
  'sensitive-file-too-large-to-scan': 'A credential-shaped file was too large to check for secrets \u2014 review it yourself before including it.',
  'nested-repository-excluded': 'A nested Git repository inside this project was not scanned. Back it up separately if you need it.',
};
const scanIssueText = (issue: string) => SCAN_ISSUE_TEXT[issue] ?? `Unrecognized scan condition: ${issue}.`;

/**
 * Cross-device backup of a connected project's own files, including gitignored ones a plain `git
 * clone` on a second machine would never bring back (DR-061, 2026-09-25). Local-folder backend only
 * today \u2014 no real hosted vendor account exists in this repo, so "enable" points at a local folder
 * (e.g. a second drive) rather than a cloud service; that is said plainly below, not implied.
 * Gitignored and sensitively-named files are never pre-selected \u2014 the person reviews and ticks them.
 * A file with a likely secret blocks the backup entirely; there is no override in this version.
 */
export function VaultPanel({ state, request, repoId, repoName, sharedStatus, onStatusChange }: {
  state: TownState; request: RequestFn; repoId: string; repoName: string;
  sharedStatus: VaultStatus | null; onStatusChange: (status: VaultStatus) => void;
}) {
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}`;
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState('');
  const [scan, setScan] = useState<VaultScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [passphrase, setPassphrase] = useState('');
  // PV-05: one label per in-flight operation, not a single shared boolean \u2014 so each button's own
  // spinner reflects whether IT is the one running, not merely that "something, somewhere" is busy
  // (`busy` below is still used to keep the existing "only one action at a time" safety gate).
  const [busyOp, setBusyOp] = useState<VaultOperation | null>(null);
  const busy = busyOp !== null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manifest, setManifest] = useState<VaultManifest | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [backups, setBackups] = useState<VaultBackupSummary[] | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreDirectory, setRestoreDirectory] = useState('');
  const [restorePreview, setRestorePreview] = useState<VaultRestorePreviewResult | null>(null);
  const [pendingOperations, setPendingOperations] = useState<VaultRestoreOperationView[] | null>(null);
  const [resumePassphrase, setResumePassphrase] = useState('');
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // Accessibility: a status/error line replacing a control that just unmounted (e.g. "Resume restore" or
  // "Restore N files here", once the action they performed removes the block containing them) is the
  // sanest next focus target — otherwise focus silently reverts to <body> with no visual cue for a
  // sighted keyboard user, even though a screen reader still hears the role=status/alert text.
  useEffect(() => { if (notice) noticeRef.current?.focus({ preventScroll: true }); }, [notice]);
  useEffect(() => { if (error) errorRef.current?.focus({ preventScroll: true }); }, [error]);

  const act = async (op: VaultOperation, work: () => Promise<void>) => {
    setBusyOp(op); setError(null);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'This request could not be completed.'); }
    finally { setBusyOp(null); }
  };
  const enable = () => act('enable', async () => {
    const result = await request<VaultStatus>(`${prefix}/vault/enable`, { directory });
    onStatusChange(result); setNotice('Project Vault is on. This is a local folder today, not a cloud service \u2014 point it at a second drive or a folder you sync some other way.');
  });
  const runScan = () => act('scan', async () => {
    const result = await request<VaultScanResult>(`${prefix}/vault/scan`, { repoId });
    setScan(result); setManifest(null);
    setSelected(new Set(result.entries.filter(entry => !entry.gitignored && !entry.sensitiveName).map(entry => entry.path)));
  });
  const findingFor = (path: string) => scan?.findings.find(finding => finding.path === path);
  const blockedByFindings = [...selected].some(path => findingFor(path));
  const refreshVaultStatus = async () => { try { onStatusChange(await request<VaultStatus>(`${prefix}/vault`, undefined, undefined, 'GET')); } catch { /* Best-effort: the prior known status stays displayed. */ } };
  const backup = () => act('backup', async () => {
    try {
      const result = await request<VaultManifest>(`${prefix}/vault/backup`, { repoId, paths: [...selected], passphrase }, AbortSignal.timeout(LONG_TIMEOUT_MS));
      setManifest(result); setNotice(`Backed up ${result.fileCount} file${result.fileCount === 1 ? '' : 's'} (${bytesText(result.totalBytes)}), encrypted with your passphrase.`);
      // PV-05: refresh the shared "last backed up" status/list now, rather than only whenever some
      // unrelated effect happens to refire \u2014 the badge and any other open Vault section must reflect
      // this backup immediately, not silently lag until the next workspace change.
      await refreshVaultStatus();
    } finally {
      // Never retained past this one request, success or failure — the field's own label promises this.
      setPassphrase('');
    }
  });
  const fetchBackups = async () => { setBackups(await request<VaultBackupSummary[]>(`${prefix}/vault/backups`, undefined, undefined, 'GET')); };
  const fetchRestoreOperations = async () => {
    setPendingOperations(await request<VaultRestoreOperationView[]>(`${prefix}/vault/backups/${encodeURIComponent(repoId)}/restore-operations`, undefined, undefined, 'GET'));
  };
  // Best-effort: a refresh failing here must never mask the primary restore/resume result it follows,
  // and must never be fired-and-forgotten either (an un-awaited nested act() call previously let the
  // outer busy flag clear while these were still in flight, and let a stale response overwrite a newer
  // action's error/notice — every caller below awaits this directly, with no act() wrapper of its own).
  const refreshRestoreState = async () => { await Promise.allSettled([fetchBackups(), fetchRestoreOperations()]); };
  const loadBackups = () => act('loadBackups', fetchBackups);
  const loadRestoreOperations = () => act('loadOperations', fetchRestoreOperations);
  const preview = () => act('preview', async () => {
    try {
      const result = await request<VaultRestorePreviewResult>(`${prefix}/vault/backups/${encodeURIComponent(repoId)}/restore-preview`, { passphrase: restorePassphrase, destinationDirectory: restoreDirectory }, AbortSignal.timeout(LONG_TIMEOUT_MS));
      setRestorePreview(result);
      // Deliberately NOT cleared here: restore() below reuses this same typed passphrase for the very
      // next request in this two-step flow. Only a failed preview clears it (nothing to reuse it for).
    } catch (cause) { setRestorePassphrase(''); throw cause; }
  });
  const restore = () => act('restore', async () => {
    if (!restorePreview) return;
    const destination = restorePreview.destination;
    try {
      const result = await request<VaultManifest>(`${prefix}/vault/backups/${encodeURIComponent(repoId)}/restore`, { operationId: restorePreview.operationId, passphrase: restorePassphrase }, AbortSignal.timeout(LONG_TIMEOUT_MS));
      setNotice(`Restored ${result.fileCount} file${result.fileCount === 1 ? '' : 's'} into ${destination}.`);
    } finally {
      // Runs on success AND failure (including a client-side timeout the server-side restore may have
      // outlived): never keep a stale binding to retry against, never keep the passphrase, and always
      // refresh so an operation that kept running server-side shows up immediately as active/interrupted
      // instead of silently only after a full page reload.
      setRestorePreview(null); setRestorePassphrase(''); setRestoreDirectory('');
      await refreshRestoreState();
    }
  });
  const resumeRestore = (operationId: string) => act('resume', async () => {
    try {
      const result = await request<VaultManifest>(`${prefix}/vault/backups/${encodeURIComponent(repoId)}/restore`, { operationId, passphrase: resumePassphrase }, AbortSignal.timeout(LONG_TIMEOUT_MS));
      setNotice(`Restored ${result.fileCount} file${result.fileCount === 1 ? '' : 's'}.`);
    } finally {
      setResumePassphrase('');
      await refreshRestoreState();
    }
  });
  // PV-05: a passphrase left typed-but-never-submitted must not linger once the panel is collapsed —
  // "kept only on this request" should not depend on the owner remembering to submit or clear it first.
  const toggleOpen = () => setOpen(value => {
    const next = !value;
    if (!next) { setPassphrase(''); setRestorePassphrase(''); setResumePassphrase(''); }
    return next;
  });

  const repoStatus = sharedStatus?.repositories.find(item => item.repoId === repoId);
  const eligibleCount = scan ? scan.entries.filter(entry => !findingFor(entry.path)).length : 0;
  return <div className="vault-panel">
    <button type="button" className="vault-toggle" onClick={toggleOpen} aria-expanded={open}>
      {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<Lock size={14} /><span>Project Vault{repoStatus?.lastBackupAt ? ` \u00b7 last backed up ${timeText(repoStatus.lastBackupAt)}` : ''}</span>
    </button>
    {open && <div className="vault-body">
      <p className="muted small">Back up {repoName}&rsquo;s own files &mdash; including ones never pushed to GitHub &mdash; to a local folder you choose, encrypted with a passphrase only you hold. Local folder only today; no cloud account is connected.</p>
      {!sharedStatus?.enabled && <div className="vault-enable">
        <label>Local backup folder<input type="text" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="e.g. D:\\AgentTownVault or a synced folder path" disabled={busy} /></label>
        <button className="button" disabled={busy || !directory.trim()} onClick={() => void enable()}>{busyOp === 'enable' ? <LoaderCircle size={16} className="spin" /> : <Lock size={16} />}Turn on Project Vault</button>
      </div>}
      {sharedStatus?.enabled && <>
        <p className="muted small">Backup folder: <code>{sharedStatus.backend?.directory}</code></p>
        <button className="button" disabled={busy} onClick={() => void runScan()}>{busyOp === 'scan' ? <LoaderCircle size={16} className="spin" /> : null}Scan project files</button>
        {scan && <>
          <p className="muted small">{scan.entries.length} file{scan.entries.length === 1 ? '' : 's'} found ({bytesText(scan.totalBytes)}){scan.entries.length > 0 ? `, ${eligibleCount} eligible to include by default` : ''}. Gitignored and credential-shaped files are never pre-selected &mdash; review before including them.</p>
          {scan.entries.length === 0 && <p className="muted small">No files were found to back up for this project.</p>}
          {scan.issues.length > 0 && <ul className="setup-steps" role="status">{scan.issues.map(issue => <li key={issue}>{scanIssueText(issue)}</li>)}</ul>}
          <ul className="vault-file-list">
            {scan.entries.map(entry => {
              const finding = findingFor(entry.path);
              return <li key={entry.path} className={finding ? 'vault-file-blocked' : ''}>
                <label>
                  <input type="checkbox" checked={selected.has(entry.path)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(entry.path); else next.delete(entry.path); return next; })} />
                  <span className="vault-file-path">{entry.path}</span>
                  <span className="vault-file-meta">{bytesText(entry.sizeBytes)}{entry.gitignored ? ' \u00b7 gitignored' : ''}{entry.sensitiveName ? ' \u00b7 credential-shaped name' : ''}</span>
                </label>
                {finding && <p className="vault-finding" role="alert"><ShieldAlert size={13} /> Likely secret on line {finding.line} ({finding.ruleId}): {finding.redactedSnippet}. Deselect this file to continue.</p>}
              </li>;
            })}
          </ul>
          {scan.entries.length > 0 && selected.size === 0 && <p className="muted small">Nothing is selected yet &mdash; tick at least one file above to back it up.</p>}
          <label>Passphrase (kept only on this request, never saved)<input type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} disabled={busy} /></label>
          <button className="button primary" disabled={busy || !selected.size || passphrase.length < 12 || blockedByFindings} onClick={() => void backup()}>
            {busyOp === 'backup' ? <LoaderCircle size={16} className="spin" /> : <Lock size={16} />}Back up {selected.size} selected file{selected.size === 1 ? '' : 's'}
          </button>
          {blockedByFindings && <p className="form-error" role="alert">A selected file has a likely secret. Deselect it above before backing up.</p>}
        </>}
        {manifest && <p className="form-notice" role="status">Backup complete: {manifest.fileCount} files, {bytesText(manifest.totalBytes)}.</p>}
        <button type="button" className="text-button" disabled={busy} onClick={() => { setRestoreOpen(value => !value); if (!backups) void loadBackups(); if (!pendingOperations) void loadRestoreOperations(); }}>{restoreOpen ? 'Hide restore' : 'Restore from a backup'}</button>
        {restoreOpen && <div className="vault-restore">
          {backups === null && <p className="muted small" role="status">Loading backups&hellip;</p>}
          {backups?.length === 0 && <p className="muted small">No backups found in this folder yet.</p>}
          {backups && backups.length > 0 && <ul className="vault-backup-list">{backups.map(item => <li key={item.repoId}><strong>{item.label}</strong><small>{timeText(item.createdAt)} &middot; {item.fileCount} files &middot; {bytesText(item.totalBytes)}</small></li>)}</ul>}
          {(() => {
            const interrupted = pendingOperations?.find(op => op.needsPassphrase);
            const active = pendingOperations?.find(op => op.active);
            if (interrupted) return <>
              <p className="form-notice" role="status">A previous restore for this backup was interrupted (status: {interrupted.status}). Enter the passphrase to resume.</p>
              <label>Passphrase<input type="password" value={resumePassphrase} onChange={event => setResumePassphrase(event.target.value)} disabled={busy} /></label>
              <button className="button primary" disabled={busy || resumePassphrase.length < 12} onClick={() => void resumeRestore(interrupted.id)}>{busyOp === 'resume' ? <LoaderCircle size={16} className="spin" /> : null}Resume restore</button>
            </>;
            if (active) return <>
              <p className="muted small" role="status">A restore is currently running.</p>
              <button type="button" className="text-button" disabled={busy} onClick={() => void loadRestoreOperations()}>{busyOp === 'loadOperations' ? <LoaderCircle size={16} className="spin" /> : null}Refresh status</button>
            </>;
            return null;
          })()}
          <p className="muted small">Only the most recent backup is kept per project here &mdash; a new backup replaces the previous one; this is not a version history. To restore a DIFFERENT project&rsquo;s backup, or restore with no project connected at all, use "Restore a project from Vault" above.</p>
          <label>Restore into this folder<input type="text" value={restoreDirectory} onChange={event => setRestoreDirectory(event.target.value)} placeholder="An empty or new local folder" disabled={busy} /></label>
          <label>Passphrase<input type="password" value={restorePassphrase} onChange={event => setRestorePassphrase(event.target.value)} disabled={busy} /></label>
          <button className="button" disabled={busy || restorePassphrase.length < 12 || !restoreDirectory.trim()} onClick={() => void preview()}>{busyOp === 'preview' ? <LoaderCircle size={16} className="spin" /> : null}Preview this backup</button>
          {restorePreview && <>
            <p className="muted small">{restorePreview.manifest.label}: {restorePreview.manifest.fileCount} files, {bytesText(restorePreview.manifest.totalBytes)}, backed up {timeText(restorePreview.manifest.createdAt)}.</p>
            <p className="muted small">Restoring into <code>{restorePreview.destination}</code> ({restorePreview.destinationKind === 'new' ? 'a new folder' : 'an existing empty folder'}).</p>
            <button className="button primary" disabled={busy} onClick={() => void restore()}>{busyOp === 'restore' ? <LoaderCircle size={16} className="spin" /> : null}Restore {restorePreview.manifest.fileCount} files here</button>
          </>}
        </div>}
      </>}
      {error && <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
      {notice && <p className="form-notice" role="status" tabIndex={-1} ref={noticeRef}>{notice}</p>}
    </div>}
  </div>;
}
