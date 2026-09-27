import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { FOLDER_PICK_LIMITS, folderPickUnavailableReasons, type BrowserSession, type FolderPick, type FolderPickUnavailableReason, type Snapshot } from '@agent-town/contracts';

/**
 * "Browse..." beside the Project folder field (plan items WS1-05 / WS1-07).
 *
 * The local service opens a real folder window on the owner's desktop and hands back only the chosen path
 * text, so here the three folder-window routes are mocked and every journey checks what the page does with
 * their answers: text, focus, announcements, polling and cleanup. The service side (opening the window,
 * re-validating the path when it is added) has its own tests; nothing here opens a real window.
 */
const workspaceId = 'fixture-folder-browse';
const prefix = `/api/v1/workspaces/${workspaceId}`;
const checkedAt = '2026-09-24T09:00:00Z';
const pickId = '11111111-1111-4111-8111-111111111111';
const chosenPath = String.raw`C:\fixture-projects\chosen-project`;

// The agreed sentences, written out here on purpose: the page must show exactly these.
const text = {
  hint: 'Opens a folder window on this computer. You can also type or paste a path.',
  opening: 'Opening the folder window…',
  waiting: 'A folder window opened on your computer. It may be behind this window. Press Alt+Tab if you cannot see it.',
  typeInstead: "Can't see it? Type a path",
  typeHint: 'Still no window? You can close it and type the path instead.',
  closeUnconfirmed: 'The folder window did not confirm it closed. It will close by itself within about 30 seconds. Nothing was added.',
  alreadyOpen: 'A folder window is already open on your computer.',
  chosen: 'Folder chosen. Check the path, then choose Add this project.',
  closed: 'Folder window closed. Nothing was added.',
  lostContact: 'Lost contact with the local service. Try Browse... again or type the path.',
  timedOut: 'The folder window was open for 5 minutes and was closed. Choose Browse... to try again, or type the path.',
} as const;
// A Record keyed by the contract's reasons: adding a reason there stops this file compiling until it is covered.
const unavailableText: Record<FolderPickUnavailableReason, string> = {
  'unsupported-platform': 'Folder windows are only available on Windows. Type or paste the folder path instead.',
  'no-desktop': "Agent Town could not open a window on this computer's desktop. Type or paste the folder path instead.",
  'helper-failed': 'The folder window could not open. Type or paste the folder path instead.',
};

type Reply = { status?: number; body: unknown } | 'abort';
type Answer<Args extends unknown[]> = (...args: Args) => Reply | Promise<Reply>;
interface Handlers {
  start?: Answer<[number]>;
  poll?: Answer<[number]>;
  cancel?: Answer<[]>;
}
interface Options { scanRunning?: boolean; roots?: string[]; clock?: boolean; viewport?: { width: number; height: number } }

const pick = (over: Partial<FolderPick> = {}): FolderPick => ({ id: pickId, state: 'waiting', startedAt: checkedAt, expiresAt: '2026-09-24T09:05:00Z', ...over });
const ok = (body: unknown, status = 200): Reply => ({ status, body });

