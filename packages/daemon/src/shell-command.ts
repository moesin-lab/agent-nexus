import { spawn } from 'node:child_process';

export interface ShellCommandInput {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ShellCommandResult {
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  spawnError?: string;
}

export type ShellCommandExecutor = (
  input: ShellCommandInput,
) => Promise<ShellCommandResult>;

const FORCE_KILL_GRACE_MS = 1000;

export const executeShellCommand: ShellCommandExecutor = (input) =>
  new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', input.command], {
      cwd: input.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let truncated = false;
    let spawnError: string | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const killProcessGroup = (signal: NodeJS.Signals): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Process may already have exited.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Best effort: close/error settles the result.
      }
    };

    const terminate = (): void => {
      killProcessGroup('SIGTERM');
      forceKillTimer ??= setTimeout(() => {
        killProcessGroup('SIGKILL');
      }, FORCE_KILL_GRACE_MS);
      forceKillTimer.unref();
    };

    const collect = (chunk: Buffer): void => {
      const remaining = input.maxOutputBytes - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        terminate();
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      chunks.push(accepted);
      outputBytes += accepted.length;
      if (accepted.length < chunk.length) {
        truncated = true;
        terminate();
      }
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      spawnError = error.message;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    timeout.unref();

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        output: Buffer.concat(chunks).toString('utf8'),
        exitCode,
        signal,
        timedOut,
        truncated,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
