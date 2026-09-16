import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import { WindowsDpapiVault } from '../../apps/service/src/identity/vault';

async function privacy(directory: string): Promise<unknown> {
  const script = `
    $ErrorActionPreference = 'Stop'
    $path = [Console]::In.ReadToEnd()
    $acl = [IO.Directory]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]'Access, Owner')
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $rule = $rules[0]
    [Console]::Out.Write((@{
      ownerIsCurrentUser = ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value)
      protected = $acl.AreAccessRulesProtected
      onlyCurrentUser = ($rules.Count -eq 1 -and $rule.IdentityReference.Value -eq $sid.Value)
      fullControl = ($rule.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow)
      inheritedByFiles = ($rule.InheritanceFlags -eq [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -and $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None)
    } | ConvertTo-Json -Compress))
  `;
  return new Promise((resolve, reject) => {
    const root = process.env.SystemRoot!;
    const child = spawn(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume();
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.stdin.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('Fixture permission inspection failed'));
      else { try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid fixture permission result')); } }
    });
    child.stdin.end(directory, 'utf8');
  });
}

it.skipIf(process.platform !== 'win32')('reopens a previously secured vault after restart without changing or losing its credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-town-vault-restart-'));
  const reference = 'vault-restart-fixture';
  const secret = 'fixture-only credential with Unicode café';
  try {
    await new WindowsDpapiVault(directory).put(reference, secret);
    const expectedPrivacy = { ownerIsCurrentUser: true, protected: true, onlyCurrentUser: true, fullControl: true, inheritedByFiles: true };
    expect(await privacy(directory)).toEqual(expectedPrivacy);
    const before = await readFile(join(directory, `${reference}.dpapi`), 'utf8');
    expect(before).not.toContain(secret);
    expect(await new WindowsDpapiVault(directory).get(reference)).toBe(secret);
    expect(await readFile(join(directory, `${reference}.dpapi`), 'utf8')).toBe(before);
    await new WindowsDpapiVault(directory).put('second-vault-reference', 'another fixture-only value');
    expect(await new WindowsDpapiVault(directory).get(reference)).toBe(secret);
    expect((await readdir(directory)).sort()).toEqual([`${reference}.dpapi`, 'second-vault-reference.dpapi'].sort());
    await new WindowsDpapiVault(directory).delete('second-vault-reference');
    expect(await new WindowsDpapiVault(directory).get(reference)).toBe(secret);
    expect(await privacy(directory)).toEqual(expectedPrivacy);
  } finally {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('agent-town-vault-restart-')) throw new Error('Unsafe fixture cleanup');
    await rm(target, { recursive: true, force: true });
  }
}, 30_000);
