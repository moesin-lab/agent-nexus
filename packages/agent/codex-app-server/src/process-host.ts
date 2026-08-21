import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { JsonlFrameReader } from './jsonl.js';
import {
  RpcProtocolError,
  RpcTransport,
  type RpcId,
  type RpcRequestOptions,
} from './rpc-transport.js';

const STDIO_APP_SERVER_SUPERVISOR = `
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(1);
if (!command) process.exit(127);
let child;
let terminating = false;
const terminateGroup = () => {
  if (terminating) return;
  terminating = true;
  if (process.platform === 'win32') {
    try { child?.kill('SIGKILL'); } catch {}
    process.exit(137);
  }
  try {
    // This process is the detached group leader. Codex and any descendants
    // inherit its PGID, so daemon pipe loss can kill the entire group at once.
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    process.kill(process.pid, 'SIGKILL');
  }
};
process.stdin.once('end', terminateGroup);
process.stdin.once('error', terminateGroup);
process.stdin.resume();

child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  detached: false,
  stdio: ['pipe', 'pipe', 'pipe'],
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once('error', (error) => {
  try { process.stderr.write(String(error?.stack ?? error) + '\\n'); } catch {}
  terminateGroup();
});
child.once('exit', () => {
  // The root can exit before descendants. Keep the group leader alive long
  // enough to remove every remaining member, then terminate the supervisor.
  terminateGroup();
});
`.trimStart();

export interface SpawnedAppServer {
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface ProcessHostOptions {
  bin: string;
  cwd: string;
  codexHome: string;
  env: Record<string, string>;
  requestTimeoutMs: number;
  terminateGraceMs: number;
  maxFrameBytes?: number;
  maxStderrBytes?: number;
}

export interface ProcessHostDependencies {
  spawn?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      shell: false;
      stdio: ['pipe', 'pipe', 'pipe'];
      detached: boolean;
    },
  ) => SpawnedAppServer;
  signalProcessGroup?: (child: SpawnedAppServer, signal: NodeJS.Signals) => void;
  isProcessGroupAlive?: (child: SpawnedAppServer) => boolean;
}

export interface ProcessHostCallbacks {
  onNotification?: (frame: Record<string, unknown>) => void;
  onServerRequest?: (frame: Record<string, unknown>) => void;
  onFatal?: (error: ProcessHostError) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class ProcessHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessHostError';
  }
}

export class AppServerProcessHost {
  private child: SpawnedAppServer | null = null;
  private transport: RpcTransport | null = null;
  private readonly reader: JsonlFrameReader;
  private stderrBytes = 0;
  private fatalError: ProcessHostError | null = null;
  private stopping = false;
  private exited = false;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private terminationPromise: Promise<void> | null = null;

  constructor(
    private readonly options: ProcessHostOptions,
    private readonly dependencies: ProcessHostDependencies = {},
    private readonly callbacks: ProcessHostCallbacks = {},
  ) {
    this.reader = new JsonlFrameReader(options.maxFrameBytes ?? 8 * 1024 * 1024);
  }

