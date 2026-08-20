import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  TerminalSessionStartError,
  type TerminalSessionHandle,
  type TerminalSessionStart,
  type TerminalSessionStartLifecycle,
} from '@agent-nexus/daemon';
import type { RemoteViewerAdmission } from './websocket-process-host.js';

const VIEWER_LAUNCHER = 'codex-remote-viewer-launcher.mjs';
const VIEWER_METADATA = 'codex-remote-viewer-owner.json';
const METADATA_VERSION = 1;
const SAFE_ENVIRONMENT = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
]);

const VIEWER_LAUNCHER_SOURCE = `
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

const fail = (message) => {
  process.stderr.write('codex remote viewer launcher: ' + message + '\\n');
  process.exit(126);
};

const metadataPath = process.argv[2];
if (!metadataPath) fail('missing metadata path');
let metadata;
try {
  const metadataStat = lstatSync(metadataPath);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || (metadataStat.mode & 0o777) !== 0o600) {
    fail('metadata is not a private regular file');
  }
  if (typeof process.getuid === 'function' && metadataStat.uid !== process.getuid()) {
    fail('metadata owner mismatch');
  }
  metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  const tokenStat = lstatSync(metadata.tokenFile);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || (tokenStat.mode & 0o777) !== 0o600) {
    fail('token is not a private regular file');
  }
  if (typeof process.getuid === 'function' && tokenStat.uid !== process.getuid()) {
    fail('token owner mismatch');
  }
  if (dirname(realpathSync(metadata.tokenFile)) !== dirname(realpathSync(metadataPath))) {
    fail('token escaped viewer runtime directory');
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const token = readFileSync(metadata.tokenFile, 'utf8').trim();
if (!token) fail('empty capability token');
const child = spawn(metadata.bin, [
  '--remote',
  metadata.endpoint,
  '--remote-auth-token-env',
  metadata.tokenEnvName,
  'resume',
  metadata.binding.threadId,
], {
  cwd: metadata.cwd,
  env: { ...process.env, [metadata.tokenEnvName]: token },
  stdio: 'inherit',
  shell: false,
});
child.once('error', (error) => {
  process.stderr.write(String(error?.stack ?? error) + '\\n');
  process.exitCode = 127;
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`.trimStart();

export interface CodexRemoteViewerBinding {
  homeId: string;
  appServerIncarnationId: string;
  threadId: string;
}

export interface CodexRemoteViewerStartInput {
  binding: CodexRemoteViewerBinding;
  admission: RemoteViewerAdmission;
  bin: string;
  cwd: string;
  codexHome: string;
  environment: Readonly<Record<string, string | undefined>>;
}

export interface CodexRemoteViewerHandle {
  viewerId: string;
  binding: CodexRemoteViewerBinding;
  state: 'Running' | 'StartAmbiguous';
}

export interface CodexRemoteViewerReconciliationBinding {
  homeId: string;
  threadId: string;
}

export type CodexRemoteViewerStartResult =
  | { kind: 'running'; handle: CodexRemoteViewerHandle }
  | { kind: 'ambiguous'; handle: CodexRemoteViewerHandle; error: Error }
  | { kind: 'unavailable'; error: Error };

export interface CodexRemoteViewerPort {
  start(input: CodexRemoteViewerStartInput): Promise<CodexRemoteViewerStartResult>;
  stop(handle: CodexRemoteViewerHandle): Promise<void>;
  reconcileConversation(
    conversationHome: string,
    binding: CodexRemoteViewerReconciliationBinding,
  ): Promise<void>;
}

export interface CodexRemoteViewerTerminalHost {
  start(
    config: TerminalSessionStart,
    lifecycle?: TerminalSessionStartLifecycle,
  ): TerminalSessionHandle;
  inspect(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
  ): TerminalSessionHandle;
  stop(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
    mode: 'Graceful' | 'Force',
  ): { state: 'Stopped' | 'Exited'; alreadyTerminal: boolean };
  recover(sessionId: string, ownerToken: string): TerminalSessionHandle;
  reconcileAllocatedStart(
    sessionId: string,
    ownerToken: string,
  ): { state: 'Stopped' | 'Exited'; alreadyTerminal: boolean };
}

