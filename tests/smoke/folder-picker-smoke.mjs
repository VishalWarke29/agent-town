#!/usr/bin/env node
// Folder-picker spike harness (plan item WS1-05). Spawns candidate folder-window helpers exactly the way the service will
// (Windows PowerShell 5.1 by absolute path, -STA -EncodedCommand, hidden, stdio [ignore,pipe,pipe], minimal env), from a
// hidden background Node process, while a stand-in "browser" window is the foreground window with fresh input. A separate
// observer process measures the dialog (visible? foreground? topmost? keyboard focus?) and drives Cancel/Select through
// UI Automation. Every window the harness opens is closed by the harness; a separate watchdog process kills every
// tracked process tree if the harness dies. Windows only. Not part of `npm test`; run it explicitly:
//
//   node tests/smoke/folder-picker-smoke.mjs --plan infra
//   node tests/smoke/folder-picker-smoke.mjs --plan control,baseline,mitigations --runs 5 --out results.json
//   node tests/smoke/folder-picker-smoke.mjs --plan functional,shots --cond asis        (tests the script the service ships; --final <file> overrides)
//
// Plans: infra, control, baseline, mitigations, pwsh, functional, guards, parent, select, shots. It prints (and writes with --out) a JSON table.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { here, loadScript, powershellPath, spawnHelper } from './folder-picker/lib.mjs';

const smokeDir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const plans = String(opt('plan', 'infra')).split(',');
const runsPerVariant = Number(opt('runs', '5'));
const outFile = opt('out', '');
const actionOverride = opt('action', '');
const only = opt('only', '') ? opt('only', '').split(',') : null;
const asisRuns = Number(opt('asis', '2'));
const strictLock = opt('lock', '0') === '1';   // stand-in calls LockSetForegroundWindow after each click (deterministic foreground lock)
// --cond asis: run the final-helper checks with whatever program is in front (the stand-in cannot take the front when a person is using the PC).
const finalCond = opt('cond', 'fresh');
// The helper under test: --final <file>, or by default the script the service ships (copied to a temporary file that is removed at the end).
let shippedCopy = null;
function shippedHelperFile() {
  const source = readFileSync(join(smokeDir, '..', '..', 'apps', 'service', 'src', 'folder-picker-script.ts'), 'utf8');
  const begin = source.indexOf('String.raw`') + 'String.raw`'.length, end = source.lastIndexOf('`;');
  shippedCopy = join(tmpdir(), `agent-town-folder-helper-${process.pid}.ps1`);
  writeFileSync(shippedCopy, source.slice(begin, end));
  return shippedCopy;
}
const finalHelper = opt('final', '') ? resolve(opt('final', '')) : shippedHelperFile();
const shotDir = resolve(opt('shots', join(smokeDir, '..', '..', 'docs', 'assets', 'audit')));
const HARNESS_CAP_MS = 25 * 60_000;
const TRIAL_CAP_MS = 40_000;

if (process.platform !== 'win32') { console.error('This spike only runs on Windows.'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const stat = a => a.length ? { n: a.length, min: Math.min(...a), median: median(a), max: Math.max(...a) } : { n: 0 };
const spawned = new Set();           // every pid this harness started, for the final leftover check
const helperPids = new Set();
const shortEnv = extra => ({ SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP, ...extra });

async function waitForIdle(obs, needMs, capMs) {
  const start = Date.now();
  for (;;) {
    const e = (await obs.cmd({ cmd: 'env' })).env;
    if (e.idleMs >= needMs) return { reached: true, idleMs: e.idleMs, waitedSec: Math.round((Date.now() - start) / 1000) };
    if (Date.now() - start > capMs) return { reached: false, idleMs: e.idleMs, waitedSec: Math.round((Date.now() - start) / 1000), note: 'someone used the machine during the wait' };
    await sleep(5000);
  }
}

function killTree(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 }); } catch { /* already gone */ } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// ---- watchdog -------------------------------------------------------------------------------------------------------
class Watchdog {
  constructor() {
    this.proc = spawn(process.execPath, [join(here, 'watchdog.mjs'), String(HARNESS_CAP_MS + 120_000)], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    this.proc.stdin.on('error', () => { /* watchdog gone */ });
    spawned.add(this.proc.pid);
  }
  track(pid, image) { spawned.add(pid); this.proc.stdin.write(`track ${pid} ${image}\n`); }
  untrack(pid) { this.proc.stdin.write(`untrack ${pid}\n`); }
  async stop() { try { this.proc.stdin.write('untrack 0\nquit\n'); this.proc.stdin.end(); } catch { /* ignore */ } await sleep(300); if (alive(this.proc.pid)) killTree(this.proc.pid); }
}

// ---- observer --------------------------------------------------------------------------------------------------------
class Observer {
  constructor(wd) {
    this.events = []; this.pending = new Map(); this.nextId = 1; this.buffer = '';
    this.child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'observer.ps1')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AT_SPIKE_PARENT_PID: String(process.pid), AT_SPIKE_MAX_MS: String(HARNESS_CAP_MS + 60_000) } });
    wd.track(this.child.pid, 'powershell.exe');
    this.stderr = '';
    this.child.stderr.on('data', c => { this.stderr += c; });
    this.child.stdin.on('error', () => { /* observer gone */ });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', c => this.onData(c));
  }
  onData(chunk) {
    this.buffer += chunk; let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); p.resolve(msg); }
      else if (msg.ev) this.events.push({ ...msg, rt: Date.now() });
    }
  }
  async ready() { await this.waitEvent(e => e.ev === 'ready', 60_000); }
  cmd(obj, timeoutMs = 20_000) {
    const id = this.nextId++;
    return new Promise((resolveCmd, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`observer command timed out: ${obj.cmd}`)); }, timeoutMs);
      this.pending.set(id, { resolve: m => { clearTimeout(timer); resolveCmd(m); } });
      // ASCII-only JSON so non-ASCII paths survive the observer's stdin regardless of code page.
      const json = JSON.stringify({ id, ...obj }).replace(/[\u0080-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      this.child.stdin.write(json + '\n');
    });
  }
  async waitEvent(pred, timeoutMs, from = 0) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const e = this.events.slice(from).find(pred); if (e) return e;
      if (Date.now() > end) return null;
      await sleep(10);
    }
  }
  async stop() { try { await this.cmd({ cmd: 'quit' }, 3000); } catch { /* ignore */ } await sleep(200); if (alive(this.child.pid)) killTree(this.child.pid); }
}

