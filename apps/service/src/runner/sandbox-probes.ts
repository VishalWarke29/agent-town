import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkedPath, isWithin } from '../discovery/paths.js';
import { WorkflowError } from '../workflow/index.js';
import { sandboxedCommand } from './openai-worker.js';
import type { RpcTransport } from './rpc.js';

/** All denied fixtures contain invented text, never real user credentials. */
export async function verifySandboxBoundary(rpc: RpcTransport, source: string, dataDirectory: string): Promise<void> {
  const suffix = randomUUID(), privateRoot = join(dataDirectory, `boundary-private-${suffix}`), probeRoot = join(source, `.agent-town-boundary-${suffix}`);
  const network = createServer(socket => socket.end());
  try {
    await mkdir(join(privateRoot, '.git', 'objects'), { recursive: true, mode: 0o700 });
    await mkdir(probeRoot, { mode: 0o700 });
    const credential = join(privateRoot, '.env'), history = join(privateRoot, '.git', 'objects', 'fixture');
    await writeFile(credential, 'INVENTED_BOUNDARY_FIXTURE', { flag: 'wx' });
    await writeFile(history, 'INVENTED_HISTORY_FIXTURE', { flag: 'wx' });
    const alias = join(probeRoot, 'linked');
    await symlink(privateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const run = async (script: string, args: string[], message: string) => {
      const result = await sandboxedCommand(rpc, source, [process.execPath, '-e', script, ...args]);
      if (result.exitCode !== 0) throw new WorkflowError('codex_source_isolation_missing', message, 503);
    };
    await run('const fs=require("node:fs"),p=process.argv[1];fs.writeFileSync(p,"ok",{flag:"wx"});if(fs.readFileSync(p,"utf8")!=="ok")process.exit(17);fs.unlinkSync(p)', [join(probeRoot, 'source.txt')], 'The sandbox could not read and write approved source files.');
    const deniedRead = 'const fs=require("node:fs");for(const p of process.argv.slice(1)){try{fs.readFileSync(p);process.exit(17)}catch(e){if(!["EACCES","EPERM"].includes(e.code))process.exit(19)}}';
    await run(deniedRead, [credential, history, join(alias, '.env')], 'The sandbox did not deny protected files, Git objects, or a junction escape.');
    await run('const fs=require("node:fs");try{fs.writeFileSync(process.argv[1],"probe");process.exit(17)}catch(e){if(!["EACCES","EPERM"].includes(e.code))process.exit(19)}', [credential], 'The sandbox did not deny writes outside the source tree.');
    await run('const cp=require("node:child_process"),r=cp.spawnSync(process.execPath,["-e",process.argv[1],...process.argv.slice(2)],{stdio:"ignore"});if(r.status!==0)process.exit(17)', [deniedRead, credential, history], 'A child process did not preserve the protected-file boundary.');
    await run('const fs=require("node:fs");try{fs.linkSync(process.argv[1],process.argv[2]);process.exit(17)}catch(e){if(!["EACCES","EPERM"].includes(e.code))process.exit(19)}', [credential, join(probeRoot, 'hardlink.txt')], 'The sandbox did not deny a hard-link import from outside the source tree.');
    await new Promise<void>((resolveReady, reject) => { network.once('error', reject); network.listen(0, '127.0.0.1', resolveReady); });
    const address = network.address();
    if (!address || typeof address === 'string') throw new Error('Invalid probe endpoint');
    await run('const net=require("node:net"),s=net.connect(Number(process.argv[1]),"127.0.0.1");s.on("connect",()=>process.exit(17));s.on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),1200)', [String(address.port)], 'The sandbox allowed network access to a reachable local service.');
  } finally {
    network.close();
    for (const [path, root] of [[probeRoot, source], [privateRoot, dataDirectory]]) {
      const target = resolve(path!), parent = resolve(root!);
      if (target !== parent && isWithin(parent, target)) {
        try { await checkedPath(target, [parent]); await rm(target, { recursive: true, force: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new WorkflowError('sandbox_probe_cleanup_failed', 'The boundary probe could not finish safely. Execution remains blocked.'); }
      }
    }
  }
}
