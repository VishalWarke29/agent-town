// Throwaway parent for the "parent is hard-killed" test. Spawns the helper exactly like the service and reports its pid
// and every stdout line on its own stdout, then idles until the harness kills it with taskkill /F (without /T).
import { loadScript, spawnHelper } from './lib.mjs';

const [scriptFile, envJson] = process.argv.slice(2);
const extra = envJson ? JSON.parse(envJson) : {};
const { child } = spawnHelper(loadScript(scriptFile), { AGENT_TOWN_PARENT_PID: String(process.pid), AGENT_TOWN_WINDOW_MS: '120000', ...extra });
process.stdout.write(JSON.stringify({ stubPid: process.pid, helperPid: child.pid }) + '\n');
let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', c => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { process.stdout.write(JSON.stringify({ line: buf.slice(0, i) }) + '\n'); buf = buf.slice(i + 1); }
});
child.stderr.resume();
child.on('exit', code => process.stdout.write(JSON.stringify({ helperExit: code }) + '\n'));
setInterval(() => {}, 1000);