async function startStandin(wd, lockFile) {
  const child = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'standin.ps1')],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AT_SPIKE_PARENT_PID: String(process.pid), AT_SPIKE_MAX_MS: String(HARNESS_CAP_MS + 60_000), ...(lockFile ? { AT_SPIKE_LOCK_FILE: lockFile } : {}) } });
  wd.track(child.pid, 'powershell.exe'); child.stderr.resume();
  const info = await new Promise((res, rej) => {
    let buf = ''; const timer = setTimeout(() => rej(new Error('stand-in did not report a window')), 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => { buf += c; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(timer); try { res(JSON.parse(buf.slice(0, i))); } catch (e) { rej(e); } } });
  });
  return { child, hwnd: info.hwnd, pid: info.pid };
}

// ---- helper process bookkeeping ---------------------------------------------------------------------------------------
function runHelperProcess(text, extraEnv, kind, wd) {
  const t0 = Date.now();
  const { child, encodedLength, commandLineLength } = spawnHelper(text, extraEnv, kind);
  helperPids.add(child.pid); wd.track(child.pid, kind === 'pwsh' ? 'pwsh.exe' : 'powershell.exe');
  const run = { child, t0, encodedLength, commandLineLength, pid: child.pid, lines: [], stdoutBytes: 0, stderrText: '', exit: null, exitAt: null, chunks: '' };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', c => {
    run.stdoutBytes += Buffer.byteLength(c); run.chunks += c; let i;
    while ((i = run.chunks.indexOf('\n')) >= 0) { const l = run.chunks.slice(0, i).replace(/\r$/, ''); run.chunks = run.chunks.slice(i + 1); run.lines.push({ at: Date.now(), text: l }); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => { if (run.stderrText.length < 400) run.stderrText += c; });
  run.done = new Promise(res => child.on('close', code => { run.exit = code; run.exitAt = Date.now(); res(code); }));
  child.on('error', e => { run.spawnError = e.code ?? e.message; });
  return run;
}
const parseLines = run => run.lines.map(l => { try { return { at: l.at, json: JSON.parse(l.text) }; } catch { return { at: l.at, invalid: l.text.slice(0, 80) }; } });

// ---- one trial ---------------------------------------------------------------------------------------------------------
const FIXTURE_NAME = process.env.FP_FIXTURE_NAME ?? 'Agent Town spike ünï 漢字 \u{1F600} (test)';
let fixtureDir = null;
function fixture() {
  if (!fixtureDir) { const made = mkdtempSync(join(tmpdir(), `${FIXTURE_NAME} `)); fixtureDir = realpathSync.native(made); }
  return fixtureDir;
}

