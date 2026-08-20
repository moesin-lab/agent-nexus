import { chmodSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppServerProcessHost } from '../src/process-host.ts';

const rootDir = mkdtempSync(join(tmpdir(), 'agent-nexus-stdio-crash-'));
const executable = join(rootDir, 'stubborn-stdio-app-server.mjs');
copyFileSync(new URL('./stubborn-stdio-app-server.mjs', import.meta.url), executable);
chmodSync(executable, 0o700);
const host = new AppServerProcessHost({
  bin: executable,
  cwd: process.cwd(),
  codexHome: process.cwd(),
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  requestTimeoutMs: 1_000,
  terminateGraceMs: 250,
});
host.start();
process.stdout.write(`${JSON.stringify({ pid: host.pid(), rootDir })}\n`);
setInterval(() => {}, 1_000);
