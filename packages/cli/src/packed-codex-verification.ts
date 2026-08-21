import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDefaultCodexAppServerEngineFactory,
  runCodexAppServerCompatibilityProbe,
  type CodexAppServerSessionEngine,
} from '@agent-nexus/agent-codex-app-server';
import type { SessionConfig, SessionKey } from '@agent-nexus/protocol';

const FIRST_TURN_MARKER = 'PACKED_CODEX_TURN_ONE_OK_731';
const SECOND_TURN_MARKER = 'PACKED_CODEX_TURN_TWO_OK_731';
const PROCESS_MARKER = 'PACKED_CODEX_PROCESS_OK_731';
const PROCESS_FIXTURE = [
  "const nonce = process.argv[1]",
  "process.stdout.write(`READY ${nonce} ${process.pid}\\n`)",
  "process.stdin.on('data', (chunk) => process.stdout.write(`PONG ${nonce} ${chunk.toString()}`))",
  "setInterval(() => process.stdout.write(`TICK ${nonce}\\n`), 100)",
].join(';');

interface VerificationEngine {
  engine: CodexAppServerSessionEngine;
  dispose(): Promise<void>;
}

export interface PackedCodexTurnVerificationDependencies {
  createEngine?: () => Promise<VerificationEngine>;
  turnTimeoutMs?: number;
}

