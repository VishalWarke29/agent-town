import { useEffect, useId, useRef, useState } from 'react';
import { Check, FolderGit2, FolderOpen, FolderPlus, Github, LoaderCircle, Search, Square } from 'lucide-react';
import type { GitHubListingStatus, Repository, RootRemovalReview, TownState, VaultStatus } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';
import { folderWindowText, reasonText } from './reasonText';
import { useFolderBrowse } from './useFolderBrowse';
import { connectedProjectNotice } from './houseCopy';
import { VaultPanel } from './VaultPanel';

const timeText = (value: string) => new Date(value).toLocaleString();

export function RepositoriesPanel({ state, request, available, onConnected }: { state: TownState; request: IdentityController['request']; available: boolean; onConnected?: (repoId: string) => void }) {
  const [root, setRoot] = useState('');
  const [chosen, setChosen] = useState<string[]>(state.repositories.map(repo => repo.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectingPath, setConnectingPath] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [removal, setRemoval] = useState<RootRemovalReview | null>(null);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const helpId = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selectedKey = state.repositories.map(repo => repo.id).sort().join(',');
  const previousSavedIds = useRef(state.repositories.map(repo => repo.id));
  useEffect(() => {
    const next = selectedKey ? selectedKey.split(',') : [];
    const previous = previousSavedIds.current;
    previousSavedIds.current = next;
    // A live update may connect/remove another repository while this checkbox
    // draft is being edited. Reconcile that change without resetting other edits.
    const removed = new Set(previous.filter(id => !next.includes(id)));
    const added = next.filter(id => !previous.includes(id));
    setChosen(current => [...new Set([...current.filter(id => !removed.has(id)), ...added])]);
  }, [selectedKey]);
  const prefix = `/workspaces/${encodeURIComponent(state.workspace.id)}`;
  useEffect(() => {
    if (!state.repositories.some(repo => repo.localPath)) return;
    let disposed = false;
    void request<VaultStatus>(`${prefix}/vault`, undefined, undefined, 'GET').then(result => { if (!disposed && mounted.current) setVaultStatus(result); }).catch(() => {});
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.workspace.id]);
  const fieldRef = useRef<HTMLInputElement>(null);
  const browseRef = useRef<HTMLButtonElement>(null);
  // "Browse..." only ever fills the path field with text; adding the folder stays the separate step below.
  const folder = useFolderBrowse({ prefix, request, onPath: setRoot, fields: { field: fieldRef, browse: browseRef } });
  const discovery = state.discovery;
  const running = discovery?.operation?.status === 'running';
  const candidates = Array.from(new Map([...state.repositories, ...(discovery?.candidates ?? [])].map(repo => [repo.id, repo])).values());
  const savedIds = new Set(state.repositories.map(repo => repo.id));
  const pendingIds = chosen.filter(id => !candidates.some(repo => repo.id === id));
  const unverifiedChoices = candidates.some(repo => chosen.includes(repo.id) && !savedIds.has(repo.id) && repo.discoveryStatus && repo.discoveryStatus.state !== 'current');
  const roots = discovery?.roots ?? [];
  const emptyGitScan = discovery?.operation?.status === 'complete' && discovery.operation.foundCount === 0;
  const listing = discovery?.githubListing;
  const blocked = !available ? 'Reconnect to the local service before changing repository setup.' : busy ? 'Wait for the current request to finish.' : running ? 'Wait for the current scan, or cancel it below.' : null;
  const rootHelp = blocked ?? (roots.length >= 8 ? 'Eight folders are already allowed. Keep this scope or remove an unused folder before adding another.' : !root.trim() ? 'Type or paste an absolute folder path first. The example below is not selected.' : 'Let Agent Town look inside this folder, read-only, for projects.');
  const scanHelp = blocked ?? (!roots.length ? 'Add a project folder above before scanning.' : 'Scan only the allowed folders listed above. This does not run project code.');
  // Only what would make the path useless disables it (no service, or no room for another folder), with the same visible
  // reason as the Add button. A scan or a request in flight does not matter to choosing a folder, and a window that is
  // already open stays usable (a second click just says so), so the button never loses focus while the person is choosing.
  const browseUnavailable = !folder.active && (!available || roots.length >= 8);
  const folderMessageId = `${helpId}-folder-message`;

  const act = async (work: () => Promise<void>, github = false) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    if (github) { setGithubError(null); setGithubNotice(null); setGithubBusy(true); } else { setError(null); setNotice(null); }
    try { await work(); }
    catch (cause) { if (mounted.current) (github ? setGithubError : setError)(cause instanceof Error ? cause.message : 'The action failed. Try again after the local service reconnects.'); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); setGithubBusy(false); } }
  };

  return <section className="repository-setup" aria-label="Connect repositories">
    <h3 className="subheading">Bring your projects into town</h3>
    <p className="muted small">Connect a local project folder directly, or discover Git repositories and save your selection. These actions use no AI credits.</p>
    <section aria-label="Local folders">
    <h4>Local folders</h4>
    <p className="muted small">Add your project folder, then choose <strong>Use as local project</strong>. Git is optional. To find Git repositories inside a project folder, use <strong>Scan selected folders</strong>.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="form-notice" role="status">{notice}</p>}
    <form className="setup-form" onKeyDown={folder.onKeyDown} onSubmit={event => { event.preventDefault(); if (!root.trim()) return; folder.stop(); folder.clearMessage(); void act(async () => { await request(`${prefix}/roots`, { path: root.trim() }); if (mounted.current) { setRoot(''); setNotice('Folder added. Use it as a local project, or scan for Git repositories inside it.'); } }); }}>
      <div className="folder-field-row">
        <label>Project folder<input ref={fieldRef} value={root} onChange={event => { setRoot(event.target.value); folder.clearMessage(); }} required maxLength={1024}
          aria-describedby={`${helpId}-root${folder.message?.tone === 'problem' ? ` ${folderMessageId}` : ''}`} spellCheck={false} autoComplete="off" /></label>
        <button type="button" ref={browseRef} className="button folder-browse-button" aria-busy={folder.active} disabled={browseUnavailable}
          aria-describedby={`${helpId}-browse${browseUnavailable ? ` ${helpId}-root` : ''}`} onClick={folder.browse}>
          {folder.active ? <LoaderCircle size={16} className="spin" /> : <FolderOpen size={16} />}{folderWindowText.browse}
        </button>
      </div>
      <div className="folder-browse">
        <p className="muted folder-browse-hint" id={`${helpId}-browse`}>{folderWindowText.hint}</p>
        {/* Always mounted so a screen reader hears each change once. Not atomic: a new sentence must not re-read the old one. */}
        <div className="folder-browse-live" role="status" aria-live="polite" aria-atomic="false">
          {folder.opening && <p className="folder-browse-wait">{folderWindowText.opening}</p>}
          {folder.waiting && <p className="folder-browse-wait">{folderWindowText.waiting}</p>}
          {folder.showTypeHint && <p className="folder-browse-wait">{folderWindowText.typeHint}</p>}
          {folder.message && <p key={folder.message.id} id={folderMessageId} className={folder.message.tone === 'problem' ? 'form-error' : 'form-notice'}>{folder.message.text}</p>}
        </div>
        {(folder.waiting || folder.opening) && <div className="folder-browse-actions">
          <button type="button" className="button" onClick={folder.cancel}>{folderWindowText.cancel}</button>
          {folder.showTypeHint && <button type="button" className="button" onClick={folder.typeInstead}>{folderWindowText.typeInstead}</button>}
        </div>}
      </div>
      <p className="muted small" id={`${helpId}-root`}>{rootHelp} Example: <code>C:\projects</code></p>
      <button className="button" aria-describedby={`${helpId}-root`} disabled={!!blocked || !root.trim() || roots.length >= 8}><FolderGit2 size={16} />Add this project</button>
    </form>
    {roots.length > 0 ? <div className="selected-roots"><h4>Folders Agent Town may look in · {roots.length}/8</h4>{roots.map(path => {
      const connected = state.repositories.some(repo => repo.source === 'local' && repo.localPath === path);
      const connecting = connectingPath === path;
      return <article key={path} className="selected-root">
        <code>{path}</code>
        <button className={`button ${connected ? '' : 'primary'}`} disabled={!!blocked || connected || state.repositories.length >= 100}
          aria-label={connected ? `Project connected: ${path}` : `Use ${path} as a local project`} aria-busy={connecting}
          onClick={() => void act(async () => {
            setConnectingPath(path);
            // The first project opens its own details, where tracking is set up. Later ones stay here so
            // several folders can be connected in a row.
            const firstProject = state.repositories.length === 0;
            try {
              const result = await request<{ repository: Repository }>(`${prefix}/projects/local`, { path });
              if (mounted.current) {
                if (firstProject && onConnected) onConnected(result.repository.id);
                else setNotice(connectedProjectNotice(result.repository.name));
              }
            } finally { if (mounted.current) setConnectingPath(null); }
          })}>
          {connecting ? <LoaderCircle size={16} className="spin" /> : connected ? <Check size={16} /> : <FolderPlus size={16} />}
          {connecting ? 'Connecting project…' : connected ? 'Project connected' : 'Use as local project'}
        </button>
        {!connected && <p className="muted small">Connect this folder itself as one project. No Git setup is needed.{state.repositories.length >= 100 ? ' The 100-project limit is reached.' : ''}</p>}
        <button className="text-button" disabled={!!blocked} onClick={() => void act(async () => { const result = await request<RootRemovalReview>(`${prefix}/roots/remove/preview`, { path }); if (mounted.current) setRemoval(result); })}>Review removal of {path}</button>
        {removal?.path === path && <section className="archive-review" aria-label="Folder removal review"><p className="small">Remove this allowed folder and disconnect {removal.repositories.length} selected repositories? Local files stay on disk. Archived sessions, reports and repository metadata stay in History.</p>{removal.repositories.length > 0 && <ul className="setup-steps">{removal.repositories.map(repo => <li key={repo.id}>{repo.name}</li>)}</ul>}{!removal.allowed && <ul className="setup-steps">{removal.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}<div className="setup-actions"><button className="button" disabled={!!blocked || !removal.allowed} onClick={() => void act(async () => { await request(`${prefix}/roots/remove`, { path, reviewToken: removal.reviewToken }); if (mounted.current) { setRemoval(null); setNotice('Folder removed from discovery. Local files and saved history are preserved.'); } })}>Remove allowed folder</button><button className="button" disabled={busy} onClick={() => setRemoval(null)}>Keep folder</button></div></section>}
      </article>;
    })}</div> : <p className="muted small">No folders are allowed yet.</p>}
    <p className="muted small" id={`${helpId}-scan`}>{scanHelp}</p>
    <div className="setup-actions">
      <button className="button primary" aria-describedby={`${helpId}-scan`} disabled={!!blocked || !roots.length} onClick={() => void act(async () => { await request(`${prefix}/scans`); })}>{running ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}{running ? 'Scanning folders…' : 'Scan selected folders'}</button>
      {running && <button className="button" disabled={busy || !available} onClick={() => void act(async () => { await request(`${prefix}/scans/${encodeURIComponent(discovery!.operation!.id)}/cancel`); })}><Square size={13} />Cancel scan</button>}
    </div>
    {discovery?.operation && <p className={`scan-state ${discovery.operation.status === 'failed' ? 'form-error' : 'muted'}`} role="status">{discovery.operation.message}{discovery.operation.coverage === 'partial' ? ' Coverage is partial.' : ''}</p>}
    {emptyGitScan && <div className="folder-scan-help">
      <h4>No Git repositories found</h4>
      <p className="muted small">Your folder may still be a project. This scan looks for Git checkouts; it does not list every project folder. Choose <strong>Use as local project</strong> beside an allowed folder to connect it directly.</p>
      {state.repositories.some(repo => repo.projectKind === 'folder') && <p className="muted small">Your connected local projects stay in town when a Git scan finds no repositories.</p>}
    </div>}
    {!!discovery?.operation?.reasons?.length && <ul className="setup-steps">{discovery.operation.reasons.map(reason => <li key={reason}>{reasonText(reason)}</li>)}</ul>}
    {discovery?.refresh && <p className="muted small">{discovery.refresh.state === 'inactive' ? 'Automatic refresh starts after a folder is selected and scanned.' : <>{discovery.refresh.watchedPaths} metadata paths watched; {discovery.refresh.skippedPaths} use periodic checks only. Allowed folders are reconciled every {discovery.refresh.reconciliationSeconds} seconds.</>}</p>}
    </section>
    <section aria-label="GitHub repositories" className="repository-github">
      <h4>GitHub repositories</h4>
      <p className="muted small">GitHub sign-in identifies you. Repository access also needs the configured GitHub App installed on the account or organization, with repositories selected and any organization approval completed. Local folders are separate.</p>
      <p className="muted small" id={`${helpId}-github`}>{blocked ?? 'Check read-only installation access. This makes GitHub metadata requests and does not clone repositories or start an agent.'}</p>
      <button className="button" aria-describedby={`${helpId}-github`} disabled={!!blocked} onClick={() => void act(async () => {
        const result = await request<{ repositories: Repository[]; partial: boolean; diagnostics?: GitHubListingStatus }>(`${prefix}/github/repositories`, undefined, AbortSignal.timeout(60000));
        if (mounted.current) setGithubNotice(result.partial ? `Partial GitHub check. ${result.repositories.length} results retained from this check; review the reasons below.` : `${result.repositories.length} GitHub repositories are available to review.`);
      }, true)}>{githubBusy ? <LoaderCircle size={16} className="spin" /> : <Github size={16} />}{githubBusy ? 'Checking GitHub access…' : 'List permitted GitHub repos'}</button>
      {githubBusy && <p className="muted small" role="status">Checking account access and permitted repositories. Credential renewal can take extra time; this request waits up to 60 seconds. No AI credits are used.</p>}
      {githubError && <p className="form-error" role="alert">{githubError}</p>}
      {githubNotice && <p className="form-notice" role="status">{githubNotice}</p>}
      {listing ? <div className="scan-state">
        <p>Last check: {timeText(listing.checkedAt)} · {listing.status}</p>
        <p>{listing.installationCount === null ? 'Installation count unavailable.' : `${listing.installationCount} of ${listing.installationTotal ?? '?'} installations checked.`} {listing.repositoryTotal === null ? 'Upstream repository total unavailable.' : `${listing.repositoryTotal} repositories reported upstream.`}</p>
        <p>{listing.receivedCount} received · {listing.retainedCount} retained from this check · {listing.selectableCount} currently available to select.</p>
        {!!listing.reasons.length && <ul className="setup-steps">{listing.reasons.map(reason => <li key={reason}>{reasonText(reason)}</li>)}</ul>}
      </div> : <p className="muted small">GitHub repository access has not been checked in this workspace.</p>}
    </section>
    {(candidates.length > 0 || pendingIds.length > 0) && <form className="candidate-selection" onSubmit={event => { event.preventDefault(); void act(async () => { await request(`${prefix}/repositories/select`, { ids: chosen }); if (mounted.current) setNotice('Repository selection saved. Your town now reflects these projects.'); }); }}>
      <h3 className="subheading">Choose your repositories</h3>
      <p className="muted small">{chosen.length}/100 selected. Stale results must be refreshed before they can be newly selected. To disconnect a repository, archive ended sessions and task attempts, stop watching and revoke its connections, then clear its checkbox and save. Files and archived evidence stay saved.</p>
      {candidates.map(repo => <label className="candidate-row" key={repo.id}><input type="checkbox" checked={chosen.includes(repo.id)} disabled={!!blocked || (!chosen.includes(repo.id) && (chosen.length >= 100 || (!savedIds.has(repo.id) && !!repo.discoveryStatus && repo.discoveryStatus.state !== 'current')))} onChange={event => setChosen(current => event.target.checked ? [...current, repo.id] : current.filter(id => id !== repo.id))} /><span><strong>{repo.name}</strong><small>{repo.localPath ?? (repo.source === 'github' ? 'GitHub · remote metadata' : 'Local repository')}</small><small>{repo.projectKind === 'folder' ? 'Local folder · Git not configured' : repo.source === 'github' ? 'No local checkout linked' : repo.git?.availability === 'unavailable' ? 'Git measurements unavailable' : repo.branch || 'Branch unavailable'}</small><small>{repo.discoveryStatus ? `${repo.discoveryStatus.state} · Last check: ${timeText(repo.discoveryStatus.checkedAt)}` : 'Freshness not recorded; refresh to verify.'}</small>{repo.discoveryStatus && <small>Last successful verification: {repo.discoveryStatus.lastVerifiedAt ? timeText(repo.discoveryStatus.lastVerifiedAt) : 'Unavailable'}{repo.discoveryStatus.reasons.length ? ` · ${repo.discoveryStatus.reasons.map(reasonText).join(' ')}` : ''}</small>}</span></label>)}
      {!!pendingIds.length && <><p className="form-error" role="alert">Some unsaved selections disappeared after a refresh. Discard those missing choices and review the current results.</p><button className="button" type="button" onClick={() => setChosen(current => current.filter(id => !pendingIds.includes(id)))}>Discard missing selections</button></>}
      {unverifiedChoices && <p className="form-error" role="alert">An unsaved choice is now stale. Refresh it or clear its checkbox before saving.</p>}
      <button className="button primary" disabled={!!blocked || chosen.length > 100 || !!pendingIds.length || unverifiedChoices}><Check size={16} />Save repository selection</button>
    </form>}
    {state.repositories.some(repo => repo.localPath) && <section aria-label="Project Vault" className="repository-vault">
      <h3 className="subheading">Project Vault</h3>
      <p className="muted small">Back up a connected project&rsquo;s own files &mdash; including ones a plain <code>git clone</code> would never bring back &mdash; to a local folder you choose, encrypted with your own passphrase. Local folder only today; no cloud account is connected yet.</p>
      {state.repositories.filter(repo => repo.localPath).map(repo => <VaultPanel key={repo.id} state={state} request={request} repoId={repo.id} repoName={repo.name} sharedStatus={vaultStatus} onStatusChange={setVaultStatus} />)}
    </section>}
  </section>;
}
