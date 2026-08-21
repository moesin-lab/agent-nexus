import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import WebSocket from 'ws';
import {
  createRemoteAppServerAuth,
  type RemoteAppServerAuth,
} from './remote-auth.js';
import {
  RpcProtocolError,
  RpcTransport,
  type RpcId,
  type RpcRequestOptions,
} from './rpc-transport.js';
import type { ProcessHostCallbacks, ProcessHostOptions } from './process-host.js';

const WEBSOCKET_APP_SERVER_SUPERVISOR = `
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(1);
if (!command) process.exit(127);
let child;
let terminating = false;
const terminateForControlPipeLoss = () => {
  if (terminating) return;
  terminating = true;
  if (process.platform === 'win32') {
    try { child?.kill('SIGKILL'); } catch {}
    process.exit(137);
  }
  try {
    // The supervisor is the detached group leader and Codex inherits its PGID.
    // SIGKILL also terminates this supervisor, so no orphan can outlive control EOF.
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    process.kill(process.pid, 'SIGKILL');
  }
};
process.stdin.once('end', terminateForControlPipeLoss);
process.stdin.once('error', terminateForControlPipeLoss);
process.stdin.resume();

child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  detached: false,
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.once('error', (error) => {
  process.stderr.write(String(error?.stack ?? error) + '\\n');
  process.exit(127);
});
child.once('exit', (code, signal) => {
  if (process.platform !== 'win32') {
    // The root can exit before its descendants. Kill the whole supervised
    // group while this group leader is still alive, then let SIGKILL reap us.
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`.trimStart();

export interface SpawnedWebSocketAppServer {
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface AppServerWebSocket {
  on(event: 'message', listener: (data: unknown, isBinary?: boolean) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  send(data: string, callback: (error?: Error) => void): void;
  close(): void;
}

export interface WebSocketProcessHostOptions extends ProcessHostOptions {
  startupTimeoutMs: number;
}

export interface WebSocketProcessHostDependencies {
  createAuth?: (conversationHome: string) => Promise<RemoteAppServerAuth>;
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
  ) => SpawnedWebSocketAppServer;
  connect?: (endpoint: string, token: string) => Promise<AppServerWebSocket>;
  signalProcessGroup?: (
    child: SpawnedWebSocketAppServer,
    signal: NodeJS.Signals,
  ) => void;
  isProcessGroupAlive?: (child: SpawnedWebSocketAppServer) => boolean;
  beforeAuthDispose?: () => Promise<void>;
}

export interface RemoteViewerAdmission {
  endpoint: string;
  appServerIncarnationId: string;
  tokenEnvName: RemoteAppServerAuth['tokenEnvName'];
  tokenFile: string;
  runtimeDir: string;
}

export class WebSocketProcessHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSocketProcessHostError';
  }
}

/**
 * Owns one authenticated loopback app-server incarnation. The bearer token is
 * kept out of argv and disposed together with the child process incarnation.
 */
export class AuthenticatedWebSocketProcessHost {
  private auth: RemoteAppServerAuth | null = null;
  private authCreation: Promise<RemoteAppServerAuth> | null = null;
  private child: SpawnedWebSocketAppServer | null = null;
  private socket: AppServerWebSocket | null = null;
  private transport: RpcTransport | null = null;
  private startPromise: Promise<void> | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private rejectStartup: ((error: Error) => void) | null = null;
  private resolveEndpoint: ((endpoint: string) => void) | null = null;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private terminationPromise: Promise<void> | null = null;
  private beforeAuthDisposePromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposeError: unknown = null;
  private stderrBuffer = Buffer.alloc(0);
  private stderrBytes = 0;
  private endpoint: string | null = null;
  private fatalError: WebSocketProcessHostError | null = null;
  private stopping = false;
  private exited = false;
  private ready = false;

  constructor(
    private readonly options: WebSocketProcessHostOptions,
    private readonly dependencies: WebSocketProcessHostDependencies = {},
    private readonly callbacks: ProcessHostCallbacks = {},
  ) {
    if (!Number.isInteger(options.startupTimeoutMs) || options.startupTimeoutMs < 1) {
      throw new WebSocketProcessHostError('startupTimeoutMs 必须是正整数');
    }
  }

  start(): Promise<void> {
    if (this.startPromise || this.child || this.exited) {
      return Promise.reject(new WebSocketProcessHostError('WebSocket app-server host 已启动或结束'));
    }
    this.startPromise = this.startInternal();
    return this.startPromise;
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
      : `[redacted WebSocket app-server stderr: ${this.stderrBytes} bytes]`;
  }

