import { useEffect, useId, useRef, useState } from 'react';
import { Check, FolderPlus, LoaderCircle, Lock } from 'lucide-react';
import type { Repository, TownState, VaultBackupSummary, VaultRestorePreviewResult, VaultStatus } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';
import { useFolderBrowse } from './useFolderBrowse';
import { folderWindowText } from './reasonText';

const bytesText = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
const timeText = (value: string) => new Date(value).toLocaleString();
const LONG_TIMEOUT_MS = 300_000;
/** A short, non-cryptographic disambiguator for two backups that happen to share the same display
 * label (PV-03: "distinguish same-name backups") — never claimed as a secure identifier, just enough
 * of the opaque storage key for a person to tell two same-named entries apart in a short list. */
const shortKey = (repoId: string) => repoId.length <= 10 ? repoId : `${repoId.slice(0, 6)}…${repoId.slice(-4)}`;

/**
 * PV-03: restore is a workspace-level entry, reachable with zero connected local projects, decoupled
 * from whichever project (if any) is currently open elsewhere in the app. `VaultPanel.tsx` (mounted
 * per connected project) keeps its own restore section for the common "restore into the project I'm
 * already looking at" case; this component exists specifically for the disconnected/cross-project
 * recovery case PV-03 targets — a fresh workspace with no project connected yet, or restoring a
 * DIFFERENT project's backup than the one currently open. Enabling Project Vault itself is also
 * workspace-level (no project is required), so this component offers that too when it is not on yet.
 */