/** Release-only proof that the installed CLI bundle can run the pinned backend. */
export async function runPackedCodexTurnVerification(
  dependencies: PackedCodexTurnVerificationDependencies = {},
): Promise<{ threadId: string }> {
  const turnTimeoutMs = dependencies.turnTimeoutMs ?? 120_000;
  if (!Number.isInteger(turnTimeoutMs) || turnTimeoutMs < 1) {
    throw new Error('packed Codex verification timeout must be a positive integer');
  }
  const { engine, dispose } = await (
    dependencies.createEngine ?? createDefaultVerificationEngine
  )();
  let result: { threadId: string } | undefined;
  let primaryError: unknown;
  try {
    const started = await engine.start();
    const processStatus = await withDeadline(
      engine.startProcess({
        argv: [process.execPath, '-e', PROCESS_FIXTURE, PROCESS_MARKER],
      }),
      turnTimeoutMs,
    );
    if (processStatus.state !== 'running') {
      throw new Error('packed Codex process start verification failed');
    }
    const ready = await waitForProcessText(
      engine,
      processStatus.handle,
      0,
      `READY ${PROCESS_MARKER}`,
      turnTimeoutMs,
    );
    const pidMatch = new RegExp(`READY ${PROCESS_MARKER} (\\d+)`).exec(ready.text);
    const processPid = pidMatch ? Number(pidMatch[1]) : 0;
    if (!Number.isSafeInteger(processPid) || processPid < 1) {
      throw new Error('packed Codex process PID verification failed');
    }
    assertRunningProcessStatus(engine, processStatus.handle, ready.cursor);

    const firstOutcome = await withDeadline(
      engine.runTurn(
        `Reply with exactly ${FIRST_TURN_MARKER} and nothing else.`,
        'packed-codex-verification-message-1',
      ),
      turnTimeoutMs,
    );
    if (
      firstOutcome.status !== 'completed' ||
      !firstOutcome.text?.includes(FIRST_TURN_MARKER)
    ) {
      throw new Error('packed Codex turn verification failed');
    }
    const tick = await waitForProcessText(
      engine,
      processStatus.handle,
      ready.cursor,
      `TICK ${PROCESS_MARKER}`,
      turnTimeoutMs,
    );
    assertRunningProcessStatus(engine, processStatus.handle, tick.cursor);
    const stdin = Buffer.from('PING\n');
    const written = await withDeadline(
      engine.writeProcessStdin({
        handle: processStatus.handle,
        dataBase64: stdin.toString('base64'),
      }),
      turnTimeoutMs,
    );
    if (written.acceptedBytes !== stdin.length || !written.stdinOpen) {
      throw new Error('packed Codex process stdin verification failed');
    }
    await waitForProcessText(
      engine,
      processStatus.handle,
      tick.cursor,
      `PONG ${PROCESS_MARKER} PING`,
      turnTimeoutMs,
    );

    const secondOutcome = await withDeadline(
      engine.runTurn(
        `Reply with exactly ${SECOND_TURN_MARKER} and nothing else.`,
        'packed-codex-verification-message-2',
      ),
      turnTimeoutMs,
    );
    if (
      secondOutcome.status !== 'completed' ||
      !secondOutcome.text?.includes(SECOND_TURN_MARKER)
    ) {
      throw new Error('packed Codex turn verification failed');
    }
    assertRunningProcessStatus(engine, processStatus.handle, tick.cursor);
    const terminated = await withDeadline(
      engine.terminateProcess(processStatus.handle),
      turnTimeoutMs,
    );
    if (
      terminated.status.state !== 'exited' ||
      !Number.isInteger(terminated.status.exitCode)
    ) {
      throw new Error('packed Codex process terminate verification failed');
    }
    await waitForProcessAbsent(processPid, Math.min(turnTimeoutMs, 5_000));
    result = { threadId: started.threadId };
  } catch (error) {
    primaryError = error;
    if (error instanceof PackedCodexVerificationTimeoutError) {
      void engine.interrupt().catch(() => false);
    }
  }

  const cleanupErrors: unknown[] = [];
  let stopConfirmed = false;
  try {
    await engine.stop();
    stopConfirmed = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (stopConfirmed) {
    try {
      await dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'packed Codex verification and cleanup failed',
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'packed Codex verification cleanup failed');
  }
  if (!result) throw new Error('packed Codex turn verification failed');
  return result;
}

function assertRunningProcessStatus(
  engine: CodexAppServerSessionEngine,
  handle: string,
  minimumCursor: number,
): void {
  const status = engine.processStatus(handle);
  if (
    status.handle !== handle ||
    status.state !== 'running' ||
    status.nextCursor < minimumCursor
  ) {
    throw new Error('packed Codex process status verification failed');
  }
}

class PackedCodexVerificationTimeoutError extends Error {
  constructor() {
    super('packed Codex turn verification timed out');
    this.name = 'PackedCodexVerificationTimeoutError';
  }
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PackedCodexVerificationTimeoutError());
    }, timeoutMs);
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitForProcessText(
  engine: CodexAppServerSessionEngine,
  handle: string,
  initialCursor: number,
  expected: string,
  timeoutMs: number,
): Promise<{ cursor: number; text: string }> {
  const deadline = Date.now() + timeoutMs;
  let cursor = initialCursor;
  let text = '';
  while (Date.now() < deadline) {
    const page = engine.readProcessOutput({ handle, cursor });
    if (page.truncatedBefore) {
      throw new Error('packed Codex process output was truncated');
    }
    for (const chunk of page.chunks) {
      text += Buffer.from(chunk.dataBase64, 'base64').toString('utf8');
    }
    cursor = page.nextCursor;
    if (text.includes(expected)) return { cursor, text };
    if (page.status.state !== 'running') {
      throw new Error('packed Codex process exited before expected output');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new PackedCodexVerificationTimeoutError();
}

async function waitForProcessAbsent(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('packed Codex process cleanup was not confirmed');
}

async function createDefaultVerificationEngine(): Promise<VerificationEngine> {
  const bin = process.env['CODEX_BIN'] || 'codex';
  await runCodexAppServerCompatibilityProbe({ bin });
  const root = await mkdtemp(join(tmpdir(), 'agent-nexus-packed-codex-'));
  try {
    await chmod(root, 0o700);
    const persistenceRoot = await realpath(root);
    const workingDir = await realpath(process.cwd());
    const sourceCodexHome = await realpath(
      process.env['CODEX_HOME'] || join(homedir(), '.codex'),
    );
    const factory = createDefaultCodexAppServerEngineFactory({
      sourceCodexHome,
      persistenceRoot,
      agentName: 'packed-codex-verification',
      clientVersion: '0.1.0-packed-verification',
      environment: process.env,
    });
    await factory.prepare();
    const key: SessionKey = {
      platformName: 'packed-verification',
      platform: 'lark',
      channelId: 'packed-verification',
      initiatorUserId: 'packed-verification',
    };
    const sessionConfig: SessionConfig = {
      sessionId: 'packed-codex-verification',
      workingDir,
      timeoutMs: 120_000,
    };
    return {
      engine: factory({
        key,
        sessionConfig,
        backendConfig: {
          bin,
          workingDir,
          sandbox: 'read-only',
          addDirs: [],
          maxInputBytes: 262_144,
          requestTimeoutMs: 30_000,
          interruptGraceMs: 5_000,
          terminateGraceMs: 5_000,
          conversationRetentionMs: null,
          supplementalViewer: { enabled: false },
        },
      }),
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