  viewerAdmission(): RemoteViewerAdmission {
    const auth = this.auth;
    if (!this.ready || this.stopping || this.exited || !auth || !this.endpoint) {
      throw new WebSocketProcessHostError('viewer admission 不可用');
    }
    return {
      endpoint: this.endpoint,
      appServerIncarnationId: auth.appServerIncarnationId,
      tokenEnvName: auth.tokenEnvName,
      tokenFile: auth.tokenFile,
      runtimeDir: auth.runtimeDir,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.clearStartupTimer();
    this.rejectStartup?.(new WebSocketProcessHostError('WebSocket app-server host stopped'));
    this.rejectStartup = null;
    this.transport?.close(new RpcProtocolError('RPC transport stopped'));
    this.closeSocket();
    const child = this.child;
    if (!child || !this.exitPromise) {
      let startupCleanupError: unknown;
      await this.authCreation?.catch((error: unknown) => {
        if (error instanceof AggregateError) startupCleanupError = error;
      });
      await this.startPromise?.catch(() => undefined);
      let disposalError: unknown;
      try {
        await this.disposeAuthForStop();
      } catch (error) {
        disposalError = error;
      }
      if (startupCleanupError && disposalError) {
        throw new AggregateError(
          [startupCleanupError, disposalError],
          'WebSocket app-server startup and token cleanup both failed',
        );
      }
      if (startupCleanupError) throw startupCleanupError;
      if (disposalError) throw disposalError;
      return;
    }
    let terminationError: unknown;
    try {
      await this.beforeAuthDispose().catch(() => undefined);
      await this.terminateChild(child);
    } catch (error) {
      terminationError = error;
    }
    let disposalError: unknown;
    try {
      await this.disposeAuthForStop();
    } catch (error) {
      disposalError = error;
    }
    if (terminationError && disposalError) {
      throw new AggregateError(
        [terminationError, disposalError],
        'WebSocket app-server process and token cleanup both failed',
      );
    }
    if (terminationError) throw terminationError;
    if (disposalError) throw disposalError;
  }

  private async startInternal(): Promise<void> {
    try {
      this.authCreation = (this.dependencies.createAuth ?? createRemoteAppServerAuth)(
        this.options.codexHome,
      );
      this.auth = await this.authCreation;
      this.authCreation = null;
      if (this.stopping) {
        await this.disposeAuth();
        throw new WebSocketProcessHostError('WebSocket app-server host stopped during startup');
      }
      const spawn = this.dependencies.spawn ?? defaultSpawn;
      const child = spawn(this.options.bin, [...this.auth.serverArgs], {
        cwd: this.options.cwd,
        env: { ...this.options.env, CODEX_HOME: this.options.codexHome },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      this.child = child;
      this.exitPromise = new Promise<void>((resolve) => {
        this.resolveExit = resolve;
      });

      const endpointReady = new Promise<string>((resolve) => {
        this.resolveEndpoint = resolve;
      });
      const startupFailure = new Promise<never>((_resolve, reject) => {
        this.rejectStartup = reject;
      });
      this.startupTimer = setTimeout(() => {
        this.rejectStartup?.(
          new WebSocketProcessHostError('等待 loopback WebSocket endpoint 超时'),
        );
      }, this.options.startupTimeoutMs);

      child.stderr.on('data', (chunk: Buffer | Uint8Array | string) => {
        this.handleStderr(chunk);
      });
      child.once('exit', (code, signal) => this.handleExit(code, signal));
      child.on('error', () => this.handleChildError());

      const endpoint = await Promise.race([endpointReady, startupFailure]);
      this.endpoint = endpoint;
      const connecting = (this.dependencies.connect ?? defaultConnect)(endpoint, this.auth.token);
      void connecting.then(
        (socket) => {
          if (this.stopping || this.fatalError || this.exited) socket.close();
        },
        () => undefined,
      );
      let socket: AppServerWebSocket;
      try {
        socket = await Promise.race([connecting, startupFailure]);
      } catch {
        throw new WebSocketProcessHostError('authenticated WebSocket connection failed');
      }
      if (this.exited || this.stopping || this.fatalError) {
        socket.close();
        throw new WebSocketProcessHostError('WebSocket app-server exited during startup');
      }

      this.socket = socket;
      this.transport = new RpcTransport(
        { write: (frame) => this.writeSocket(frame) },
        {
          requestTimeoutMs: this.options.requestTimeoutMs,
          onNotification: this.callbacks.onNotification,
          onServerRequest: this.callbacks.onServerRequest,
          onFatal: (error) => this.hostFatal(error.message),
        },
      );
      socket.on('message', (data, isBinary) => this.handleMessage(data, isBinary));
      socket.on('error', () => this.hostFatal('authenticated WebSocket transport error'));
      socket.once('close', (code) => {
        if (!this.stopping && !this.exited) {
          this.hostFatal(`authenticated WebSocket closed unexpectedly code=${code}`);
        }
      });
      this.ready = true;
      this.rejectStartup = null;
      this.resolveEndpoint = null;
      this.clearStartupTimer();
    } catch (error) {
      const normalized =
        error instanceof WebSocketProcessHostError
          ? error
          : new WebSocketProcessHostError(
              error instanceof Error ? error.message : 'WebSocket app-server startup failed',
            );
      this.hostFatal(normalized.message);
      throw normalized;
    }
  }

  private handleStderr(chunk: Buffer | Uint8Array | string): void {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    this.stderrBytes += incoming.length;
    if (!this.resolveEndpoint || this.fatalError) return;
    const max = this.options.maxStderrBytes ?? 64 * 1024;
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, incoming]).subarray(-max);
    const match = /listening on:\s*(ws:\/\/[^\s]+)/i.exec(this.stderrBuffer.toString('utf8'));
    if (!match?.[1]) return;
    try {
      const endpoint = validateLoopbackEndpoint(match[1]);
      const resolve = this.resolveEndpoint;
      this.resolveEndpoint = null;
      this.stderrBuffer = Buffer.alloc(0);
      resolve(endpoint);
    } catch (error) {
      this.rejectStartup?.(
        error instanceof Error ? error : new WebSocketProcessHostError('invalid endpoint'),
      );
    }
  }

  private handleMessage(data: unknown, isBinary = false): void {
    if (!this.transport || this.fatalError) return;
    try {
      if (isBinary) throw new WebSocketProcessHostError('binary WebSocket frame 不受支持');
      const bytes = toBuffer(data);
      const max = this.options.maxFrameBytes ?? 8 * 1024 * 1024;
      if (bytes.length === 0 || bytes.length > max) {
        throw new WebSocketProcessHostError('WebSocket frame 为空或超过大小限制');
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new WebSocketProcessHostError('WebSocket frame 包含非法 JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new WebSocketProcessHostError('WebSocket JSON-RPC frame 必须是 object');
      }
      this.transport.receive(parsed as Record<string, unknown>);
    } catch (error) {
      this.hostFatal(error instanceof Error ? error.message : 'invalid WebSocket frame');
    }
  }

  private getTransport(): RpcTransport {
    if (this.fatalError) throw this.fatalError;
    if (!this.ready || !this.transport || !this.socket || this.exited) {
      throw new WebSocketProcessHostError('WebSocket app-server host 未运行');
    }
    return this.transport;
  }

  private writeSocket(frame: string): Promise<void> {
    const socket = this.socket;
    if (!socket || this.exited || this.stopping) {
      return Promise.reject(new WebSocketProcessHostError('WebSocket transport 已关闭'));
    }
    const payload = frame.endsWith('\n') ? frame.slice(0, -1) : frame;
    return new Promise<void>((resolve, reject) => {
      socket.send(payload, (error) => {
        if (error) reject(new WebSocketProcessHostError('WebSocket frame write failed'));
        else resolve();
      });
    });
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.ready = false;
    this.clearStartupTimer();
    this.resolveExit?.();
    this.resolveExit = null;
    this.rejectStartup?.(
      new WebSocketProcessHostError(
        `WebSocket app-server exited during startup code=${String(code)} signal=${String(signal)}`,
      ),
    );
    this.rejectStartup = null;
    this.callbacks.onExit?.(code, signal);
    this.closeSocket();
    void this.disposeAuth().catch(() => undefined);
    if (!this.stopping) {
      this.hostFatal(`WebSocket app-server 意外退出 code=${String(code)} signal=${String(signal)}`);
    }
  }

  private handleChildError(): void {
    const child = this.child;
    if (!child?.pid) {
      this.exited = true;
      this.ready = false;
      this.clearStartupTimer();
      this.resolveExit?.();
      this.resolveExit = null;
    }
    this.hostFatal('WebSocket app-server process error');
    if (this.exited) void this.disposeAuth().catch(() => undefined);
  }

  private hostFatal(message: string): void {
    if (this.fatalError) return;
    this.fatalError = new WebSocketProcessHostError(message);
    this.ready = false;
    this.clearStartupTimer();
    this.transport?.fail(new RpcProtocolError(message), false);
    this.callbacks.onFatal?.(this.fatalError);
    this.rejectStartup?.(this.fatalError);
    this.rejectStartup = null;
    this.closeSocket();
    const child = this.child;
    if (child && !this.stopping) {
      this.stopping = true;
      void this.terminateAfterViewerCleanup(child).catch(() => undefined);
    }
    if (!child || this.exited) {
      void this.disposeAuth().catch(() => undefined);
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Process-group cleanup remains the final lifecycle boundary.
    }
  }

  private signal(child: SpawnedWebSocketAppServer, signal: NodeJS.Signals): void {
    try {
      (this.dependencies.signalProcessGroup ?? defaultSignalProcessGroup)(child, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      this.hostFatal(`failed to signal WebSocket app-server process group with ${signal}`);
    }
  }

  private terminateChild(child: SpawnedWebSocketAppServer): Promise<void> {
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
            reject(
              new WebSocketProcessHostError(
                'WebSocket app-server process group exit was not confirmed',
              ),
            );
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
            reject(
              new WebSocketProcessHostError(
                'WebSocket app-server process group exit was not confirmed',
              ),
            );
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

  private async terminateAfterViewerCleanup(
    child: SpawnedWebSocketAppServer,
  ): Promise<void> {
    await this.beforeAuthDispose().catch(() => undefined);
    await this.terminateChild(child);
  }

  private isProcessGroupAlive(child: SpawnedWebSocketAppServer): boolean {
    try {
      return (this.dependencies.isProcessGroupAlive ?? defaultIsProcessGroupAlive)(child);
    } catch {
      this.hostFatal('failed to verify WebSocket app-server process group exit');
      return true;
    }
  }

  private clearStartupTimer(): void {
    if (!this.startupTimer) return;
    clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private disposeAuth(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.disposeError) return Promise.reject(this.disposeError);
    const auth = this.auth;
    if (!auth) return Promise.resolve();
    const disposal = Promise.resolve()
      .then(async () => {
        let viewerError: unknown;
        try {
          await this.beforeAuthDispose();
        } catch (error) {
          viewerError = error;
        }
        let authError: unknown;
        try {
          if (viewerError) {
            // Revoke the bearer but retain private terminal recovery metadata for next open.
            await auth.revoke();
          } else {
            await auth.dispose();
            if (this.auth === auth) this.auth = null;
          }
        } catch (error) {
          authError = error;
        }
        if (viewerError && authError) {
          throw new AggregateError(
            [viewerError, authError],
            'remote viewer and WebSocket auth cleanup both failed',
          );
        }
        if (viewerError) throw viewerError;
        if (authError) throw authError;
      })
      .then(
        () => {
          this.disposePromise = null;
        },
        (error: unknown) => {
          this.disposePromise = null;
          this.disposeError = error;
          throw error;
        },
      );
    this.disposePromise = disposal;
    return disposal;
  }

  private beforeAuthDispose(): Promise<void> {
    if (this.beforeAuthDisposePromise) return this.beforeAuthDisposePromise;
    this.beforeAuthDisposePromise = Promise.resolve().then(
      () => this.dependencies.beforeAuthDispose?.(),
    );
    return this.beforeAuthDisposePromise;
  }

  private async disposeAuthForStop(): Promise<void> {
    try {
      await this.disposeAuth();
    } catch (error) {
      if (this.disposeError === error) this.disposeError = null;
      throw error;
    }
  }
}

function validateLoopbackEndpoint(candidate: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(candidate);
  } catch {
    throw new WebSocketProcessHostError('app-server readiness endpoint 非法');
  }
  if (
    endpoint.protocol !== 'ws:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== '' && endpoint.pathname !== '/')
  ) {
    throw new WebSocketProcessHostError('app-server readiness endpoint 必须是 loopback WebSocket');
  }
  const port = Number(endpoint.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new WebSocketProcessHostError('app-server readiness endpoint port 非法');
  }
  return candidate;
}

function toBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data) && data.every((item) => Buffer.isBuffer(item))) {
    return Buffer.concat(data);
  }
  throw new WebSocketProcessHostError('unsupported WebSocket frame payload');
}

