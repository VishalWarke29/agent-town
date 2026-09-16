import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// A real watcher/module-graph/HTTP/WebSocket smoke. It deliberately does not
// execute browser JavaScript or claim React refresh/state-preservation evidence.
class SmokeError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new SmokeError(code, message); };
const started = performance.now();
const abort = new AbortController();
const deadline = setTimeout(() => abort.abort(), 20_000);
let transport;
let fixture;

function options() {
  const args = process.argv.slice(2), values = new Map();
  if (args.length !== 4) fail('arguments', 'Use --web-port PORT --fixture-web-root COPIED_WEB_ROOT.');
  for (let index = 0; index < args.length; index += 2) {
    if (!['--web-port', '--fixture-web-root'].includes(args[index]) || values.has(args[index])) fail('arguments', 'Provide each supported argument once.');
    values.set(args[index], args[index + 1]);
  }
  const port = values.get('--web-port'), supplied = values.get('--fixture-web-root');
  if (!/^\d{1,5}$/.test(port ?? '') || Number(port) < 1024 || Number(port) > 65535) fail('port', 'Choose a local web port from 1024 to 65535.');
  if (!supplied || !isAbsolute(supplied)) fail('fixture-root', 'The copied web root must be absolute.');
  const project = fileURLToPath(new URL('../../', import.meta.url)), root = resolve(supplied);
  const parts = relative(project, root).split(sep);
  if (parts.length < 4 || parts[0] !== '.data' || !/^dev-launcher-[a-zA-Z0-9_-]+$/.test(parts[1]) || parts.at(-2) !== 'apps' || parts.at(-1) !== 'web' || parts.includes('..')) fail('fixture-root', 'Use a copied apps/web inside this workspace .data/dev-launcher-* directory.');
  let current = resolve(project);
  for (const part of parts) { current = join(current, part); const info = lstatSync(current); if (!info.isDirectory() || info.isSymbolicLink()) fail('fixture-root', 'Copied fixture ancestors must be regular directories.'); }
  const canonical = realpathSync(root);
  if ((process.platform === 'win32' ? canonical.toLowerCase() !== root.toLowerCase() : canonical !== root)) fail('fixture-root', 'The copied web root must not redirect elsewhere.');
  return { port: Number(port), root };
}

async function readModule(url) {
  const response = await fetch(url, { signal: abort.signal, cache: 'no-store' });
  if (response.status !== 200) fail('http-status', 'Vite did not return a successful module response.');
  const reader = response.body?.getReader(); if (!reader) fail('empty-module', 'Vite returned no module body.');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); fail('module-size', 'Vite module response exceeded the smoke limit.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function connect(origin, token) {
  const key = randomBytes(16).toString('base64'), history = [], waiters = new Set();
  let socket, buffer = Buffer.alloc(0), fragmented = null, failure, stopping = false;
  const expectedAccept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const rejectPending = error => { failure ??= error; for (const waiter of waiters) waiter.reject(failure); waiters.clear(); };
  const close = () => { stopping = true; socket?.destroy(); rejectPending(new SmokeError('closed', 'The smoke connection has ended.')); };
  const expired = () => { rejectPending(new SmokeError('deadline', 'The live-update smoke exceeded its 20-second deadline.')); socket?.destroy(); };
  abort.signal.addEventListener('abort', expired, { once: true });
  const receive = payload => {
    const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (message.type === 'error') fail('vite-error', 'Vite reported an HMR error.');
    if (message.type === 'full-reload') fail('full-reload', 'Vite requested a full reload instead of the expected dependency update.');
    if (history.length >= 100) fail('message-limit', 'The HMR stream exceeded the bounded message limit.');
    history.push(message);
    for (const waiter of waiters) if (waiter.matches(message)) { waiters.delete(waiter); waiter.resolve(message); }
  };
  const decode = data => {
    buffer = Buffer.concat([buffer, data]);
    if (buffer.length > 128 * 1024) fail('frame-size', 'The HMR frame buffer exceeded its limit.');
    while (buffer.length >= 2) {
      const fin = !!(buffer[0] & 0x80), opcode = buffer[0] & 0x0f;
      if ((buffer[0] & 0x70) || (buffer[1] & 0x80)) fail('frame-protocol', 'The server sent an unsupported WebSocket frame.');
      let size = buffer[1] & 0x7f, offset = 2;
      if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
      else if (size === 127) { if (buffer.length < 10) return; const large = buffer.readBigUInt64BE(2); if (large > 65536n) fail('frame-size', 'The HMR message exceeded its limit.'); size = Number(large); offset = 10; }
      if (size > 65536) fail('frame-size', 'The HMR message exceeded its limit.');
      if (buffer.length < offset + size) return;
      const payload = buffer.subarray(offset, offset + size); buffer = buffer.subarray(offset + size);
      if (opcode >= 8) {
        if (!fin || size > 125) fail('frame-protocol', 'The server sent an invalid control frame.');
        if (opcode === 8) fail('early-close', 'Vite closed the connection before the smoke completed.');
        if (opcode === 9) {
          const mask = randomBytes(4), pong = Buffer.alloc(6 + size); pong[0] = 0x8a; pong[1] = 0x80 | size; mask.copy(pong, 2);
          for (let index = 0; index < size; index++) pong[6 + index] = payload[index] ^ mask[index % 4];
          socket.write(pong);
        } else if (opcode !== 10) fail('frame-protocol', 'The server sent an unknown control frame.');
        continue;
      }
      if (opcode === 1) { if (fragmented) fail('frame-protocol', 'The server interleaved text messages.'); fragmented = Buffer.from(payload); }
      else if (opcode === 0 && fragmented) fragmented = Buffer.concat([fragmented, payload]);
      else fail('frame-protocol', 'Expected a text HMR message.');
      if (fragmented.length > 65536) fail('frame-size', 'The HMR message exceeded its limit.');
      if (fin) { const complete = fragmented; fragmented = null; receive(complete); }
    }
  };
  try {
    await new Promise((resolveConnection, rejectConnection) => {
      const req = request(`${origin}/?token=${encodeURIComponent(token)}`, { signal: abort.signal, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', Origin: origin,
        'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'vite-hmr',
      } });
      req.on('response', response => { response.resume(); rejectConnection(new SmokeError('upgrade-rejected', 'Vite rejected the browser-origin WebSocket handshake.')); });
      req.on('error', () => rejectConnection(new SmokeError('websocket-connection', 'The local HMR socket could not connect.')));
      req.on('upgrade', (response, connected, head) => {
        socket = connected;
        if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expectedAccept || response.headers['sec-websocket-protocol'] !== 'vite-hmr') { close(); rejectConnection(new SmokeError('handshake', 'Vite returned an invalid WebSocket handshake.')); return; }
        socket.on('error', () => { if (!stopping) rejectPending(new SmokeError('websocket-error', 'The local HMR socket failed.')); });
        socket.on('close', () => { if (!stopping) rejectPending(new SmokeError('early-close', 'The local HMR socket closed early.')); });
        socket.on('data', data => { try { decode(data); } catch (error) { rejectPending(error instanceof SmokeError ? error : new SmokeError('invalid-message', 'Vite returned an invalid HMR message.')); socket.destroy(); } });
        try { if (head.length) decode(head); resolveConnection(); } catch { close(); rejectConnection(new SmokeError('invalid-message', 'Vite returned an invalid initial HMR frame.')); }
      });
      req.end();
    });
  } catch (error) { close(); abort.signal.removeEventListener('abort', expired); throw error; }
  return {
    waitFor(matches) { if (failure) return Promise.reject(failure); const message = history.find(matches); if (message) return Promise.resolve(message); return new Promise((resolve, reject) => waiters.add({ matches, resolve, reject })); },
    close() { abort.signal.removeEventListener('abort', expired); close(); },
  };
}