export function VaultRestoreEntry({ state, request, available, sharedStatus, onStatusChange, onConnected }: {
  state: TownState; request: IdentityController['request']; available: boolean;
  sharedStatus: VaultStatus | null; onStatusChange: (status: VaultStatus) => void; onConnected?: (repoId: string) => void;
}) {
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}`;
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [backups, setBackups] = useState<VaultBackupSummary[] | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [destination, setDestination] = useState('');
  const [preview, setPreview] = useState<VaultRestorePreviewResult | null>(null);
  const [restoredPath, setRestoredPath] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const helpId = useId();
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const browseRef = useRef<HTMLButtonElement>(null);
  const folder = useFolderBrowse({ prefix, request, onPath: setDestination, fields: { field: fieldRef, browse: browseRef } });
  useEffect(() => { if (notice) noticeRef.current?.focus({ preventScroll: true }); }, [notice]);
  useEffect(() => { if (error) errorRef.current?.focus({ preventScroll: true }); }, [error]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'This request could not be completed.'); }
    finally { setBusy(false); }
  };
  const enable = () => act(async () => {
    const result = await request<VaultStatus>(`${prefix}/vault/enable`, { directory });
    onStatusChange(result); setNotice('Project Vault is on for this workspace. You can now restore from a backup here, even before connecting a project.');
  });
  const loadBackups = () => act(async () => { setBackups(await request<VaultBackupSummary[]>(`${prefix}/vault/backups`, undefined, undefined, 'GET')); });
  const selected = backups?.find(item => item.repoId === selectedRepoId) ?? null;
  const previewBackup = () => act(async () => {
    if (!selected) return;
    try {
      const result = await request<VaultRestorePreviewResult>(`${prefix}/vault/backups/${encodeURIComponent(selected.repoId)}/restore-preview`, { passphrase, destinationDirectory: destination }, AbortSignal.timeout(LONG_TIMEOUT_MS));
      setPreview(result);
    } catch (cause) { setPassphrase(''); throw cause; }
  });
  const restore = () => act(async () => {
    if (!preview || !selected) return;
    const path = preview.destination;
    try {
      const result = await request<{ fileCount: number }>(`${prefix}/vault/backups/${encodeURIComponent(selected.repoId)}/restore`, { operationId: preview.operationId, passphrase }, AbortSignal.timeout(LONG_TIMEOUT_MS));
      setNotice(`Restored ${result.fileCount} file${result.fileCount === 1 ? '' : 's'} into ${path}. Nothing is connected or watched automatically.`);
      setRestoredPath(path);
    } finally { setPreview(null); setPassphrase(''); setDestination(''); }
  });
  const connectThisFolder = () => act(async () => {
    if (!restoredPath) return;
    setConnecting(true);
    try {
      // `/projects/local` only accepts a path already on the allowed-roots list (the same prerequisite
      // "Add this project" establishes above, in Local folders) — a restored destination is new to
      // Agent Town and is never on that list yet, so add it first, in the same explicit action.
      await request(`${prefix}/roots`, { path: restoredPath });
      const result = await request<{ repository: Repository }>(`${prefix}/projects/local`, { path: restoredPath });
      setNotice(`Connected ${result.repository.name} as a project. Watching and tool setup are separate, explicit steps.`);
      setRestoredPath(null);
      if (onConnected) onConnected(result.repository.id);
    } finally { setConnecting(false); }
  });

  const enabled = !!sharedStatus?.enabled;
  return <section className="vault-restore-entry" aria-label="Restore a project from Vault">
    <button type="button" className="vault-toggle" onClick={() => { setOpen(value => !value); if (!open && enabled && !backups) void loadBackups(); }} aria-expanded={open}>
      <Lock size={14} /><span>Restore a project from Vault</span>
    </button>
    {open && <div className="vault-body">
      <p className="muted small">Restore a project&rsquo;s encrypted backup here — from any earlier backup, whether or not that project is connected right now, or any project at all is. This is separate from the per-project backup panel below.</p>
      {!enabled && <div className="vault-enable">
        <p className="muted small">Project Vault is not on for this workspace yet. Point it at the same local folder (or drive) the original backup was written to, then pick the backup below.</p>
        <label>Local backup folder<input type="text" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="e.g. D:\\AgentTownVault or a synced folder path" disabled={busy} /></label>
        <button className="button" disabled={busy || !available || !directory.trim()} onClick={() => void enable()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Lock size={16} />}Turn on Project Vault</button>
      </div>}
      {enabled && <>
        <p className="muted small">Backup folder: <code>{sharedStatus?.backend?.directory}</code>. Only the most recent backup is kept per project — restoring does not offer a version history, and a new backup replaces the previous one for that same project.</p>
        {backups === null && <p className="muted small" role="status">Loading backups…</p>}
        {backups?.length === 0 && <p className="muted small">No backups found in this folder yet.</p>}
        {backups && backups.length > 0 && <fieldset className="setup-form"><legend>Choose a backup to restore</legend>
          {backups.map(item => <label key={item.repoId} className="candidate-row"><input type="radio" name="vault-restore-backup" checked={selectedRepoId === item.repoId} onChange={() => { setSelectedRepoId(item.repoId); setPreview(null); }} />
            <span><strong>{item.label}</strong><small>Backup id {shortKey(item.repoId)} · {timeText(item.createdAt)} · {item.fileCount} file{item.fileCount === 1 ? '' : 's'} · {bytesText(item.totalBytes)}</small></span>
          </label>)}
        </fieldset>}
        {selected && <>
          <div className="folder-field-row">
            <label>Restore into this folder<input ref={fieldRef} type="text" value={destination} onChange={event => { setDestination(event.target.value); folder.clearMessage(); }} placeholder="An empty or new local folder" disabled={busy} aria-describedby={`${helpId}-dest`} /></label>
            <button type="button" ref={browseRef} className="button folder-browse-button" aria-busy={folder.active} disabled={!folder.active && !available} onClick={folder.browse}>{folder.active ? <LoaderCircle size={16} className="spin" /> : null}{folderWindowText.browse}</button>
          </div>
          <div className="folder-browse">
            <div className="folder-browse-live" role="status" aria-live="polite" aria-atomic="false">
              {folder.opening && <p className="folder-browse-wait">{folderWindowText.opening}</p>}
              {folder.waiting && <p className="folder-browse-wait">{folderWindowText.waiting}</p>}
              {folder.showTypeHint && <p className="folder-browse-wait">{folderWindowText.typeHint}</p>}
              {folder.message && <p key={folder.message.id} className={folder.message.tone === 'problem' ? 'form-error' : 'form-notice'}>{folder.message.text}</p>}
            </div>
            {(folder.waiting || folder.opening) && <div className="folder-browse-actions"><button type="button" className="button" onClick={folder.cancel}>{folderWindowText.cancel}</button>{folder.showTypeHint && <button type="button" className="button" onClick={folder.typeInstead}>{folderWindowText.typeInstead}</button>}</div>}
          </div>
          <p className="muted small" id={`${helpId}-dest`}>Choose an empty or new folder. An existing file at this destination is never overwritten.</p>
          <label>Passphrase<input type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} disabled={busy} /></label>
          <button className="button" disabled={busy || passphrase.length < 12 || !destination.trim()} onClick={() => void previewBackup()}>Preview this backup</button>
          {preview && <>
            <p className="muted small">{preview.manifest.label}: {preview.manifest.fileCount} files, {bytesText(preview.manifest.totalBytes)}, backed up {timeText(preview.manifest.createdAt)}.</p>
            <p className="muted small">Restoring into <code>{preview.destination}</code> ({preview.destinationKind === 'new' ? 'a new folder' : 'an existing empty folder'}).</p>
            <button className="button primary" disabled={busy} onClick={() => void restore()}>{busy ? <LoaderCircle size={16} className="spin" /> : null}Restore {preview.manifest.fileCount} files here</button>
          </>}
        </>}
        {restoredPath && <div className="setup-actions">
          <p className="muted small">The restored files are on disk at <code>{restoredPath}</code>, not connected to Agent Town yet.</p>
          <button className="button" disabled={connecting || !available} onClick={() => void connectThisFolder()}>{connecting ? <LoaderCircle size={16} className="spin" /> : <FolderPlus size={16} />}Connect this folder</button>
          <button type="button" className="text-button" onClick={() => setRestoredPath(null)}><Check size={14} /> Not now</button>
        </div>}
      </>}
      {error && <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
      {notice && <p className="form-notice" role="status" tabIndex={-1} ref={noticeRef}>{notice}</p>}
    </div>}
  </section>;
}
