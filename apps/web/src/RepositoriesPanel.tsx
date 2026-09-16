import { useEffect, useId, useRef, useState } from 'react';
import { Check, FolderGit2, FolderPlus, Github, LoaderCircle, Search, Square } from 'lucide-react';
import type { GitHubListingStatus, Repository, RootRemovalReview, TownState } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';

const explanations: Record<string, string> = {
  'no-installations': 'No installation is available to this account. Install your configured GitHub App on the personal account or organization that owns the repositories, select repositories, then check again.',
  'no-repositories': 'The accessible installations returned no repositories. Review the App’s repository selection and your own access. Organization owners may need to approve installation or repository access.',
  'suspended-installation': 'An installation is suspended. Ask its account or organization owner to restore access, then check again.',
  'installation-limit': 'Only the first 100 installations were checked. This inventory is incomplete.',
  'page-limit': 'The GitHub page limit was reached. Some permitted repositories were not returned.',
  'deadline': 'The shared 12-second limit was reached. The repositories already received are available below; retry to check missing results.',
  'candidate-limit': 'The 200-record review limit was reached. Selected repositories are preserved; some new results were not retained.',
  'github_unauthorized': 'GitHub authorization expired or was revoked. Open Connections and sign in again.',
  'github_not_connected': 'Connect GitHub in Connections, then check repository access again.',
  'github_access_limited': 'GitHub denied or rate-limited this check. Review App installation, organization approval and your account access, then retry later.',
  'github_permissions_too_broad': 'The configured GitHub App has write permissions. Change its repository permissions to read-only before discovery.',
  'github_listing_timeout': 'GitHub did not respond within the 12-second limit. Check the connection and retry.',
  'github_listing_cancelled': 'The GitHub check was cancelled. Retry when ready.',
  'github_unavailable': 'GitHub could not be reached. Previous records are stale; check your connection and retry.',
  'github_response_invalid': 'GitHub returned an unexpected response. Previous records are stale; retry later.',
  'github-repository-unavailable': 'Not returned by the latest complete GitHub check. It may have moved or access may have changed; saved history is preserved.',
  'repository-unavailable': 'Not found by the latest complete local scan. Check that the checkout still exists inside an allowed folder.',
  'project-folder-unavailable': 'This project folder could not be read. Check that it still exists at the saved path, then scan again.',
  'git-metadata-not-scanned': 'This folder has Git metadata that has not been verified. Scan selected folders to check it.',
  'entry-limit': 'The entry limit was reached. Choose a smaller parent folder to check omitted paths.',
  'depth-limit': 'Some folders were too deeply nested. Add a closer parent folder to check them.',
  'repository-limit': 'The 100-repository scan limit was reached. Choose smaller parent folders.',
  'instruction-limit': 'Some instruction metadata exceeded the per-repository limit.',
  'time-limit': 'The scan time limit was reached. Choose a smaller parent folder and retry.',
  'unreadable-entry': 'Some selected paths could not be read. Check their existence and local permissions.',
  'unsafe-path': 'Links or unsafe paths were skipped. Select the actual checkout folder; discovery does not follow links.',
  'git-unavailable': 'Git metadata could not be verified. Check the Git installation and checkout access.',
  'git-output-limit': 'Git output exceeded the safe read limit; Git measurements are unavailable.',
  'git-timeout': 'Git did not respond in time; Git measurements are unavailable.',
  'unsafe-git-config': 'Git settings require unsupported or executable behavior. This checkout was not executed.',
  'unsupported-git-layout': 'The Git layout cannot be safely read by this scanner.',
  'external-git-directory': 'A worktree’s Git directory is outside the allowed folders. Add its actual parent folder only if you intend to allow it.',
  'cancelled': 'This scan was cancelled. Scan again to verify the saved inventory.',
  'scan-failed': 'The scan failed. Check folder access and retry.',
  'scan-interrupted': 'The service stopped during the scan. Scan again to verify saved inventory.',
};
const reasonText = (reason: string) => explanations[reason] ?? 'Some metadata could not be verified. Review the selected scope and retry.';
const timeText = (value: string) => new Date(value).toLocaleString();

