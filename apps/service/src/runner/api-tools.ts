import { z } from 'zod';
import { WorkflowError, sanitizeModelText } from '../workflow/index.js';
import { sandboxedCommand } from './openai-worker.js';
import { checkedWorktreeFile } from './worktrees.js';
import type { ExecutionInput } from './types.js';
import type { RpcTransport } from './rpc.js';
import { requireSourceTree } from './source-tree.js';
import { checkedPath } from '../discovery/paths.js';

export function sanitizedData(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return sanitizeModelText(value, secrets);
  if (Array.isArray(value)) return value.map(item => sanitizedData(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizedData(item, secrets)]));
  return value;
}
export async function executeWorkerTool(name: string, args: unknown, input: ExecutionInput, rpc: RpcTransport): Promise<string> {
  try {
    requireSourceTree(input.worktree);
    await checkedPath(input.worktree, [input.worktree]);
    let result: string;
    if (name === 'read_file' || name === 'write_file') {
      const data = (name === 'read_file' ? z.object({ path: z.string() }).strict() : z.object({ path: z.string(), content: z.string().max(128000) }).strict()).parse(args);
      const path = await checkedWorktreeFile(input.worktree, data.path, name === 'write_file');
      const content = 'content' in data && typeof data.content === 'string' ? data.content : '';
      if ((input.apiKey && content.includes(input.apiKey)) || /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/.test(content)) throw new WorkflowError('credential_write_denied', 'Credentials cannot be written into source files.');
      const command = name === 'read_file'
        ? [process.execPath, '-e', 'const fs=require("node:fs");process.stdout.write(fs.readFileSync(process.argv[1],"utf8"))', path]
        : [process.execPath, '-e', 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],process.argv[2],{encoding:"utf8"});process.stdout.write("File saved")', path, content];
      const output = await sandboxedCommand(rpc, input.worktree, command, input.signal);
      result = output.exitCode === 0 ? output.stdout : 'The sandbox denied or failed this file operation.';
    } else if (name === 'run_command') {
      const data = z.object({ argv: z.array(z.string().min(1).max(3000)).min(1).max(30) }).strict().parse(args);
      if (input.apiKey && data.argv.some(value => value.includes(input.apiKey!))) throw new WorkflowError('credential_argument_denied', 'Credentials cannot be used in command arguments.');
      const output = await sandboxedCommand(rpc, input.worktree, data.argv, input.signal);
      result = `Exit ${output.exitCode}\n${output.stdout}\n${output.stderr}`;
    } else throw new WorkflowError('worker_tool_denied', 'This tool is not authorized.');
    return sanitizeModelText(result, input.apiKey ? [input.apiKey] : []).slice(0, 32000);
  } catch { return 'Tool request denied or failed. Stay within the approved source-file and sandbox scope.'; }
}
