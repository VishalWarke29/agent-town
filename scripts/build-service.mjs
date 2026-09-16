import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = createHash('sha256');
async function hashSources(directory) {
  for (const item of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) await hashSources(path);
    else if (item.isFile()) { hash.update(path); hash.update(await readFile(join(root, path))); }
  }
}
for (const directory of ['apps/web/src', 'apps/web/public', 'apps/service/src', 'apps/service/drizzle', 'packages/contracts/src']) await hashSources(directory);
for (const file of ['run.ps1', 'package.json', 'package-lock.json', 'apps/web/package.json', 'apps/web/index.html', 'apps/web/vite.config.ts', 'apps/service/package.json', 'packages/contracts/package.json', 'scripts/build-service.mjs', 'scripts/runtime-config.mjs', 'scripts/dev.mjs', 'scripts/dev-service.mjs']) { hash.update(file); hash.update(await readFile(join(root, file))); }
const webHtml = await readFile(join(root, 'apps/web/dist/index.html'), 'utf8').catch(() => '');
const buildInfo = { id: hash.digest('hex').slice(0, 12), builtAt: new Date().toISOString(), webEntry: webHtml.match(/src="([^"]+\.js)"/)?.[1] ?? null };
await writeFile(join(root, 'apps/web/dist/agent-town-build.json'), JSON.stringify(buildInfo));
await build({
  entryPoints: [`${root}/apps/service/src/index.ts`],
  outfile: `${root}/apps/service/dist/index.js`,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external',
  alias: { '@agent-town/contracts': `${root}/packages/contracts/src/index.ts` },
  define: { __AGENT_TOWN_BUILD__: JSON.stringify(buildInfo) },
});
await build({
  entryPoints: [`${root}/apps/service/src/observation/bridge.ts`],
  outfile: `${root}/apps/service/dist/hook-bridge.cjs`,
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', packages: 'external',
  alias: { '@agent-town/contracts': `${root}/packages/contracts/src/index.ts` },
});
await copyFile(`${root}/apps/service/src/runner/claude-worker.mjs`, `${root}/apps/service/dist/claude-worker.mjs`);
await copyFile(`${root}/apps/service/src/native-discovery/metadata-worker.mjs`, `${root}/apps/service/dist/metadata-worker.mjs`);
await build({
  entryPoints: [`${root}/apps/service/src/ops/cli.ts`],
  outfile: `${root}/apps/service/dist/ops.js`,
  bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external',
  alias: { '@agent-town/contracts': `${root}/packages/contracts/src/index.ts` },
});
