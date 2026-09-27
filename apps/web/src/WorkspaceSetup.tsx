import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Check, Clipboard, ExternalLink, FolderGit2, Github, LoaderCircle, LogOut, Plus, ShieldCheck, Unplug } from 'lucide-react';
import { DEMO_WORKSPACE } from '@agent-town/contracts';
import type { IdentityController } from './useIdentity';
import { PRIVACY_COPY, SIGN_IN_CODE_WARNING } from './firstRunCopy';

function copyValue(value: string, onDone: (notice: string) => void) {
  void navigator.clipboard.writeText(value)
    .then(() => onDone('Copied.'))
    .catch(() => onDone('Clipboard access is unavailable. Select and copy the value yourself.'));
}

/** The advanced, opt-in path for a computer with no shared GitHub App client ID yet (WS1-12 has not
 * shipped one). Kept out of the main sign-in flow: "device flow" and the config file path only ever
 * appear inside this panel. */
function GithubAppAdvancedSetup({ open, onOpenChange, headingRef }: { open: boolean; onOpenChange: (open: boolean) => void; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const [copyNotice, setCopyNotice] = useState('');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return <details className="setup-advanced" open={open} onToggle={event => onOpenChange((event.target as HTMLDetailsElement).open)}>
    <summary>Advanced: use your own GitHub App</summary>
    <div className="setup-help">
      {/* Visually hidden: the summary above already shows this heading's text at all times (collapsed
          or open). This duplicate exists only as the explicit, focusable landing target for this step. */}
      <h3 ref={headingRef} tabIndex={-1} className="sr-only">Advanced: use your own GitHub App</h3>
      <p className="muted small">Agent Town does not ship a shared GitHub sign-in app yet. Create your own GitHub App on this computer to sign in.</p>
      <ol className="setup-steps">
        <li>Go to <a href="https://github.com/settings/apps/new" target="_blank" rel="noopener noreferrer">GitHub → Settings → Developer settings → New GitHub App <ExternalLink size={13} /></a>.</li>
        <li>Set <strong>Homepage URL</strong> to <code>{origin}</code> <button type="button" className="text-button" onClick={() => copyValue(origin, setCopyNotice)}><Clipboard size={13} />Copy</button></li>
        <li>Under <strong>Permissions → Repository permissions</strong>, set <strong>Contents</strong> and <strong>Metadata</strong> to <strong>Read-only</strong>. Leave every other permission at <strong>No access</strong>.</li>
        <li>Turn on <strong>Device Flow</strong> near the bottom of the page.</li>
        <li>Create the app, then copy its <strong>Client ID</strong>.</li>
        <li>Open <code>agent-town.config.json</code> in the project folder, set <code>githubClientId</code> to that value, and save. This screen checks automatically every five seconds.</li>
      </ol>
      <p className="muted small">Checklist: read-only repository permissions (Contents, Metadata) · Device Flow turned on · no client secret or AI API key needed for GitHub sign-in.</p>
      {copyNotice && <p className="muted small" role="status">{copyNotice}</p>}
    </div>
  </details>;
}

export function WorkspaceSetup({ identity, available = identity.connection === 'connected' }: { identity: IdentityController; available?: boolean }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'personal' | 'company'>('personal');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [codeCopyNotice, setCodeCopyNotice] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { session, flow, busy } = identity;
  const reasonId = useId();
  const signInButtonRef = useRef<HTMLButtonElement>(null);
  const advancedHeadingRef = useRef<HTMLHeadingElement>(null);
  const deviceHeadingRef = useRef<HTMLHeadingElement>(null);
  const nextStepHeadingRef = useRef<HTMLHeadingElement>(null);
  const hadFlow = useRef(false);
  const wasSignedIn = useRef(Boolean(session?.user));
  const copyCode = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCodeCopyNotice('Copied. Paste it on the GitHub page.'); }
    catch { setCodeCopyNotice('Clipboard access is unavailable. Select and copy the code above instead.'); }
  };
  // Move focus to each step's own heading as it first appears, so a screen-reader user lands on the
  // next thing to do instead of the top of an unchanged panel.
  useEffect(() => {
    if (flow && !hadFlow.current) deviceHeadingRef.current?.focus();
    hadFlow.current = Boolean(flow);
  }, [flow]);
  useEffect(() => {
    const isSignedIn = Boolean(session?.user);
    if (isSignedIn && !wasSignedIn.current) nextStepHeadingRef.current?.focus();
    wasSignedIn.current = isSignedIn;
  }, [session?.user]);
  if (identity.previewOnly) return <section className="workspace-setup" aria-label="Demo environment"><div className="feature-heading"><ShieldCheck size={25} /><h3>Demo environment</h3><p>This town uses fictional repositories, sessions, and reports. No accounts connect and no AI credits are used.</p></div><p>To set up your real workspace, stop the service and start it in development mode:</p><code className="repo-path">.\run.ps1 -Mode development</code></section>;
  return <section className="workspace-setup" aria-label="Private workspace setup">
    <div className="feature-heading"><ShieldCheck size={25} /><h3>Your work, kept private.</h3><p>{PRIVACY_COPY}</p></div>
    {identity.error && <p className="form-error" role="alert">{identity.error}</p>}
    {identity.notice && <p className="form-notice" role="status">{identity.notice}</p>}
    {session && !available && <p className="muted small" role="status">New sign-in and workspace creation are paused while the local service reconnects. Saved workspace choices remain available.</p>}
    {!session && <p className="muted" role="status">Connecting to the local service…</p>}
    {session && !session.user && !flow && (session.identity.configured
      ? <button ref={signInButtonRef} className="button primary" disabled={busy || !available} onClick={() => { setCodeCopyNotice(''); void identity.startSignIn(); }}>{busy ? <LoaderCircle size={16} className="spin" /> : <Github size={16} />}Sign in with GitHub</button>
      : <div className="setup-not-configured">
          <h3 className="subheading" role="status">GitHub sign-in is not set up on this computer yet</h3>
          <p className="muted small">This installation has no GitHub App client ID yet. Set one up below{identity.previewAvailable ? ', or explore the sample town while you wait.' : '.'}</p>
          <div className="setup-actions">
            <button type="button" className="button primary" onClick={() => { setAdvancedOpen(true); requestAnimationFrame(() => advancedHeadingRef.current?.focus()); }}>Set up GitHub sign-in</button>
            {identity.previewAvailable && <button type="button" className="text-button" onClick={() => identity.chooseWorkspace(DEMO_WORKSPACE)}>Explore the sample town</button>}
          </div>
          <button type="button" aria-disabled="true" aria-describedby={reasonId} className="button" onClick={event => event.preventDefault()}><Github size={16} />Sign in with GitHub</button>
          <p id={reasonId} className="muted small">Sign-in isn’t available yet: GitHub sign-in is not set up on this computer.</p>
          <GithubAppAdvancedSetup open={advancedOpen} onOpenChange={setAdvancedOpen} headingRef={advancedHeadingRef} />
        </div>)}
    {flow && <div className="device-flow">
      <h3 ref={deviceHeadingRef} tabIndex={-1} className="subheading">Enter this one-time code on GitHub</h3>
      <p className="muted small">{SIGN_IN_CODE_WARNING}</p>
      <strong className="device-code">{flow.userCode}</strong>
      <button className="text-button" onClick={() => void copyCode(flow.userCode)}><Clipboard size={14} />Copy code</button>
      {codeCopyNotice && <p className="muted small" role="status">{codeCopyNotice}</p>}
      <a className="button primary" href={`${flow.verificationUri}?user_code=${encodeURIComponent(flow.userCode)}`} target="_blank" rel="noopener noreferrer">Open GitHub <ExternalLink size={15} /></a>
      <p className="muted small">Expires at {new Date(flow.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Keep this page open while approving the code.</p>
      <button className="text-button" disabled={busy} onClick={() => { setCodeCopyNotice(''); void identity.cancelSignIn().then(() => signInButtonRef.current?.focus()); }}>Cancel sign-in</button>
    </div>}
    {session?.user && <>
      <p role="status" className="muted small">Signed in as {session.user.displayName ?? session.user.login}.</p>
      <div className="signed-in"><Github size={18} /><div><strong>{session.user.displayName ?? session.user.login}</strong><small>@{session.user.login}</small></div><button className="icon-button" aria-label="Sign out of GitHub" title="Sign out of GitHub" disabled={busy} onClick={() => void identity.logout()}><LogOut size={17} /></button></div>
      <div className="setup-help">
        <p className="muted small">Signing out only closes this browser session. To permanently remove the GitHub credential stored by this app, disconnect it below — you will need to re-authorize via GitHub afterward.</p>
        {!confirmDisconnect
          ? <button className="text-button" disabled={busy} onClick={() => setConfirmDisconnect(true)}><Unplug size={14} />Disconnect GitHub</button>
          : <div className="setup-actions">
              <p className="form-error" role="alert">Permanently remove the stored GitHub credential? This cannot be undone from here; you will need to re-authorize via GitHub afterward.</p>
              <button className="button" disabled={busy} onClick={() => { setConfirmDisconnect(false); void identity.disconnectGithub(); }}>{busy ? <LoaderCircle size={16} className="spin" /> : <Unplug size={16} />}Yes, permanently disconnect</button>
              <button className="text-button" disabled={busy} onClick={() => setConfirmDisconnect(false)}>Cancel</button>
            </div>}
      </div>
      <h3 className="subheading">Your workspaces</h3>
      {session.workspaces.length === 0 && <p className="muted">Create a workspace to connect your repositories.</p>}
      <div className="workspace-options">{session.workspaces.map(workspace => <button key={workspace.id} className={`workspace-option ${identity.workspaceId === workspace.id ? 'selected' : ''}`} aria-pressed={identity.workspaceId === workspace.id} onClick={() => identity.chooseWorkspace(workspace.id)}><FolderGit2 size={17} /><span><strong>{workspace.name}</strong><small>{workspace.kind === 'company' ? 'Company' : 'Personal'} · private</small></span>{identity.workspaceId === workspace.id && <Check size={15} />}</button>)}</div>
      <form className="setup-form" onSubmit={event => { event.preventDefault(); if (available && !busy && name.trim()) void identity.createWorkspace(name.trim(), kind); }}>
        <h3 ref={nextStepHeadingRef} tabIndex={-1} className="subheading">Create workspace</h3>
        <label>Workspace name<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required placeholder="My workshop" /></label>
        <label>Workspace type<select value={kind} onChange={event => setKind(event.target.value as 'personal' | 'company')}><option value="personal">Personal</option><option value="company">Company</option></select></label>
        <button className="button primary" disabled={busy || !available || !name.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}Create workspace</button>
      </form>
    </>}
    {identity.previewAvailable && identity.workspaceId && <button className="setting-action" onClick={() => identity.workspaceId === DEMO_WORKSPACE ? identity.exitPreview() : identity.chooseWorkspace(DEMO_WORKSPACE)}>{identity.workspaceId === DEMO_WORKSPACE ? 'Exit sample town' : 'Explore sample town'}<ExternalLink size={15} /></button>}
  </section>;
}
