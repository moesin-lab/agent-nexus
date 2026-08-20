import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type TerminalSessionState =
  | 'Starting'
  | 'Running'
  | 'Exited'
  | 'Stopped'
  | 'Lost';

export interface TerminalSessionStart {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  cols: number;
  rows: number;
  ownerToken: string;
}

export interface TerminalSessionHandle {
  sessionId: string;
  ownerToken: string;
  incarnationId: string;
  state: TerminalSessionState;
}

export interface TerminalObservation {
  sessionId: string;
  incarnationId: string;
  text: string;
  truncated: boolean;
  observedAt: Date;
  evidence: 'WeakTerminalSnapshot';
}

export interface TerminalAttachDescriptor {
  transport: 'LocalProcess';
  executable: string;
  args: readonly string[];
  expiresAt: Date | null;
}

export type TerminalWrite =
  | { mode: 'Raw'; data: Uint8Array }
  | { mode: 'BracketedPaste'; text: string }
  | { mode: 'Keys'; keys: readonly TerminalKey[] };

export type TerminalKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'Backspace'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'CtrlC'
  | 'CtrlD';

interface LiveSession {
  handle: TerminalSessionHandle;
  target: string;
  socketPath: string;
  launchPath: string;
  childPidPath: string;
  forceAckPath: string;
  forceRequestPath: string;
  forceToken: string;
  startupIncomplete: boolean;
}

export interface TerminalSessionStartLifecycle {
  onAllocated?(handle: TerminalSessionHandle): void;
}

export class TerminalSessionStartError extends Error {
  readonly code = 'TerminalAmbiguousStart';
  readonly handle!: TerminalSessionHandle;

  constructor(
    message: string,
    handle: TerminalSessionHandle,
  ) {
    super(`TerminalAmbiguousStart: ${message}`);
    this.name = 'TerminalSessionStartError';
    // The handle is required for deterministic compensation, but contains the
    // owner token and therefore must not be included by default Error serializers.
    Object.defineProperty(this, 'handle', {
      value: { ...handle },
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

const LAUNCHER_SOURCE = `
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
const configPath = process.argv[2];
const claimedConfigPath = configPath + '.claimed';
// Claim is the first launcher action. The host may only treat an unclaimed
// launch record plus an absent target as proof that no child side effect began.
renameSync(configPath, claimedConfigPath);
const config = JSON.parse(readFileSync(claimedConfigPath, 'utf8'));
const durableWrite = (path, contents, flag) => {
  const fd = openSync(path, flag, 0o600);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
// Publish an intent before releasing the claimed config, so a crash can never
// make a possibly spawned detached child look definitively absent.
durableWrite(config.childPidPath, JSON.stringify({ state: 'spawning' }), 'wx');
const rootFd = openSync(dirname(config.childPidPath), 'r');
try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
unlinkSync(claimedConfigPath);
let child;
try {
  child = spawn(config.executable, config.args, {
    cwd: config.cwd,
    env: config.env,
    stdio: 'inherit',
    detached: true,
  });
} catch (error) {
  try { unlinkSync(config.childPidPath); } catch {}
  process.stderr.write(String(error?.stack ?? error) + '\\n');
  process.exit(127);
}
durableWrite(config.childPidPath, String(child.pid), 'w');
let forceRequested = false;
let forceNonce = '';
const signalGroup = (signal) => {
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
};
const groupState = () => {
  try {
    process.kill(-child.pid, 0);
    return 'alive';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'absent' : 'unknown';
  }
};
const waitForGroupExit = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let state = groupState();
  while (state !== 'absent' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = groupState();
  }
  return state;
};
const forwardHandlers = new Map();
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  const handler = () => signalGroup(signal === 'SIGHUP' ? 'SIGTERM' : signal);
  forwardHandlers.set(signal, handler);
  process.on(signal, handler);
}
const forcePoll = setInterval(() => {
  try {
    if (!existsSync(config.forceRequestPath)) return;
    const request = JSON.parse(readFileSync(config.forceRequestPath, 'utf8'));
    if (request?.token !== config.forceToken || typeof request?.nonce !== 'string') return;
    unlinkSync(config.forceRequestPath);
    if (forceRequested) return;
    forceRequested = true;
    forceNonce = request.nonce;
    signalGroup('SIGKILL');
  } catch {}
}, 20);
child.once('error', (error) => {
  if (child.pid) {
    process.stderr.write(String(error?.stack ?? error) + '\\n');
    return;
  }
  clearInterval(forcePoll);
  try { unlinkSync(config.childPidPath); } catch {}
  for (const [forwardedSignal, handler] of forwardHandlers) {
    process.removeListener(forwardedSignal, handler);
  }
  process.stderr.write(String(error?.stack ?? error) + '\\n');
  process.exit(127);
});
child.once('exit', async (code, signal) => {
  clearInterval(forcePoll);
  let state = groupState();
  if (state !== 'absent' && !forceRequested) {
    signalGroup('SIGTERM');
    state = await waitForGroupExit(250);
  }
  if (state !== 'absent') {
    signalGroup('SIGKILL');
    state = await waitForGroupExit(500);
  }
  if (state !== 'absent') {
    process.stderr.write('terminal launcher could not confirm process group exit\\n');
    process.exit(125);
    return;
  }
  if (forceRequested) {
    durableWrite(config.forceAckPath, JSON.stringify({ nonce: forceNonce }), 'w');
  }
  try { unlinkSync(config.childPidPath); } catch {}
  for (const [forwardedSignal, handler] of forwardHandlers) {
    process.removeListener(forwardedSignal, handler);
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`.trimStart();

const KEY_NAMES: Readonly<Record<TerminalKey, string>> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Tab: 'Tab',
  Backspace: 'BSpace',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  CtrlC: 'C-c',
  CtrlD: 'C-d',
};

const CHILD_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'CODEX_HOME',
]);

function terminalError(code: string, detail: string): Error {
  return new Error(`${code}: ${detail}`);
}

function commandExitStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  return typeof error.status === 'number' ? error.status : null;
}