async function runTrial(ctx, v, cond, action, label) {
  const { obs, wd } = ctx;
  const rec = { variant: v.id, condition: cond, action, label: label ?? null, regime: cond === 'fresh' && ctx.lockFile ? 'strict-lock' : 'natural' };
  if (cond === 'asis' && /tap/.test(JSON.stringify(v.env ?? {}))) { rec.skipped = 'key-injection variants are never run against the owner\'s own foreground window'; return rec; }
  // 1. precondition
  if (cond === 'fresh') {
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) { const r = await obs.cmd({ cmd: 'click' }); rec.click = r.click; ok = Boolean(r.click?.clicked && r.click?.fgIsStandin); if (!ok) await sleep(400); }
    if (!ok) { rec.skipped = 'stand-in could not be made the foreground window'; rec.standinState = (await obs.cmd({ cmd: 'standinState' })).standin; return rec; }
    await obs.cmd({ cmd: 'ref', hwnd: ctx.standin.hwnd });
    if (ctx.lockFile) { writeFileSync(ctx.lockFile, String(Date.now())); await sleep(450); }
  } else {
    const e = (await obs.cmd({ cmd: 'env' })).env; await obs.cmd({ cmd: 'ref', hwnd: e.fg.hwnd });
  }
  await sleep(150);
  const env0 = (await obs.cmd({ cmd: 'env' })).env;
  rec.pre = { idleMs: env0.idleMs, foreground: env0.fg.who === 'other' ? env0.fg.proc : env0.fg.who, inputDesktopAccessible: env0.inputDesktopAccessible };
  // 2. spawn like the service
  const text = loadScript(v.scriptAbs ?? join(here, v.script));
  const fromEvent = ctx.obs.events.length;
  const run = runHelperProcess(text, { AGENT_TOWN_PARENT_PID: String(process.pid), AGENT_TOWN_WINDOW_MS: '60000', ...(v.env ?? {}), ...(action.startsWith('select') && v.dialog === 'tree' ? { AT_SPIKE_PRESELECT: fixture() } : {}) }, v.shell ?? 'ps51', wd);
  await obs.cmd({ cmd: 'track', pid: run.pid });
  rec.helperPid = run.pid; rec.encodedCommandLength = run.encodedLength;
  const hardStop = setTimeout(() => killTree(run.pid), TRIAL_CAP_MS);
  try {
    // 3. wait for the dialog window
    const isDialog = e => e.ev === 'win' && e.pid === run.pid && (v.match === 'title' ? e.title === 'Choose a project folder' : e.cls === '#32770');
    // stop waiting as soon as the helper process has exited without showing a window
    let win = null; const waitEnd = Date.now() + (v.id.endsWith('-noburn') ? 9_000 : 25_000);
    while (!win && Date.now() < waitEnd) { win = await obs.waitEvent(isDialog, 200, fromEvent); if (!win && run.exit !== null) { win = await obs.waitEvent(isDialog, 300, fromEvent); break; } }
    const parsed = () => parseLines(run);
    rec.diag = parsed().filter(l => l.json?.diag).map(l => l.json);
    if (!win) {
      rec.visible = false; rec.exitCode = run.exit; rec.stderr = run.stderrText.slice(0, 160); rec.lines = parsed().map(l => l.json ?? l.invalid);
      return rec;
    }
    rec.visible = true;
    rec.spawnToVisibleMs = win.t - run.t0;
    rec.atAppear = {
      isForeground: win.isForeground, foregroundIs: win.fg.who === 'other' ? `other:${win.fg.proc}` : win.fg.who, keyboardFocusIs: win.focus.who === 'other' ? `other:${win.focus.proc}` : win.focus.who,
      topmost: win.topmost, aboveReferenceInZOrder: win.zRef >= 0 ? win.z < win.zRef : null, zIndex: win.z, referenceZIndex: win.zRef,
      occlusionHitsOf9: win.occlusionHitsOf9, cloaked: win.cloaked, dpiAwareness: win.dpiAwareness, hasOwner: win.hasOwner, toolWindow: win.toolWindow,
      taskbarButtonExpected: !win.toolWindow && (!win.hasOwner || win.appWindowStyle), rect: win.rect, title: win.title, class: win.cls,
    };
    const thirdPartyBefore = obs.events.slice(fromEvent).filter(e => e.ev === 'fg' && e.t <= win.t && e.info.who === 'other').length;
    rec.thirdPartyForegroundChangesBeforeAppear = thirdPartyBefore;
    rec.clean = thirdPartyBefore === 0 && (cond === 'asis' || ['standin', 'helper'].includes(win.fg.who));
    // 4. does it stay in front? sample the same state again
    const snaps = [];
    for (const wait of [700, 1300]) { await sleep(wait); const s = (await obs.cmd({ cmd: 'snap', hwnd: win.hwnd })).snap; snaps.push(s.gone ? { gone: true } : { isForeground: s.isForeground, foregroundIs: s.fg.who === 'other' ? `other:${s.fg.proc}` : s.fg.who, keyboardFocusIs: s.focus.who === 'other' ? `other:${s.focus.proc}` : s.focus.who, occlusionHitsOf9: s.occlusionHitsOf9, topmost: s.topmost }); }
    rec.after = { plus700ms: snaps[0], plus2000ms: snaps[1] };
    // foreground changes to other processes while the dialog was up (SmartScreen, security prompts, ...)
    rec.foregroundTimeline = obs.events.slice(fromEvent).filter(e => e.ev === 'fg').map(e => ({ dt: e.t - run.t0, who: e.info.who === 'other' ? `other:${e.info.proc}` : e.info.who }));
    rec.thirdPartyForegroundChangesAfterAppear = obs.events.slice(fromEvent).filter(e => e.ev === 'fg' && e.t > win.t && e.info.who === 'other').length;
    // 5. action
    const exact = fixture();
    let actRes = null;
    if (action === 'cancel-uia') actRes = await obs.cmd({ cmd: 'uiaCancel', hwnd: win.hwnd });
    else if (action === 'cancel-wm') actRes = await obs.cmd({ cmd: 'close', hwnd: win.hwnd });
    else if (action === 'select-uia') actRes = await obs.cmd({ cmd: 'uiaSelect', hwnd: win.hwnd, kind: v.dialog === 'tree' ? 'tree' : 'vista', path: exact });
    else if (action === 'select-keyboard') actRes = await obs.cmd({ cmd: 'keyboardSelect', hwnd: win.hwnd, path: exact });
    else if (action === 'dump') { actRes = await obs.cmd({ cmd: 'dump', hwnd: win.hwnd }, 60_000); rec.uiaControls = actRes.controls; actRes = { ok: actRes.ok }; await obs.cmd({ cmd: 'uiaCancel', hwnd: win.hwnd }); }
    else if (action === 'tabwalk') { actRes = await obs.cmd({ cmd: 'tabwalk', hwnd: win.hwnd, n: 9 }, 60_000); rec.tabOrder = actRes.tabs; delete actRes.tabs; await obs.cmd({ cmd: 'uiaCancel', hwnd: win.hwnd }); }
    else if (action === 'shot') { actRes = await obs.cmd({ cmd: 'shot', hwnd: win.hwnd, file: ctx.shotFile ?? join(tmpdir(), 'fp-shot.png') }); await obs.cmd({ cmd: 'uiaCancel', hwnd: win.hwnd }); }
    rec.actionResult = actRes ? { ok: actRes.ok, method: actRes.method ?? actRes.result, error: actRes.error, editFocused: actRes.editFocused, typed: actRes.typed, enter: actRes.enter, secondPress: actRes.secondPress, size: actRes.size } : null;
    const tAct = Date.now();
    if (process.env.FP_DEBUG_AFTER && action.startsWith('select')) {
      await sleep(1500);
      rec.debugShot = await obs.cmd({ cmd: 'shot', hwnd: win.hwnd, file: process.env.FP_DEBUG_AFTER });
      rec.debugDump = (await obs.cmd({ cmd: 'dump', hwnd: win.hwnd }, 60_000)).controls;
    }
    const code = await Promise.race([run.done, sleep(12_000).then(() => 'timeout')]);
    rec.exitCode = code === 'timeout' ? 'still-running' : code;
    rec.actionToExitMs = run.exitAt ? run.exitAt - tAct : null;
    const gone = await obs.waitEvent(e => e.ev === 'gone' && e.hwnd === win.hwnd, 4000, fromEvent);
    rec.windowGoneAfterActionMs = gone ? gone.t - tAct : null;
    await sleep(500);
    const fgAfter = (await obs.cmd({ cmd: 'env' })).env.fg; rec.foregroundAfterCloseIs = fgAfter.who === 'other' ? `other:${fgAfter.proc}` : fgAfter.who;
    const openLine = parsed().find(l => l.json?.state === 'open');
    rec.spawnToOpenLineMs = openLine ? openLine.at - run.t0 : null;
    rec.openLineMinusVisibleMs = openLine ? openLine.at - win.t : null;
    const lines = parsed(); rec.diag = lines.filter(l => l.json?.diag).map(l => l.json); rec.lines = lines.filter(l => !l.json?.diag).map(l => l.json ?? { invalid: l.invalid });
    rec.strictLines = lines.filter(l => !l.json?.diag).every(l => l.json && ['open', 'selected', 'cancelled'].includes(l.json.state));
    const selected = lines.find(l => l.json?.state === 'selected');
    if (action.startsWith('select')) rec.returnedPathExact = selected ? selected.json.path === exact : false;
    if (selected) rec.lines = rec.lines.map(l => l.state === 'selected' ? { state: 'selected', pathLength: l.path.length, pathIsExact: l.path === exact } : l);
    rec.stdoutBytes = run.stdoutBytes; rec.stderr = run.stderrText.replace(/\s+/g, ' ').slice(0, 160);
    return rec;
  } finally {
    clearTimeout(hardStop);
    if (run.exit === null) { rec.killedByHarness = true; killTree(run.pid); await Promise.race([run.done, sleep(4000)]); }
    await obs.cmd({ cmd: 'untrack', pid: run.pid }).catch(() => { });
    rec.processGoneAfterTrial = !alive(run.pid);
    wd.untrack(run.pid);
  }
}

