import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Inspect current served files; the running backend may predate a web rebuild. */
export async function servedWebBuild(directory: string): Promise<{ entry: string | null; buildId: string | null; builtAt: string | null }> {
  try {
    const html = await readFile(join(directory, 'index.html'), 'utf8');
    const entry = html.match(/src="([^"\s]+\.js)"/)?.[1] ?? null;
    let buildId: string | null = null, builtAt: string | null = null;
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'agent-town-build.json'), 'utf8')) as { id?: unknown; builtAt?: unknown; webEntry?: unknown };
      if (entry && manifest.webEntry === entry && typeof manifest.id === 'string' && /^[a-f0-9]{12}$/.test(manifest.id)
        && typeof manifest.builtAt === 'string' && Number.isFinite(Date.parse(manifest.builtAt))) { buildId = manifest.id; builtAt = manifest.builtAt; }
    } catch { /* A Vite-only rebuild has no matching service build identity. */ }
    return { entry, buildId, builtAt };
  } catch { return { entry: null, buildId: null, builtAt: null }; }
}

/** Inspect the built hook bridge's own build manifest (written atomically alongside it by
 * scripts/build-service.mjs — see WS3-24); the running service may predate a later rebuild that
 * already swapped the bridge on disk out from under it. */
export async function bridgeBuild(directory: string): Promise<{ buildId: string | null; builtAt: string | null }> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'hook-bridge-build.json'), 'utf8')) as { id?: unknown; builtAt?: unknown };
    if (typeof manifest.id === 'string' && /^[a-f0-9]{12}$/.test(manifest.id) && typeof manifest.builtAt === 'string' && Number.isFinite(Date.parse(manifest.builtAt))) {
      return { buildId: manifest.id, builtAt: manifest.builtAt };
    }
    return { buildId: null, builtAt: null };
  } catch { return { buildId: null, builtAt: null }; }
}

/** True only when the bridge on disk was stamped by a genuinely different build than the one this
 * service process is running — never when its manifest is simply absent or unreadable (a plain
 * `npx tsc`-only checkout, or a build predating WS3-24, reads as "unknown," not "mismatched"), and
 * never in development, whose own bridge invocation runs straight from source with no build step in
 * between to skew. */
export function bridgeRebuiltSinceStart(bridge: { buildId: string | null }, runningBuildId: string, development: boolean): boolean {
  return !development && bridge.buildId !== null && bridge.buildId !== runningBuildId;
}