function commandWasNotStarted(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'EACCES';
}

function commandStderr(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stderr' in error)) return '';
  return Buffer.isBuffer(error.stderr)
    ? error.stderr.toString('utf8').trim()
    : typeof error.stderr === 'string'
      ? error.stderr.trim()
      : '';
}

function isConfirmedMissingTmuxTarget(error: unknown): boolean {
  if (commandExitStatus(error) !== 1 || !error || typeof error !== 'object') return false;
  const message = commandStderr(error);
  return message === 'no current target' ||
    /^can't find session: [^\r\n]+$/.test(message) ||
    /^no server running on [^\r\n]+$/.test(message) ||
    /^error connecting to [^\r\n]+ \(No such file or directory\)$/.test(message);
}

function isTransientTmuxServerExit(error: unknown): boolean {
  return commandExitStatus(error) === 1 && commandStderr(error) === 'server exited unexpectedly';
}

function ownerHash(ownerToken: string): string {
  return createHash('sha256').update(ownerToken).digest('hex');
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function shellQuoteControlledPath(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class ExperimentalTmuxTerminalSessionHost {
  private readonly rootDir: string;
  private readonly socketRoot: string;
  private readonly launcherPath: string;
  private readonly tmuxBin: string;
  private readonly identityProbe: (pid: number) => string;
  private readonly hostId = randomBytes(16).toString('hex');
  private readonly hostIdentity: string;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly terminalSessions = new Set<string>();

  constructor(options: {
    rootDir: string;
    tmuxBin?: string;
    processIdentity?: (pid: number) => string;
  }) {
    if (!isAbsolute(options.rootDir)) {
      throw terminalError('TerminalConfigInvalid', 'rootDir must be absolute');
    }
    this.rootDir = ensurePrivateTerminalDirectory(options.rootDir);
    this.socketRoot = ensurePrivateTerminalDirectory(join(
      realpathSync('/tmp'),
      `agent-nexus-tmux-${createHash('sha256')
        .update(this.rootDir)
        .digest('hex')
        .slice(0, 32)}`,
    ));
    this.launcherPath = join(this.rootDir, 'terminal-launcher.mjs');
    this.tmuxBin = options.tmuxBin ?? 'tmux';
    this.identityProbe = options.processIdentity ?? ((pid) => this.readProcessIdentity(pid));
    this.hostIdentity = this.processIdentity(process.pid);
    writePrivateExecutableAtomic(this.launcherPath, LAUNCHER_SOURCE);
  }

  start(
    config: TerminalSessionStart,
    lifecycle: TerminalSessionStartLifecycle = {},
  ): TerminalSessionHandle {
    this.validateStart(config);
    const sessionId = randomBytes(16).toString('hex');
    const incarnationId = randomBytes(16).toString('hex');
    const handle: TerminalSessionHandle = {
      sessionId,
      ownerToken: config.ownerToken,
      incarnationId,
      state: 'Starting',
    };
    lifecycle.onAllocated?.({ ...handle });
    const target = `anx-${sessionId}`;
    const socketPath = this.socketPathFor(sessionId);
    const childPidPath = this.childPidPathFor(sessionId);
    const forceAckPath = this.forceAckPathFor(sessionId);
    const forceRequestPath = this.forceRequestPathFor(sessionId);
    const forceToken = this.forceTokenFor(sessionId, config.ownerToken);
    rmSync(forceAckPath, { force: true });
    rmSync(forceRequestPath, { force: true });
    const launchPath = join(this.rootDir, `launch-${sessionId}.json`);
    const live: LiveSession = {
      handle,
      target,
      socketPath,
      launchPath,
      childPidPath,
      forceAckPath,
      forceRequestPath,
      forceToken,
      startupIncomplete: true,
    };
    this.sessions.set(sessionId, live);
    const command = [
      'exec',
      shellQuoteControlledPath(process.execPath),
      shellQuoteControlledPath(this.launcherPath),
      shellQuoteControlledPath(launchPath),
    ].join(' ');
    let newSessionAttempted = false;
    let newSessionReturned = false;
    try {
      writeFileSync(
        launchPath,
        JSON.stringify({
          executable: config.executable,
          args: config.args,
          cwd: config.cwd,
          env: config.env,
          childPidPath,
          forceAckPath,
          forceRequestPath,
          forceToken,
        }),
        { mode: 0o600 },
      );
      newSessionAttempted = true;
      this.tmux(socketPath, [
        'new-session',
        '-d',
        '-s',
        target,
        '-x',
        String(config.cols),
        '-y',
        String(config.rows),
        '-c',
        config.cwd,
        command,
      ]);
      newSessionReturned = true;
      this.tmux(socketPath, [
        'set-option',
        '-t',
        target,
        '@agent-nexus-session-id',
        sessionId,
      ]);
      this.tmux(socketPath, [
        'set-option',
        '-t',
        target,
        '@agent-nexus-owner-hash',
        ownerHash(config.ownerToken),
      ]);
      this.tmux(socketPath, [
        'set-option',
        '-t',
        target,
        '@agent-nexus-incarnation-id',
        incarnationId,
      ]);
      this.tmux(socketPath, [
        'set-option',
        '-t',
        target,
        '@agent-nexus-host-pid',
        String(process.pid),
      ]);
      this.tmux(socketPath, [
        'set-option',
        '-t',
        target,
        '@agent-nexus-host-id',
        this.hostId,
      ]);
      this.tmux(socketPath, [
        'set-option',
        '-t',
        target,
        '@agent-nexus-host-identity',
        this.hostIdentity,
      ]);
      this.waitForLauncherReady(launchPath, childPidPath);
    } catch (error) {
      if (
        !newSessionAttempted ||
        (!newSessionReturned && commandWasNotStarted(error))
      ) {
        rmSync(launchPath, { force: true });
        this.sessions.delete(sessionId);
        throw terminalError(
          'TerminalDependencyUnavailable',
          error instanceof Error ? error.message : String(error),
        );
      }
      handle.state = 'Lost';
      throw new TerminalSessionStartError(
        'backing terminal cleanup was not confirmed',
        { ...handle },
      );
    }
    handle.state = 'Running';
    live.startupIncomplete = false;
    return { ...handle };
  }

  inspect(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
  ): TerminalSessionHandle {
    const live = this.authorize(sessionId, ownerToken, incarnationId);
    const targetPresent = this.hasTarget(live.socketPath, live.target);
    if (!targetPresent) this.assertNoLiveChildRecord(sessionId);
    const state = targetPresent ? 'Running' : 'Exited';
    live.handle.state = state;
    return { ...live.handle };
  }

  write(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
    input: TerminalWrite,
  ): { acceptedBytes: number; incarnationId: string } {
    const live = this.authorize(sessionId, ownerToken, incarnationId);
    if (!this.hasTarget(live.socketPath, live.target)) {
      throw terminalError('TerminalStateConflict', 'session is not running');
    }
    if (input.mode === 'Keys') {
      const keys = input.keys.map((key) => KEY_NAMES[key]);
      if (keys.some((key) => !key)) {
        throw terminalError('TerminalConfigInvalid', 'unsupported terminal key');
      }
      if (keys.length > 0) {
        try {
          this.tmux(live.socketPath, [
            'send-keys',
            '-t',
            live.target,
            ...keys,
          ]);
        } catch {
          throw terminalError(
            'AmbiguousWrite',
            'tmux may have accepted the key sequence',
          );
        }
      }
      return { acceptedBytes: keys.length, incarnationId };
    }
    const bytes =
      input.mode === 'Raw' ? Buffer.from(input.data) : Buffer.from(input.text);
    const bufferName = `anx-${randomBytes(8).toString('hex')}`;
    try {
      this.tmux(live.socketPath, ['load-buffer', '-b', bufferName, '-'], bytes);
    } catch {
      throw terminalError(
        'TerminalInternalFailure',
        'tmux rejected the private paste buffer',
      );
    }
    try {
      this.tmux(live.socketPath, [
        'paste-buffer',
        ...(input.mode === 'BracketedPaste' ? ['-p'] : []),
        '-d',
        '-b',
        bufferName,
        '-t',
        live.target,
      ]);
    } catch {
      this.deleteBufferBestEffort(live.socketPath, bufferName);
      throw terminalError(
        'AmbiguousWrite',
        'tmux may have delivered the paste buffer',
      );
    }
    if (input.mode === 'BracketedPaste') {
      try {
        this.tmux(live.socketPath, [
          'send-keys',
          '-t',
          live.target,
          'Enter',
        ]);
      } catch {
        throw terminalError(
          'AmbiguousWrite',
          'paste succeeded but submit acknowledgement failed',
        );
      }
    }
    return { acceptedBytes: bytes.length, incarnationId };
  }

  snapshot(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
    maxChars: number,
  ): TerminalObservation {
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 1_000_000) {
      throw terminalError('TerminalConfigInvalid', 'maxChars out of range');
    }
    const live = this.authorize(sessionId, ownerToken, incarnationId);
    const captured = this.tmux(live.socketPath, [
      'capture-pane',
      '-p',
      '-J',
      '-S',
      '-',
      '-t',
      live.target,
    ]).toString('utf8');
    const truncated = captured.length > maxChars;
    return {
      sessionId,
      incarnationId,
      text: truncated ? captured.slice(-maxChars) : captured,
      truncated,
      observedAt: new Date(),
      evidence: 'WeakTerminalSnapshot',
    };
  }

  resize(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
    cols: number,
    rows: number,
  ): { incarnationId: string } {
    this.validateDimensions(cols, rows);
    const live = this.authorize(sessionId, ownerToken, incarnationId);
    if (!this.hasTarget(live.socketPath, live.target)) {
      throw terminalError('TerminalStateConflict', 'session is not running');
    }
    this.tmux(live.socketPath, [
      'resize-window',
      '-t',
      live.target,
      '-x',
      String(cols),
      '-y',
      String(rows),
    ]);
    return { incarnationId };
  }

  attach(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
  ): TerminalAttachDescriptor | null {
    const live = this.authorize(sessionId, ownerToken, incarnationId);
    if (!this.hasTarget(live.socketPath, live.target)) {
      this.assertNoLiveChildRecord(sessionId);
      return null;
    }
    return {
      transport: 'LocalProcess',
      executable: this.tmuxBin,
      args: [
        '-S',
        live.socketPath,
        '-f',
        '/dev/null',
        'attach-session',
        '-t',
        live.target,
      ],
      expiresAt: null,
    };
  }

  stop(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
    mode: 'Graceful' | 'Force',
  ): { state: 'Stopped' | 'Exited'; alreadyTerminal: boolean } {
    const live = this.authorizeForStop(sessionId, ownerToken, incarnationId);
    if (this.terminalSessions.has(sessionId)) {
      return { state: 'Stopped', alreadyTerminal: true };
    }
    if (live.startupIncomplete) {
      if (mode !== 'Force') {
        throw terminalError('TerminalStateConflict', 'ambiguous start requires force stop');
      }
      if (
        !this.hasTarget(live.socketPath, live.target) &&
        this.cancelUnclaimedLaunch(sessionId)
      ) {
        // Winning the atomic rename proves the launcher can no longer claim config.
      } else if (!this.requestForceStop(live)) {
        throw terminalError(
          'TerminalInternalFailure',
          'ambiguous terminal start cleanup was not confirmed',
        );
      }
      this.killTargetBestEffort(live.socketPath, live.target);
      live.handle.state = 'Stopped';
      this.terminalSessions.add(sessionId);
      return { state: 'Stopped', alreadyTerminal: false };
    }
    if (!this.hasTarget(live.socketPath, live.target)) {
      this.assertNoLiveChildRecord(sessionId);
      live.handle.state = 'Exited';
      this.terminalSessions.add(sessionId);
      return { state: 'Exited', alreadyTerminal: true };
    }
    if (mode === 'Graceful') {
      this.tmux(live.socketPath, ['send-keys', '-t', live.target, 'C-c']);
      const deadline = Date.now() + 500;
      while (
        Date.now() < deadline &&
        this.hasTarget(live.socketPath, live.target)
      ) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      if (this.hasTarget(live.socketPath, live.target)) {
        throw terminalError(
          'TerminalStateConflict',
          'session did not exit after graceful interrupt',
        );
      }
      this.assertNoLiveChildRecord(sessionId);
      live.handle.state = 'Exited';
      this.terminalSessions.add(sessionId);
      return { state: 'Exited', alreadyTerminal: false };
    }
    if (!this.requestForceStop(live)) {
      throw terminalError(
        'TerminalInternalFailure',
        'launcher did not acknowledge force stop',
      );
    }
    live.handle.state = 'Stopped';
    this.terminalSessions.add(sessionId);
    return { state: 'Stopped', alreadyTerminal: false };
  }

  reconcileAllocatedStart(
    sessionId: string,
    ownerToken: string,
  ): { state: 'Stopped' | 'Exited'; alreadyTerminal: boolean } {
    if (!/^[0-9a-f]{32}$/.test(sessionId) || Buffer.byteLength(ownerToken) < 16) {
      throw terminalError(
        'TerminalConfigInvalid',
        'sessionId or ownerToken is not canonical',
      );
    }
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (!equalSecret(existing.handle.ownerToken, ownerToken)) {
        throw terminalError('TerminalUnauthorized', 'owner token mismatch');
      }
      if (!existing.startupIncomplete) {
        throw terminalError(
          'TerminalStateConflict',
          'completed terminal start must use normal recover/stop',
        );
      }
      return this.stop(
        sessionId,
        ownerToken,
        existing.handle.incarnationId,
        'Force',
      );
    }

    const target = `anx-${sessionId}`;
    const socketPath = this.socketPathFor(sessionId);
    const targetPresent = this.hasTarget(socketPath, target);
    if (targetPresent) {
      const storedSessionId = this.showOption(
        socketPath,
        target,
        '@agent-nexus-session-id',
      );
      const storedOwner = this.showOption(
        socketPath,
        target,
        '@agent-nexus-owner-hash',
      );
      if (
        (storedSessionId !== '' && storedSessionId !== sessionId) ||
        (storedOwner !== '' && !equalSecret(storedOwner, ownerHash(ownerToken)))
      ) {
        throw terminalError('TerminalUnauthorized', 'ownership marker mismatch');
      }
      if (
        storedSessionId === sessionId &&
        equalSecret(storedOwner, ownerHash(ownerToken))
      ) {
        throw terminalError(
          'TerminalStateConflict',
          'completed ownership markers require normal recover/stop',
        );
      }
    }

    const live: LiveSession = {
      handle: {
        sessionId,
        ownerToken,
        incarnationId: randomBytes(16).toString('hex'),
        state: 'Lost',
      },
      target,
      socketPath,
      launchPath: join(this.rootDir, `launch-${sessionId}.json`),
      childPidPath: this.childPidPathFor(sessionId),
      forceAckPath: this.forceAckPathFor(sessionId),
      forceRequestPath: this.forceRequestPathFor(sessionId),
      forceToken: this.forceTokenFor(sessionId, ownerToken),
      startupIncomplete: true,
    };
    if (!targetPresent && this.cancelUnclaimedLaunch(sessionId)) {
      // Atomic cancellation proves the launcher can no longer create a child.
    } else if (!this.requestForceStop(live)) {
      throw terminalError(
        'TerminalInternalFailure',
        'allocated terminal start cleanup was not confirmed',
      );
    }
    this.terminalSessions.add(sessionId);
    return { state: 'Stopped', alreadyTerminal: false };
  }

  recover(sessionId: string, ownerToken: string): TerminalSessionHandle {
    if (!/^[0-9a-f]{32}$/.test(sessionId) || Buffer.byteLength(ownerToken) < 16) {
      throw terminalError(
        'TerminalConfigInvalid',
        'sessionId or ownerToken is not canonical',
      );
    }
    const existing = this.sessions.get(sessionId);
    if (existing && equalSecret(existing.handle.ownerToken, ownerToken)) {
      return { ...existing.handle };
    }
    const target = `anx-${sessionId}`;
    const socketPath = this.socketPathFor(sessionId);
    if (!this.hasTarget(socketPath, target)) {
      this.assertNoLiveChildRecord(sessionId);
      throw terminalError('TerminalNotFound', 'backing tmux session is absent');
    }
    const storedSessionId = this.showOption(
      socketPath,
      target,
      '@agent-nexus-session-id',
    );
    const storedOwner = this.showOption(
      socketPath,
      target,
      '@agent-nexus-owner-hash',
    );
    if (
      storedSessionId !== sessionId ||
      !equalSecret(storedOwner, ownerHash(ownerToken))
    ) {
      throw terminalError('TerminalUnauthorized', 'ownership marker mismatch');
    }
    const releaseLock = this.acquireRecoveryLock(sessionId);
    try {
      const leasePid = Number(
        this.showOption(
          socketPath,
          target,
          '@agent-nexus-host-pid',
        ),
      );
      const leaseHostId = this.showOption(
        socketPath,
        target,
        '@agent-nexus-host-id',
      );
      const leaseIdentity = this.showOption(
        socketPath,
        target,
        '@agent-nexus-host-identity',
      );
      const leasePidState =
        Number.isInteger(leasePid) && leasePid > 0
          ? this.processState(leasePid)
          : 'dead';
      const leasePidIsOtherLiveHost =
        Number.isInteger(leasePid) &&
        leasePid > 0 &&
        leasePidState !== 'dead' &&
        (leasePid !== process.pid || leaseHostId !== this.hostId);
      if (leasePidIsOtherLiveHost) {
        if (leasePidState === 'unknown') {
          throw terminalError(
            'TerminalStateConflict',
            'session is owned by an unverifiable host pid',
          );
        }
        const actualIdentity = this.processIdentity(leasePid);
        if (
          actualIdentity === '' ||
          leaseIdentity === '' ||
          leaseIdentity === actualIdentity
        ) {
          throw terminalError(
            'TerminalStateConflict',
            'session is owned by a live or unverifiable host',
          );
        }
      }
      const incarnationId = randomBytes(16).toString('hex');
      this.tmux(socketPath, [
        'set-option', '-t', target,
        '@agent-nexus-incarnation-id', incarnationId,
      ]);
      this.tmux(socketPath, [
        'set-option', '-t', target,
        '@agent-nexus-host-pid', String(process.pid),
      ]);
      this.tmux(socketPath, [
        'set-option', '-t', target,
        '@agent-nexus-host-id', this.hostId,
      ]);
      this.tmux(socketPath, [
        'set-option', '-t', target,
        '@agent-nexus-host-identity', this.hostIdentity,
      ]);
      const handle: TerminalSessionHandle = {
        sessionId,
        ownerToken,
        incarnationId,
        state: 'Running',
      };
      this.sessions.set(sessionId, {
        handle,
        target,
        socketPath,
        launchPath: join(this.rootDir, `launch-${sessionId}.json`),
        childPidPath: this.childPidPathFor(sessionId),
        forceAckPath: this.forceAckPathFor(sessionId),
        forceRequestPath: this.forceRequestPathFor(sessionId),
        forceToken: this.forceTokenFor(sessionId, ownerToken),
        startupIncomplete: false,
      });
      return { ...handle };
    } finally {
      releaseLock();
    }
  }

  detach(): void {
    for (const live of this.sessions.values()) {
      if (this.hasTarget(live.socketPath, live.target)) {
        this.tmux(live.socketPath, [
          'set-option', '-t', live.target,
          '@agent-nexus-host-pid', '0',
        ]);
        this.tmux(live.socketPath, [
          'set-option', '-t', live.target,
          '@agent-nexus-host-id', '',
        ]);
        this.tmux(live.socketPath, [
          'set-option', '-t', live.target,
          '@agent-nexus-host-identity', '',
        ]);
      }
    }
    this.sessions.clear();
  }

  shutdown(): void {
    for (const live of this.sessions.values()) {
      if (!this.requestForceStop(live)) continue;
      this.killTargetBestEffort(live.socketPath, live.target);
    }
    this.sessions.clear();
  }

  private authorize(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
  ): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live || !equalSecret(live.handle.ownerToken, ownerToken)) {
      throw terminalError('TerminalUnauthorized', 'owner token mismatch');
    }
    if (live.handle.incarnationId !== incarnationId) {
      throw terminalError('StaleIncarnation', 'session incarnation changed');
    }
    if (this.hasTarget(live.socketPath, live.target)) {
      const storedOwner = this.showOption(
        live.socketPath,
        live.target,
        '@agent-nexus-owner-hash',
      );
      if (!equalSecret(storedOwner, ownerHash(ownerToken))) {
        throw terminalError('TerminalUnauthorized', 'ownership marker mismatch');
      }
      const storedIncarnation = this.showOption(
        live.socketPath,
        live.target,
        '@agent-nexus-incarnation-id',
      );
      if (storedIncarnation !== incarnationId) {
        throw terminalError('StaleIncarnation', 'backing incarnation changed');
      }
    }
    return live;
  }

  private authorizeForStop(
    sessionId: string,
    ownerToken: string,
    incarnationId: string,
  ): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live || !equalSecret(live.handle.ownerToken, ownerToken)) {
      throw terminalError('TerminalUnauthorized', 'owner token mismatch');
    }
    if (live.handle.incarnationId !== incarnationId) {
      throw terminalError('StaleIncarnation', 'session incarnation changed');
    }
    return live.startupIncomplete
      ? live
      : this.authorize(sessionId, ownerToken, incarnationId);
  }

  private validateStart(config: TerminalSessionStart): void {
    if (
      typeof config.executable !== 'string' ||
      typeof config.cwd !== 'string' ||
      config.executable.includes('\0') ||
      config.cwd.includes('\0') ||
      !isAbsolute(config.executable) ||
      !isAbsolute(config.cwd)
    ) {
      throw terminalError(
        'TerminalConfigInvalid',
        'executable and cwd must be absolute',
      );
    }
    if (
      typeof config.ownerToken !== 'string' ||
      Buffer.byteLength(config.ownerToken) < 16
    ) {
      throw terminalError('TerminalConfigInvalid', 'ownerToken is too short');
    }
    if (
      !Array.isArray(config.args) ||
      config.args.some(
        (arg) => typeof arg !== 'string' || arg.includes('\0'),
      )
    ) {
      throw terminalError('TerminalConfigInvalid', 'args must be safe strings');
    }
    try {
      accessSync(config.executable, constants.X_OK);
      if (!statSync(config.cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw terminalError(
        'TerminalConfigInvalid',
        'executable or cwd is not accessible',
      );
    }
    this.validateDimensions(config.cols, config.rows);
    if (
      typeof config.env !== 'object' ||
      config.env === null ||
      Array.isArray(config.env)
    ) {
      throw terminalError('TerminalConfigInvalid', 'env must be a record');
    }
    for (const [key, value] of Object.entries(config.env)) {
      if (
        !CHILD_ENV_ALLOWLIST.has(key) ||
        typeof value !== 'string' ||
        value.includes('\0')
      ) {
        throw terminalError('TerminalConfigInvalid', 'invalid environment entry');
      }
    }
  }

  private validateDimensions(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      cols < 20 ||
      cols > 500 ||
      !Number.isInteger(rows) ||
      rows < 5 ||
      rows > 300
    ) {
      throw terminalError('TerminalConfigInvalid', 'terminal size out of range');
    }
  }

  private tmux(
    socketPath: string,
    args: readonly string[],
    input?: Uint8Array,
  ): Buffer {
    return execFileSync(
      this.tmuxBin,
      ['-S', socketPath, '-f', '/dev/null', ...args],
      {
        cwd: this.rootDir,
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          TMPDIR: this.rootDir,
        },
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  }

  private hasTarget(socketPath: string, target: string): boolean {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        this.tmux(socketPath, ['has-session', '-t', target]);
        return true;
      } catch (error) {
        if (isConfirmedMissingTmuxTarget(error)) return false;
        if (isTransientTmuxServerExit(error) && attempt < 3) {
          // The server can disappear while answering has-session. Retry until
          // tmux provides either a live target or its canonical absent proof.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          continue;
        }
        throw terminalError(
          'TerminalDependencyUnavailable',
          `tmux target presence could not be verified: ${commandStderr(error) || 'unknown error'}`,
        );
      }
    }
    throw terminalError('TerminalInternalFailure', 'tmux target probe retry exhausted');
  }

  private showOption(socketPath: string, target: string, name: string): string {
    try {
      return this.tmux(socketPath, ['show-option', '-qv', '-t', target, name])
        .toString('utf8')
        .trim();
    } catch (error) {
      throw terminalError(
        'TerminalDependencyUnavailable',
        `tmux ownership marker could not be observed: ${commandStderr(error) || 'unknown error'}`,
      );
    }
  }

  private killTargetBestEffort(socketPath: string, target: string): void {
    try {
      this.tmux(socketPath, ['kill-session', '-t', target]);
    } catch {
      // Idempotent cleanup: an already exited target is equivalent to stopped.
    }
  }

  private deleteBufferBestEffort(socketPath: string, bufferName: string): void {
    try {
      this.tmux(socketPath, ['delete-buffer', '-b', bufferName]);
    } catch {
      // The successful -d paste path already deletes the buffer.
    }
  }

  private socketPathFor(sessionId: string): string {
    return join(this.socketRoot, `s-${sessionId.slice(0, 16)}`);
  }

  private childPidPathFor(sessionId: string): string {
    return join(this.rootDir, `child-${sessionId}.pid`);
  }

  private forceAckPathFor(sessionId: string): string {
    return join(this.rootDir, `force-${sessionId}.ack`);
  }

  private forceRequestPathFor(sessionId: string): string {
    return join(this.rootDir, `force-${sessionId}.request`);
  }

  private forceTokenFor(sessionId: string, ownerToken: string): string {
    return createHash('sha256')
      .update('agent-nexus-terminal-force\0')
      .update(sessionId)
      .update('\0')
      .update(ownerToken)
      .digest('hex');
  }

  private processState(pid: number): 'alive' | 'dead' | 'unknown' {
    try {
      process.kill(pid, 0);
      return 'alive';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
    }
  }

  private assertNoLiveChildRecord(sessionId: string): void {
    const launchPath = join(this.rootDir, `launch-${sessionId}.json`);
    const claimedLaunchPath = `${launchPath}.claimed`;
    if (existsSync(claimedLaunchPath)) {
      throw terminalError(
        'TerminalInternalFailure',
        'claimed terminal launch is unresolved',
      );
    }
    this.cancelUnclaimedLaunch(sessionId);
    if (existsSync(claimedLaunchPath)) {
      throw terminalError(
        'TerminalInternalFailure',
        'terminal launcher won the recovery claim race',
      );
    }
    const childPidPath = this.childPidPathFor(sessionId);
    if (!existsSync(childPidPath)) return;
    let record: { pid: number; identity: string };
    try {
      const source = lstatSync(childPidPath);
      if (
        source.isSymbolicLink() ||
        !source.isFile() ||
        (source.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === 'function' && source.uid !== process.getuid())
      ) {
        throw new Error('unsafe child identity record');
      }
      const parsed = JSON.parse(readFileSync(childPidPath, 'utf8')) as Partial<{
        pid: number;
        identity: string;
      }>;
      if (
        !Number.isInteger(parsed.pid) ||
        parsed.pid! <= 0 ||
        typeof parsed.identity !== 'string' ||
        parsed.identity.length === 0
      ) {
        throw new Error('invalid child identity record');
      }
      record = { pid: parsed.pid, identity: parsed.identity } as {
        pid: number;
        identity: string;
      };
    } catch {
      throw terminalError(
        'TerminalInternalFailure',
        'persisted child identity could not be verified',
      );
    }
    const pidState = this.processState(record.pid);
    const groupState = this.processState(-record.pid);
    if (pidState === 'unknown' || groupState === 'unknown') {
      throw terminalError(
        'TerminalStateConflict',
        'persisted child process group is unverifiable',
      );
    }
    if (groupState === 'alive') {
      throw terminalError(
        'TerminalStateConflict',
        'persisted child process group may still be running',
      );
    }
    if (pidState === 'alive') {
      const actualIdentity = this.processIdentity(record.pid);
      if (actualIdentity === '' || actualIdentity === record.identity) {
        throw terminalError(
          'TerminalStateConflict',
          'persisted child process may still be running',
        );
      }
    }
    rmSync(childPidPath, { force: true });
  }

  private cancelUnclaimedLaunch(sessionId: string): boolean {
    const launchPath = join(this.rootDir, `launch-${sessionId}.json`);
    const cancelledPath = `${launchPath}.cancelled-${randomBytes(8).toString('hex')}`;
    try {
      renameSync(launchPath, cancelledPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw terminalError(
        'TerminalInternalFailure',
        'unclaimed terminal launch could not be cancelled',
      );
    }
    rmSync(cancelledPath, { force: true });
    return true;
  }

  private processIdentity(pid: number): string {
    return this.identityProbe(pid);
  }

  private readProcessIdentity(pid: number): string {
    try {
      const started = execFileSync(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        {
          encoding: 'utf8',
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2_000,
        },
      ).trim();
      return started ? `${pid}:${started}` : '';
    } catch {
      return '';
    }
  }

  private waitForLauncherReady(
    launchPath: string,
    childPidPath: string,
  ): void {
    const deadline = Date.now() + 5_000;
    let pid = this.readPublishedChildPid(childPidPath);
    while (
      Date.now() < deadline &&
      (existsSync(launchPath) || pid === null)
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      pid = this.readPublishedChildPid(childPidPath);
    }
    if (existsSync(launchPath) || pid === null) {
      throw terminalError(
        'TerminalInternalFailure',
        'terminal launcher did not consume its private record',
      );
    }
    const identity = this.processIdentity(pid);
    if (!Number.isInteger(pid) || pid <= 0 || identity === '') {
      throw terminalError(
        'TerminalInternalFailure',
        'terminal launcher did not publish a valid child identity',
      );
    }
    const fd = openSync(childPidPath, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid, identity }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  private readPublishedChildPid(childPidPath: string): number | null {
    try {
      const pid = Number(readFileSync(childPidPath, 'utf8'));
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private requestForceStop(live: LiveSession): boolean {
    if (!this.hasTarget(live.socketPath, live.target)) {
      try {
        this.assertNoLiveChildRecord(live.handle.sessionId);
        return true;
      } catch {
        // A launcher can survive a tmux target disappearing because it owns a
        // detached child PGID and catches pane signals. Preserve compensation
        // by publishing the authenticated Force request before failing closed.
      }
    }
    rmSync(live.forceAckPath, { force: true });
    const nonce = randomBytes(16).toString('hex');
    const temporaryRequestPath = `${live.forceRequestPath}.${nonce}.tmp`;
    let requestFd: number | undefined;
    try {
      requestFd = openSync(temporaryRequestPath, 'wx', 0o600);
      writeFileSync(
        requestFd,
        JSON.stringify({ token: live.forceToken, nonce }),
      );
      fsyncSync(requestFd);
      closeSync(requestFd);
      requestFd = undefined;
      renameSync(temporaryRequestPath, live.forceRequestPath);
    } catch {
      if (requestFd !== undefined) closeSync(requestFd);
      rmSync(temporaryRequestPath, { force: true });
      return false;
    }
    const deadline = Date.now() + 1_000;
    while (
      Date.now() < deadline &&
      (!existsSync(live.forceAckPath) ||
        this.hasTarget(live.socketPath, live.target))
    ) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    let acknowledgedNonce = '';
    try {
      const ack = JSON.parse(readFileSync(live.forceAckPath, 'utf8')) as {
        nonce?: unknown;
      };
      acknowledgedNonce = typeof ack.nonce === 'string' ? ack.nonce : '';
    } catch {
      // Missing or partial ack is not acknowledgement.
    }
    const acknowledged =
      acknowledgedNonce === nonce &&
      !this.hasTarget(live.socketPath, live.target);
    if (acknowledged) {
      rmSync(live.forceAckPath, { force: true });
      rmSync(live.forceRequestPath, { force: true });
      rmSync(live.childPidPath, { force: true });
    }
    return acknowledged;
  }

  private acquireRecoveryLock(sessionId: string): () => void {
    const lockPath = join(this.rootDir, `recover-${sessionId}.lock`);
    const lockToken = randomBytes(16).toString('hex');
    const identityHash = createHash('sha256')
      .update(this.hostIdentity)
      .digest('hex')
      .slice(0, 16);
    const lockTarget = `${process.pid}.${identityHash}.${lockToken}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        symlinkSync(lockTarget, lockPath);
        return () => {
          try {
            if (readlinkSync(lockPath) === lockTarget) unlinkSync(lockPath);
          } catch {
            // A released or externally removed lock is already unlocked.
          }
        };
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : '';
        if (code !== 'EEXIST') throw error;
        let existingTarget = '';
        try {
          existingTarget = readlinkSync(lockPath);
        } catch {
          // The lock vanished between EEXIST and inspection; retry creation.
          continue;
        }
        const [pidText, storedIdentityHash] = existingTarget.split('.');
        const lockPid = Number(pidText);
        const actualIdentity =
          Number.isInteger(lockPid) && lockPid > 0
            ? this.processIdentity(lockPid)
            : '';
        const actualIdentityHash = actualIdentity
          ? createHash('sha256')
              .update(actualIdentity)
              .digest('hex')
              .slice(0, 16)
          : '';
        const lockPidState =
          Number.isInteger(lockPid) && lockPid > 0
            ? this.processState(lockPid)
            : 'dead';
        if (
          Number.isInteger(lockPid) &&
          lockPid > 0 &&
          lockPidState !== 'dead' &&
          (lockPidState === 'unknown' ||
            actualIdentity === '' ||
            storedIdentityHash === undefined ||
            storedIdentityHash === actualIdentityHash)
        ) {
          throw terminalError(
            'TerminalStateConflict',
            'another host is recovering this session',
          );
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // Another recovery attempt already reclaimed the stale lock.
        }
      }
    }
    throw terminalError(
      'TerminalStateConflict',
      'could not acquire the recovery lease',
    );
  }
}

function ensurePrivateTerminalDirectory(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path) {
    throw terminalError(
      'TerminalConfigInvalid',
      'managed terminal path must be an absolute canonical non-root path',
    );
  }
  const components: string[] = [];
  for (let candidate = path; ; candidate = dirname(candidate)) {
    components.push(candidate);
    if (dirname(candidate) === candidate) break;
  }
  components.reverse();

  for (const candidate of components) {
    let created = false;
    let info;
    try {
      info = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        mkdirSync(candidate, { mode: 0o700 });
        created = true;
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      info = lstatSync(candidate);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw terminalError(
        'TerminalConfigInvalid',
        'managed terminal path must be a directory, not a symlink',
      );
    }
    if (realpathSync(candidate) !== candidate) {
      throw terminalError(
        'TerminalConfigInvalid',
        'managed terminal path must be canonical',
      );
    }
    if (!created && candidate !== path) continue;
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && info.uid !== currentUid) {
      throw terminalError(
        'TerminalConfigInvalid',
        'managed terminal path owner is not the current uid',
      );
    }
    chmodSync(candidate, 0o700);
  }
  return path;
}

function writePrivateExecutableAtomic(path: string, source: string): void {
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o700);
    writeFileSync(fd, source);
    chmodSync(temporary, 0o700);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directoryFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
}