interface ViewerMetadata {
  version: typeof METADATA_VERSION;
  viewerId: string;
  binding: CodexRemoteViewerBinding;
  terminal: Pick<TerminalSessionHandle, 'sessionId' | 'ownerToken'>;
  bin: string;
  cwd: string;
  endpoint: string;
  tokenEnvName: string;
  tokenFile: string;
}

interface LiveViewer {
  publicHandle: CodexRemoteViewerHandle;
  terminalHandle: TerminalSessionHandle;
  pollTimer: NodeJS.Timeout | null;
  stopPromise: Promise<void> | null;
}

export class CodexRemoteViewerAdapter implements CodexRemoteViewerPort {
  private readonly terminalHost: CodexRemoteViewerTerminalHost;
  private readonly processExecPath: string;
  private readonly pollIntervalMs: number;
  private readonly onMaintenanceError: (error: Error) => void;
  private readonly viewers = new Map<string, LiveViewer>();

  constructor(options: {
    terminalHost: CodexRemoteViewerTerminalHost;
    processExecPath?: string;
    pollIntervalMs?: number;
    onMaintenanceError?: (error: Error) => void;
  }) {
    this.terminalHost = options.terminalHost;
    this.processExecPath = options.processExecPath ?? process.execPath;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.onMaintenanceError = options.onMaintenanceError ?? (() => undefined);
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1) {
      throw new Error('viewer pollIntervalMs must be a positive integer');
    }
  }

  async start(input: CodexRemoteViewerStartInput): Promise<CodexRemoteViewerStartResult> {
    const validated = validateStartInput(input);
    const viewerId = randomBytes(16).toString('hex');
    const ownerToken = randomBytes(32).toString('base64url');
    const launcherPath = join(validated.runtimeDir, VIEWER_LAUNCHER);
    const metadataPath = join(validated.runtimeDir, VIEWER_METADATA);
    writeDurableFile(launcherPath, VIEWER_LAUNCHER_SOURCE, 0o700);

    let allocated: TerminalSessionHandle | null = null;
    const lifecycle: TerminalSessionStartLifecycle = {
      onAllocated: (handle) => {
        allocated = { ...handle };
        writePrivateMetadata(metadataPath, {
          version: METADATA_VERSION,
          viewerId,
          binding: { ...input.binding },
          terminal: {
            sessionId: handle.sessionId,
            ownerToken: handle.ownerToken,
          },
          bin: input.bin,
          cwd: input.cwd,
          endpoint: input.admission.endpoint,
          tokenEnvName: input.admission.tokenEnvName,
          tokenFile: input.admission.tokenFile,
        });
      },
    };
    try {
      const terminalHandle = this.terminalHost.start({
        executable: this.processExecPath,
        args: [launcherPath, metadataPath],
        cwd: input.cwd,
        env: safeEnvironment(input.environment, validated.codexHome),
        cols: 80,
        rows: 24,
        ownerToken,
      }, lifecycle);
      return {
        kind: 'running',
        handle: this.registerViewer(viewerId, input.binding, terminalHandle, 'Running'),
      };
    } catch (error) {
      if (error instanceof TerminalSessionStartError) {
        const terminalHandle = error.handle ?? allocated;
        if (!terminalHandle) throw error;
        const handle = this.registerViewer(
          viewerId,
          input.binding,
          terminalHandle,
          'StartAmbiguous',
        );
        return {
          kind: 'ambiguous',
          handle,
          error: diagnosticError(error, 'remote viewer start is ambiguous'),
        };
      }
      rmSync(metadataPath, { force: true });
      rmSync(launcherPath, { force: true });
      return {
        kind: 'unavailable',
        error: diagnosticError(error, 'remote viewer terminal is unavailable'),
      };
    }
  }

  async stop(handle: CodexRemoteViewerHandle): Promise<void> {
    const live = this.viewers.get(handle.viewerId);
    if (!live || !sameBinding(live.publicHandle.binding, handle.binding)) {
      throw new Error('remote viewer handle is unknown or stale');
    }
    if (live.stopPromise) return live.stopPromise;
    live.stopPromise = Promise.resolve().then(() => {
      if (live.pollTimer) clearInterval(live.pollTimer);
      live.pollTimer = null;
      const terminal = live.terminalHandle;
      this.terminalHost.stop(
        terminal.sessionId,
        terminal.ownerToken,
        terminal.incarnationId,
        'Force',
      );
      this.viewers.delete(handle.viewerId);
    });
    return live.stopPromise;
  }

  async reconcileConversation(
    conversationHome: string,
    binding: CodexRemoteViewerReconciliationBinding,
  ): Promise<void> {
    if (!/^[0-9a-f]{32}$/.test(binding.homeId) || !binding.threadId) {
      throw new Error('remote viewer reconciliation binding is invalid');
    }
    const home = validatePrivateDirectory(conversationHome, 0o700, 'conversation home');
    const runtimeRoot = join(home, 'agent-nexus-runtime');
    if (!existsSync(runtimeRoot)) return;
    validatePrivateDirectory(runtimeRoot, 0o700, 'remote runtime root');
    for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith('remote-')) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('remote viewer runtime entry is not a directory');
      }
      const runtimeDir = join(runtimeRoot, entry.name);
      validatePrivateDirectory(runtimeDir, 0o700, 'remote runtime directory');
      const metadataPath = join(runtimeDir, VIEWER_METADATA);
      if (!existsSync(metadataPath)) continue;
      const metadata = readPrivateMetadata(metadataPath);
      if (
        metadata.binding.homeId !== binding.homeId ||
        metadata.binding.threadId !== binding.threadId
      ) {
        throw new Error('remote viewer persisted binding does not match conversation');
      }
      let terminal: TerminalSessionHandle;
      try {
        terminal = this.terminalHost.recover(
          metadata.terminal.sessionId,
          metadata.terminal.ownerToken,
        );
      } catch (error) {
        if (isTerminalNotFound(error)) continue;
        this.terminalHost.reconcileAllocatedStart(
          metadata.terminal.sessionId,
          metadata.terminal.ownerToken,
        );
        continue;
      }
      this.terminalHost.stop(
        terminal.sessionId,
        terminal.ownerToken,
        terminal.incarnationId,
        'Force',
      );
    }
  }

  private registerViewer(
    viewerId: string,
    binding: CodexRemoteViewerBinding,
    terminalHandle: TerminalSessionHandle,
    state: CodexRemoteViewerHandle['state'],
  ): CodexRemoteViewerHandle {
    const publicHandle: CodexRemoteViewerHandle = {
      viewerId,
      binding: { ...binding },
      state,
    };
    const live: LiveViewer = {
      publicHandle,
      terminalHandle: { ...terminalHandle },
      pollTimer: null,
      stopPromise: null,
    };
    this.viewers.set(viewerId, live);
    if (state === 'Running') {
      live.pollTimer = setInterval(() => this.pollViewer(live), this.pollIntervalMs);
      live.pollTimer.unref();
    }
    return publicHandle;
  }

  private pollViewer(live: LiveViewer): void {
    if (live.stopPromise) return;
    try {
      const terminal = live.terminalHandle;
      const inspected = this.terminalHost.inspect(
        terminal.sessionId,
        terminal.ownerToken,
        terminal.incarnationId,
      );
      if (inspected.state === 'Running' || inspected.state === 'Starting') return;
      if (live.pollTimer) clearInterval(live.pollTimer);
      live.pollTimer = null;
      this.onMaintenanceError(
        new Error(`supplemental remote viewer exited (${inspected.state})`),
      );
    } catch (error) {
      if (live.pollTimer) clearInterval(live.pollTimer);
      live.pollTimer = null;
      this.onMaintenanceError(
        diagnosticError(error, 'supplemental remote viewer inspect failed'),
      );
    }
  }
}