async function openSetup(page: Page, handlers: Handlers, options: Options = {}) {
  const calls = { starts: 0, polls: 0, cancels: [] as string[], roots: [] as unknown[], startHeaders: {} as Record<string, string>, unexpected: [] as string[] };
  const snapshot: Snapshot = { cursor: 1, state: { schemaVersion: 1, workspace: { id: workspaceId, name: 'Folder window', mode: 'private' }, simulation: { running: false, step: 0 }, repositories: [], agents: [], handoffs: [], activity: [], manager: { version: 0, brief: 'No reports received.', updatedAt: null }, discovery: { roots: options.roots ?? [], candidates: [], operation: options.scanRunning ? { id: 'scan-fixture', status: 'running', startedAt: checkedAt, finishedAt: null, message: 'Reading selected folder metadata…', coverage: null } : null } } };
  const session: BrowserSession = { csrf: 'fixture-csrf', mode: 'private', applicationMode: 'development', user: { id: 'fixture-owner', login: 'fixture-owner', displayName: 'Fixture Owner', avatarUrl: null }, workspaces: [{ id: workspaceId, name: 'Folder window', kind: 'personal' }], identity: { configured: true } };
  if (options.viewport) await page.setViewportSize(options.viewport);
  if (options.clock) await page.clock.install({ time: new Date('2026-09-24T09:00:00Z') });
  await page.addInitScript(() => {
    class FixtureEvents extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify((event as CustomEvent).detail) }));
      constructor() { super(); window.addEventListener('fixture-folder-browse', this.listener); setTimeout(() => this.onopen?.(), 0); }
      close() { window.removeEventListener('fixture-folder-browse', this.listener); }
    }
    window.EventSource = FixtureEvents as unknown as typeof EventSource;
  });
  const publish = async () => { snapshot.cursor++; await page.evaluate(value => window.dispatchEvent(new CustomEvent('fixture-folder-browse', { detail: value })), snapshot); };
  const send = async (route: Route, reply: Reply) => {
    try {
      if (reply === 'abort') await route.abort('failed');
      else await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body) });
    } catch { /* The page already gave up on this request (cancelled or timed out): nothing to answer. */ }
  };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    if (path === '/api/v1/session') return send(route, ok(session));
    if (path.endsWith('/snapshot')) return send(route, ok(snapshot));
    if (path === `${prefix}/folders/pick` && method === 'POST') {
      calls.starts++; calls.startHeaders = request.headers();
      return send(route, await (handlers.start ?? (() => ok(pick())))(calls.starts));
    }
    if (path === `${prefix}/folders/pick/${pickId}/cancel` && method === 'POST') {
      calls.cancels.push(path);
      return send(route, await (handlers.cancel ?? (() => ok(pick({ state: 'cancelled' }))))());
    }
    if (path === `${prefix}/folders/pick/${pickId}` && method === 'GET') {
      calls.polls++;
      return send(route, await (handlers.poll ?? (() => ok(pick())))(calls.polls));
    }
    if (path === `${prefix}/roots` && method === 'POST') {
      const body = request.postDataJSON() as { path: string };
      calls.roots.push(body); snapshot.state.discovery!.roots = [body.path];
      await send(route, ok({ ok: true })); await publish(); return;
    }
    calls.unexpected.push(`${method} ${path}`);
    return send(route, { status: 400, body: { code: 'UNEXPECTED_FIXTURE_REQUEST', message: 'No other requests in this fixture.' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect a project', exact: true }).click();
  const local = page.getByRole('region', { name: 'Local folders', exact: true });
  await expect(local).toBeVisible();
  if (options.clock) await page.clock.pauseAt(new Date('2026-09-24T09:30:00Z'));
  return {
    calls, publish, local,
    field: local.getByLabel('Project folder', { exact: true }),
    browse: local.getByRole('button', { name: 'Browse...', exact: true }),
    add: local.getByRole('button', { name: 'Add this project', exact: true }),
    cancel: local.getByRole('button', { name: 'Cancel', exact: true }),
    typeInstead: local.getByRole('button', { name: text.typeInstead, exact: true }),
    live: page.locator('.folder-browse-live'),
  };
}

/** Records every sentence that appears inside the polite live region, so "announced once" is measured, not assumed. */
async function watchAnnouncements(page: Page) {
  await page.evaluate(() => {
    const region = document.querySelector('.folder-browse-live');
    if (!region) throw new Error('The folder window live region is missing.');
    const store = window as unknown as { __announced: string[] };
    store.__announced = [];
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'characterData') { const value = (record.target.textContent ?? '').trim(); if (value) store.__announced.push(value); continue; }
        for (const node of record.addedNodes) { const value = (node.textContent ?? '').trim(); if (value) store.__announced.push(value); }
      }
    }).observe(region, { childList: true, subtree: true, characterData: true });
  });
  return () => page.evaluate(() => (window as unknown as { __announced: string[] }).__announced);
}

const message = (page: Page, sentence: string) => page.locator('.folder-browse-live').getByText(sentence, { exact: true });