// ---- functional checks on the final helper -------------------------------------------------------------------------------
async function testParentKill(ctx, scriptFile, envExtra, label) {
  const { obs, wd } = ctx;
  const out = { label };
  const stub = spawn(process.execPath, [join(here, 'parent-stub.mjs'), scriptFile, JSON.stringify(envExtra)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  wd.track(stub.pid, 'node.exe'); stub.stderr.resume();
  const lines = []; let buf = '';
  stub.stdout.setEncoding('utf8'); stub.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { try { lines.push({ at: Date.now(), ...JSON.parse(buf.slice(0, i)) }); } catch { /* ignore */ } buf = buf.slice(i + 1); } });
  let info = null; for (let i = 0; i < 400 && !info; i++) { info = lines.find(l => l.helperPid); await sleep(50); }
  if (!info) { out.error = 'stub did not start'; killTree(stub.pid); return out; }
  helperPids.add(info.helperPid); wd.track(info.helperPid, 'powershell.exe'); await obs.cmd({ cmd: 'track', pid: info.helperPid });
  const fromEvent = obs.events.length;
  const win = await obs.waitEvent(e => e.ev === 'win' && e.pid === info.helperPid && e.cls === '#32770', 25_000, fromEvent);
  out.dialogVisible = Boolean(win);
  const tKill = Date.now();
  try { execFileSync('taskkill', ['/PID', String(info.stubPid), '/F'], { windowsHide: true, stdio: 'ignore' }); out.parentKilledWithoutTreeFlag = true; } catch { out.parentKilledWithoutTreeFlag = false; }
  let exitedAt = null;
  for (let i = 0; i < 160 && exitedAt === null; i++) { if (!alive(info.helperPid)) exitedAt = Date.now(); else await sleep(100); }
  out.helperExitedAfterParentKillMs = exitedAt ? exitedAt - tKill : null;
  out.helperSurvived15s = exitedAt === null;
  if (win) { const gone = await obs.waitEvent(e => e.ev === 'gone' && e.hwnd === win.hwnd, 500, fromEvent); out.windowGoneAfterParentKillMs = gone ? gone.t - tKill : null; }
  if (exitedAt === null) { killTree(info.helperPid); out.killedByHarness = true; }
  killTree(stub.pid); await obs.cmd({ cmd: 'untrack', pid: info.helperPid }).catch(() => { });
  return out;
}

