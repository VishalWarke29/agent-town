import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Activity, ArrowDownToLine, ArrowUpRight, BookOpen, Boxes, Check, ChevronDown, CircleHelp, ClipboardList, Compass, Feather, FileText, FolderGit2, Focus, GitBranch, GlassWater, Home, Layers3, Leaf, List, LoaderCircle, Maximize, Menu, Minus, Pause, Play, Plus, Radio, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, Unplug, Users, Wallet, X, type LucideIcon } from 'lucide-react';
import { DEMO_WORKSPACE, activityLabel, autoDetectTools, type Agent, type AutoDetectSurface, type Repository, type ToolSurface, type TownState, type ManagerProposal } from '@agent-town/contracts';
import type { CameraAction, Selection } from './world/interaction';
import { ARCHIVE_CAMERA_RADIUS, ARCHIVE_POSITION, isActivityStale, ROOM_PAGE_SIZE } from './world/interaction';
import { layoutSolarSystems } from './world/orbitLayout';
import { layoutConstellation } from './world/constellationLayout';
import { useWorldNavigation } from './useWorldNavigation';
import { RepositoryAgents } from './RepositoryAgents';
import { useTown } from './useTown';
import { useDbSchema } from './useDbSchema';
import { ArchivePanel } from './ArchivePanel';
import { useIdentity, type IdentityController } from './useIdentity';
import { PanelBoundary } from './PanelBoundary';
import { LiveTrackingPanel, WatchingStatus } from './LiveTrackingPanel';
import { WorkspaceSetup } from './WorkspaceSetup';
import { RepositoriesPanel } from './RepositoriesPanel';
import { InstructionFiles } from './InstructionFiles';
import { reasonText } from './reasonText';
import { CONNECT_PROJECT_ACTION, EMPTY_LIST_AGENTS, EMPTY_TOWN_ACTION, EMPTY_TOWN_BODY, EMPTY_TOWN_HEADING, GITHUB_NOT_CONFIGURED_STATUS, WELCOME_EYEBROW, WELCOME_PRIVACY_NOTE, isReturningVisitor, markVisited, welcomeBody, welcomeHeading } from './firstRunCopy';
import { ASSIGN_SLOT_INTERIM_LINE, EMPTY_HOUSE_LINE_1, EMPTY_HOUSE_LINE_2, PROJECT_INSPECTOR_LEDE, watchingLede } from './houseCopy';
import { ObservationPanel } from './ObservationPanel';
import { EconomyPanel, ManagerPanel, WorkflowConnections } from './WorkflowPanel';
import { TelemetryPanel } from './TelemetryPanel';
import { RunnerPanel } from './RunnerPanel';
import { OperationsPanel } from './OperationsPanel';
import { HistoryPanel } from './HistoryPanel';
import { NativeSessionDetails } from './NativeSessionDetails';
import { SessionReports } from './SessionReports';
import { agentDisplayName, agentSearchText } from './agentDisplayName';
import { sessionHierarchy } from './sessionHierarchy';
import { ChildAgentControl, sessionSummary } from './SessionPresentation';
import { WorldBoundary } from './WorldBoundary';
import { createPrivateStateRegistry, draftStore, keepsConnectionsDrawer, privateResetCause, usePrivateState } from './draftStore';

const World = lazy(() => import('./world/World').then(module => ({ default: module.World })));
type Section = 'agents' | 'repositories' | 'tasks' | 'activity' | 'services' | 'connections' | 'usage' | 'settings';
const sections: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'agents', label: 'Agents', icon: Users }, { id: 'repositories', label: 'Repositories', icon: FolderGit2 },
  { id: 'tasks', label: 'Tasks', icon: ClipboardList }, { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'services', label: 'API activity', icon: Radio },
  { id: 'connections', label: 'Connections', icon: Unplug }, { id: 'usage', label: 'Usage', icon: Wallet },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

function usePreference(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => { try { const stored = localStorage.getItem(key); return stored === null ? fallback : stored === 'true'; } catch { return fallback; } });
  const update = (next: boolean) => { setValue(next); try { localStorage.setItem(key, String(next)); } catch { /* Browser storage is optional. */ } };
  return [value, update] as const;
}