/** Both project sizes must show the button fully, keep the field usable, and never scroll sideways. */
async function expectFits(page: Page, locators: Locator[]) {
  const drawer = page.locator('dialog[open] .drawer-content');
  const drawerBox = (await drawer.boundingBox())!;
  const viewport = page.viewportSize()!;
  for (const locator of locators) {
    const box = (await locator.boundingBox())!;
    expect(box.x, 'starts inside the drawer').toBeGreaterThanOrEqual(drawerBox.x - 0.5);
    expect(box.x + box.width, 'ends inside the drawer').toBeLessThanOrEqual(drawerBox.x + drawerBox.width + 0.5);
    expect(box.x + box.width, 'ends inside the window').toBeLessThanOrEqual(viewport.width + 0.5);
  }
  const overflow = await page.evaluate(() => {
    const content = document.querySelector('dialog[open] .drawer-content')!;
    return { content: content.scrollWidth - content.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(overflow.content, 'drawer content scrolls sideways').toBeLessThanOrEqual(0);
  expect(overflow.page, 'page scrolls sideways').toBeLessThanOrEqual(0);
}

test.describe('Browse... folder window', () => {
  test('shows the waiting message with Cancel, keeps the button available and busy, and sends one CSRF-protected start', async ({ page }) => {
    const { browse, cancel, typeInstead, live, local, calls, field } = await openSetup(page, {});
    await expect(browse).toBeVisible();
    await expect(browse).toHaveText('Browse...');
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    // The hint is visible and the button is described by it.
    await expect(local.getByText(text.hint, { exact: true })).toBeVisible();
    const describedBy = (await browse.getAttribute('aria-describedby'))!.split(' ');
    await expect(page.locator(`[id="${describedBy[0]}"]`)).toHaveText(text.hint);
    // The typed path field is unchanged and still available.
    await expect(field).toBeEditable();
    await expect(local.getByText('Type or paste an absolute folder path first.', { exact: false })).toBeVisible();
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveAttribute('aria-live', 'polite');

    await browse.click();
    await expect(live.getByText(text.waiting, { exact: true })).toBeVisible();
    await expect(cancel).toBeVisible();
    await expect(browse).toHaveAttribute('aria-busy', 'true');
    await expect(browse).toBeEnabled();
    await expect(browse).toBeFocused();
    await expect(typeInstead).toHaveCount(0);
    expect(calls.starts).toBe(1);
    expect(calls.startHeaders['x-csrf-token']).toBe('fixture-csrf');
    expect(calls.unexpected).toEqual([]);
  });

  test('a chosen folder fills the field, is announced once, focuses the field so the path is read, and is not added until asked', async ({ page }) => {
    const { browse, field, add, local, live, calls } = await openSetup(page, { poll: n => ok(n < 2 ? pick() : pick({ state: 'selected', path: chosenPath })) });
    const announced = await watchAnnouncements(page);
    await browse.click();
    await expect(field).toHaveValue(chosenPath);
    await expect(message(page, text.chosen)).toBeVisible();
    await expect(field).toBeFocused();
    await expect(add).toBeEnabled();
    await expect(live.getByText(text.waiting, { exact: true })).toHaveCount(0);
    await expect(local.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    // Each sentence reached the live region exactly once, in order.
    expect(await announced()).toEqual([text.waiting, text.chosen]);
    // Choosing is not adding: nothing reached the add route yet, and no polling continues.
    expect(calls.roots).toEqual([]);
    const polls = calls.polls;
    await page.waitForTimeout(FOLDER_PICK_LIMITS.pollMs * 1.6);
    expect(calls.polls).toBe(polls);
    // Adding is still the person's own step, through the same button and route.
    await page.keyboard.press('Enter');
    await expect(local.getByRole('heading', { name: 'Folders Agent Town may look in · 1/8' })).toBeVisible();
    expect(calls.roots).toEqual([{ path: chosenPath }]);
    await expect(message(page, text.chosen)).toHaveCount(0);
    expect(calls.cancels).toEqual([]);
    expect(calls.unexpected).toEqual([]);
  });

  test('a window closed on the desktop is announced once and returns focus to Browse...', async ({ page }) => {
    const { browse, field, add, calls } = await openSetup(page, { poll: n => ok(n < 2 ? pick() : pick({ state: 'cancelled' })) });
    const announced = await watchAnnouncements(page);
    await browse.click();
    await expect(message(page, text.closed)).toBeVisible();
    await expect(browse).toBeFocused();
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    await expect(field).toHaveValue('');
    await expect(add).toBeDisabled();
    expect(await announced()).toEqual([text.waiting, text.closed]);
    const polls = calls.polls;
    await page.waitForTimeout(FOLDER_PICK_LIMITS.pollMs * 1.6);
    expect(calls.polls).toBe(polls);
    // The person can start over.
    await browse.click();
    await expect(page.locator('.folder-browse-live').getByText(text.waiting, { exact: true })).toBeVisible();
    expect(calls.starts).toBe(2);
  });

  test('pressing Cancel closes the window, says so once, and returns focus to Browse...', async ({ page }) => {
    const { browse, cancel, live, calls } = await openSetup(page, {});
    const announced = await watchAnnouncements(page);
    await browse.click();
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect(message(page, text.closed)).toBeVisible();
    await expect(browse).toBeFocused();
    await expect(live.getByText(text.waiting, { exact: true })).toHaveCount(0);
    await expect.poll(() => calls.cancels).toEqual([`${prefix}/folders/pick/${pickId}/cancel`]);
    expect(await announced()).toEqual([text.waiting, text.closed]);
    const polls = calls.polls;
    await page.waitForTimeout(FOLDER_PICK_LIMITS.pollMs * 1.6);
    expect(calls.polls).toBe(polls);
  });

  test('a keyboard alone can open, cancel with Tab and Enter, and cancel with Escape before the drawer closes', async ({ page }) => {
    const { browse, field, cancel, calls } = await openSetup(page, {});
    await field.focus();
    await page.keyboard.press('Tab');
    await expect(browse).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(cancel).toBeVisible();
    await expect(browse).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(message(page, text.closed)).toBeVisible();
    await expect(browse).toBeFocused();
    expect(calls.cancels).toHaveLength(1);

    // Escape closes a pending window first; the drawer stays until Escape is pressed again.
    await page.keyboard.press('Enter');
    await expect(cancel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(cancel).toHaveCount(0);
    await expect(message(page, text.closed)).toBeVisible();
    await expect(browse).toBeFocused();
    await expect(page.getByTestId('left-drawer')).toBeVisible();
    expect(calls.starts).toBe(2);
    await expect.poll(() => calls.cancels.length).toBe(2);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('left-drawer')).toBeHidden();
  });

  test('after about ten seconds "Can\'t see it? Type a path" appears, closes the window and focuses the field', async ({ page }) => {
    const { browse, field, cancel, typeInstead, live, calls } = await openSetup(page, {}, { clock: true });
    await browse.click();
    await expect(cancel).toBeVisible();
    await expect(typeInstead).toHaveCount(0);
    await page.clock.runFor(FOLDER_PICK_LIMITS.typePathHintMs - 1_000);
    await expect(typeInstead).toHaveCount(0);
    await page.clock.runFor(1_500);
    await expect(typeInstead).toBeVisible();
    await expect(live.getByText(text.typeHint, { exact: true })).toBeVisible();
    await expect(cancel).toBeVisible();
    await typeInstead.click();
    await expect(field).toBeFocused();
    await expect(live.getByText(text.typeHint, { exact: true })).toHaveCount(0);
    await expect(live.getByText(text.waiting, { exact: true })).toHaveCount(0);
    await expect(typeInstead).toHaveCount(0);
    await expect.poll(() => calls.cancels).toEqual([`${prefix}/folders/pick/${pickId}/cancel`]);
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    // The typed path stays the way forward.
    await field.fill(chosenPath);
    await expect(field).toHaveValue(chosenPath);
  });

  for (const reason of folderPickUnavailableReasons) {
    test(`a window that is unavailable (${reason}) shows one plain sentence and focuses the field`, async ({ page }) => {
      const { browse, field, live, calls } = await openSetup(page, { poll: n => ok(n < 2 ? pick() : pick({ state: 'unavailable', reason })) });
      const announced = await watchAnnouncements(page);
      await browse.click();
      await expect(message(page, unavailableText[reason])).toBeVisible();
      await expect(field).toBeFocused();
      await expect(live.getByText(text.waiting, { exact: true })).toHaveCount(0);
      await expect(browse).toHaveAttribute('aria-busy', 'false');
      // Never the raw code, never jargon.
      await expect(page.getByText(reason, { exact: false })).toHaveCount(0);
      await expect(live).not.toContainText(/helper|spool|hook|producer|attribution|discovery|device flow|powershell/i);
      expect(await announced()).toEqual([text.waiting, unavailableText[reason]]);
      expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.repository-setup').analyze()).violations).toEqual([]);
      expect(calls.cancels).toEqual([]);
    });
  }

  test('a window that is unavailable straight away, or for a reason this page does not know, never shows a raw code', async ({ page }) => {
    let answer: Reply = ok(pick({ state: 'unavailable', reason: 'no-desktop' }));
    const { browse, field, calls } = await openSetup(page, { start: () => answer });
    await browse.click();
    await expect(message(page, unavailableText['no-desktop'])).toBeVisible();
    await expect(field).toBeFocused();
    expect(calls.polls).toBe(0);
    answer = ok({ ...pick({ state: 'unavailable' }), reason: 'a-future-reason' });
    await browse.click();
    await expect(message(page, 'The folder window could not be used. Type or paste the folder path instead.')).toBeVisible();
    await expect(page.getByText('a-future-reason')).toHaveCount(0);
    await expect(field).toBeFocused();
  });

  test('a window that stayed open too long says so and focuses the field', async ({ page }) => {
    const { browse, field, calls } = await openSetup(page, { poll: n => ok(n < 2 ? pick() : pick({ state: 'timed-out' })) });
    const announced = await watchAnnouncements(page);
    await browse.click();
    await expect(message(page, text.timedOut)).toBeVisible();
    await expect(field).toBeFocused();
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    expect(await announced()).toEqual([text.waiting, text.timedOut]);
    expect(calls.cancels).toEqual([]);
    await browse.click();
    await expect(page.locator('.folder-browse-live').getByText(text.waiting, { exact: true })).toBeVisible();
  });

  test('a second click while a window is open starts nothing and says so each time', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { browse, cancel, calls } = await openSetup(page, { start: async () => { await gate; return ok(pick()); } });
    const announced = await watchAnnouncements(page);
    await browse.click();
    await expect(browse).toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => calls.starts).toBe(1);
    await browse.click(); // Still opening: nothing new starts and nothing is announced yet.
    expect(calls.starts).toBe(1);
    release();
    await expect(cancel).toBeVisible();
    await browse.click();
    await expect(message(page, text.alreadyOpen)).toBeVisible();
    await browse.click();
    await expect.poll(async () => (await announced()).filter(value => value === text.alreadyOpen).length).toBe(2);
    expect(calls.starts).toBe(1);
    await expect(browse).toBeFocused();
    expect(await announced()).toEqual([text.waiting, text.alreadyOpen, text.alreadyOpen]);
    await expect(message(page, text.alreadyOpen)).toHaveCount(1);
  });

  test('a start that reports a window already open keeps waiting on that window', async ({ page }) => {
    const { browse, cancel, field, calls } = await openSetup(page, { start: () => ok(pick({ alreadyOpen: true })), poll: n => ok(n < 2 ? pick() : pick({ state: 'selected', path: chosenPath })) });
    await browse.click();
    await expect(message(page, text.alreadyOpen)).toBeVisible();
    await expect(cancel).toBeVisible();
    await expect(browse).toHaveAttribute('aria-busy', 'true');
    expect(calls.starts).toBe(1);
    await expect(field).toHaveValue(chosenPath);
    expect(calls.starts).toBe(1);
    expect(calls.polls).toBeGreaterThanOrEqual(2);
  });

  test('a failed start shows the service\'s plain message beside the field, never a raw code', async ({ page }) => {
    let answer: Reply = { status: 409, body: { code: 'FOLDER_WINDOW_BUSY', message: 'Another folder window is already open. Close it, then try again.' } };
    const { browse, field, cancel, calls } = await openSetup(page, { start: () => answer });
    await browse.click();
    await expect(message(page, 'Another folder window is already open. Close it, then try again.')).toBeVisible();
    await expect(page.getByText('FOLDER_WINDOW_BUSY')).toHaveCount(0);
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    await expect(browse).toBeEnabled();
    await expect(cancel).toHaveCount(0);
    await expect(field).toBeEditable();
    // A server error without its own sentence still gets a plain one.
    answer = { status: 500, body: {} };
    await browse.click();
    await expect(message(page, 'This action could not be completed.')).toBeVisible();
    // The service not answering at all is described in plain words too.
    answer = 'abort';
    await browse.click();
    await expect(message(page, text.lostContact)).toBeVisible();
    expect(calls.starts).toBe(3);
    // The next try clears the old message and works.
    answer = ok(pick());
    await browse.click();
    await expect(cancel).toBeVisible();
    await expect(message(page, text.lostContact)).toHaveCount(0);
  });

  test('a couple of network hiccups are ignored, but lasting silence says contact was lost and closes the window', async ({ page }) => {
    let mode: 'hiccup' | 'silent' = 'hiccup';
    const { browse, field, cancel, calls } = await openSetup(page, { poll: n => mode === 'hiccup' ? (n <= 2 ? 'abort' : ok(pick({ state: 'selected', path: chosenPath }))) : 'abort' });
    await browse.click();
    await expect(field).toHaveValue(chosenPath);
    await expect(message(page, text.chosen)).toBeVisible();
    await expect(page.getByText(text.lostContact)).toHaveCount(0);
    expect(calls.polls).toBe(3);

    mode = 'silent';
    const before = calls.polls;
    await browse.click();
    await expect(message(page, text.lostContact)).toBeVisible();
    await expect(cancel).toHaveCount(0);
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    expect(calls.polls - before).toBe(3);
    await expect.poll(() => calls.cancels.length).toBe(1);
    await expect(field).toHaveValue(chosenPath); // The earlier text is untouched.
  });

  test('a window the service no longer knows ends at once with the lost-contact sentence', async ({ page }) => {
    const { browse, calls } = await openSetup(page, { poll: () => ({ status: 404, body: { code: 'FOLDER_PICK_NOT_FOUND', message: 'That folder window is gone.' } }) });
    await browse.click();
    await expect(message(page, text.lostContact)).toBeVisible();
    expect(calls.polls).toBe(1);
    await expect(page.getByText('FOLDER_PICK_NOT_FOUND')).toHaveCount(0);
  });

  test('leaving the panel while a window is open stops polling and asks for the window to be closed', async ({ page }) => {
    const { browse, cancel, calls } = await openSetup(page, {});
    await browse.click();
    await expect(cancel).toBeVisible();
    await expect.poll(() => calls.polls).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
    await expect(page.getByTestId('left-drawer')).toBeHidden();
    await expect.poll(() => calls.cancels).toEqual([`${prefix}/folders/pick/${pickId}/cancel`]);
    const polls = calls.polls;
    await page.waitForTimeout(FOLDER_PICK_LIMITS.pollMs * 1.6);
    expect(calls.polls).toBe(polls);
  });

  test('stays available while a scan runs (choosing a folder does not touch the scan), unlike Add this project', async ({ page }) => {
    const running = await openSetup(page, { poll: n => ok(n < 2 ? pick() : pick({ state: 'selected', path: chosenPath })) }, { scanRunning: true });
    await expect(running.add).toBeDisabled();
    await expect(running.browse).toBeEnabled();
    await running.browse.click();
    await expect(running.field).toHaveValue(chosenPath);
    expect(running.calls.starts).toBe(1);
    // The path waits in the field; Add says why it cannot be used yet, and nothing was sent to the add route.
    await expect(running.local.getByText('Wait for the current scan, or cancel it below.', { exact: false }).first()).toBeVisible();
    expect(running.calls.roots).toEqual([]);
  });

  test('is unavailable once eight folders are allowed, with the same visible reason as Add this project', async ({ page }) => {
    const roots = Array.from({ length: 8 }, (_, index) => String.raw`C:\fixture-projects\project-${index + 1}`);
    const { browse, add, local } = await openSetup(page, {}, { roots });
    await expect(browse).toBeDisabled();
    await expect(add).toBeDisabled();
    await expect(local.getByText('Eight folders are already allowed.', { exact: false })).toBeVisible();
    const ids = (await browse.getAttribute('aria-describedby'))!.split(' ');
    expect(ids).toHaveLength(2);
  });

  test('adding the typed path while a window is open closes the window quietly and adds only that path', async ({ page }) => {
    const { browse, field, live, calls, local } = await openSetup(page, {});
    const announced = await watchAnnouncements(page);
    await browse.click();
    await expect(live.getByText(text.waiting, { exact: true })).toBeVisible();
    await field.fill(chosenPath);
    await field.press('Enter');
    await expect(local.getByRole('heading', { name: 'Folders Agent Town may look in · 1/8' })).toBeVisible();
    expect(calls.roots).toEqual([{ path: chosenPath }]);
    await expect.poll(() => calls.cancels).toEqual([`${prefix}/folders/pick/${pickId}/cancel`]);
    // The person carried on, so no "closed" or "chosen" sentence, and nothing is left waiting.
    await expect(live).toHaveText('');
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    await expect(local.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    expect(await announced()).toEqual([text.waiting]);
    const polls = calls.polls;
    await page.waitForTimeout(FOLDER_PICK_LIMITS.pollMs * 1.6);
    expect(calls.polls).toBe(polls);
  });

  test('a slow answer that arrives after Cancel is ignored: the field stays empty and nothing more is announced', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { browse, cancel, field, calls } = await openSetup(page, { poll: async n => { if (n < 2) return ok(pick()); await gate; return ok(pick({ state: 'selected', path: chosenPath })); } });
    const announced = await watchAnnouncements(page);
    await browse.click();
    await expect.poll(() => calls.polls).toBe(2); // The second poll is now held.
    await cancel.click();
    await expect(message(page, text.closed)).toBeVisible();
    release();
    await page.waitForTimeout(500);
    await expect(field).toHaveValue('');
    await expect(browse).toBeFocused();
    expect(await announced()).toEqual([text.waiting, text.closed]);
  });

  test('leaving while the window is still opening closes the window that then appears', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { browse, field, calls } = await openSetup(page, { start: async () => { await gate; return ok(pick()); } });
    await browse.click();
    await expect.poll(() => calls.starts).toBe(1);
    await page.keyboard.press('Escape'); // Closes the pending window first, not the drawer.
    await expect(message(page, text.closed)).toBeVisible();
    await expect(browse).toBeFocused();
    await expect(page.getByTestId('left-drawer')).toBeVisible();
    release();
    await expect.poll(() => calls.cancels).toEqual([`${prefix}/folders/pick/${pickId}/cancel`]);
    expect(calls.polls).toBe(0);
    await expect(field).toHaveValue('');
    await expect(browse).toHaveAttribute('aria-busy', 'false');
  });

  test('a late "already open" answer after leaving closes nothing, because this click did not open that window', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { browse, calls } = await openSetup(page, { start: async () => { await gate; return ok(pick({ alreadyOpen: true })); } });
    await browse.click();
    await expect.poll(() => calls.starts).toBe(1);
    await page.keyboard.press('Escape');
    await expect(message(page, text.closed)).toBeVisible();
    release();
    await page.waitForTimeout(500);
    expect(calls.cancels).toEqual([]);
    expect(calls.polls).toBe(0);
  });

  test('a slow start says the window is opening and offers Cancel, without claiming it is open', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { browse, cancel, live, calls } = await openSetup(page, { start: async () => { await gate; return ok(pick()); } }, { clock: true });
    await browse.click();
    await expect.poll(() => calls.starts).toBe(1);
    await expect(live.getByText(text.opening, { exact: true })).toHaveCount(0); // Quick starts stay quiet.
    await page.clock.runFor(1_200);
    await expect(live.getByText(text.opening, { exact: true })).toBeVisible();
    await expect(cancel).toBeVisible();
    await expect(live.getByText(text.waiting, { exact: true })).toHaveCount(0);
    release();
    await expect(live.getByText(text.waiting, { exact: true })).toBeVisible();
    await expect(live.getByText(text.opening, { exact: true })).toHaveCount(0);
    await expect(cancel).toBeVisible();
  });

  test('Cancel during a slow start ends the wait, and the window that then appears is closed', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { browse, cancel, calls } = await openSetup(page, { start: async () => { await gate; return ok(pick()); } }, { clock: true });
    await browse.click();
    await expect.poll(() => calls.starts).toBe(1);
    await page.clock.runFor(1_200);
    await cancel.click();
    await expect(message(page, text.closed)).toBeVisible();
    await expect(browse).toBeFocused();
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    release();
    await expect.poll(() => calls.cancels).toEqual([`${prefix}/folders/pick/${pickId}/cancel`]);
  });

  test('a chosen folder replaces text already in the field, and typing afterwards dismisses the "chosen" sentence', async ({ page }) => {
    const { browse, field } = await openSetup(page, { poll: n => ok(n < 2 ? pick() : pick({ state: 'selected', path: chosenPath })) });
    await field.fill(String.raw`C:\older-text`);
    await browse.click();
    await expect(field).toHaveValue(chosenPath);
    await expect(message(page, text.chosen)).toBeVisible();
    await field.pressSequentially('x');
    await expect(field).toHaveValue(`${chosenPath}x`);
    await expect(message(page, text.chosen)).toHaveCount(0);
  });

  test('a problem is tied to the field that gets focus, so a screen reader reads it with the field', async ({ page }) => {
    const { browse, field } = await openSetup(page, { poll: n => ok(n < 2 ? pick() : pick({ state: 'unavailable', reason: 'no-desktop' })) });
    await browse.click();
    await expect(message(page, unavailableText['no-desktop'])).toBeVisible();
    await expect(field).toBeFocused();
    const ids = (await field.getAttribute('aria-describedby'))!.split(' ');
    expect(ids).toHaveLength(2);
    const described = await Promise.all(ids.map(id => page.locator(`[id="${id}"]`).innerText()));
    expect(described.join(' ')).toContain(unavailableText['no-desktop']);
  });

  test('if the service never hears Cancel, the page says the window will still close by itself', async ({ page }) => {
    const { browse, cancel, calls } = await openSetup(page, { cancel: () => 'abort' });
    await browse.click();
    await cancel.click();
    await expect(message(page, text.closeUnconfirmed)).toBeVisible();
    await expect(message(page, text.closed)).toHaveCount(0);
    await expect(browse).toHaveAttribute('aria-busy', 'false');
    expect(calls.cancels).toHaveLength(1);
  });

  test('Browse straight after Cancel waits for the Cancel to reach the service, so the old window is never adopted', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { browse, cancel, calls } = await openSetup(page, { cancel: async () => { await gate; return ok(pick({ state: 'cancelled' })); } });
    await browse.click();
    await cancel.click();
    await expect(message(page, text.closed)).toBeVisible();
    await browse.click();
    await page.waitForTimeout(500);
    expect(calls.starts).toBe(1); // Held back until the Cancel is delivered.
    release();
    await expect.poll(() => calls.starts).toBe(2);
    await expect(browse).toHaveAttribute('aria-busy', 'true');
  });

  test('passes an accessibility scan while the waiting message is showing', async ({ page }) => {
    const { browse, cancel } = await openSetup(page, {});
    await browse.click();
    await expect(cancel).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).include('.repository-setup').analyze();
    expect(results.violations).toEqual([]);
    expect(results.passes.length).toBeGreaterThan(0);
  });

  test('fits a 320 px window: the button is fully visible, nothing scrolls sideways and the field keeps room', async ({ page }) => {
    const { browse, field, cancel, typeInstead, live } = await openSetup(page, {}, { viewport: { width: 320, height: 720 }, clock: true });
    await expect(browse).toBeVisible();
    await expectFits(page, [field, browse]);
    const fieldBox = (await field.boundingBox())!, browseBox = (await browse.boundingBox())!;
    expect(fieldBox.width, 'the path field keeps room to type').toBeGreaterThanOrEqual(200);
    // Too narrow for both side by side: the button sits on its own line under the field.
    if (fieldBox.width + browseBox.width + 8 > (await page.locator('dialog[open] .drawer-content').boundingBox())!.width) expect(browseBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height - 1);
    await browse.click();
    await expect(cancel).toBeVisible();
    await page.clock.runFor(FOLDER_PICK_LIMITS.typePathHintMs + 500);
    await expect(typeInstead).toBeVisible();
    await expectFits(page, [field, browse, cancel, typeInstead, live.getByText(text.waiting, { exact: true })]);
    await typeInstead.click();
    await expect(message(page, text.closed)).toBeVisible();
    await expectFits(page, [field, browse, live.getByText(text.closed, { exact: true })]);
    // The longest sentence must also stay inside the drawer.
    await field.fill(String.raw`C:\a-very-long-fixture-folder-name\with-many-nested-parts\that-would-otherwise-run-far-past-the-edge`);
    await expectFits(page, [field, browse]);
  });

  test('uses text of at least 12 px and touch targets of at least 24 px (44 px for touch) on every new control', async ({ page }, testInfo) => {
    const { browse, cancel, typeInstead, live, local } = await openSetup(page, {}, { clock: true });
    const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
    if (testInfo.project.name === 'mobile') expect(coarse, 'the touch rule is only proven if the phone project is coarse').toBe(true);
    const minimum = coarse ? 44 : 24;
    const measure = async (locator: Locator) => locator.evaluate(element => { const box = element.getBoundingClientRect(); return { font: parseFloat(getComputedStyle(element).fontSize), height: box.height, width: box.width }; });
    const hint = local.getByText(text.hint, { exact: true });
    await expect(hint).toBeVisible();
    expect((await measure(hint)).font).toBeGreaterThanOrEqual(12);
    await browse.click();
    await expect(cancel).toBeVisible();
    await page.clock.runFor(FOLDER_PICK_LIMITS.typePathHintMs + 500);
    await expect(typeInstead).toBeVisible();
    for (const [name, locator] of [['Browse...', browse], ['Cancel', cancel], ['Type a path', typeInstead]] as const) {
      const size = await measure(locator);
      expect(size.font, `${name} text size`).toBeGreaterThanOrEqual(12);
      expect(size.height, `${name} target height`).toBeGreaterThanOrEqual(minimum);
      expect(size.width, `${name} target width`).toBeGreaterThanOrEqual(minimum);
    }
    expect((await measure(live.getByText(text.waiting, { exact: true }))).font).toBeGreaterThanOrEqual(12);
    await typeInstead.click();
    const closed = message(page, text.closed);
    await expect(closed).toBeVisible();
    expect((await measure(closed)).font).toBeGreaterThanOrEqual(12);
  });
});