export function spawnSupervisedWebSocketAppServer(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    shell: false;
    stdio: ['pipe', 'pipe', 'pipe'];
    detached: boolean;
  },
): SpawnedWebSocketAppServer {
  return nodeSpawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      WEBSOCKET_APP_SERVER_SUPERVISOR,
      command,
      ...args,
    ],
    options,
  ) as ChildProcessWithoutNullStreams;
}

const defaultSpawn = spawnSupervisedWebSocketAppServer;

function defaultConnect(endpoint: string, token: string): Promise<AppServerWebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, {
      followRedirects: false,
      headers: { Authorization: `Bearer ${token}` },
      maxPayload: 8 * 1024 * 1024,
    });
    const onOpen = (): void => {
      socket.off('error', onError);
      resolve(socket as AppServerWebSocket);
    };
    const onError = (): void => {
      socket.off('open', onOpen);
      reject(new WebSocketProcessHostError('authenticated WebSocket connection failed'));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

function defaultSignalProcessGroup(
  child: SpawnedWebSocketAppServer,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32' && child.pid) {
    process.kill(-child.pid, signal);
    return;
  }
  const candidate = child as SpawnedWebSocketAppServer & {
    kill?: (signal: NodeJS.Signals) => boolean;
  };
  candidate.kill?.(signal);
}

function defaultIsProcessGroupAlive(child: SpawnedWebSocketAppServer): boolean {
  if (process.platform === 'win32' || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