function validateStartInput(input: CodexRemoteViewerStartInput): {
  codexHome: string;
  runtimeDir: string;
} {
  if (!/^[0-9a-f]{32}$/.test(input.binding.homeId)) {
    throw new Error('remote viewer home binding is not canonical');
  }
  if (!/^[0-9a-f]{32}$/.test(input.binding.appServerIncarnationId)) {
    throw new Error('remote viewer app-server incarnation is not canonical');
  }
  if (
    input.binding.appServerIncarnationId !== input.admission.appServerIncarnationId
  ) {
    throw new Error('remote viewer app-server incarnation is stale');
  }
  if (!input.binding.threadId || input.binding.threadId.includes('\0')) {
    throw new Error('remote viewer thread binding is invalid');
  }
  const endpoint = new URL(input.admission.endpoint);
  if (
    endpoint.protocol !== 'ws:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.port === '' ||
    endpoint.port === '0' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/'
  ) {
    throw new Error('remote viewer endpoint must be an authenticated loopback WebSocket');
  }
  if (!input.bin || input.bin.includes('\0') || !isAbsolute(input.cwd)) {
    throw new Error('remote viewer executable must be safe and cwd must be absolute');
  }
  const codexHome = validatePrivateDirectory(input.codexHome, 0o700, 'CODEX_HOME');
  const runtimeRoot = join(codexHome, 'agent-nexus-runtime');
  validatePrivateDirectory(runtimeRoot, 0o700, 'remote runtime root');
  const runtimeDir = validatePrivateDirectory(
    input.admission.runtimeDir,
    0o700,
    'remote runtime directory',
  );
  assertDescendant(runtimeRoot, runtimeDir);
  if (dirname(input.admission.tokenFile) !== runtimeDir) {
    throw new Error('remote viewer token escaped runtime directory');
  }
  const token = lstatSync(input.admission.tokenFile);
  if (
    token.isSymbolicLink() ||
    !token.isFile() ||
    (token.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === 'function' && token.uid !== process.getuid())
  ) {
    throw new Error('remote viewer token must be a private 0600 regular file');
  }
  return { codexHome, runtimeDir };
}

