import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeApplicationMode, readRuntimeConfig, runtimeDataPaths } from '../../scripts/runtime-config.mjs';
import { developmentServerOptions } from '../../apps/web/vite.config.js';

const roots: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'agent-town-config-')); roots.push(path); return path; };
const resolverFixture = () => {
  const root = temporary(); mkdirSync(join(root, 'scripts'));
  for (const name of ['resolve-mode.mjs', 'runtime-config.mjs']) copyFileSync(resolve('scripts', name), join(root, 'scripts', name));
  return root;
};
afterEach(() => {
  for (const path of roots.splice(0)) {
    if (!resolve(path).startsWith(`${resolve(tmpdir())}${sep}agent-town-config-`)) throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});

describe('application environment configuration', () => {
  it('keeps custom development web, proxy and HMR ports consistent without rewriting the browser origin', () => {
    expect(developmentServerOptions({})).toMatchObject({ host: '127.0.0.1', port: 5173, strictPort: true,
      ws: { host: '127.0.0.1', clientPort: 5173 }, proxy: { '/api': { target: 'http://127.0.0.1:4310', changeOrigin: false } } });
    expect(developmentServerOptions({ AGENT_TOWN_PORT: '54321', AGENT_TOWN_WEB_PORT: '54322' })).toMatchObject({
      port: 54322, ws: { clientPort: 54322 }, proxy: { '/api': { target: 'http://127.0.0.1:54321', changeOrigin: false } },
    });
    for (const name of ['AGENT_TOWN_PORT', 'AGENT_TOWN_WEB_PORT']) {
      for (const value of ['', '1023', '65536', '1e4', '1234.5', ' 54321', 'private-invalid-value']) {
        expect(() => developmentServerOptions({ [name]: value })).toThrow(`${name} must be an integer between 1024 and 65535.`);
      }
    }
    expect(() => developmentServerOptions({ AGENT_TOWN_PORT: '54321', AGENT_TOWN_WEB_PORT: '54321' })).toThrow('must be different');
  });

  it('keeps app mode independent from Node bundling mode and accepts the prod alias', () => {
    const projectDirectory = temporary();
    for (const NODE_ENV of ['development', 'production', 'test']) {
      expect(readRuntimeConfig({ projectDirectory, env: { NODE_ENV } })).toEqual({ mode: 'development', modeSource: 'default', githubClientId: '' });
    }
    expect(normalizeApplicationMode('prod')).toBe('production');
    expect(normalizeApplicationMode('DEMO')).toBe('demo');
  });

  it('uses environment overrides over validated public configuration without mutating the file', () => {
    const projectDirectory = temporary(), path = join(projectDirectory, 'agent-town.config.json');
    const original = JSON.stringify({ mode: 'demo', githubClientId: 'configured-public-id' }); writeFileSync(path, original);
    expect(readRuntimeConfig({ projectDirectory, env: {} })).toEqual({ mode: 'demo', modeSource: 'configuration', githubClientId: 'configured-public-id' });
    expect(readRuntimeConfig({ projectDirectory, env: { AGENT_TOWN_MODE: 'prod', AGENT_TOWN_GITHUB_CLIENT_ID: 'overridden-public-id' } })).toEqual({ mode: 'production', modeSource: 'environment', githubClientId: 'overridden-public-id' });
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('launcher preflight identifies the saved or overridden ID source outside the project directory without printing IDs', async () => {
    const root = resolverFixture(), path = join(root, 'agent-town.config.json');
    const savedId = 'saved-fixture-public-id', overrideId = 'override-fixture-public-id';
    const original = JSON.stringify({ mode: 'development', githubClientId: savedId }); writeFileSync(path, original);
    for (const override of [undefined, overrideId]) {
      const result = await promisify(execFile)(process.execPath, [join(root, 'scripts', 'resolve-mode.mjs')], {
        cwd: tmpdir(), windowsHide: true, timeout: 5000, env: { ...process.env, AGENT_TOWN_MODE: undefined, AGENT_TOWN_GITHUB_CLIENT_ID: override },
      });
      expect(JSON.parse(result.stdout)).toEqual({ mode: 'development', modeSource: 'configuration', githubConfigured: true, githubSource: override ? 'environment' : 'configuration' });
      expect(result.stdout + result.stderr).not.toContain(savedId); expect(result.stdout + result.stderr).not.toContain(overrideId);
    }
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('launcher preflight rejects an empty environment override instead of masking a saved ID', async () => {
    const root = resolverFixture(), path = join(root, 'agent-town.config.json');
    const original = JSON.stringify({ githubClientId: 'saved-fixture-public-id' }); writeFileSync(path, original);
    await expect(promisify(execFile)(process.execPath, [join(root, 'scripts', 'resolve-mode.mjs')], {
      cwd: tmpdir(), windowsHide: true, timeout: 5000, env: { ...process.env, AGENT_TOWN_MODE: undefined, AGENT_TOWN_GITHUB_CLIENT_ID: '' },
    })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('is set but empty and overrides agent-town.config.json') });
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('rejects invalid modes, unknown secret fields, malformed and oversized files without echoing their values', () => {
    const projectDirectory = temporary(), path = join(projectDirectory, 'agent-town.config.json'), marker = 'PRIVATE_CONFIGURATION_MARKER';
    for (const contents of [JSON.stringify({ mode: marker }), JSON.stringify({ apiKey: marker }), '{', ' '.repeat(4097)]) {
      writeFileSync(path, contents);
      let failure: unknown;
      try { readRuntimeConfig({ projectDirectory, env: {} }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error); expect((failure as Error).message).not.toContain(marker);
    }
    writeFileSync(path, '{}');
    for (const value of ['', 'staging', marker]) expect(() => readRuntimeConfig({ projectDirectory, env: { AGENT_TOWN_MODE: value } })).toThrow('Application mode must be');
  });

  it('preserves legacy development paths and isolates demo/production under a custom data base', () => {
    const projectDirectory = temporary(), base = join(projectDirectory, 'existing-data');
    mkdirSync(join(base, 'private'), { recursive: true }); writeFileSync(join(base, 'private', 'preserved.txt'), 'existing private state');
    const options = { projectDirectory, env: { AGENT_TOWN_DATA_DIR: base } };
    expect(runtimeDataPaths('development', options)).toEqual({ directory: base, privateDirectory: join(base, 'private'), database: join(base, 'preview.sqlite') });
    for (const mode of ['demo', 'production'] as const) {
      expect(runtimeDataPaths(mode, options)).toEqual({ directory: join(base, mode), privateDirectory: join(base, mode, 'private'), database: join(base, mode, 'preview.sqlite') });
      expect(existsSync(join(base, mode))).toBe(false);
    }
    expect(readFileSync(join(base, 'private', 'preserved.txt'), 'utf8')).toBe('existing private state');
    expect(readdirSync(base)).toEqual(['private']);
  });

  it('direct development startup rejects production and the private worker rejects missing IPC before creating data', async () => {
    const base = temporary();
    await expect(promisify(execFile)(process.execPath, ['scripts/dev.mjs'], {
      cwd: process.cwd(), windowsHide: true, timeout: 10000, env: { ...process.env, AGENT_TOWN_MODE: 'production', AGENT_TOWN_DATA_DIR: base },
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Hot reload cannot use production mode') });
    await expect(promisify(execFile)(process.execPath, ['scripts/dev-service.mjs'], {
      cwd: process.cwd(), windowsHide: true, timeout: 5000, env: { ...process.env, AGENT_TOWN_MODE: 'development', AGENT_TOWN_DATA_DIR: base },
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Start the development service through run.ps1 -Dev') });
    expect(readdirSync(base)).toEqual([]);
  });

  it('keeps Windows development profiles and production profiles separate while demo needs no private profile', () => {
    const projectDirectory = temporary(), profile = join(projectDirectory, 'profile'), options = { projectDirectory, env: { LOCALAPPDATA: profile }, platform: 'win32' as const };
    expect(runtimeDataPaths('development', options).privateDirectory).toBe(join(profile, 'AgentTown'));
    expect(runtimeDataPaths('production', options).privateDirectory).toBe(join(profile, 'AgentTown', 'production'));
    expect(runtimeDataPaths('demo', { projectDirectory, env: {}, platform: 'linux' }).privateDirectory).toBe(join(projectDirectory, '.data', 'demo', 'private'));
    expect(() => runtimeDataPaths('production', { projectDirectory, env: {}, platform: 'linux' })).toThrow('Private workspace storage');
    expect(() => runtimeDataPaths('development', { projectDirectory, env: { AGENT_TOWN_DATA_DIR: '' } })).toThrow('AGENT_TOWN_DATA_DIR');
    expect(readdirSync(projectDirectory)).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('launcher Environment alias overrides inherited mode and Doctor leaves the selected data untouched', async () => {
    const base = temporary();
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'run.ps1', '-Environment', 'prod', '-Doctor', '-Port', '65520'], {
      cwd: process.cwd(), windowsHide: true, timeout: 20000, env: { ...process.env, AGENT_TOWN_MODE: 'demo', AGENT_TOWN_DATA_DIR: base },
    });
    expect(result.stdout).toContain('Application mode: production');
    expect(result.stdout).toContain('Separate production data; loopback only');
    expect(result.stdout).not.toContain(base); expect(readdirSync(base)).toEqual([]);
  }, 25000);

  it.skipIf(process.platform !== 'win32')('launcher rejects production hot reload before dependency installation or data creation', async () => {
    const base = temporary(), stampPath = 'node_modules/.agent-town-lock', stamp = existsSync(stampPath) ? readFileSync(stampPath) : null;
    await expect(promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'run.ps1', '-Mode', 'production', '-Dev'], {
      cwd: process.cwd(), windowsHide: true, timeout: 10000, env: { ...process.env, AGENT_TOWN_DATA_DIR: base },
    })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('-Dev enables hot reload and cannot be combined with production mode') });
    expect(existsSync(stampPath) ? readFileSync(stampPath) : null).toEqual(stamp); expect(readdirSync(base)).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('occupied-port startup explains the existing instance and preserves dependencies and private data', async () => {
    const base = temporary(), stampPath = 'node_modules/.agent-town-lock', stamp = existsSync(stampPath) ? readFileSync(stampPath) : null;
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port');
      const clientId = 'fixture-launcher-public-id';
      let failure: unknown;
      try {
        await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('run.ps1'), '-Mode', 'development', '-NoBuild', '-Port', String(address.port), '-GitHubClientId', clientId], {
          cwd: tmpdir(), windowsHide: true, timeout: 10000, env: { ...process.env, AGENT_TOWN_DATA_DIR: base },
        });
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 1, stdout: expect.stringContaining('press Ctrl+C in its existing terminal') });
      const output = (failure as { stdout: string }).stdout;
      expect(output).toContain('public Client ID loaded from -GitHubClientId option');
      expect(output).toContain('a separate AGENT_TOWN_DATA_DIR');
      expect(output).not.toContain(clientId); expect(output).not.toContain('Installing locked project dependencies');
      expect(existsSync(stampPath) ? readFileSync(stampPath) : null).toEqual(stamp); expect(readdirSync(base)).toEqual([]);
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it.skipIf(process.platform !== 'win32')('custom development web-port conflicts fail before installation or private data creation', async () => {
    const base = temporary(), server = createServer(), reservation = createServer();
    const stampPath = 'node_modules/.agent-town-lock', stamp = existsSync(stampPath) ? readFileSync(stampPath) : null;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const web = server.address(), service = reservation.address();
    if (!web || typeof web === 'string' || !service || typeof service === 'string') throw new Error('Fixture ports unavailable');
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    try {
      await expect(promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'run.ps1', '-Mode', 'development', '-Dev', '-Port', String(service.port), '-WebPort', String(web.port)], {
        cwd: process.cwd(), windowsHide: true, timeout: 10000, env: { ...process.env, AGENT_TOWN_DATA_DIR: base },
      })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(`Port ${web.port} is already in use`) });
      expect(existsSync(stampPath) ? readFileSync(stampPath) : null).toEqual(stamp); expect(readdirSync(base)).toEqual([]);
      expect(server.listening).toBe(true);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it.skipIf(process.platform !== 'win32')('rejects ambiguous or irrelevant development ports before creating data', async () => {
    const base = temporary();
    for (const [args, message] of [
      [['-Dev', '-Port', '54321', '-WebPort', '54321'], 'Development service and web ports must be different'],
      [['-WebPort', '54322'], '-WebPort applies only with -Dev'],
    ] as const) {
      await expect(promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'run.ps1', ...args], {
        cwd: process.cwd(), windowsHide: true, timeout: 10000, env: { ...process.env, AGENT_TOWN_DATA_DIR: base },
      })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining(message) });
    }
    expect(readdirSync(base)).toEqual([]);
  });
});
