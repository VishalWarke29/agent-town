import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { folderPickHelperLineSchema } from '@agent-town/contracts';
import { MAX_ENCODED_COMMAND_CHARS } from '../../apps/service/src/folder-picker';
import { FOLDER_PICKER_SCRIPT } from '../../apps/service/src/folder-picker-script';

/**
 * The folder window helper is a fixed script that runs on the person's desktop. These tests do not run it (see
 * folder-picker-real.test.ts for that); they make any edit to it a deliberate, reviewed change.
 *
 * To change the helper: edit folder-picker-script.ts, run the real-window checks (docs/11, "Browse for a folder"),
 * then update the checksum below in the same change.
 */
const PINNED_SHA256 = 'a94c7f5a4d06b8932cfc399cf442b3f2b31abb7969d51c8fa5a8f551ca584e39';

const encodedLength = Buffer.from(FOLDER_PICKER_SCRIPT, 'utf16le').toString('base64').length;

describe('folder window helper script', () => {
  it('fits on one Windows command line with room to spare', () => {
    expect(encodedLength).toBeLessThanOrEqual(MAX_ENCODED_COMMAND_CHARS - 3_000);
  });

  it('keeps every character it was written with (no template-literal surprises)', () => {
    expect(FOLDER_PICKER_SCRIPT).not.toContain('${');
    expect(FOLDER_PICKER_SCRIPT).not.toContain('`');
    expect(FOLDER_PICKER_SCRIPT).not.toContain('\r');
    const roundTrip = Buffer.from(Buffer.from(FOLDER_PICKER_SCRIPT, 'utf16le').toString('base64'), 'base64').toString('utf16le');
    expect(roundTrip).toBe(FOLDER_PICKER_SCRIPT);
    // Plain ASCII: nothing that a console code page could change on the way in.
    expect(FOLDER_PICKER_SCRIPT).toMatch(/^[\x09\x0a\x20-\x7e]+$/);
  });

  it('is pinned by checksum, so any edit is deliberate', () => {
    expect(createHash('sha256').update(FOLDER_PICKER_SCRIPT, 'utf8').digest('hex')).toBe(PINNED_SHA256);
  });

  it('takes no user text: its only inputs are two numbers from the environment', () => {
    const names = [...FOLDER_PICKER_SCRIPT.matchAll(/Read-Number '([A-Z_]+)'/g)].map(match => match[1]);
    expect(names.sort()).toEqual(['AGENT_TOWN_PARENT_PID', 'AGENT_TOWN_WINDOW_MS']);
    expect(FOLDER_PICKER_SCRIPT).not.toMatch(/\$env:/i);
    expect(FOLDER_PICKER_SCRIPT).not.toMatch(/\$args|\$input|Read-Host|\[Console\]::In|OpenStandardInput/i);
    expect(FOLDER_PICKER_SCRIPT).toContain("if ($v -match '^[0-9]{1,9}$')");
  });

  it('does nothing but show a folder window: no network, no other programs, no file or registry access', () => {
    const forbidden = [
      /Invoke-Expression|\biex\b/i, /Start-Process|ProcessStartInfo|Process\.Start/i, /Invoke-WebRequest|Invoke-RestMethod|WebClient|HttpClient|System\.Net|https?:/i,
      /Get-ChildItem|Get-Content|Set-Content|Add-Content|Out-File|Remove-Item|New-Item|Copy-Item|Move-Item/i,
      /System\.IO\.File|Directory\.|Registry|Environment\.SetEnvironmentVariable|Assembly\.Load|DownloadString|FromBase64String|EncodedCommand/i,
      /Write-Host|Write-Output|Write-Error|Write-Warning/i,
    ];
    for (const pattern of forbidden) expect(FOLDER_PICKER_SCRIPT).not.toMatch(pattern);
  });

  it('prints only the three protocol lines, and the chosen path only through the escaper', () => {
    // A C# string literal, optionally followed by the escaped path and the closing brace.
    const emitted = [...FOLDER_PICKER_SCRIPT.matchAll(/\bEmit\(("(?:[^"\\]|\\.)*"(?: \+ Q\(path\) \+ "(?:[^"\\]|\\.)*")?)\)/g)].map(match => match[1]!);
    expect(emitted).toHaveLength(3);
    const [open, cancelled, selected] = ['open', 'cancelled', 'selected'].map(state => emitted.find(text => text.includes(`state\\":\\"${state}`))!);
    expect(folderPickHelperLineSchema.parse(JSON.parse(unquote(open!)))).toEqual({ state: 'open' });
    expect(folderPickHelperLineSchema.parse(JSON.parse(unquote(cancelled!)))).toEqual({ state: 'cancelled' });
    expect(selected).toBe('"{\\"state\\":\\"selected\\",\\"path\\":" + Q(path) + "}"');
    // Anything that is not plain ASCII is written as \uXXXX, so the line is valid JSON whatever the console code page.
    expect(FOLDER_PICKER_SCRIPT).toContain('c < 0x20 || c > 0x7e');
  });

  it('only closes its own window and only asks for folders', () => {
    expect(FOLDER_PICKER_SCRIPT).toContain('dlg.SetOptions(opts | 0x8 | 0x20 | 0x40 | 0x800 | 0x02000000)');
    // WM_CLOSE goes to the window found in this helper's own process, never to another program's window.
    expect(FOLDER_PICKER_SCRIPT).toContain('if (pid != (uint)myPid) return true;');
    expect(FOLDER_PICKER_SCRIPT).toContain('PostMessageW(dialog, 0x0010');
    expect(FOLDER_PICKER_SCRIPT).toContain('if (closeRequested && sw.ElapsedMilliseconds - closeAt > 1500) Process.GetCurrentProcess().Kill();');
  });
});

// The C# is compiled by Windows PowerShell each time the helper starts, so a typing mistake would only show on the first
// real click. This starts the real script WITHOUT its parent process id, which it refuses (exit code 2, no window, no
// output) only after the C# has compiled: a compile error would exit with code 1 and print an error instead.
describe.skipIf(process.platform !== 'win32')('folder window helper script (compiles, opens no window)', () => {
  it('compiles and then refuses to show a window without a live service to answer to', () => {
    const systemRoot = process.env.SystemRoot!;
    const directory = mkdtempSync(join(tmpdir(), 'agent-town-folder-script-test-'));
    try {
      const run = spawnSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(FOLDER_PICKER_SCRIPT, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 60_000, cwd: directory, env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: directory, TMP: directory } });
      expect(run.error).toBeUndefined();
      expect({ status: run.status, stdout: run.stdout, stderr: run.stderr.slice(0, 300) }).toEqual({ status: 2, stdout: '', stderr: '' });
    } finally { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }, 90_000);
});

/** Turns the C# text of a string literal (`"..."` with \" escapes) into the string it stands for. */
function unquote(source: string): string {
  return JSON.parse(source) as string;
}
