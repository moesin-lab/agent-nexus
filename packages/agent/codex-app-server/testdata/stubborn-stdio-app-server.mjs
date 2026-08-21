#!/usr/bin/env node
import { spawn } from 'node:child_process';

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {});
}
spawn('/bin/sh', ['-c', 'trap "" HUP TERM INT; while :; do sleep 1; done'], {
  detached: false,
  stdio: 'ignore',
});
setInterval(() => {}, 1_000);
