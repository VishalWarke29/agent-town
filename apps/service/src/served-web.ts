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