async function testNoWindowStuff(ctx, scriptFile, label, extraEnv) {
  // a run that never shows a window (invalid environment); must exit non-zero and print nothing sensitive
  const run = runHelperProcess(loadScript(scriptFile), extraEnv, 'ps51', ctx.wd);
  const code = await Promise.race([run.done, sleep(15_000).then(() => 'timeout')]);
  if (code === 'timeout') killTree(run.pid);
  return { label, exitCode: code, stdoutBytes: run.stdoutBytes, stdoutLines: run.lines.map(l => l.text.slice(0, 80)), stderr: run.stderrText.replace(/\s+/g, ' ').slice(0, 120), ms: (run.exitAt ?? Date.now()) - run.t0 };
}

// ---- plans -----------------------------------------------------------------------------------------------------------------
const B = (id, env, extra = {}) => ({ id, script: 'candidate-b-ifileopendialog.ps1', dialog: 'vista', env, ...extra });
const A = (id, env, extra = {}) => ({ id, script: 'candidate-a-folderbrowserdialog.ps1', dialog: 'tree', env, ...extra });
const C = (id, env) => ({ id, script: 'candidate-control-plainwindow.ps1', dialog: 'none', match: 'title', env });
const BURN = { AT_SPIKE_BURN: '1' };
const variants = {
  // Every window a helper shows is hidden when the show state is not burned (windowsHide:true), so the "-noburn" rows are the evidence.
  control: [C('control-plain-noburn', {}), C('control-plain', { ...BURN }), C('control-sfw', { ...BURN, AT_SPIKE_PRE: 'sfw' }), C('control-tapf24-sfw', { ...BURN, AT_SPIKE_PRE: 'tapf24,sfw' }), C('control-tapalt-sfw', { ...BURN, AT_SPIKE_PRE: 'tapalt,sfw' }), C('control-tapvk-sfw', { ...BURN, AT_SPIKE_PRE: 'tapvk,sfw' }), C('control-mouse0-sfw', { ...BURN, AT_SPIKE_PRE: 'mouse0,sfw' }), C('control-attach', { ...BURN, AT_SPIKE_PRE: 'attach' })],
  baseline: [A('A0-folderbrowserdialog-noburn', {}), B('B0-ifileopendialog-noburn', {}), A('A0-folderbrowserdialog', { ...BURN }), B('B0-ifileopendialog', { ...BURN })],
  mitigations: [
    B('B-owner', { ...BURN, AT_SPIKE_OWNER: '1' }),
    B('B-owner-sfw', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'sfw' }),
    B('B-owner-tapalt-sfw', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'tapalt,sfw' }),
    B('B-owner-tapf24-sfw', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'tapf24,sfw' }),
    B('B-owner-tapvk-sfw', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'tapvk,sfw' }),
    B('B-owner-mouse0-sfw', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'mouse0,sfw' }),
    B('B-owner-attach', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'attach' }),
    B('B-owner-switchtothiswindow', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'sw2' }),
    B('B-owner-bring-sfw', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'bring,sfw' }),
    B('B-post-topmost', { ...BURN, AT_SPIKE_POST: 'topmost' }),
    B('B-post-tapvk-sfw', { ...BURN, AT_SPIKE_POST: 'tapvk,sfw' }),
    B('B-owner-ladder', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'ladder' }),
    B('B-owner-ladder-dpi', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'ladder', AT_SPIKE_DPI: '1' }),
    A('A-owner', { ...BURN, AT_SPIKE_OWNER: '1' }),
    A('A-owner-ladder', { ...BURN, AT_SPIKE_OWNER: '1', AT_SPIKE_PRE: 'ladder' }),
  ],
  pwsh: [A('D-pwsh7-folderbrowserdialog-noburn', {}, { shell: 'pwsh' }), A('D-pwsh7-folderbrowserdialog', { ...BURN }, { shell: 'pwsh' })],
};

