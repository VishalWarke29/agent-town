import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';

test('the world fills the viewport and drawers overlay the same canvas', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const remoteRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') remoteRequests.push(request.url()); });
  await page.goto('/?preview=1');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('button', { name: 'Web studio', exact: true })).toBeVisible();
  await expect(page.getByTestId('left-drawer')).toHaveCount(0);
  await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  const before = await canvas.boundingBox();
  expect(before?.width).toBe(page.viewportSize()!.width);
  expect(before?.height).toBe(page.viewportSize()!.height);
  const handle = await canvas.elementHandle();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await expect(page.getByTestId('left-drawer')).toBeVisible();
  await page.getByRole('button', { name: /Milo.*Claude/ }).click();
  await expect(page.getByTestId('right-drawer')).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(before);
  expect(await canvas.evaluate((node, old) => node === old, handle)).toBe(true);
  if (testInfo.project.name === 'mobile') await expect(page.getByTestId('left-drawer')).toHaveCount(0);
  else await expect(page.getByTestId('left-drawer')).toBeVisible();
  mkdirSync('docs/assets/previews', { recursive: true });
  await page.screenshot({ path: `docs/assets/previews/${testInfo.project.name}-agent.png`, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('right-drawer')).toHaveCount(0);
  if (testInfo.project.name === 'desktop') await page.keyboard.press('Escape');
  await page.screenshot({ path: `docs/assets/previews/${testInfo.project.name}-world.png`, animations: 'disabled' });
  expect(errors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('a saved report reaches the manager and survives refresh', async ({ page }, testInfo) => {
  await page.goto('/?preview=1');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByRole('button', { name: /Milo.*Claude/ }).click();
  const character = page.locator('.agent-label').filter({ hasText: 'Milo' });
  await expect(character).toBeVisible();
  const start = await character.boundingBox();
  await page.getByRole('button', { name: 'Send sample report', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report saved · manager pending', exact: true })).toBeDisabled();
  await expect.poll(async () => { const next = await character.boundingBox(); return Math.hypot((next?.x ?? 0) - start!.x, (next?.y ?? 0) - start!.y); }).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Visit the manager', exact: true }).click();
  await expect(page.getByText('Milo’s report', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Update sample brief', exact: true }).click();
  await expect(page.getByText(/Added to sample brief v/).first()).toBeVisible();
  await expect(page.getByText('Context delivery: not connected', { exact: true }).first()).toBeVisible();
  const version = await page.locator('.version').innerText();
  await page.reload();
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open manager', exact: true }).click();
  await expect(page.locator('.version')).toHaveText(version);
  await expect(page.locator('.brief-text')).toContainText('Milo:');
  await page.screenshot({ path: `docs/assets/previews/${testInfo.project.name}-manager.png`, animations: 'disabled' });
});

test('list view and display preferences work without launching agents', async ({ page }) => {
  await page.goto('/?preview=1');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.locator('.sample-tag')).toHaveText('Sample data');
  await expect(page.getByRole('navigation', { name: 'Town navigation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'List view navigation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await expect(page.getByTestId('left-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open connections', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Inspect Nova', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('Backend engineer');
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.getByRole('button', { name: 'Show world', exact: true }).click();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('checkbox', { name: /Reduced motion/ }).check();
  await page.getByRole('checkbox', { name: /Opaque panels/ }).check();
  await expect(page.locator('main')).toHaveClass(/opaque/);
  await page.reload();
  await expect(page.locator('main')).toHaveClass(/reduce-motion/);
  await expect(page.locator('main')).toHaveClass(/opaque/);
});

test('billing toggle is an honest setup preview', async ({ page }) => {
  await page.goto('/?preview=1');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await page.getByRole('button', { name: 'API credits', exact: true }).click();
  await expect(page.getByRole('button', { name: 'API credits', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Not connected', { exact: true })).toHaveCount(4);
  await page.getByRole('button', { name: 'Usage', exact: true }).click();
  await expect(page.getByText('This preview makes no AI requests', { exact: true })).toBeVisible();
});

test('browser reconnect restores persisted activity after a network interruption', async ({ page, context }) => {
  await page.goto('/?preview=1');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run demo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause demo', exact: true })).toBeEnabled();
  await context.setOffline(true);
  await expect(page.getByText('Reconnecting · showing last saved state', { exact: true })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause demo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run demo', exact: true })).toBeEnabled();
});

test('opaque drawers and the accessible list pass automated accessibility checks', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('agent-town-opaque-panels', 'true'));
  await page.goto('/?preview=1');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByRole('button', { name: /Milo.*Claude/ }).click();
  await expect(page.getByTestId('right-drawer')).toBeVisible();
  const scan = async () => {
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(results.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  };
  await scan();
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Close details', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('right-drawer').locator(':focus')).toHaveCount(1);
  }
  await page.keyboard.press('Escape');
  if (testInfo.project.name === 'desktop') await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await scan();
});

test('WebGL unavailability opens a usable list instead of a broken world', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === 'webgl' || type === 'webgl2') return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as typeof original;
  });
  await page.goto('/?preview=1');
  await expect(page.getByText('The 3D world is unavailable in this browser. All available actions are accessible here.', { exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Town navigation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'List view navigation', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('accessible-list-navigation.png') });
  await page.getByRole('button', { name: 'Open connections', exact: true }).click();
  await expect(page.getByTestId('left-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open connections', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Inspect Nova', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('Backend engineer');
  await expect(page.getByRole('button', { name: 'Follow this agent', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(page.getByRole('button', { name: '3D world unavailable; List view active', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'List view active · 3D unavailable', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Inspect Milo', exact: true }).click();
  await expect(page.getByTestId('right-drawer')).toContainText('Frontend engineer');
  expect(errors).toEqual([]);
});

test('mobile drawers isolate the background and restore desktop interaction on resize', async ({ page }) => {
  await page.goto('/?preview=1');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  const canvas = await page.locator('canvas').elementHandle();
  await page.setViewportSize({ width: 390, height: 844 });
  const listButton = page.locator('button[aria-label="Show list view"]');
  const buttonBox = await listButton.boundingBox();
  await page.getByRole('button', { name: 'Open manager', exact: true }).click();
  const drawer = page.getByTestId('right-drawer');
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect.poll(() => drawer.evaluate(node => node.matches(':modal'))).toBe(true);
  await listButton.evaluate((button: HTMLButtonElement) => button.focus());
  await expect(drawer.locator(':focus')).toHaveCount(1);
  await page.mouse.click(buttonBox!.x + buttonBox!.width / 2, buttonBox!.y + buttonBox!.height / 2);
  await expect(page.locator('.list-view')).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await page.getByRole('button', { name: 'Close details', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(drawer.locator(':focus')).toHaveCount(1);

  await page.setViewportSize({ width: 1200, height: 844 });
  await expect.poll(() => drawer.evaluate(node => node.matches(':modal'))).toBe(false);
  await page.getByRole('button', { name: 'Show list view', exact: true }).click();
  await expect(page.locator('.list-view table')).toBeVisible();
  await expect(page.locator('.list-view')).toHaveAttribute('inert', '');
  await page.getByRole('button', { name: 'Show world', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => drawer.evaluate(node => node.matches(':modal'))).toBe(true);
  await expect(drawer.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open manager', exact: true })).toBeFocused();
  expect(await page.locator('canvas').evaluate((node, old) => node === old, canvas)).toBe(true);
});

test('a failed sample action remains readable and dismissible inside the active drawer', async ({ page }) => {
  await page.route('**/api/v1/workspaces/demo-town/demo/commands', route => route.fulfill({ status: 503, json: { message: 'Fixture storage temporarily unavailable.' } }));
  await page.goto('/?preview=1');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open agents', exact: true }).click();
  await page.getByRole('button', { name: /Nova.*Codex/ }).click();
  await page.getByRole('button', { name: 'Send sample report', exact: true }).click();
  const drawer = page.getByTestId('right-drawer');
  await expect(drawer.getByRole('alert')).toHaveText('Fixture storage temporarily unavailable.');
  await drawer.getByRole('button', { name: 'Dismiss message', exact: true }).click();
  await expect(drawer.getByRole('alert')).toHaveCount(0);
  await expect(drawer).toBeVisible();
});

// UX-05 (RV-5): below 900px the old pill lost its only sample-town label (.footer-separator and
// .preview-badge both disappear there, see styles.css), so a narrow sample town looked identical to a real,
// private one once the intro closed. The pill's own text now carries "Sample town" at every width; the top
// bar (a separate fixed bar above the footer) must not grow past its usual one-row height picking it up.
test('the sample-town pill keeps its label at 320, 390 and 560px, and the top bar does not wrap', async ({ page }) => {
  await page.goto('/?preview=1');
  const pill = page.getByText('Sample town · local service connected', { exact: true });
  await expect(pill).toBeVisible();
  for (const width of [320, 390, 560]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(pill).toBeVisible();
    const topbarBox = await page.locator('.topbar').boundingBox();
    const pillBox = await pill.boundingBox();
    expect(topbarBox).not.toBeNull();
    expect(pillBox).not.toBeNull();
    // A wrapped top bar would grow tall enough to reach into the footer's own space; the pill (fixed to
    // the bottom of the viewport) staying below where the top bar ends proves the top bar held one row.
    expect(topbarBox!.y + topbarBox!.height).toBeLessThan(pillBox!.y);
    expect(pillBox!.x).toBeGreaterThanOrEqual(0);
    expect(pillBox!.x + pillBox!.width).toBeLessThanOrEqual(width);
  }
});

// UX-05 (Gap 8): usePreference read matchMedia only once at mount, so an OS reduced-motion change made
// while the tab stayed open was never seen. It must now track the OS live, and an explicit in-app choice
// must then keep winning over a later OS flip.
test('reduced motion follows a live OS change, and the in-app toggle then wins', async ({ page }) => {
  await page.goto('/?preview=1');
  const main = page.locator('main');
  await expect(page.getByText('Sample town · local service connected', { exact: true })).toBeVisible();
  await expect(main).not.toHaveClass(/reduce-motion/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(main).toHaveClass(/reduce-motion/);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(main).not.toHaveClass(/reduce-motion/);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('checkbox', { name: /Reduced motion/ }).check();
  await expect(main).toHaveClass(/reduce-motion/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('checkbox', { name: /Reduced motion/ }).uncheck();
  await expect(main).not.toHaveClass(/reduce-motion/);
  // The explicit choice above keeps winning over a later OS flip, until it is changed again in-app.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(main).not.toHaveClass(/reduce-motion/);
});