const REDUCED_MOTION_KEY = 'agent-town-reduced-motion';
// UX-05 (Gap 8): the plain usePreference above reads matchMedia only once, at mount, so an OS reduced-motion
// change made while the app stays open (or a change made before this tab's very first render but after some
// earlier tab cached the fallback) was never seen. This tracks the OS query live for as long as no explicit
// in-app choice has been saved; the moment the checkbox in Settings is used, that saved choice wins and the
// OS is no longer consulted, exactly like every other stored preference here.
function useReducedMotionPreference() {
  const readStored = () => { try { return localStorage.getItem(REDUCED_MOTION_KEY); } catch { return null; } };
  const [value, setValue] = useState(() => { const stored = readStored(); return stored === null ? matchMedia('(prefers-reduced-motion: reduce)').matches : stored === 'true'; });
  useEffect(() => {
    // Subscribe once: re-check storage inside the handler (not via a [value] dependency) so an
    // in-app toggle doesn't tear down and re-create this listener on every change (review note, UX-05).
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => { if (readStored() === null) setValue(query.matches); }; // stop following the OS once an explicit in-app choice exists.
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  const update = (next: boolean) => { setValue(next); try { localStorage.setItem(REDUCED_MOTION_KEY, String(next)); } catch { /* Browser storage is optional. */ } };
  return [value, update] as const;
}

function IconButton({ icon: Icon, label, onClick, active = false, disabled = false }: { icon: LucideIcon; label: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return <button type="button" className={`icon-button ${active ? 'active' : ''}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon size={19} strokeWidth={1.7} /></button>;
}

// Reveal List controls with room for their focus ring. Native focus alone can leave a
// fractional edge clipped; world labels must never scroll (they are never in .list-view).
function restoreListFocus(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true });
  if (element && document.activeElement === element && element.closest('.list-view')) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
}

function Drawer({ side, title, viewKey, eyebrow, onClose, toolbar, children, demo = true, notice }: { side: 'left' | 'right'; title: string; viewKey?: string; eyebrow: string; onClose: () => void; toolbar?: ReactNode; children: ReactNode; demo?: boolean; notice?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const focusedBeforeResize = useRef<HTMLElement | null>(null);
  // Capture before React makes the opener's List/room container inert. A stable
  // data-agent-id (when present) is preferred over aria-label text in the fallback
  // lookup below, since two different agents can share the same display name.
  const [opener] = useState(() => ({ element: document.activeElement as HTMLElement | null, label: document.activeElement?.getAttribute('aria-label'), agentId: document.activeElement?.getAttribute('data-agent-id') }));
  const [narrow, setNarrow] = useState(matchMedia('(max-width: 899px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 899px)');
    const change = () => setNarrow(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useLayoutEffect(() => {
    const drawer = ref.current;
    return () => {
      drawer?.close();
      // Wait for React to remove explicit background inert attributes. Do not
      // steal focus from a replacement drawer or a Strict Mode remount.
      requestAnimationFrame(() => {
        if (drawer?.isConnected || document.activeElement?.closest('dialog[open]')) return;
        // Switching World/List can remount navigation while this drawer stays open.
        const target = opener.element?.isConnected ? opener.element
          : opener.agentId ? document.querySelector<HTMLButtonElement>(`button[data-agent-id="${CSS.escape(opener.agentId)}"]`)
          : opener.label ? document.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(opener.label)}"]`) : null;
        const restorable = target && target !== document.body && target !== document.documentElement && !target.closest('[inert]') && target.getClientRects().length > 0;
        if (restorable) restoreListFocus(target);
        if (!restorable || document.activeElement !== target) restoreListFocus(document.querySelector<HTMLButtonElement>('button[aria-label="Open agents"]:not([inert] *)'));
      });
    };
  }, []);
  useLayoutEffect(() => {
    const drawer = ref.current!;
    const focused = drawer.contains(document.activeElement) ? document.activeElement as HTMLElement : focusedBeforeResize.current;
    const nestedModals = [...drawer.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(dialog => dialog.matches(':modal'));
    // Native modality makes the rest of the document inert, including the canvas.
    // Keep this same element when resizing so the world and drawer content survive.
    if (narrow) drawer.showModal(); else drawer.show();
    // Reopening a parent modal puts it above existing evidence in the top layer.
    // Restore the nested stack and its focus without remounting its contents.
    for (const modal of nestedModals) { modal.close(); modal.showModal(); }
    const top = nestedModals.at(-1) ?? drawer;
    (focused?.isConnected && top.contains(focused) ? focused : top.querySelector<HTMLButtonElement>('button'))?.focus({ preventScroll: true });
    return () => {
      focusedBeforeResize.current = drawer.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      drawer.close();
    };
  }, [narrow]);
  useLayoutEffect(() => {
    ref.current?.querySelector('.drawer-content')?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [viewKey]);
  return <dialog ref={ref} className={`drawer glass drawer-${side}`} aria-modal={narrow || undefined} aria-label={title} data-testid={`${side}-drawer`} onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (!narrow || event.key !== 'Tab') return;
    const controls = Array.from(ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')).filter(el => el.offsetParent !== null);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header className="drawer-header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><IconButton icon={X} label={`Close ${side === 'left' ? 'navigation' : 'details'}`} onClick={onClose} /></header>
    {toolbar && <div className="drawer-toolbar">{toolbar}</div>}
    <div className="drawer-content">{notice}<PanelBoundary resetKey={viewKey ?? title}>{children}</PanelBoundary></div>
    <footer className="drawer-footer"><Leaf size={13} /> {demo ? 'Local preview. Zero AI calls.' : 'Local monitoring uses zero AI calls.'}</footer>
  </dialog>;
}

function Portrait({ agent, large = false }: { agent: Agent; large?: boolean }) {
  return <span className={`portrait ${large ? 'large' : ''}`} style={{ '--coat': agent.color } as CSSProperties} aria-hidden="true"><i className="pixel-hat" /><i className="pixel-face" /><i className="pixel-body" /></span>;
}

function Status({ agent, connected, now }: { agent: Agent; connected: boolean; now: number }) { return <><span className={`status status-${agent.activity}`}><i />{agent.activity === 'unknown' && agent.discovery ? 'Discovered · activity unknown' : activityLabel[agent.activity]}</span>{isActivityStale(agent, connected, now) && <span className="stale-tag">Last reported · stale</span>}</>; }
function agentToolLabel(agent: Agent, state: TownState): string {
  const run = state.runner?.runs.find(run => run.id === agent.id);
  return run?.tool === 'openai-api' ? 'OpenAI API worker' : run?.tool === 'anthropic-api' ? 'Anthropic API worker' : run?.tool === 'claude' ? 'Claude SDK worker' : agent.provider;
}
function When({ value }: { value: string }) { return <time dateTime={value}>{new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>; }
function Note({ children, icon: Icon = CircleHelp }: { children: ReactNode; icon?: LucideIcon }) { return <div className="note"><Icon size={16} /><p>{children}</p></div>; }

function WorkspaceReadiness() {
  return <section className="setup-form" role="status"><h3>Workspace setup needs a refresh</h3><p>Your account settings could not be loaded. Restart the local service if it is running an older build, then reload this workspace.</p><button className="button" onClick={() => window.location.reload()}><RotateCcw size={16} />Reload workspace</button><p className="muted small">Reloading does not connect an account or start paid work.</p></section>;
}

export function App() {
  const sessionIdentity = useIdentity();
  // Signing out, or removing the GitHub credentials, is the person's own act, so unsent drafts go with it. A session that
  // ends by itself (expiry, a restart) is not: it keeps them, hidden, for the same owner and workspace (D72, UX-03).
  const signOutIntent = useRef(false);
  const endSession = (end: () => Promise<void>) => async () => { signOutIntent.current = true; try { await end(); } finally { window.setTimeout(() => { signOutIntent.current = false; }, 3000); } };
  const identity: IdentityController = { ...sessionIdentity, logout: endSession(sessionIdentity.logout), disconnectGithub: endSession(sessionIdentity.disconnectGithub) };
  const town = useTown(identity.workspaceId, identity.session?.csrf ?? null, identity.refreshSession);
  const state = town.state;
  // The ONE list of private screen state (UX-03): everything an account or workspace owns is declared with usePrivateState and
  // is put back by resetPrivateState(); the draft store registers with it. A plain useState below is a decision, not an accident.
  const [privateState] = useState(createPrivateStateRegistry);
  const [showChildAgents, setShowChildAgents] = usePrivateState(privateState, false);
  const hierarchy = useMemo(() => sessionHierarchy(state?.agents ?? []), [state?.agents]);
  const presentedAgents = showChildAgents ? state?.agents ?? [] : hierarchy.primary;
  const presentationState = useMemo(() => state ? { ...state, agents: presentedAgents } : undefined, [state, presentedAgents]);
  const exploration = useWorldNavigation(`${identity.workspaceId ?? ''}:${identity.session?.user?.id ?? 'sample'}`, presentationState);
  const demo = identity.workspaceId === DEMO_WORKSPACE;
  // Sign-out, expiry and an account change keep an open Connections drawer (the sign-in surface, WS1-02); a workspace change closes it.
  const [section, setSection] = usePrivateState<Section | null>(privateState, null, (current, cause) => keepsConnectionsDrawer(cause) && current === 'connections' ? current : null);
  const [selection, setSelection] = usePrivateState<Selection | null>(privateState, null);
  const [archiveMode, setArchiveMode] = usePrivateState<'none' | 'solar' | 'constellation'>(privateState, 'none');
  const archiveSelected = selection?.kind === 'archive';
  const dbSchema = useDbSchema(identity.workspaceId, archiveSelected);
  // Picking a 3D style frames a tight, near-full-screen camera view on the visualization itself
  // (archiveCameraPose), the same way opening a repository frames its workroom — otherwise it rendered
  // at whatever zoom the camera last happened to be, sometimes overlapping a nearby house. Leaving the
  // style (back to the list, or closing the Archive entirely) returns the camera as repos already do.
  const previousArchiveMode = useRef<'none' | 'solar' | 'constellation'>('none');
  useEffect(() => {
    if (archiveMode !== 'none' && previousArchiveMode.current === 'none') {
      // Framed to the actual current content (a small schema zooms in close; a larger one gets a
      // wider frame) rather than a fixed guess — falls back to ARCHIVE_CAMERA_RADIUS if the schema
      // snapshot has not loaded yet, which the layout functions need to compute a real footprint.
      const groups = dbSchema.snapshot?.groups;
      // ARCHIVE_CAMERA_RADIUS is a floor, not just a missing-data fallback: a schema small enough to
      // want a tighter frame than this actually asks the camera for a zoom level beyond CAMERA_MAX_ZOOM
      // (clamped there — camera-framing.ts), which produces a WIDER effective view than intended, the
      // opposite of "zoomed in". Larger schemas still grow past this floor via Math.max.
      const contentRadius = !groups ? 0 : archiveMode === 'solar' ? layoutSolarSystems(groups).footprintRadius : layoutConstellation(groups).footprintRadius;
      camera('archive', ARCHIVE_POSITION, undefined, Math.max(ARCHIVE_CAMERA_RADIUS, contentRadius));
      setHintDismissed(true);
    } else if (archiveMode === 'none' && previousArchiveMode.current !== 'none') camera('return');
    previousArchiveMode.current = archiveMode;
  }, [archiveMode, dbSchema.snapshot]);
  // Every one of the many places that close or replace `selection` (Escape, backToTown,
  // backToRepository, openRepository, openTracking, openWatch, camera('reset'), select() itself)
  // only ever calls setSelection — none of them separately knew to reset archiveMode. Leaving the
  // Archive by any of those routes (anything but its own drawer's close button, or re-clicking the
  // already-active style) left archiveMode stale: reopening the Archive later skipped straight back
  // to the same 3D visualization instead of its picker, and — since the effect above only returns the
  // camera when archiveMode actually transitions to 'none' — the camera stayed zoomed into the archive
  // view too. One effect here covers every current and future caller instead of patching each site.
  useEffect(() => { if (!archiveSelected && archiveMode !== 'none') setArchiveMode('none'); }, [archiveSelected, archiveMode]);
  const [rosterOpen, setRosterOpen] = usePrivateState(privateState, false);
  const [trackingRepoId, setTrackingRepoId] = usePrivateState<string | null>(privateState, null);
  const [pendingRepoId, setPendingRepoId] = usePrivateState<string | null>(privateState, null);
  const [trackingHint, setTrackingHint] = usePrivateState<{ provider?: ToolSurface; sourceId?: string; sessionId?: string } | null>(privateState, null);
  const [cameraMenu, setCameraMenu] = usePrivateState(privateState, false);
  const [activityNow, setActivityNow] = useState(Date.now);
  const repositoryOpener = useRef<HTMLElement | null>(null);
  const [listRequested, setListView] = useState(false);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const listView = listRequested || webglUnavailable;
  const [follow, setFollow] = usePrivateState<string | null>(privateState, null);
  const [query, setQuery] = usePrivateState(privateState, '');
  const [draftProposal, setDraftProposal] = usePrivateState<ManagerProposal | null>(privateState, null);
  const [billing, setBilling] = useState<'subscription' | 'api'>('subscription');
  const [reduced, setReduced] = useReducedMotionPreference();
  const [opaque, setOpaque] = usePreference('agent-town-opaque-panels', false);
  const [hintDismissed, setHintDismissed] = usePreference('agent-town-hint-dismissed', false);
  // A reset puts the camera back through the same action a person's own Reset uses, so the world redraws from its first pose.
  const [cameraAction, setCameraAction] = usePrivateState<CameraAction>(privateState, { kind: 'reset', nonce: 0 }, current => ({ kind: 'reset', nonce: current.nonce + 1 }));
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [returningVisitor] = useState(isReturningVisitor);
  // identity.session is truthy as soon as ANY /api/v1/session response loads, signed in or not; the
  // returning-visitor flag must only follow a real prior sign-in, never a first, still-unconfigured load.
  useEffect(() => { if (identity.session?.user) markVisited(); }, [identity.session?.user]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setActivityNow(Date.now()); };
    const timer = window.setInterval(refresh, 10000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const sourceConnected = (record: Agent) => town.connection === 'connected' && !state?.observation?.connections.some(source => source.id === record.observation?.connectionId && source.status === 'revoked');
  const unavailable = useCallback(() => { setWebglUnavailable(true); setListView(true); }, []);
  const stopFollow = useCallback(() => setFollow(null), []);
  const openSection = (value: Section) => { setRosterOpen(false); setSection(current => current === value ? null : value); if (window.innerWidth < 900) setSelection(null); };
  // A dead-end button inside one drawer (Tasks: Connect a project, Open Connections) moves the same drawer to another section; its own button is
  // gone by then, so keyboard focus goes to the new section's tab instead of falling out of the drawer.
  const goToSection = (value: Section) => { openSection(value); requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="left-drawer"] .section-tabs button.active')?.focus({ preventScroll: true })); };
  function openTracking(context?: string | { repoId: string; provider?: ToolSurface; sourceId?: string; sessionId?: string }) {
    const info = typeof context === 'string' ? { repoId: context } : context;
    setTrackingRepoId(info?.repoId ?? state?.repositories.find(repo => repo.localPath)?.id ?? null);
    // Only a specific inspected agent carries provider/source/session context; the manual "Set up
    // tracking" button inside Connections and "Manual setup for other tools" (LiveTrackingPanel,
    // reached from the quiet Watch link below via H0-08) keep today's default behavior instead.
    setTrackingHint(info?.provider ? { provider: info.provider, sourceId: info.sourceId, sessionId: info.sessionId } : null);
    setRosterOpen(false); setSelection(null); setSection('connections');
    requestAnimationFrame(() => { const heading = document.getElementById('tracking-setup-heading'); heading?.scrollIntoView({ block: 'start', behavior: 'instant' }); heading?.focus({ preventScroll: true }); });
  }
  // H0-08: the quiet "Watch sessions (optional)" link that replaces the five old "Set up tracking"
  // buttons. Unlike openTracking (which opens Connections' manual form), this opens the SAME right-
  // drawer inspector "Repository details" opens, with its Watch sessions (optional) slot (H0-07's
  // data-slot="watch", filled by LiveTrackingPanel) already expanded — DES-02 RH-1: "it opens the
  // inspector with slot 8 open and sends nothing." Expanding only flips that panel's own local
  // `expanded` state (its "Show details" toggle never fires a request by itself; nothing here does
  // either); reaching the manual form from here goes through its own "Manual setup for other tools"
  // link, which still calls openTracking above.
  function openWatch(repoId?: string) {
    const id = repoId ?? state?.repositories.find(repo => repo.localPath)?.id;
    if (!id) return;
    setRosterOpen(false); setSection(null); setSelection({ kind: 'repo', id });
    requestAnimationFrame(() => {
      const toggle = document.querySelector<HTMLButtonElement>('.inspector-watch .tracking-head button[aria-expanded]');
      if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
      document.querySelector<HTMLElement>('.inspector-watch .tracking-head h3')?.focus({ preventScroll: true });
    });
  }
  // Wa2r finding 1 (H0-09): trackingRepoId/trackingHint are a one-shot hint for the single Connections visit
  // openTracking() just opened; nothing ever cleared them, so a later, generic reopen of Connections (the dock,
  // a pill, a section tab) kept seeding ObservationPanel's manual-setup form open and refiring native-setup.
  // Leaving 'connections' by any route (Close, Escape, a workspace change, a section-tab click) consumes the hint.
  useEffect(() => { if (section !== 'connections') { setTrackingRepoId(null); setTrackingHint(null); } }, [section]);
  function camera(kind: CameraAction['kind'], point?: [number, number], direction?: CameraAction['direction'], radius?: number) {
    setFollow(null);
    if (kind === 'reset') { exploration.clear(); setRosterOpen(false); setSelection(null); }
    setCameraAction(current => ({ kind, point, direction, radius, nonce: current.nonce + 1 }));
  }
  function openRepository(id: string) {
    const repo = state?.repositories.find(candidate => candidate.id === id);
    if (!repo) return;
    if (!exploration.repository) repositoryOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!exploration.room || exploration.repository?.id !== id) camera('room', repo.position);
    exploration.enter(id); setFollow(null); setSection(null); setSelection(null); setRosterOpen(false); setHintDismissed(true);
  }
  function select(value: Selection) {
    if (value.kind === 'repo') { openRepository(value.id); return; }
    if (value.kind === 'agent') exploration.revealAgent(value.id);
    setRosterOpen(false); setSelection(value);
    if (window.innerWidth < 900) setSection(null);
  }
  function backToTown() {
    const opener = repositoryOpener.current;
    const originalRepositoryId = opener?.dataset.repoId;
    camera('return'); exploration.clear(); setRosterOpen(false); setSelection(null); setSection(null);
    requestAnimationFrame(() => {
      if (repositoryOpener.current !== opener || document.activeElement?.closest('dialog[open]')) return;
      const visibleTarget = (target: HTMLElement | null | undefined): target is HTMLElement => {
        if (!target?.isConnected || target === document.body || target === document.documentElement || target.closest('[inert]') || target.matches(':disabled') || getComputedStyle(target).visibility !== 'visible') return false;
        const rect = target.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
      };
      // House labels can remount while exploring. Restore the original house only
      // if it is already onscreen; an animated return may still leave it offscreen.
      const house = originalRepositoryId ? [...document.querySelectorAll<HTMLButtonElement>('button.world-label[data-repo-id][data-room-open="false"]')].find(button => button.dataset.repoId === originalRepositoryId && visibleTarget(button)) : undefined;
      const navigation = ['Open repositories', 'Show list view', 'Show world', 'Open saved activity']
        .flatMap(label => [...document.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)])
        .find(visibleTarget);
      const target = visibleTarget(opener) ? opener : house ?? navigation;
      restoreListFocus(target);
      if (target && document.activeElement !== target) restoreListFocus(navigation);
      repositoryOpener.current = null;
    });
  }
  function backToRepository() {
    if (!exploration.repository) return;
    camera('room', exploration.repository.position); exploration.enter(exploration.repository.id);
    setFollow(null); setSelection(null); setRosterOpen(false); setSection(null);
  }

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (selection) setSelection(null); else if (rosterOpen) setRosterOpen(false); else if (section) setSection(null); else if (cameraMenu) setCameraMenu(false); else if (exploration.repository) backToTown(); else if (listView && !webglUnavailable) setListView(false);
    };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [selection, section, rosterOpen, cameraMenu, listView, webglUnavailable, exploration.repository?.id]);
  useEffect(() => {
    const resize = () => { if (window.innerWidth < 900 && selection) setSection(null); };
    window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, [selection]);
  // A real owner change (signed-in user A to signed-in user B) or a real workspace change (workspace
  // A to workspace B) clears private display state. Signed-out-to-signed-in and the WS1-08 path (no
  // workspace to the first workspace) must NOT reset anything — that is what closed this same panel
  // and made a fresh sign-in feel like starting over (WS1-02).
  // UX-03 widens that: a LOST user id (sign-out, or a session that ended) is an owner change too, or the next person to sign in
  // would find the proposal, search, selection and open Tasks drawer the last person left. privateResetCause() decides, and one
  // resetPrivateState() clears the whole list of private state (including the draft store) for every cause.
  const previousIdentity = useRef({ userId: identity.session?.user?.id, workspaceId: identity.workspaceId });
  useEffect(() => privateState.register(() => { repositoryOpener.current = null; }), [privateState]);
  useEffect(() => {
    const previous = previousIdentity.current;
    const next = { userId: identity.session?.user?.id, workspaceId: identity.workspaceId };
    previousIdentity.current = next;
    // Whoever is signed in keeps only their own hidden drafts (D72); another person's leftovers from an expired session go.
    if (next.userId && next.workspaceId) draftStore.retainOnly(next.userId, next.workspaceId);
    const cause = privateResetCause(previous, next, signOutIntent.current);
    if (cause) privateState.resetPrivateState(cause);
  }, [identity.workspaceId, identity.session?.user?.id]);

  useEffect(() => {
    if (exploration.repository && !selection && !rosterOpen) document.querySelector<HTMLElement>('[data-testid="room-context"] h2')?.focus({ preventScroll: true });
  }, [exploration.repository?.id]);
  useEffect(() => {
    if (!exploration.invalidated) return;
    camera('reset'); setRosterOpen(false); setSelection(null); setFollow(null);
  }, [exploration.invalidated]);
  // A newly connected project opens its details once the live snapshot contains it; selecting it earlier
  // would be undone by the guard below, which clears a selection whose repository is not in state yet.
  useEffect(() => {
    if (!pendingRepoId) return;
    const expire = setTimeout(() => setPendingRepoId(null), 15000);
    return () => clearTimeout(expire);
  }, [pendingRepoId]);
  useEffect(() => {
    if (!pendingRepoId || !state?.repositories.some(repo => repo.id === pendingRepoId)) return;
    setSection(null); setSelection({ kind: 'repo', id: pendingRepoId }); setPendingRepoId(null);
  }, [pendingRepoId, state?.repositories]);
  useEffect(() => {
    if (!state) return;
    if (selection?.kind === 'repo' && !state.repositories.some(repo => repo.id === selection.id)) setSelection(null);
    if (selection?.kind === 'agent' && !state.agents.some(agent => agent.id === selection.id)) setSelection(null);
    if (follow && !presentedAgents.some(agent => agent.id === follow)) setFollow(null);
  }, [state, selection, follow, presentedAgents]);
  const agent = selection?.kind === 'agent' ? state?.agents.find(a => a.id === selection.id) : undefined;
  const selectedRun = agent ? state?.runner?.runs.find(run => run.id === agent.id) : undefined;
  const runConnectionLabel = selectedRun ? state?.workflow?.connections.find(connection => connection.id === selectedRun.connectionId)?.label ?? state?.runner?.subscriptions.find(connection => connection.id === selectedRun.connectionId)?.label ?? 'Saved connection' : undefined;
  const repository = selection?.kind === 'repo' ? state?.repositories.find(r => r.id === selection.id) : undefined;
  const managerSelected = selection?.kind === 'manager';
  const available = town.connection === 'connected' && !town.pending;
  const connection = identity.workspaceId ? town.connection : identity.connection;
  const setupReady = Boolean(identity.session && !identity.workspaceId);
  const pendingReports = state?.handoffs.filter(h => h.status === 'saved') ?? [];
  const drawerNotice = (town.error || localNotice) && <div className="drawer-error" role="alert"><p>{town.error ?? localNotice}</p><IconButton icon={X} label="Dismiss message" onClick={() => { town.dismissError(); setLocalNotice(null); }} /></div>;

  async function fullscreen() {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { setLocalNotice('This browser could not enter fullscreen. The town still fills the page.'); }
  }

  return <main className={`town-app ${listView ? 'list-mode' : ''} ${exploration.repository ? 'house-focused' : ''} ${opaque ? 'opaque' : ''} ${reduced ? 'reduce-motion' : ''}`}>
    {!state && <div className="setup-landscape" aria-hidden="true" />}
    {state && !webglUnavailable && <WorldBoundary onUnavailable={unavailable}><Suspense fallback={<div className="scene-loading"><LoaderCircle className="spin" size={22} /><span>Planting the town…</span></div>}><div style={{ visibility: listView ? 'hidden' : 'visible' }}><World state={presentationState!} selection={selection} onSelect={select} follow={follow} onStopFollow={stopFollow} cameraAction={cameraAction} reducedMotion={reduced} active={!listView} room={exploration.room} connected={town.connection === 'connected'} snapshotGeneration={town.snapshotGeneration} labelsInteractive={!section && !selection && !rosterOpen} onUnavailable={unavailable} archiveMode={archiveSelected ? archiveMode : 'none'} dbSchema={archiveSelected ? dbSchema.snapshot : null} /></div></Suspense></WorldBoundary>}
    <div className="world-vignette" aria-hidden="true" />
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Home size={23} strokeWidth={1.7} /></span><div><span className="brand-name">agent town<span className="brand-period">.</span></span><span className="brand-subtitle">A LITTLE WORLD FOR BIG IDEAS</span></div></div>
      <button className="workspace-pill glass" onClick={() => openSection('connections')} aria-label={demo ? "Demo workspace and connections" : "Private workspace and connections"}><span className="workspace-avatar"><Feather size={17} /></span><span>{state?.workspace.name ?? "Your private workshop"}<small>{demo ? "Demo workspace · sample data" : identity.session?.user ? `Private · @${identity.session.user.login}` : "Choose your workspace"}</small></span><ChevronDown size={15} /></button>
      <div className="top-actions"><span className="preview-badge">{demo ? identity.previewOnly ? "DEMO MODE" : "LOCAL PREVIEW" : identity.workspaceId ? "PRIVATE WORKSPACE" : "WORKSPACE SETUP"}</span>{demo && <button className="button primary compact demo-toggle" aria-label={state?.simulation.running ? 'Pause demo' : 'Run demo'} title={state?.simulation.running ? 'Pause demo' : 'Run demo'} disabled={!available} onClick={() => void town.command({ action: state?.simulation.running ? 'pause' : 'play' })}>{town.pending ? <LoaderCircle size={15} className="spin" /> : state?.simulation.running ? <Pause size={15} /> : <Play size={15} />}<span>{state?.simulation.running ? 'Pause demo' : 'Run demo'}</span></button>}{demo && !identity.previewOnly && !section && <IconButton icon={Home} label="Exit sample town" onClick={identity.exitPreview} />}{state ? <IconButton key="view-switch" icon={listView ? Layers3 : List} label={webglUnavailable ? '3D world unavailable; List view active' : listView ? 'Show world' : 'Show list view'} disabled={webglUnavailable} onClick={() => { if (!webglUnavailable) setListView(!listView); }} active={listView} /> : <IconButton key="setup-connections" icon={Unplug} label="Open connections" onClick={() => openSection('connections')} />}</div>
    </header>

    {!state && !setupReady && <div className="loading-card glass" role="status"><span className="loading-sprout"><Leaf size={29} /></span><h1>{connection === 'reconnecting' ? 'Waiting for the workshop' : 'Opening the workshop'}</h1><p>{connection === 'reconnecting' ? identity.error ?? 'Start the local service with run.ps1. This page will reconnect automatically.' : 'Connecting to your local Agent Town service…'}</p><LoaderCircle className="spin" size={20} /></div>}

    {!state && setupReady && <section className="loading-card welcome-card glass" aria-label="Welcome to Agent Town"><span className="loading-sprout"><FolderGit2 size={29} /></span><p className="eyebrow">{WELCOME_EYEBROW}</p><h1>{welcomeHeading(Boolean(identity.session?.user), returningVisitor)}</h1><p>{welcomeBody(Boolean(identity.session?.user))}</p>{
      /* Hidden while the Connections drawer is already open: it opens that same drawer, and once open
         its own heading/submit already carry this action's one name ("Create workspace"), so a second,
         identically-labelled button in the background would be confusing, not just redundant (WS1-02). */
      section !== 'connections' && <button className="button primary" onClick={() => setSection('connections')}>{identity.session?.user ? 'Create workspace' : identity.session?.identity.configured ? 'Set up your workspace' : 'Set up GitHub sign-in'}<Plus size={16} /></button>
    }{!identity.session?.user && !identity.session?.identity.configured && <p className="welcome-status">{GITHUB_NOT_CONFIGURED_STATUS}</p>}{section !== 'connections' && identity.error && <p className="form-error" role="alert">{identity.error}</p>}{section !== 'connections' && identity.notice && <p className="form-notice" role="status">{identity.notice}</p>}{identity.previewAvailable && <div className="welcome-sample"><p>Want to explore the design first?</p><button className="text-button" onClick={() => identity.chooseWorkspace(DEMO_WORKSPACE)}>Explore sample town<ArrowUpRight size={15} /></button><small>Fictional projects and agents. No AI calls.</small></div>}<p className="welcome-privacy"><Leaf size={13} />{WELCOME_PRIVACY_NOTE}</p></section>}
    {!state && section === 'connections' && <Drawer side="left" demo={demo} notice={selection ? undefined : drawerNotice} eyebrow="YOUR WORKSHOP" title="Connections" onClose={() => setSection(null)}><WorkspaceSetup identity={identity} /></Drawer>}

    {state && <>
      {!section && !listView && <nav className="tool-dock glass" aria-label="Town navigation"><IconButton icon={Menu} label="Open navigation" onClick={() => openSection('agents')} /><span className="dock-divider" />{sections.slice(0, 3).map(item => <IconButton key={item.id} icon={item.icon} label={`Open ${item.label.toLowerCase()}`} onClick={() => openSection(item.id)} />)}<IconButton icon={Sparkles} label="Open manager" onClick={() => select({ kind: 'manager' })} /><IconButton icon={Boxes} label="Open the archive" onClick={() => select({ kind: 'archive' })} /><span className="dock-divider" /><IconButton icon={Unplug} label="Open connections" onClick={() => openSection('connections')} /><IconButton icon={Settings2} label="Open settings" onClick={() => openSection('settings')} /></nav>}

      {demo && !exploration.repository && !listView && !section && !hintDismissed && <div className="world-intro"><p className="eyebrow"><span className="sun-dot" /> WELCOME TO YOUR WORKSHOP</p><h1>Good work grows here.</h1><p>Meet the agents. Explore their work.<br />Bring every little update together.</p><button className="text-button" onClick={() => { select({ kind: 'agent', id: 'milo' }); setHintDismissed(true); }}>Meet your sample agents <ArrowUpRight size={15} /></button><button className="dismiss-intro" aria-label="Dismiss welcome" onClick={() => setHintDismissed(true)}><X size={14} /></button></div>}

      {!demo && !listView && !section && state.repositories.length === 0 && <div className="world-intro"><p className="eyebrow">YOUR PRIVATE WORKSHOP</p><h1>{EMPTY_TOWN_HEADING}</h1><p>{EMPTY_TOWN_BODY}</p><button className="text-button" onClick={() => openSection('repositories')}>{EMPTY_TOWN_ACTION} <ArrowUpRight size={15} /></button></div>}

      <div className={listView ? "list-layout" : undefined}>
      {exploration.repository && <section className="room-context glass" inert={Boolean(section || selection || rosterOpen)} data-testid="room-context" data-repo-id={exploration.repository.id} aria-label="Repository workroom">
        <div className="room-heading"><div><p className="eyebrow">{demo ? 'SAMPLE WORKROOM' : 'REPOSITORY WORKROOM'}</p><h2 tabIndex={-1}>{listView ? exploration.repository.name : <button type="button" className="room-title-button" data-room-open={Boolean(exploration.room)} data-repo-id={exploration.repository.id} aria-expanded={Boolean(exploration.room)} onClick={backToRepository}>{exploration.repository.name}</button>}</h2><p className="room-summary">{demo ? `${exploration.residents.length} sample sessions` : sessionSummary(state.agents.filter(a => a.repoId === exploration.repository!.id))} · {state.agents.filter(a => a.repoId === exploration.repository!.id && a.activity === 'reporting').length} reporting across all sessions{town.connection !== 'connected' ? ' · Reconnecting' : ''}</p></div><button className="button room-exit" onClick={backToTown}>Back to town</button></div>
        <div className="room-actions"><button className="button" onClick={() => { setRosterOpen(true); setSelection(null); setSection(null); }}><Users size={15} />Agents in this repository</button><button className="button" onClick={() => { setRosterOpen(false); setSelection({ kind: 'repo', id: exploration.repository!.id }); setSection(null); }}><FolderGit2 size={15} />Repository details</button>{!demo && exploration.repository.localPath && <button className="text-button" style={{ minHeight: 44 }} onClick={() => openWatch(exploration.repository!.id)}>Watch sessions (optional)</button>}{!listView && <button className="text-button" onClick={backToRepository}>{exploration.room ? 'Show room' : 'Back to repository'}</button>}</div>
        {!demo && <ChildAgentControl count={hierarchy.children.filter(a => a.repoId === exploration.repository!.id).length} checked={showChildAgents} onChange={setShowChildAgents} />}
        {exploration.deskCount > 0 ? <div className="room-pages"><span aria-live="polite">Page {exploration.page + 1} of {exploration.pageCount} · {exploration.deskSlots.slice(exploration.page * ROOM_PAGE_SIZE, (exploration.page + 1) * ROOM_PAGE_SIZE).filter(id => id !== null).length} shown · {exploration.deskCount} desk residents</span>{exploration.pageCount > 1 && <span><button className="button" aria-label="Previous desks" disabled={exploration.page === 0} onClick={() => exploration.setPage(exploration.page - 1)}>Previous</button><button className="button" aria-label="Next desks" disabled={exploration.page === exploration.pageCount - 1} onClick={() => exploration.setPage(exploration.page + 1)}>Next</button></span>}</div> : <p className="room-summary">{exploration.residents.length ? 'No desk residents. Reports and inactive sessions are in the roster.' : town.connection === 'connected' ? `${EMPTY_HOUSE_LINE_1} ${EMPTY_HOUSE_LINE_2}` : 'Waiting for session information.'}</p>}
      </section>}

      {listView && <section className="list-view glass" inert={Boolean(section || selection || rosterOpen)} aria-label="Accessible town list"><div className="list-heading"><div><p className="eyebrow">THE SAME TOWN, A DIFFERENT VIEW</p><h1>{state.workspace.name}</h1></div><span className="sample-tag">{demo ? "Sample data" : "Private workspace"}</span></div><nav className="list-navigation" aria-label="List view navigation">{sections.map(item => <button className="button" key={item.id} aria-label={`Open ${item.label.toLowerCase()}`} onClick={() => openSection(item.id)}><item.icon size={15} />{item.label}</button>)}</nav>{webglUnavailable && <Note>The 3D world is unavailable in this browser. All available actions are accessible here.</Note>}{!demo && !exploration.repository && <><p className="muted small">{sessionSummary(state.agents)} in town</p><ChildAgentControl count={hierarchy.children.length} checked={showChildAgents} onChange={setShowChildAgents} /></>}{exploration.repository ? <RepositoryAgents key={exploration.repository.id} showChildAgents={showChildAgents} onShowChildAgents={setShowChildAgents} showControls={rosterOpen} state={state} repoId={exploration.repository.id} connected={town.connection === 'connected'} onSelect={id => select({ kind: 'agent', id })} onWatch={openWatch} /> : <table><caption>{demo ? "Sample agents and their current activities" : "Sessions in the live town and their current activities"}</caption><thead><tr><th>Agent</th><th>Assignment</th><th>Activity</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{presentedAgents.map(a => <tr key={a.id}><td data-label="Agent"><strong>{agentDisplayName(a)}</strong><small>{agentToolLabel(a, state)} · {a.role}</small><small>{hierarchy.unresolved.some(item => item.id === a.id) ? "Parent unavailable" : hierarchy.childrenById.get(a.id)?.length ? `${hierarchy.childrenById.get(a.id)!.length} child agents · open details` : hierarchy.parentById.has(a.id) ? "Child agent" : ""}</small></td><td data-label="Assignment">{a.task}</td><td data-label="Activity"><Status agent={a} connected={sourceConnected(a)} now={activityNow} /></td><td data-label="Details"><button className="text-button" data-agent-id={a.id} onClick={() => select({ kind: 'agent', id: a.id })} aria-label={`Inspect ${agentDisplayName(a)}`}>Inspect <ArrowUpRight size={14} /></button></td></tr>)}</tbody></table>}{!demo && state.agents.length === 0 && <p className="empty">{EMPTY_LIST_AGENTS}</p>}{!demo && state.repositories.some(repo => repo.localPath) && <button className="text-button" style={{ minHeight: 44 }} onClick={() => openWatch()}>Watch sessions (optional)</button>}{!demo && <button className="button" onClick={() => openSection("repositories")}><Plus size={16} />{CONNECT_PROJECT_ACTION}</button>}<div className="list-places">{state.repositories.map(r => <button className="button" key={r.id} onClick={() => select({ kind: 'repo', id: r.id })}><FolderGit2 size={16} />{r.name}</button>)}<button className="button" onClick={() => select({ kind: 'manager' })}><Sparkles size={16} />Town manager</button><button className="button" onClick={() => select({ kind: 'archive' })}><Boxes size={16} />Archive</button></div></section>}

      </div>

      {section && <Drawer viewKey={section} side="left" demo={demo} notice={selection ? undefined : drawerNotice} eyebrow="YOUR WORKSHOP" title={sections.find(s => s.id === section)!.label} onClose={() => setSection(null)} toolbar={<nav className="section-tabs" aria-label="Navigation sections">{sections.map(s => <button key={s.id} className={section === s.id ? 'active' : ''} onClick={() => setSection(s.id)} aria-label={s.label} title={s.label}><s.icon size={17} /></button>)}</nav>}>
        {section === 'agents' && <><div className="section-summary"><span>{demo ? `${state.agents.length} sample agents` : `${sessionSummary(state.agents)} in town`}</span><span className="sample-tag">{demo ? "DEMO" : "PRIVATE"}</span></div>{!demo && <ChildAgentControl count={hierarchy.children.length} checked={showChildAgents} onChange={setShowChildAgents} />}<label className="search"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find an agent…" aria-label="Find an agent" /></label><div className="agent-list">{presentedAgents.filter(a => `${agentSearchText(a)} ${agentToolLabel(a, state)}`.toLowerCase().includes(query.toLowerCase())).map(a => <button className={`agent-row ${agent?.id === a.id ? 'selected' : ''}`} key={a.id} onClick={() => select({ kind: 'agent', id: a.id })}><Portrait agent={a} /><span className="agent-row-body"><strong>{agentDisplayName(a)}<small>{agentToolLabel(a, state)}</small></strong><span>{a.role}</span><small>{hierarchy.unresolved.some(item => item.id === a.id) ? "Parent unavailable" : hierarchy.childrenById.get(a.id)?.length ? `${hierarchy.childrenById.get(a.id)!.length} child agents · open details` : hierarchy.parentById.has(a.id) ? "Child agent" : ""}</small><Status agent={a} connected={sourceConnected(a)} now={activityNow} /></span><ArrowUpRight size={14} /></button>)}</div>{!presentedAgents.some(a => `${agentSearchText(a)} ${agentToolLabel(a, state)}`.toLowerCase().includes(query.toLowerCase())) && <p className="empty">{state.agents.length ? (!showChildAgents && hierarchy.children.length ? "No primary sessions match. Enable Show child agents to search child names." : "No agents match that search.") : "No observed agent sessions yet."}</p>}<Note>{demo ? "These characters demonstrate the experience. Connect an observation tool or approve a managed task in a private workspace to see your own agents." : "Characters represent discovered sessions, received activity or approved managed runs. Discovery alone does not show current work. Response completion does not mean the task was accepted."}</Note>{!demo && state.repositories.some(repo => repo.localPath) && <button className="text-button" style={{ minHeight: 44 }} onClick={() => openWatch()}>Watch sessions (optional)</button>}{!demo && <details className="workflow-details"><summary>Session history and archiving</summary><HistoryPanel state={state} identity={identity} available={available} onSelectAgent={id => select({ kind: "agent", id })} /></details>}</>}
        {section === 'repositories' && <><p className="muted">Every project has a place in town.</p>{state.repositories.map(repo => <button className="repo-card" key={repo.id} onClick={() => openRepository(repo.id)}><span className="repo-icon" style={{ color: repo.color }}><FolderGit2 size={23} /></span><strong>{repo.name}</strong><p>{repo.language}</p><span><GitBranch size={12} />{repo.branch}</span></button>)}{demo ? <Note>No folders have been read or connected. These buildings use fictional repository records.</Note> : <RepositoriesPanel key={state.workspace.id} state={state} request={identity.request} available={available} onConnected={setPendingRepoId} />}</>}
        {section === 'tasks' && !demo && <RunnerPanel key={`${state.workspace.id}:${draftProposal?.id ?? "new"}`} state={state} identity={identity} available={available} proposal={draftProposal} onOpenSection={goToSection} />}
        {section === 'tasks' && demo && <><p className="muted">{demo ? "A small board of sample assignments." : "No managed assignments yet. Task launching remains disabled."}</p>{state.agents.map(a => <button key={a.id} className="task-card" onClick={() => select({ kind: 'agent', id: a.id })}><Status agent={a} connected={sourceConnected(a)} now={activityNow} /><h3>{a.task}</h3><span>{agentDisplayName(a)} · {agentToolLabel(a, state)}</span></button>)}<Note>Prepare and approve real tasks in a private workspace after connecting an account and passing execution checks.</Note></>}
        {section === 'activity' && <><div className="section-summary"><span>{demo ? "Saved sample events" : "Saved workspace events"}</span><span className="mono">#{town.cursor}</span></div><ActivityFeed state={state} /><Note icon={Radio}>Updates come from the local event service. No provider is being polled.</Note></>}
        {section === 'services' && (demo ? <Note>API inventory and runtime telemetry belong to your private workspace. Sign in and connect a local repository to set them up.</Note> : <TelemetryPanel key={state.workspace.id} state={state} identity={identity} cursor={town.cursor} available={available} />)}
        {section === 'connections' && <><WorkspaceSetup identity={identity} available={available && identity.connection === 'connected'} />{!demo && <ObservationPanel key={state.workspace.id} state={state} identity={identity} available={available} selectedRepoId={trackingRepoId} onRepoChange={setTrackingRepoId} initialProvider={trackingHint?.provider} initialSourceId={trackingHint?.sourceId} initialSessionId={trackingHint?.sessionId} />}{!demo ? (state.workflow ? <WorkflowConnections key={state.workspace.id} state={{ ...state, workflow: state.workflow }} identity={identity} available={available} /> : <WorkspaceReadiness />) : <><div className="feature-heading"><Unplug size={25} /><h3>A home for your tools.</h3><p>Connect AI billing accounts in a private workspace. GitHub sign-in and observation do not connect a billing account.</p></div><label className="field-label">Billing mode preview</label><div className="segmented" role="group" aria-label="Billing mode preview"><button aria-pressed={billing === 'subscription'} onClick={() => setBilling('subscription')}>Subscription</button><button aria-pressed={billing === 'api'} onClick={() => setBilling('api')}>API credits</button></div><p className="muted small">{billing === 'subscription' ? 'Use supported native account sessions. Existing subscriptions do not automatically include API credits.' : 'Use a personal or company API account. Each run will retain its approved account and budget.'}</p>{['OpenAI / Codex', 'Anthropic / Claude', 'Cursor', 'GitHub Copilot'].map((provider, i) => <div className="connection-row" key={provider}><span className={`provider-mark provider-${i}`}>{['O', 'A', 'C', 'G'][i]}</span><span><strong>{provider}</strong><small>Not connected</small></span><Unplug size={14} /></div>)}<Note icon={ShieldCheck}>In a private workspace, the first eligible connection stays the default for its provider and billing mode. No silent account switching.</Note></>}</>}
        {section === 'usage' && !demo && state.workflow && <EconomyPanel key={state.workspace.id} state={{ ...state, workflow: state.workflow }} identity={identity} available={available} />}
        {section === 'usage' && !demo && !state.workflow && <WorkspaceReadiness />}
        {section === 'usage' && demo && <><div className="usage-total"><span>{demo ? "AI credits used by this preview" : "AI credits used by Agent Town"}</span><strong>$0<span>.00</span></strong><small><Leaf size={14} /> This preview makes no AI requests</small></div><div className="policy-card"><span className="eyebrow">ECONOMY DEFAULT</span><h3><Leaf size={18} /> Economy mode</h3><p>Private workspaces use bounded summaries and models with a recorded quality review.</p><ul><li>Tracking and animation use no model calls.</li><li>Manager summaries are batched.</li><li>Higher-cost models require approval.</li><li>Each run keeps its selected billing account.</li></ul></div><Note>Provider credit balances are unavailable. Connect a billing account and explicitly enable spending limits in a private workspace before approving paid work.</Note></>}
        {section === 'settings' && <><h3 className="subheading">Make yourself at home</h3><label className="setting-row"><span><strong>Reduced motion</strong><small>Instant camera and report movement; static work poses.</small></span><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /></label><label className="setting-row"><span><strong>Opaque panels</strong><small>A solid background for easier reading.</small></span><input type="checkbox" checked={opaque} onChange={e => setOpaque(e.target.checked)} /></label><button className="setting-action" disabled={webglUnavailable} onClick={() => { setListView(!listView); setSection(null); }}><List size={17} />{webglUnavailable ? 'List view active · 3D unavailable' : listView ? 'Return to the world' : 'Use accessible list view'}<ArrowUpRight size={15} /></button>{demo && <button className="setting-action" onClick={() => { setHintDismissed(false); setSection(null); }}><CircleHelp size={17} />Show welcome tips<ArrowUpRight size={15} /></button>}<Note icon={GlassWater}>Preferences stay in this browser. The local service stores workspace activity separately.</Note>{!demo && <OperationsPanel key={state.workspace.id} identity={identity} available={available} />}<div className="key-hints"><span><kbd>Esc</kbd> Close a drawer</span><span><kbd>Drag</kbd> Pan the town</span><span><kbd>Two-finger scroll</kbd> Pan left/right and up/down</span><span><kbd>Pinch</kbd> Zoom in and out</span><span><kbd>Ctrl + scroll</kbd> Zoom with a mouse wheel</span></div></>}
      </Drawer>}

      {(selection || (rosterOpen && exploration.repository)) && <Drawer viewKey={selection?.kind === "manager" ? "manager" : selection?.kind === "archive" ? "archive" : selection ? `${selection.kind}:${selection.id}` : undefined} side="right" demo={demo} notice={drawerNotice} eyebrow={rosterOpen ? 'REPOSITORY SESSIONS' : managerSelected ? 'THE HEART OF THE WORKSHOP' : archiveSelected ? "AGENT TOWN'S OWN DATA" : repository ? demo ? 'REPOSITORY · SAMPLE' : 'REPOSITORY' : demo ? 'MEET YOUR AGENT · SAMPLE' : agent?.discovery && !agent.observation ? 'DISCOVERED SESSION' : 'CONNECTED AGENT'} title={rosterOpen ? exploration.repository?.name ?? 'Repository sessions' : managerSelected ? 'Town manager' : archiveSelected ? 'Archive' : repository?.name ?? (agent ? agentDisplayName(agent) : 'Details')} onClose={() => { setSelection(null); setRosterOpen(false); setArchiveMode('none'); }}>
        {exploration.repository && <button className="button room-back" onClick={backToRepository}>Back to repository</button>}
        {rosterOpen && exploration.repository && <RepositoryAgents key={exploration.repository.id} showChildAgents={showChildAgents} onShowChildAgents={setShowChildAgents} showControls={rosterOpen} state={state} repoId={exploration.repository.id} connected={town.connection === 'connected'} onSelect={id => select({ kind: 'agent', id })} onWatch={openWatch} />}
        {agent && <><div className="agent-hero"><Portrait agent={agent} large /><div><span className="provider-chip">{agentToolLabel(agent, state)}</span><h3>{agent.role}</h3><Status agent={agent} connected={sourceConnected(agent)} now={activityNow} /></div></div><button className={`button follow-button ${follow === agent.id ? 'following' : ''}`} onClick={() => { if (follow === agent.id) setFollow(null); else { if (hierarchy.parentById.has(agent.id)) setShowChildAgents(true); exploration.away(); setListView(false); setFollow(agent.id); } }} disabled={webglUnavailable}><Focus size={16} />{follow === agent.id ? 'Following agent · click to stop' : 'Follow this agent'}</button>{!demo && (agent.discovery || agent.observation) && <NativeSessionDetails agent={agent} state={state} connected={town.connection === "connected"} now={activityNow} onSelect={id => select({ kind: "agent", id })} onTracking={openTracking} />}<div className="detail-section"><p className="eyebrow">CURRENT ASSIGNMENT</p><h3 className="task-title">{agent.task}</h3><p className="muted">{demo ? "Sample assignment for exploring the workflow." : selectedRun ? "The objective approved for this managed run." : agent.discovery && !agent.observation ? "Found in local session metadata. Current work is unknown until real activity arrives." : agent.task === "External session · task not linked" ? "The tool has not supplied a task description. Activity updates alone do not identify the assignment." : "Reported by the connected tool."}</p></div><dl className="facts"><div><dt><FolderGit2 size={14} /> Repository</dt><dd>{state.repositories.find(r => r.id === agent.repoId)?.name}</dd></div><div><dt><GitBranch size={14} /> Branch</dt><dd className="mono">{selectedRun ? selectedRun.branch ?? "Not created yet" : demo ? (state.repositories.find(r => r.id === agent.repoId)?.branch || "Unavailable") : "Not reported for this session"}</dd></div><div><dt><Radio size={14} /> {agent.discovery && !agent.observation ? "Discovered" : "Last update"}</dt><dd><When value={agent.discovery && !agent.observation ? agent.discovery.discoveredAt : agent.updatedAt} /></dd></div><div><dt><Wallet size={14} /> Billing</dt><dd>{demo ? "Demo · no charges" : selectedRun ? <>{runConnectionLabel} · {selectedRun.mode}<small className="mono">{selectedRun.connectionId}</small></> : "External · unavailable"}</dd></div><div><dt><ArrowDownToLine size={14} /> Context delivered</dt><dd>{demo ? "Not connected" : selectedRun ? selectedRun.contextDelivery === "provider-acknowledged" ? `Provider acknowledged v${selectedRun.contextVersion}` : selectedRun.contextDelivery === "pending" ? "Pending" : "Unsupported" : agent.contextVersion === null ? "Not delivered" : `Version ${agent.contextVersion}`}</dd></div></dl>{selectedRun?.reportId && <button className="text-button" onClick={() => select({ kind: "manager" })}>Open saved manager report <ArrowUpRight size={14} /></button>}{agent.observation && <Note>Activity is reported by the tool. A finished response or ended session does not accept a task, process a manager report, or deliver context.</Note>}<div className="detail-section"><div className="section-summary"><h3>{demo ? "Sample changes" : "Reported changes"}</h3><span>{!demo && !selectedRun && !agent.files.length ? "Not supplied" : `${agent.files.length} files`}</span></div>{agent.files.map(file => <div className="file-row" key={file}><FileText size={14} /><code>{file}</code><span>{demo ? "M" : "Reported"}</span></div>)}<p className="evidence">{agent.evidence}</p></div>{!demo && <SessionReports state={state} identity={identity} agentId={agent.id} available={town.connection === "connected"} />}{demo && <div className="report-card"><span className="report-icon"><BookOpen size={22} /></span><h3>Keep the manager in the loop.</h3><p>Save a sample report and watch {agent.name} walk to the manager’s desk.</p><button className="button primary" disabled={!available || pendingReports.some(h => h.agentId === agent.id)} onClick={() => void town.command({ action: 'handoff', agentId: agent.id })}><ArrowUpRight size={16} />{pendingReports.some(h => h.agentId === agent.id) ? 'Report saved · manager pending' : 'Send sample report'}</button>{pendingReports.some(h => h.agentId === agent.id) && <button className="text-button" onClick={() => select({ kind: 'manager' })}>Visit the manager <ArrowUpRight size={14} /></button>}</div>}{demo && <Note>These file names and results are examples. No actual repository work or model execution has happened.</Note>}</>}
        {repository && <RepositoryInspector repository={repository} state={state} demo={demo} identity={identity} available={available} showChildAgents={showChildAgents} onShowChildAgents={setShowChildAgents} connected={town.connection === 'connected'} onSelect={id => select({ kind: 'agent', id })} onManualSetup={provider => openTracking(provider ? { repoId: repository.id, provider } : repository.id)} />}
        {managerSelected && !demo && state.workflow && <ManagerPanel key={state.workspace.id} state={{ ...state, workflow: state.workflow }} identity={identity} available={available} onPrepareTask={proposal => { setDraftProposal(proposal); setSelection(null); setSection("tasks"); }} />}
        {managerSelected && !demo && !state.workflow && <WorkspaceReadiness />}
        {managerSelected && demo && <><div className="manager-hero"><span><Sparkles size={29} /></span><div><h3>Every update, a little clearer.</h3><p>Persistent reports. A shared point of reference.</p></div></div><div className="brief-card"><div className="section-summary"><span className="eyebrow">SAMPLE SHARED BRIEF</span><span className="version">v{state.manager.version}</span></div><p className="brief-text">{state.manager.brief}</p>{state.manager.updatedAt && <small>Saved at <When value={state.manager.updatedAt} /></small>}</div><div className="section-summary"><h3>Reports at the desk</h3><span className="count">{pendingReports.length} pending</span></div>{state.handoffs.length === 0 && <div className="empty-report"><BookOpen size={29} /><h3>A quiet desk, for now.</h3><p>Select an agent and send a sample report. It stays saved even if you close this page.</p><button className="text-button" onClick={() => select({ kind: 'agent', id: 'milo' })}>Visit Milo <ArrowUpRight size={14} /></button></div>}{state.handoffs.map(h => <article className="handoff-card" key={h.id}><div className="section-summary"><strong>{state.agents.find(a => a.id === h.agentId)?.name}’s report</strong><When value={h.createdAt} /></div><p>{h.summary}</p><div className="handoff-status">{h.status === 'processed' ? <><Check size={14} /> Added to sample brief v{h.contextVersion}</> : <><FileText size={14} /> Saved · waiting for manager</>}</div>{h.status === 'saved' && <button className="button primary" disabled={!available} onClick={() => void town.command({ action: 'process', handoffId: h.id })}><BookOpen size={15} />Update sample brief</button>}<small>Context delivery: not connected</small></article>)}<Note icon={ShieldCheck}>This preview updates the brief with a local template. Private workspaces keep AI processing, approved context delivery, and final task acceptance separate.</Note></>}
        {archiveSelected && <ArchivePanel status={dbSchema.status} snapshot={dbSchema.snapshot} mode={archiveMode} onSetMode={setArchiveMode} />}
      </Drawer>}
    </>}

    {!section && !selection && !rosterOpen && (town.error || localNotice) && <div className="toast glass" role="alert"><span>{town.error ?? localNotice}</span><IconButton icon={X} label="Dismiss message" onClick={() => { town.dismissError(); setLocalNotice(null); }} /></div>}
    {state && !listView && cameraMenu && <nav className="pan-controls glass" aria-label="Pan the town"><button className="button" aria-label="Pan left" onClick={() => camera('pan', undefined, 'left')}>←</button><button className="button" aria-label="Pan up" onClick={() => camera('pan', undefined, 'up')}>↑</button><button className="button" aria-label="Pan down" onClick={() => camera('pan', undefined, 'down')}>↓</button><button className="button" aria-label="Pan right" onClick={() => camera('pan', undefined, 'right')}>→</button></nav>}
    {/* UX-05 (RV-5): below 900px .footer-separator (the SAMPLE DATA tag beside this pill) and .preview-badge (the DEMO MODE tag in the top bar) both disappear (see styles.css), so the sample town had no label at
        all at a narrow width once the intro closed. Naming it in the pill's own text instead keeps exactly one label at every width, and it reads `demo` rather than identity.previewOnly: `demo` is also true when a
        signed-in, non-preview-only person explicitly chooses Explore sample town. */}
    <footer className="world-footer"><button className="connection-pill glass" onClick={() => openSection(state ? 'activity' : 'connections')} aria-label={state ? 'Open saved activity' : 'Open connection status'}><span className={`connection-dot ${connection}`} /><span>{connection === 'connected' ? demo ? 'Sample town · local service connected' : 'Local service connected' : connection === 'connecting' ? 'Connecting to local service' : state ? 'Reconnecting · showing last saved state' : 'Waiting for local service'}</span>{connection === 'connected' && <span className="footer-separator">{demo ? "SAMPLE DATA" : state ? "PRIVATE WORKSPACE" : "READY FOR SETUP"}</span>}</button>{state && !listView && <><div className="camera-hint">{follow ? <><Focus size={14} /> Following {state.agents.find(a => a.id === follow)?.name}</> : <><Compass size={15} /> Scroll to pan <span>·</span> Pinch to zoom</>}</div><div className="camera-controls glass"><IconButton icon={Compass} label="Pan controls" active={cameraMenu} onClick={() => setCameraMenu(value => !value)} /><IconButton icon={Minus} label="Zoom out" onClick={() => camera('out')} /><IconButton icon={RotateCcw} label="Reset camera" onClick={() => camera('reset')} /><IconButton icon={Plus} label="Zoom in" onClick={() => camera('in')} /><span className="dock-divider" /><IconButton icon={Maximize} label="Toggle fullscreen" onClick={() => void fullscreen()} /></div></>}</footer>
  </main>;
}

function ActivityFeed({ state }: { state: TownState }) {
  return <ol className="activity-feed">{state.activity.map(event => <li key={event.id}><span className={`activity-mark mark-${event.kind}`}>{event.kind === 'report' ? <FileText size={13} /> : event.kind === 'context' ? <BookOpen size={13} /> : <Radio size={13} />}</span><div><p>{event.message}</p><When value={event.createdAt} /></div></li>)}</ol>;
}

/**
 * H0-07: the house inspector's fixed slot order (DES-02 section 1 / docs/records/ui/DES-02-houses-first-v1.md).
 * Facts, Assign and Residents are open on arrival. DES-02 draws Details and Watch sessions (optional) as
 * collapsed, one-line summaries, but neither slot's own content has that redesign yet: RepositoryDetails still
 * renders its instruction/skill files directly (tests/browser/repositories.spec.ts, owned by SK-01, reads the
 * "Skill files" heading the moment the inspector opens), and LiveTrackingPanel already keeps its own detail
 * rows collapsed behind its own "Show details" toggle while leaving its header visible (tests/browser/
 * houses-first.spec.ts's `openInspector()`, owned by H0-16, and tests/browser/local-folder.spec.ts pin that
 * header being reachable without an extra click). Wrapping either in a NEW collapsed disclosure here would
 * hide that already-shipped, already-tested content from both a screen reader and Playwright's role queries
 * before this item ever touches their wording — an unauthorized regression of other items' completed work,
 * not a rename. H0-07 lands the frame (the fixed order below, each slot addressable by its own `data-slot`
 * for later items — H0-08's quiet Watch link, H0-14's Watching line and Stop watching, H0-15's hide/show,
 * SK-06 and AR-31 for Details' own collapsed summary); a later item gives Details its collapsed summary
 * without breaking SK-01's, and H0-06 gives Watch its "Watch sessions (optional)" collapsed frame without
 * breaking H0-16's.
 */
function RepositoryInspector({ repository, state, demo, identity, available, showChildAgents, onShowChildAgents, connected, onSelect, onManualSetup }: { repository: Repository; state: TownState; demo: boolean; identity: IdentityController; available: boolean; showChildAgents: boolean; onShowChildAgents: (value: boolean) => void; connected: boolean; onSelect: (id: string) => void; onManualSetup: (provider?: ToolSurface) => void }) {
  // "Watching" names the tools with a non-revoked connection for this repository (DES-02 section 3); it
  // never claims a task was accepted. Demo repositories are never described as watched (D38: samples have
  // no Watch slot at all, below).
  const watchedTools = useMemo(() => {
    if (demo) return [] as AutoDetectSurface[];
    const tools = new Set<AutoDetectSurface>();
    for (const connection of state.observation?.connections ?? []) {
      if (connection.repoId === repository.id && connection.status !== 'revoked' && autoDetectTools.some(tool => tool.provider === connection.provider)) tools.add(connection.provider as AutoDetectSurface);
    }
    return [...tools];
  }, [state.observation?.connections, repository.id, demo]);
  return <>
    <RepositoryFacts key={repository.id} repository={repository} state={state} demo={demo} identity={identity} available={available} watchedTools={watchedTools} />
    <AssignSlot />
    <RepositoryAgents key={repository.id} showChildAgents={showChildAgents} onShowChildAgents={onShowChildAgents} state={state} repoId={repository.id} connected={connected} onSelect={onSelect} />
    <div className="inspector-slot inspector-details" data-slot="details"><RepositoryDetails repository={repository} state={state} demo={demo} /></div>
    {!demo && repository.localPath && <div className="inspector-slot inspector-watch" data-slot="watch"><PanelBoundary resetKey={repository.id}><LiveTrackingPanel key={repository.id} state={state} identity={identity} available={available} repository={repository} onManualSetup={onManualSetup} /></PanelBoundary></div>}
  </>;
}

/** DES-02 section 2: until CH-11 switches on the real button in V3, every house shows this one line —
 * plain text, not focusable, no button, link, icon or request. Colocated here (not its own module) because
 * H0-07 is its only caller today; AR-21 and CH-11 should import it from wherever it lands when they reuse it. */
function AssignSlot() {
  return <p className="assign-slot" data-slot="assign">{ASSIGN_SLOT_INTERIM_LINE}</p>;
}

/** Slot 1 (Facts): the lede, then the project's fact rows. Open on arrival, never collapsible. A field this
 * build has not checked yet reads "Not checked yet", never an invented 0 or "none found" (H0-07 acceptance). */
function RepositoryFacts({ repository, state, demo, identity, available, watchedTools }: { repository: Repository; state: TownState; demo: boolean; identity: IdentityController; available: boolean; watchedTools: readonly AutoDetectSurface[] }) {
  const folder = repository.projectKind === 'folder';
  // The direct-connect flow (repository-api.ts's fromProject) always sets this exact reason for a Git
  // project until its first real scan replaces the whole record; a plain folder never carries it (its Git
  // state is known immediately, not pending).
  const unscanned = !folder && repository.git?.reason === 'git-metadata-not-scanned';
  const lede = !demo && watchedTools.length ? watchingLede(watchedTools) : PROJECT_INSPECTOR_LEDE;
  return <>
    <p className="house-lede" data-slot="facts">{lede}</p>
    {/* H0-14: the "Watching" status line and "Stop watching this project" sit here, above the fact rows,
        the only controls in slot 1 (DES-02 section 1). WatchingStatus is mounted unconditionally (never
        gated on watchedTools.length, which the component reads for itself) so a connection revoking
        mid-stop can never unmount it and drop the running job's own progress (H0-14 risk note). */}
    {!demo && repository.localPath && <WatchingStatus state={state} identity={identity} available={available} repository={repository} />}
    <dl className="facts"><div><dt>Source</dt><dd>{demo ? 'Sample data' : folder ? 'Local project folder' : repository.source === 'github' ? 'GitHub metadata' : 'Selected local folder'}</dd></div>{folder ? <div><dt>Git</dt><dd>Plain folder · no Git</dd></div> : <div><dt>Branch</dt><dd className="mono">{unscanned ? 'Not checked yet' : repository.branch || 'Unavailable'}</dd></div>}<div><dt>{folder ? 'Folder check' : 'Repository scan'}</dt><dd>{demo ? 'Not connected' : folder ? repository.discoveryStatus ? `${repository.discoveryStatus.state} · ${new Date(repository.discoveryStatus.checkedAt).toLocaleDateString()}` : 'Unavailable' : unscanned ? 'Not checked yet' : repository.scan ? `${repository.scan.coverage === 'partial' ? 'Partial' : 'Complete'} · ${new Date(repository.scan.at).toLocaleDateString()}` : 'Unavailable'}</dd></div><div><dt>API telemetry</dt><dd>{demo ? "Not connected in this preview" : state.telemetry?.sources?.some(source => source.repoId === repository.id && source.status === "receiving") ? "Receiving · coverage is partial" : state.telemetry?.sources?.some(source => source.repoId === repository.id && source.status === "unverified") ? "Connected · waiting for measurements" : state.telemetry?.sources?.some(source => source.repoId === repository.id) ? "Revoked · saved evidence retained" : "Not connected"}</dd></div>{!demo && !folder && <><div><dt>Changed files</dt><dd>{unscanned ? 'Not checked yet' : repository.git?.changedFiles ?? 'Unavailable'}</dd></div><div><dt>Untracked files</dt><dd>{unscanned ? 'Not checked yet' : repository.git?.untrackedFiles ?? 'Unavailable'}</dd></div></>}</dl>
  </>;
}

/** Slot 4 (Details): description, links and instruction files — the pre-H0-07 "repository details" content
 * minus the fact rows above, which moved into RepositoryFacts. Shows what is already saved; opening it sends
 * no request of its own. */
function RepositoryDetails({ repository, state, demo }: { repository: Repository; state: TownState; demo: boolean }) {
  const folder = repository.projectKind === 'folder';
  const unscanned = !folder && repository.git?.reason === 'git-metadata-not-scanned';
  return <>
    <div className="repo-banner" style={{ '--repo-color': repository.color } as CSSProperties}><FolderGit2 size={45} /><span>{repository.language || 'Language unavailable'}</span></div>
    <h3 className="task-title">{repository.description || repository.name}</h3>
    {!demo && repository.localPath && <div className="detail-section"><p className="eyebrow">{folder ? 'PROJECT FOLDER' : 'LOCAL CHECKOUT'}</p><code className="repo-path">{repository.localPath}</code></div>}
    {!demo && repository.githubUrl && <p><a className="text-button" href={repository.githubUrl} target="_blank" rel="noopener noreferrer">View on GitHub <ArrowUpRight size={14} /></a></p>}
    {!demo && (folder ? <Note>This folder can receive supported agent events. Git branches, change counts and managed worktrees are unavailable until the project has a verified Git checkout.</Note> : repository.git?.reason && <Note>{reasonText(repository.git.reason)}</Note>)}
    {!demo && repository.scan?.reasons.map(reason => <p className="muted small" key={reason}>{reasonText(reason)}</p>)}
    {!demo && <div className="detail-section"><h3>Instruction files</h3><p className="muted small">Read-only metadata. Discovery does not run anything from these files or apply their instructions to a run.</p>{repository.instructions?.length ? <InstructionFiles files={repository.instructions} repoId={repository.id} connections={state.observation?.connections} /> : <p className="empty">{folder ? 'Instruction files have not been scanned for this local folder. Set up supported agent observation in Connections.' : repository.source === 'github' ? 'Local instruction metadata is unavailable for remote-only repositories.' : unscanned ? 'Not checked yet. Scan selected folders to check for instruction files.' : 'No supported instruction files were found in the scanned scope.'}</p>}</div>}
    {demo ? <Note>Selected-folder discovery and instruction-file metadata connect real repositories when you create a private workspace.</Note> : <Note>{state.agents.some(agent => agent.repoId === repository.id && (agent.observation || state.runner?.runs.some(run => run.id === agent.id))) ? 'External sessions provide partial observation. Managed runs show their fixed billing account, worktree, and context delivery in their agent details.' : state.agents.some(agent => agent.repoId === repository.id && agent.discovery) ? 'Stored sessions were discovered for this repository. Their current activity stays unknown until real events arrive.' : 'No tool sessions are observed for this repository yet. Adding a repository does not start an agent.'}</Note>}
  </>;
}