async function main() {
  const results = { harness: 'folder-picker-smoke.mjs', startedAt: new Date().toISOString(), node: process.version, plans, runsPerVariant, trials: [], functional: {}, notes: [] };
  const wd = new Watchdog();
  let obs = null, standin = null, lockFileToDelete = null;
  const started = Date.now();
  const capTimer = setTimeout(async () => { console.error('harness cap reached, cleaning up'); await cleanup(); process.exit(3); }, HARNESS_CAP_MS);
  async function cleanup() {
    clearTimeout(capTimer);
    for (const pid of helperPids) if (alive(pid)) killTree(pid);
    if (obs) { await obs.cmd({ cmd: 'closeStandin' }).catch(() => { }); await sleep(300); await obs.stop(); }
    if (standin && alive(standin.pid)) killTree(standin.pid);
    if (fixtureDir) { try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ } fixtureDir = null; }
    if (shippedCopy) { try { rmSync(shippedCopy, { force: true }); } catch { /* ignore */ } }
    if (lockFileToDelete) { try { rmSync(lockFileToDelete, { force: true }); } catch { /* ignore */ } }
    await wd.stop();
  }
  process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
  try {
    obs = new Observer(wd); await obs.ready();
    const lockFile = strictLock ? join(tmpdir(), `agent-town-spike-lock-${process.pid}.flag`) : null;
    lockFileToDelete = lockFile;
    standin = await startStandin(wd, lockFile);
    await obs.cmd({ cmd: 'init', standinHwnd: standin.hwnd, standinPid: standin.pid });
    const ctx = { obs, wd, standin, lockFile };
    results.regime = strictLock ? 'strict-lock: the stand-in calls LockSetForegroundWindow(LSFW_LOCK) after every click' : 'natural: whatever state the desktop foreground lock is in (real user input inside the last ForegroundLockTimeout arms it, injected input does not)';
    results.environment = (await obs.cmd({ cmd: 'env' })).env;
    results.environment.session = 'interactive console session (Windows 11)';
    results.environment.harnessPid = process.pid;
    let idx = 0;
    const record = async (v, cond, action, label) => { const r = await runTrial(ctx, v, cond, actionOverride || action, label); r.run = ++idx; results.trials.push(r); const s = r.skipped ? `skipped (${r.skipped})` : `${r.visible ? `visible ${r.spawnToVisibleMs}ms fg=${r.atAppear.foregroundIs} focus=${r.atAppear.keyboardFocusIs} top=${r.atAppear.topmost} occl=${r.atAppear.occlusionHitsOf9}/9` : 'NOT VISIBLE'} exit=${r.exitCode}`; console.error(`[${r.run}] ${v.id} ${cond} ${action}: ${s}`); return r; };

    if (plans.includes('infra')) {
      const c = (await obs.cmd({ cmd: 'click' })).click; results.functional.infra = { standinClick: c, env: results.environment };
    }
    if (plans.includes('idle')) {
      // Unattended owner: lock timeout expired (no input for >200 s), foreground = the owner's real app. Nothing is injected.
      await obs.cmd({ cmd: 'minimizeStandin' }); await sleep(600);
      const wait = await waitForIdle(obs, 205_000, 6 * 60_000); results.functional.idleWait = wait;
      if (wait.reached) {
        for (const v of [...variants.control.filter(x => x.id === 'control-plain'), ...variants.baseline.filter(x => x.id === 'B0-ifileopendialog' || x.id === 'A0-folderbrowserdialog')]) for (let i = 0; i < 2; i++) await record({ ...v, id: v.id + '@idle-expired' }, 'asis', 'cancel-uia', `idle-expired ${i + 1}`);
        const fv = { id: 'FINAL-helper@idle-expired', scriptAbs: finalHelper, dialog: 'vista', env: {} };
        try { for (let i = 0; i < 2; i++) await record(fv, 'asis', 'cancel-uia', `idle-expired ${i + 1}`); } catch (e) { results.functional.idleFinalError = String(e.message).slice(0, 100); }
      }
      await obs.cmd({ cmd: 'restoreStandin' });
    }
    if (plans.includes('quiet')) {
      // Foreground stability check: does anything else on this desktop change the foreground window while nothing of ours runs?
      const from = obs.events.length; await obs.cmd({ cmd: 'click' }); await sleep(Number(opt('quietSec', '20')) * 1000);
      const fg = obs.events.slice(from).filter(e => e.ev === 'fg').map(e => ({ at: e.t - obs.events[from].t, who: e.info.who === 'other' ? `other:${e.info.proc}` : e.info.who }));
      results.functional.quiet = { seconds: Number(opt('quietSec', '20')), foregroundChanges: fg, standin: (await obs.cmd({ cmd: 'standinState' })).standin };
    }
    if (plans.includes('noise')) {
      // Which of our own actions (if any) makes the foreground window change? Spawn no-window helpers in the service shape and log foreground changes.
      const probes = { 'sleep-only': 'Start-Sleep -Seconds 6', 'add-type-only': 'Add-Type -TypeDefinition \x27public static class Q { public static int F() { return 1; } }\x27; Start-Sleep -Seconds 5', 'nothing-running': null };
      results.functional.noise = {};
      for (const [name, script] of Object.entries(probes)) {
        await obs.cmd({ cmd: 'click' }); await sleep(600);
        const from = obs.events.length; const t0 = Date.now(); let run = null;
        if (script) { run = runHelperProcess(script, {}, 'ps51', wd); }
        await sleep(7000);
        if (run && run.exit === null) killTree(run.pid);
        results.functional.noise[name] = obs.events.slice(from).filter(e => e.ev === 'fg').map(e => ({ dt: e.t - t0, who: e.info.who === 'other' ? `other:${e.info.proc}` : e.info.who }));
      }
    }
    for (const plan of ['control', 'baseline', 'mitigations', 'pwsh']) {
      if (!plans.includes(plan)) continue;
      for (const v of variants[plan]) {
        if (only && !only.includes(v.id)) continue;
        const n = plan === 'pwsh' || v.id.endsWith('-noburn') ? Math.min(runsPerVariant, 3) : runsPerVariant;
        // keep going until n clean runs (no third-party foreground interference) or 2n+1 attempts
        for (let good = 0, tries = 0; good < n && tries < 2 * n + 1; tries++) { const r = await record(v, 'fresh', 'cancel-uia', `run ${tries + 1}`); if (!r.skipped && (!r.visible || r.clean)) good++; }
        if (plan === 'baseline' && !v.id.endsWith('-noburn') || plan === 'control' && v.id === 'control-plain') for (let i = 0; i < asisRuns; i++) await record(v, 'asis', 'cancel-uia', `as-is ${i + 1}`);
      }
    }
    if (plans.includes('functional')) {
      const fv = { id: 'FINAL-helper', scriptAbs: finalHelper, dialog: 'vista', env: {} };
      for (let i = 0; i < runsPerVariant; i++) await record(fv, finalCond, 'cancel-uia', `cancel run ${i + 1}`);
      for (let i = 0; i < 3; i++) await record(fv, finalCond, 'select-uia', `select run ${i + 1}`);
      await record(fv, finalCond, 'select-keyboard', 'keyboard-only select');
      await record(fv, finalCond, 'cancel-wm', 'WM_CLOSE');
      await record(fv, finalCond, 'dump', 'UIA control tree');
      await record(fv, finalCond, 'tabwalk', 'Tab order');
      await record(fv, 'asis', 'cancel-uia', 'as-is (owner\'s real foreground app)');
      await record(fv, 'asis', 'cancel-uia', 'as-is (owner\'s real foreground app) 2');
      results.functional.parentKill = await testParentKill(ctx, finalHelper, {}, 'final helper, parent hard-killed (taskkill /F, no /T)');
      results.functional.parentKillCandidateB = await testParentKill(ctx, join(here, 'candidate-b-ifileopendialog.ps1'), {}, 'candidate B (has its own parent watch)');
      results.functional.invalidParentPid = await testNoWindowStuff(ctx, finalHelper, 'AGENT_TOWN_PARENT_PID=abc', { AGENT_TOWN_PARENT_PID: 'abc' });
      results.functional.missingParentPid = await testNoWindowStuff(ctx, finalHelper, 'AGENT_TOWN_PARENT_PID absent', {});
      results.functional.deadParentPid = await testNoWindowStuff(ctx, finalHelper, 'AGENT_TOWN_PARENT_PID=<exited process>', { AGENT_TOWN_PARENT_PID: '4194300' });
      // own window time limit: 4 s
      const lim = await runTrialTimeLimit(ctx, finalHelper);
      results.functional.windowTimeLimit = lim;
    }
    if (plans.includes('guards')) {
      results.functional.invalidParentPid = await testNoWindowStuff(ctx, finalHelper, 'AGENT_TOWN_PARENT_PID=abc', { AGENT_TOWN_PARENT_PID: 'abc' });
      results.functional.missingParentPid = await testNoWindowStuff(ctx, finalHelper, 'AGENT_TOWN_PARENT_PID absent', {});
      results.functional.deadParentPid = await testNoWindowStuff(ctx, finalHelper, 'AGENT_TOWN_PARENT_PID=<exited process>', { AGENT_TOWN_PARENT_PID: '4194300' });
    }
    if (plans.includes('parent')) {
      results.functional.parentKill = await testParentKill(ctx, finalHelper, {}, 'final helper, parent hard-killed (taskkill /F, no /T)');
    }
    if (plans.includes('select')) {
      const fv = { id: 'FINAL-helper', scriptAbs: finalHelper, dialog: 'vista', env: {} };
      await record(fv, finalCond, 'select-uia', 'select (uia)');
      await record(fv, finalCond, 'select-keyboard', 'select (keyboard)');
    }
    if (plans.includes('shots')) {
      mkdirSync(shotDir, { recursive: true });
      const fv = { id: 'FINAL-helper', scriptAbs: finalHelper, dialog: 'vista', env: {} };
      ctx.shotFile = join(shotDir, '2026-09-24-folder-picker-dialog.png');
      await record(fv, finalCond, 'shot', 'screenshot of the dialog rectangle only');
    }
    results.summary = summarise(results.trials);
    results.leftovers = leftoverCheck();
  } catch (e) {
    results.fatal = String(e?.stack ?? e).slice(0, 600);
    console.error('FATAL', results.fatal);
  } finally {
    await cleanup();
    results.finishedAt = new Date().toISOString(); results.elapsedSec = Math.round((Date.now() - started) / 1000);
    results.processesGoneAtEnd = [...spawned].every(pid => !alive(pid));
    const json = JSON.stringify(results, null, 2);
    if (outFile) { mkdirSync(dirname(resolve(outFile)), { recursive: true }); writeFileSync(resolve(outFile), json); }
    console.log(JSON.stringify(results.summary ?? results.functional, null, 2));
    console.error(`done in ${results.elapsedSec}s; all spawned processes gone: ${results.processesGoneAtEnd}`);
  }
}

