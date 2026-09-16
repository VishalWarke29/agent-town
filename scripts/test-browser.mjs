import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(import.meta.resolve('@playwright/test/cli'));
const args = process.argv.slice(2);
const single = args.some(value => value === '--project' || value.startsWith('--project=') || value === '--list' || value === '--help');
let outputRoot = 'test-results';
if (!single) {
  const outputIndex = args.findIndex(value => value === '--output' || value.startsWith('--output='));
  if (outputIndex >= 0) {
    const value = args[outputIndex];
    outputRoot = value === '--output' ? args[outputIndex + 1] : value.slice('--output='.length);
    if (!outputRoot || outputRoot.startsWith('--')) throw new Error('--output needs a directory.');
    args.splice(outputIndex, value === '--output' ? 2 : 1);
  }
}
// Each project creates many isolated browser identities. Restart its own test
// service rather than weakening the application's 64-session protection.
for (const project of single ? [null] : ['desktop', 'mobile']) {
  const extra = project ? [`--project=${project}`, `--output=${join(outputRoot, project)}`] : [];
  if (project) process.stdout.write(`\nBrowser checks: ${project} with a fresh local service\n`);
  const child = spawn(process.execPath, [cli, 'test', ...args, ...extra], { cwd: root, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 130 : 1))); });
  if (code !== 0) { process.exitCode = code; break; }
}