function validatePrivateDirectory(path: string, mode: number, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  const source = lstatSync(path);
  if (
    source.isSymbolicLink() ||
    !source.isDirectory() ||
    (source.mode & 0o777) !== mode ||
    (typeof process.getuid === 'function' && source.uid !== process.getuid())
  ) {
    throw new Error(`${label} must be a private ${mode.toString(8)} directory`);
  }
  return realpathSync(path);
}

function assertDescendant(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (!path || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error('remote viewer path escaped runtime root');
  }
}

function safeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  codexHome: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (SAFE_ENVIRONMENT.has(key) && typeof value === 'string' && !value.includes('\0')) {
      result[key] = value;
    }
  }
  result.CODEX_HOME = codexHome;
  return result;
}

function writePrivateMetadata(path: string, metadata: ViewerMetadata): void {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeDurableFile(temporary, `${JSON.stringify(metadata)}\n`, 0o600);
  try {
    renameSync(temporary, path);
    // onAllocated must durably publish the recovery handle before tmux can start.
    fsyncDirectory(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function writeDurableFile(path: string, contents: string, mode: number): void {
  const fd = openSync(path, 'wx', mode);
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readPrivateMetadata(path: string): ViewerMetadata {
  const source = lstatSync(path);
  if (
    source.isSymbolicLink() ||
    !source.isFile() ||
    (source.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === 'function' && source.uid !== process.getuid())
  ) {
    throw new Error('remote viewer metadata must be a private 0600 regular file');
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ViewerMetadata>;
  if (
    parsed.version !== METADATA_VERSION ||
    typeof parsed.viewerId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(parsed.viewerId) ||
    !parsed.binding ||
    !/^[0-9a-f]{32}$/.test(parsed.binding.homeId) ||
    !/^[0-9a-f]{32}$/.test(parsed.binding.appServerIncarnationId) ||
    typeof parsed.binding.threadId !== 'string' ||
    !parsed.binding.threadId ||
    !parsed.terminal ||
    !/^[0-9a-f]{32}$/.test(parsed.terminal.sessionId) ||
    typeof parsed.terminal.ownerToken !== 'string' ||
    Buffer.byteLength(parsed.terminal.ownerToken) < 16
  ) {
    throw new Error('remote viewer metadata is invalid');
  }
  return parsed as ViewerMetadata;
}

function sameBinding(
  left: CodexRemoteViewerBinding,
  right: CodexRemoteViewerBinding,
): boolean {
  return left.homeId === right.homeId &&
    left.appServerIncarnationId === right.appServerIncarnationId &&
    left.threadId === right.threadId;
}

function isTerminalNotFound(error: unknown): boolean {
  return error instanceof Error && /^TerminalNotFound:/.test(error.message);
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(`${fallback}: ${String(error)}`);
}

function diagnosticError(error: unknown, fallback: string): Error {
  const source = asError(error, fallback);
  const diagnostic = new Error(source.message);
  diagnostic.name = source.name;
  if (source.stack) diagnostic.stack = source.stack;
  const code = (source as Error & { code?: unknown }).code;
  if (typeof code === 'string') {
    Object.defineProperty(diagnostic, 'code', {
      value: code,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return diagnostic;
}