async function runTrialTimeLimit(ctx, scriptFile) {
  const { obs, wd } = ctx; const out = { configuredWindowMs: 4000 };
  await obs.cmd({ cmd: 'click' });
  const fromEvent = obs.events.length;
  const run = runHelperProcess(loadScript(scriptFile), { AGENT_TOWN_PARENT_PID: String(process.pid), AGENT_TOWN_WINDOW_MS: '4000' }, 'ps51', wd);
  await obs.cmd({ cmd: 'track', pid: run.pid });
  const win = await obs.waitEvent(e => e.ev === 'win' && e.pid === run.pid && e.cls === '#32770', 25_000, fromEvent);
  out.dialogVisible = Boolean(win);
  if (win) {
    const gone = await obs.waitEvent(e => e.ev === 'gone' && e.hwnd === win.hwnd, 12_000, fromEvent);
    out.windowClosedAfterVisibleMs = gone ? gone.t - win.t : null;
    await Promise.race([run.done, sleep(6000)]);
    out.exitCode = run.exit; out.lines = run.lines.map(l => l.text.slice(0, 60)); out.processExitedAfterVisibleMs = run.exitAt ? run.exitAt - win.t : null;
  }
  if (run.exit === null) { killTree(run.pid); out.killedByHarness = true; }
  await obs.cmd({ cmd: 'untrack', pid: run.pid }).catch(() => { });
  return out;
}

