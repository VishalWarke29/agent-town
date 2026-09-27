// Hard cleanup for the folder-picker spike. The harness sends "track <pid> <image>" lines on stdin. When stdin closes
// (the harness exited or was hard-killed) or the lifetime cap passes, every tracked process tree is killed by pid, after
// checking that the pid still has the expected image name (guards against pid reuse). Exits by itself afterwards.
import { execFileSync } from 'node:child_process';

const maxMs = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 900_000;
const tracked = new Map();

function imageOf(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const m = /^"([^"]+)"/.exec(out.trim());
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}
function killAll() {
  for (const [pid, image] of tracked) {
    if (imageOf(pid) === image) {
      try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' }); } catch { /* already gone */ }
    }
  }
  tracked.clear();
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    const [cmd, pid, image] = line.split(' ');
    if (cmd === 'track' && /^\d+$/.test(pid) && image) tracked.set(Number(pid), image.toLowerCase());
    else if (cmd === 'untrack') tracked.delete(Number(pid));
    else if (cmd === 'quit') { killAll(); process.exit(0); }
  }
});
process.stdin.on('end', () => { killAll(); process.exit(0); });
process.stdin.on('error', () => { killAll(); process.exit(0); });
setTimeout(() => { killAll(); process.exit(0); }, maxMs);
