// Upstream inputs are pinned. Run with --download to refresh the vendored sources, then regenerate.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

const directory = dirname(fileURLToPath(import.meta.url));
const version = 'v1.11.0';
const files = [
  'opentelemetry/proto/common/v1/common.proto', 'opentelemetry/proto/resource/v1/resource.proto',
  'opentelemetry/proto/trace/v1/trace.proto', 'opentelemetry/proto/metrics/v1/metrics.proto',
  'opentelemetry/proto/logs/v1/logs.proto',
  ...['trace', 'metrics', 'logs'].map(signal => `opentelemetry/proto/collector/${signal}/v1/${signal}_service.proto`),
];
if (process.argv.includes('--download')) {
  for (const file of [...files, 'LICENSE']) {
    const response = await fetch(`https://raw.githubusercontent.com/open-telemetry/opentelemetry-proto/${version}/${file}`);
    if (!response.ok) throw new Error(`Pinned protocol download failed: ${response.status}`);
    const path = join(directory, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }
}
const root = new protobuf.Root();
const hashes = {};
for (const file of files) {
  const bytes = await readFile(join(directory, file));
  hashes[file] = createHash('sha256').update(bytes).digest('hex');
  protobuf.parse(bytes.toString('utf8'), root);
}
root.resolveAll();
await writeFile(join(directory, 'descriptor.json'), `${JSON.stringify(root.toJSON())}\n`);
await writeFile(join(directory, 'provenance.json'), `${JSON.stringify({ repository: 'open-telemetry/opentelemetry-proto', version, sha256: hashes }, null, 2)}\n`);