function summarise(trials) {
  const groups = new Map();
  for (const t of trials) { const k = `${t.variant} | ${t.condition} | ${t.regime ?? '-'}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const rows = [];
  for (const [k, ts] of groups) {
    const ranAll = ts.filter(t => !t.skipped); const contaminated = ranAll.filter(t => t.visible && !t.clean).length; const ran = ranAll.filter(t => !t.visible || t.clean); const vis = ran.filter(t => t.visible);
    const c = f => vis.filter(f).length;
    rows.push({
      variant: k, runs: ran.length, skipped: ts.length - ranAll.length, excludedThirdPartyInterference: contaminated, visible: `${vis.length}/${ran.length}`,
      foreground: `${c(t => t.atAppear.isForeground)}/${vis.length}`,
      keyboardFocusInDialog: `${c(t => t.atAppear.keyboardFocusIs === 'helper')}/${vis.length}`,
      topmost: `${c(t => t.atAppear.topmost)}/${vis.length}`,
      aboveReferenceWindow: `${c(t => t.atAppear.aboveReferenceInZOrder === true)}/${vis.length}`,
      fullyUnoccluded9of9: `${c(t => t.atAppear.occlusionHitsOf9 === 9)}/${vis.length}`,
      stillForegroundAt2s: `${c(t => t.after?.plus2000ms?.isForeground)}/${vis.filter(t => t.thirdPartyForegroundChangesAfterAppear === 0).length} undisturbed`,
      spawnToVisibleMs: stat(vis.map(t => t.spawnToVisibleMs)),
      addTypeMs: stat(ran.map(t => t.diag?.find(d => d.diag === 'timing')?.addTypeMs).filter(x => Number.isFinite(x))),
      psStartMs: stat(ran.map(t => t.diag?.find(d => d.diag === 'timing')?.psStartMs).filter(x => Number.isFinite(x))),
      exitCodes: [...new Set(ran.map(t => t.exitCode))].join(','),
      allProcessesGone: ran.every(t => t.processGoneAfterTrial),
    });
  }
  return rows;
}

function leftoverCheck() {
  try {
    const out = execFileSync(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      "$ids = @(" + [...helperPids].join(',') + "); Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId -or ($ids -contains $_.ParentProcessId) } | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress"],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
    return { helpersOrTheirChildrenStillRunning: out ? JSON.parse(out) : [] };
  } catch (e) { return { error: String(e.message).slice(0, 100) }; }
}

main();