export function RepositoriesPanel({ state, request, available }: { state: TownState; request: IdentityController['request']; available: boolean }) {
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
  const rootHelp = blocked ?? (roots.length >= 8 ? 'Eight folders are already allowed. Keep this scope or remove an unused folder before adding another.' : !root.trim() ? 'Type or paste an absolute folder path first. The example below is not selected.' : 'Add this folder to allow read-only discovery inside it.');
  const scanHelp = blocked ?? (!roots.length ? 'Add a parent folder above before scanning.' : 'Scan only the allowed folders listed above. This does not run project code.');

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
    <p className="muted small">Add your project folder, then choose <strong>Use as local project</strong>. Git is optional. To find Git repositories inside a parent folder, use <strong>Scan selected folders</strong>.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="form-notice" role="status">{notice}</p>}
    <form className="setup-form" onSubmit={event => { event.preventDefault(); if (root.trim()) void act(async () => { await request(`${prefix}/roots`, { path: root.trim() }); if (mounted.current) { setRoot(''); setNotice('Folder added. Use it as a local project, or scan for Git repositories inside it.'); } }); }}>
      <label>Selected parent folder<input value={root} onChange={event => setRoot(event.target.value)} required maxLength={1024} aria-describedby={`${helpId}-root`} spellCheck={false} autoComplete="off" /></label>
      <p className="muted small" id={`${helpId}-root`}>{rootHelp} Example: <code>C:\projects</code></p>
      <button className="button" aria-describedby={`${helpId}-root`} disabled={!!blocked || !root.trim() || roots.length >= 8}><FolderGit2 size={16} />Add selected folder</button>
    </form>
    {roots.length > 0 ? <div className="selected-roots"><h4>Folders allowed for discovery · {roots.length}/8</h4>{roots.map(path => {
      const connected = state.repositories.some(repo => repo.source === 'local' && repo.localPath === path);
      const connecting = connectingPath === path;
      return <article key={path} className="selected-root">
        <code>{path}</code>
        <button className={`button ${connected ? '' : 'primary'}`} disabled={!!blocked || connected || state.repositories.length >= 100}
          aria-label={connected ? `Project connected: ${path}` : `Use ${path} as a local project`} aria-busy={connecting}
          onClick={() => void act(async () => {
            setConnectingPath(path);
            try {
              const result = await request<{ repository: Repository }>(`${prefix}/projects/local`, { path });
              if (mounted.current) setNotice(`${result.repository.name} is connected and has a house in town. Open Connections to set up agent observation.`);
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
      <p className="muted small">{chosen.length}/100 selected. Stale results must be refreshed before they can be newly selected. To disconnect a repository, archive ended sessions and task attempts, remove hooks and revoke its connections, then clear its checkbox and save. Files and archived evidence stay saved.</p>
      {candidates.map(repo => <label className="candidate-row" key={repo.id}><input type="checkbox" checked={chosen.includes(repo.id)} disabled={!!blocked || (!chosen.includes(repo.id) && (chosen.length >= 100 || (!savedIds.has(repo.id) && !!repo.discoveryStatus && repo.discoveryStatus.state !== 'current')))} onChange={event => setChosen(current => event.target.checked ? [...current, repo.id] : current.filter(id => id !== repo.id))} /><span><strong>{repo.name}</strong><small>{repo.localPath ?? (repo.source === 'github' ? 'GitHub · remote metadata' : 'Local repository')}</small><small>{repo.projectKind === 'folder' ? 'Local folder · Git not configured' : repo.source === 'github' ? 'No local checkout linked' : repo.git?.availability === 'unavailable' ? 'Git measurements unavailable' : repo.branch || 'Branch unavailable'}</small><small>{repo.discoveryStatus ? `${repo.discoveryStatus.state} · Last check: ${timeText(repo.discoveryStatus.checkedAt)}` : 'Freshness not recorded; refresh to verify.'}</small>{repo.discoveryStatus && <small>Last successful verification: {repo.discoveryStatus.lastVerifiedAt ? timeText(repo.discoveryStatus.lastVerifiedAt) : 'Unavailable'}{repo.discoveryStatus.reasons.length ? ` · ${repo.discoveryStatus.reasons.map(reasonText).join(' ')}` : ''}</small>}</span></label>)}
      {!!pendingIds.length && <><p className="form-error" role="alert">Some unsaved selections disappeared after a refresh. Discard those missing choices and review the current results.</p><button className="button" type="button" onClick={() => setChosen(current => current.filter(id => !pendingIds.includes(id)))}>Discard missing selections</button></>}
      {unverifiedChoices && <p className="form-error" role="alert">An unsaved choice is now stale. Refresh it or clear its checkbox before saving.</p>}
      <button className="button primary" disabled={!!blocked || chosen.length > 100 || !!pendingIds.length || unverifiedChoices}><Check size={16} />Save repository selection</button>
    </form>}
  </section>;
}