  start(): void {
    if (this.child || this.exited) throw new ProcessHostError('app-server host 已启动或结束');
    const spawn = this.dependencies.spawn ?? defaultSpawn;
    const child = spawn(
      this.options.bin,
      ['app-server', '--listen', 'stdio://'],
      {
        cwd: this.options.cwd,
        env: { ...this.options.env, CODEX_HOME: this.options.codexHome },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    this.child = child;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.transport = new RpcTransport(
      { write: (frame) => this.writeStdin(frame) },
      {
        requestTimeoutMs: this.options.requestTimeoutMs,
        onNotification: this.callbacks.onNotification,
        onServerRequest: this.callbacks.onServerRequest,
        onFatal: (error) => this.hostFatal(error.message),
      },
    );

    child.stdout.on('data', (chunk: Buffer | Uint8Array | string) => {
      try {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        for (const frame of this.reader.push(bytes)) this.transport?.receive(frame);
      } catch (error) {
        this.hostFatal(error instanceof Error ? error.message : String(error));
      }
    });
    child.stdout.once('end', () => {
      try {
        this.reader.finish();
      } catch (error) {
        this.hostFatal(error instanceof Error ? error.message : String(error));
      }
    });
    child.stderr.on('data', (chunk: Buffer | Uint8Array | string) => {
      const incoming = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      const max = this.options.maxStderrBytes ?? 64 * 1024;
      this.stderrBytes = Math.min(max, this.stderrBytes + incoming.length);
    });
    child.on('error', () => this.handleChildError());
    child.once('exit', (code, signal) => {
      this.exited = true;
      this.callbacks.onExit?.(code, signal);
      this.resolveExit?.();
      this.resolveExit = null;
      if (!this.stopping) {
        this.hostFatal(`app-server 意外退出 code=${String(code)} signal=${String(signal)}`);
      }
    });
  }

  request(method: string, params: unknown, options?: RpcRequestOptions): Promise<unknown> {
    try {
      return this.getTransport().request(method, params, options);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  notify(method: string, params: unknown): Promise<void> {
    try {
      return this.getTransport().notify(method, params);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  respondResult(id: RpcId, result: unknown): Promise<void> {
    return this.getTransport().respondResult(id, result);
  }

  respondError(id: RpcId, code: number, message: string): Promise<void> {
    return this.getTransport().respondError(id, code, message);
  }

  isFailed(): boolean {
    return this.fatalError !== null;
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  stderrDiagnostic(): string {
    return this.stderrBytes === 0
      ? ''
      : `[redacted app-server stderr: ${this.stderrBytes} bytes]`;
  }

  async stop(): Promise<void> {
    if (!this.child || !this.exitPromise) return;
    if (!this.stopping) {
      this.stopping = true;
      this.transport?.close(new RpcProtocolError('RPC transport stopped'));
    }
    await this.terminateChild(this.child);
  }

  private getTransport(): RpcTransport {
    if (this.fatalError) throw this.fatalError;
    if (!this.transport || !this.child || this.exited) {
      throw new ProcessHostError('app-server host 未运行');
    }
    return this.transport;
  }

  private writeStdin(frame: string): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return Promise.reject(new ProcessHostError('app-server stdin 已关闭'));
    return new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, 'utf8', (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private hostFatal(message: string): void {
    if (this.fatalError) return;
    this.fatalError = new ProcessHostError(message);
    this.transport?.fail(new RpcProtocolError(message), false);
    this.callbacks.onFatal?.(this.fatalError);
    if (this.child && !this.stopping) {
      this.stopping = true;
      const child = this.child;
      void this.terminateChild(child).catch(() => undefined);
    }
  }

  private handleChildError(): void {
    const child = this.child;
    if (!child?.pid) {
      this.exited = true;
      this.resolveExit?.();
      this.resolveExit = null;
    }
    this.hostFatal('app-server process error');
  }

  private signal(child: SpawnedAppServer, signal: NodeJS.Signals): void {
    try {
      (this.dependencies.signalProcessGroup ?? defaultSignalProcessGroup)(child, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      this.hostFatal(`failed to signal app-server process group with ${signal}`);
    }
  }

  private terminateChild(child: SpawnedAppServer): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    const exited = this.exitPromise;
    if (!exited) return Promise.resolve();
    let escalationTimer: NodeJS.Timeout | null = null;
    let confirmationTimer: NodeJS.Timeout | null = null;
    const termination = new Promise<void>((resolve, reject) => {
      let settled = false;
      const confirmExited = (): boolean => {
        if (settled || !this.exited || this.isProcessGroupAlive(child)) return false;
        settled = true;
        resolve();
        return true;
      };
      void exited.then(() => confirmExited());
      if (this.exited) {
        if (confirmExited()) return;
        this.signal(child, 'SIGKILL');
        if (confirmExited()) return;
        confirmationTimer = setTimeout(() => {
          if (!confirmExited()) {
            reject(new ProcessHostError('app-server process group exit was not confirmed'));
          }
        }, this.options.terminateGraceMs);
        return;
      }
      this.signal(child, 'SIGTERM');
      if (confirmExited()) return;
      escalationTimer = setTimeout(() => {
        if (confirmExited()) return;
        this.signal(child, 'SIGKILL');
        if (confirmExited()) return;
        confirmationTimer = setTimeout(() => {
          if (!confirmExited()) {
            reject(new ProcessHostError('app-server process group exit was not confirmed'));
          }
        }, this.options.terminateGraceMs);
      }, this.options.terminateGraceMs);
    }).finally(() => {
      if (escalationTimer) clearTimeout(escalationTimer);
      if (confirmationTimer) clearTimeout(confirmationTimer);
    });
    this.terminationPromise = termination;
    return termination;
  }

  private isProcessGroupAlive(child: SpawnedAppServer): boolean {
    try {
      return (this.dependencies.isProcessGroupAlive ?? defaultIsProcessGroupAlive)(child);
    } catch {
      this.hostFatal('failed to verify app-server process group exit');
      return true;
    }
  }
}

export function spawnSupervisedStdioAppServer(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    shell: false;
    stdio: ['pipe', 'pipe', 'pipe'];
    detached: boolean;
  },
): SpawnedAppServer {
  return nodeSpawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      STDIO_APP_SERVER_SUPERVISOR,
      command,
      ...args,
    ],
    options,
  ) as ChildProcessWithoutNullStreams;
}

const defaultSpawn = spawnSupervisedStdioAppServer;

function defaultSignalProcessGroup(child: SpawnedAppServer, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    process.kill(-child.pid, signal);
    return;
  }
  const candidate = child as SpawnedAppServer & { kill?: (signal: NodeJS.Signals) => boolean };
  candidate.kill?.(signal);
}

function defaultIsProcessGroupAlive(child: SpawnedAppServer): boolean {
  if (process.platform === 'win32' || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
