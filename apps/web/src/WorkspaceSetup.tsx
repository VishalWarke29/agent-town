import { useState } from 'react';
import { Check, ExternalLink, FolderGit2, Github, LoaderCircle, LogOut, Plus, ShieldCheck } from 'lucide-react';
import { DEMO_WORKSPACE } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';

export function WorkspaceSetup({ identity, available = identity.connection === 'connected' }: { identity: IdentityController; available?: boolean }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'personal' | 'company'>('personal');
  const { session, flow, busy } = identity;
  if (identity.previewOnly) return <section className="workspace-setup" aria-label="Demo environment"><div className="feature-heading"><ShieldCheck size={25} /><h3>Demo environment</h3><p>This town uses fictional repositories, sessions, and reports. No accounts connect and no AI credits are used.</p></div><p>To set up your real workspace, stop the service and start it in development mode:</p><code className="repo-path">.\run.ps1 -Mode development</code></section>;
  return <section className="workspace-setup" aria-label="Private workspace setup">
    <div className="feature-heading"><ShieldCheck size={25} /><h3>Your work, kept private.</h3><p>GitHub identifies the owner of your local workspaces. Connecting it starts no agents and uses no AI credits.</p></div>
    {identity.error && <p className="form-error" role="alert">{identity.error}</p>}
    {identity.notice && <p className="form-notice" role="status">{identity.notice}</p>}
    {session && !available && <p className="muted small" role="status">New sign-in and workspace creation are paused while the local service reconnects. Saved workspace choices remain available.</p>}
    {!session && <p className="muted" role="status">Connecting to the local service…</p>}
    {session && !session.user && !flow && <>
      <button className="button primary" disabled={busy || !available || !session.identity.configured} onClick={() => void identity.startSignIn()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Github size={16} />}Sign in with GitHub</button>
      {!session.identity.configured && <div className="setup-help">
        <h3 className="subheading">Add your GitHub client ID when ready</h3>
        <p className="muted small">Your installation is ready for account setup. Private workspaces need a verified GitHub owner before repositories can be connected.</p>
        <ol className="setup-steps">
          <li>Create a GitHub App with device flow enabled, or use your existing app’s public Client ID.</li>
          <li>Open <code>agent-town.config.json</code> in the project folder and fill in <code>githubClientId</code>.</li>
          <li>Save the file. This screen checks automatically every five seconds; choose <strong>Sign in with GitHub</strong> when it becomes available.</li>
        </ol>
        <p className="muted small">The full ID checklist is in <code>docs/24-connect-your-accounts.md</code>. No client secret or AI API key is needed for GitHub sign-in.</p>
      </div>}
    </>}
    {flow && <div className="device-flow">
      <p>Enter this one-time code on GitHub:</p><strong className="device-code">{flow.userCode}</strong>
      <a className="button primary" href={flow.verificationUri} target="_blank" rel="noopener noreferrer">Open GitHub <ExternalLink size={15} /></a>
      <p className="muted small">Expires at {new Date(flow.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Keep this page open while approving the code.</p>
      <button className="text-button" disabled={busy} onClick={() => void identity.cancelSignIn()}>Cancel sign-in</button>
    </div>}
    {session?.user && <>
      <div className="signed-in"><Github size={18} /><div><strong>{session.user.displayName ?? session.user.login}</strong><small>@{session.user.login}</small></div><button className="icon-button" aria-label="Sign out of GitHub" title="Sign out of GitHub" disabled={busy} onClick={() => void identity.logout()}><LogOut size={17} /></button></div>
      <h3 className="subheading">Your workspaces</h3>
      {session.workspaces.length === 0 && <p className="muted">Create a workspace to connect your repositories.</p>}
      <div className="workspace-options">{session.workspaces.map(workspace => <button key={workspace.id} className={`workspace-option ${identity.workspaceId === workspace.id ? 'selected' : ''}`} aria-pressed={identity.workspaceId === workspace.id} onClick={() => identity.chooseWorkspace(workspace.id)}><FolderGit2 size={17} /><span><strong>{workspace.name}</strong><small>{workspace.kind === 'company' ? 'Company' : 'Personal'} · private</small></span>{identity.workspaceId === workspace.id && <Check size={15} />}</button>)}</div>
      <form className="setup-form" onSubmit={event => { event.preventDefault(); if (available && !busy && name.trim()) void identity.createWorkspace(name.trim(), kind); }}>
        <h3 className="subheading">Create a workspace</h3>
        <label>Workspace name<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required placeholder="My workshop" /></label>
        <label>Workspace type<select value={kind} onChange={event => setKind(event.target.value as 'personal' | 'company')}><option value="personal">Personal</option><option value="company">Company</option></select></label>
        <button className="button primary" disabled={busy || !available || !name.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}Create private workspace</button>
      </form>
    </>}
    {identity.previewAvailable && identity.workspaceId && <button className="setting-action" onClick={() => identity.workspaceId === DEMO_WORKSPACE ? identity.exitPreview() : identity.chooseWorkspace(DEMO_WORKSPACE)}>{identity.workspaceId === DEMO_WORKSPACE ? 'Exit sample town' : 'Explore sample town'}<ExternalLink size={15} /></button>}
  </section>;
}
