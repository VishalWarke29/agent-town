import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { IdentityError, type CredentialVault } from './types.js';

// Static script only in process arguments. Secrets travel through anonymous pipes.
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Security
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($payload.value)
  $entropy = [Text.Encoding]::UTF8.GetBytes('AgentTown.Credentials.v1')
  if ($payload.operation -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($payload.operation -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else { exit 1 }
  [Console]::Out.Write([Convert]::ToBase64String($result))
  [Array]::Clear($bytes, 0, $bytes.Length)
  [Array]::Clear($result, 0, $result.Length)
} catch { [Console]::Error.Write('Protected credential operation failed.'); exit 1 }
`;

const privateDirectoryScript = `
$ErrorActionPreference = 'Stop'
try {
  $directory = [Console]::In.ReadToEnd()
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity.User, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  # Persist only the owner/access sections changed above. Set-Acl also requests
  # audit access on an existing protected directory, which needs SeSecurityPrivilege.
  [IO.Directory]::SetAccessControl($directory, $acl)
} catch { [Console]::Error.Write('Protected credential directory is unavailable.'); exit 1 }
`;

function powershell(scriptText: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) { reject(new IdentityError('vault_unavailable', 'Windows protected credential storage is unavailable.', 503)); return; }
    const child = spawn(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(scriptText, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: systemRoot, WINDIR: systemRoot, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP } });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new IdentityError('vault_unavailable', 'Windows protected credential storage could not complete the operation.', 503)); } };
    const timeout = setTimeout(() => { child.kill(); fail(); }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => { total += chunk.length; if (total > 100_000) { child.kill(); fail(); } else chunks.push(chunk); });
    // Drain, but deliberately never expose native diagnostics which may include inputs.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timeout); fail(); });
    child.stdin.on('error', fail);
    child.on('close', code => { clearTimeout(timeout); if (code !== 0) fail(); else if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8').trim()); } });
    child.stdin.end(input, 'utf8');
  });
}

/** DPAPI CurrentUser encrypted files are outside the application backup tree. */
export class WindowsDpapiVault implements CredentialVault {
  readonly available = process.platform === 'win32';
  private initialized: Promise<void> | undefined;
  private readonly directory: string;
  constructor(directory?: string) {
    const local = process.env.LOCALAPPDATA;
    this.directory = directory ?? (local && isAbsolute(local) ? join(local, 'AgentTownCredentials') : '');
  }

  private async initialize(): Promise<void> {
    if (!this.available || !isAbsolute(this.directory)) throw new IdentityError('vault_unavailable', 'Windows protected credential storage is unavailable.', 503);
    if (!this.initialized) this.initialized = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new IdentityError('vault_path_invalid', 'The credential directory must be a private directory, without a link.', 503);
      await powershell(privateDirectoryScript, this.directory);
    })().catch(error => { this.initialized = undefined; throw error; });
    await this.initialized;
  }

  private path(reference: string): string {
    if (!/^[A-Za-z0-9_-]{10,160}$/.test(reference)) throw new IdentityError('credential_reference_invalid', 'Invalid protected credential reference.');
    return join(this.directory, `${reference}.dpapi`);
  }

  async put(reference: string, secret: string): Promise<void> {
    const path = this.path(reference);
    if (!secret || Buffer.byteLength(secret) > 16000) throw new IdentityError('credential_invalid', 'Invalid protected credential value.');
    await this.initialize();
    const encrypted = await powershell(script, JSON.stringify({ operation: 'protect', value: Buffer.from(secret, 'utf8').toString('base64') }));
    if (!/^[A-Za-z0-9+/]+=*$/.test(encrypted)) throw new IdentityError('vault_unavailable', 'Protected credential storage returned invalid data.', 503);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new IdentityError('vault_unavailable', 'The protected credential could not be saved.', 503);
    }
  }

  async get(reference: string): Promise<string | null> {
    const path = this.path(reference);
    await this.initialize();
    let encrypted: string;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000) throw new IdentityError('credential_invalid', 'The protected credential file is invalid.', 503);
      encrypted = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new IdentityError('vault_unavailable', 'The protected credential could not be read.', 503);
    }
    if (!/^[A-Za-z0-9+/]+=*$/.test(encrypted)) throw new IdentityError('credential_invalid', 'The protected credential file is invalid.', 503);
    const decrypted = await powershell(script, JSON.stringify({ operation: 'unprotect', value: encrypted }));
    if (!/^[A-Za-z0-9+/]+=*$/.test(decrypted)) throw new IdentityError('vault_unavailable', 'The protected credential could not be opened.', 503);
    return Buffer.from(decrypted, 'base64').toString('utf8');
  }

  async delete(reference: string): Promise<void> {
    const path = this.path(reference);
    await this.initialize();
    try { await unlink(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IdentityError('vault_unavailable', 'The protected credential could not be removed.', 503);
    }
  }
}
