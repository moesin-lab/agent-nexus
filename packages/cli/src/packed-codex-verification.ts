import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDefaultCodexAppServerEngineFactory,
  runCodexAppServerCompatibilityProbe,
  type CodexAppServerSessionEngine,
} from '@agent-nexus/agent-codex-app-server';
import type { SessionConfig, SessionKey } from '@agent-nexus/protocol';

const VERIFICATION_MARKER = 'PACKED_CODEX_TURN_OK_731';

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
    const outcome = await withDeadline(
      engine.runTurn(
        `Reply with exactly ${VERIFICATION_MARKER} and nothing else.`,
        'packed-codex-verification-message',
      ),
      turnTimeoutMs,
    );
    if (
      outcome.status !== 'completed' ||
      !outcome.text?.includes(VERIFICATION_MARKER)
    ) {
      throw new Error('packed Codex turn verification failed');
    }
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