try {
  const { port, root } = options(), origin = `http://127.0.0.1:${port}`;
  fixture = `hmr-smoke-${randomUUID()}`;
  const directory = join(root, fixture), before = `before-${randomUUID()}`, after = `after-${randomUUID()}`;
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'entry.js'), 'import { value } from "./value.js";\nexport { value };\nif (import.meta.hot) import.meta.hot.accept("./value.js", () => {});\n', { flag: 'wx' });
  writeFileSync(join(directory, 'value.js'), `export const value = ${JSON.stringify(before)};\n`, { flag: 'wx' });
  const client = await readModule(`${origin}/@vite/client`);
  const match = /\bconst wsToken = ("[a-zA-Z0-9_-]+");/.exec(client);
  if (!match) fail('token-discovery', 'The installed Vite client token format was not recognized.');
  transport = await connect(origin, JSON.parse(match[1]));
  await transport.waitFor(message => message.type === 'connected');
  const entryPath = `/${fixture}/entry.js`, valuePath = `/${fixture}/value.js`;
  const entry = await readModule(origin + entryPath), original = await readModule(origin + valuePath);
  if (!entry.includes('import.meta.hot') || !entry.includes(valuePath) || !original.includes(before)) fail('registration', 'The imported module fixture was not transformed as expected.');
  const changedAt = performance.now();
  const changed = transport.waitFor(message => message.type === 'update' && message.updates?.some(update => update.type === 'js-update' && update.path === entryPath && update.acceptedPath === valuePath && Number.isFinite(update.timestamp)));
  // If the owned fixture write fails, cleanup still rejects this waiter safely.
  void changed.catch(() => {});
  writeFileSync(join(directory, 'value.js'), `export const value = ${JSON.stringify(after)};\n`);
  const message = await changed, update = message.updates.find(update => update.type === 'js-update' && update.path === entryPath && update.acceptedPath === valuePath);
  const updateMs = performance.now() - changedAt;
  const transformed = await readModule(`${origin}${valuePath}?${update.explicitImportRequired ? 'import&' : ''}t=${update.timestamp}`);
  if (!transformed.includes(after) || transformed.includes(before)) fail('stale-transform', 'The updated module response did not contain the new source marker.');
  console.log(JSON.stringify({ ok: true, check: 'vite-hmr', webPort: port, fixture, fixtureRetained: true, browserOriginHeader: true, subprotocol: 'vite-hmr', connectedFrame: true, importedDependencyUpdate: true, freshTransformedSource: true,
    updateMs: Math.round(updateMs), elapsedMs: Math.round(performance.now() - started), deadlineMs: 20000,
    limitation: 'Real watcher, module graph, browser-origin WebSocket and HTTP transform proof only. Browser application of HMR and React state preservation were not tested.' }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, check: 'vite-hmr', code: abort.signal.aborted ? 'deadline' : error instanceof SmokeError ? error.code : 'smoke-failed',
    message: abort.signal.aborted ? 'The live-update smoke exceeded its 20-second deadline.' : error instanceof SmokeError ? error.message : 'The HMR smoke could not complete.',
    ...(fixture ? { fixture, fixtureRetained: true } : {}), elapsedMs: Math.round(performance.now() - started), deadlineMs: 20000 }));
  process.exitCode = 1;
} finally { clearTimeout(deadline); transport?.close(); abort.abort(); }
