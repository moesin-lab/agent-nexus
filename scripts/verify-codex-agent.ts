import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createCodexRuntime,
  type CodexConfig,
} from '../packages/agent/codex/src/index.ts';
import {
  RuntimeRecorder,
  VerifyError,
  assertErrorTurn,
  assertInterruptTurn,
  assertTwoTurnResume,
  assertVerify,
  isCodexAuthPrecondition,
  isCodexBinaryPrecondition,
  silentLogger,
} from '../packages/agent/codex/src/e2e-verify.ts';
import type { AgentEvent, AgentRuntime, AgentSession, SessionKey } from '../packages/protocol/src/index.ts';

const CODEX_BIN = process.env['AGENT_NEXUS_VERIFY_CODEX_BIN'] ?? 'codex';
const CODEX_MODEL = process.env['AGENT_NEXUS_VERIFY_CODEX_MODEL'];
const KEEP_ARTIFACTS = process.env['AGENT_NEXUS_VERIFY_KEEP_ARTIFACTS'] === '1';
const ALLOW_SKIP = process.env['AGENT_NEXUS_VERIFY_ALLOW_SKIP'] === '1';
const CASE_TIMEOUT_MS = Number(
  process.env['AGENT_NEXUS_VERIFY_CASE_TIMEOUT_MS'] ?? 180_000,
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new VerifyError(
          'contract_failure',
          `${label} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runVersionPreflight(): Promise<string> {
  const child = spawn(CODEX_BIN, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const code = await withTimeout(
    new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode) => resolve(exitCode));
    }),
    30_000,
    'codex --version',
  );
  assertVerify(
    code === 0,
    'environment_precondition',
    `codex --version failed with exit code ${String(code)}: ${stderr.slice(0, 1000)}`,
  );
  const version = stdout.trim();
  assertVerify(
    version.length > 0,
    'environment_precondition',
    'codex --version returned empty stdout',
  );
  return version;
}

async function prepareWorkdir(): Promise<{ dir: string; owned: boolean }> {
  const requested = process.env['AGENT_NEXUS_VERIFY_WORKDIR'];
  const dir = requested
    ? path.resolve(requested)
    : await mkdtemp(path.join(tmpdir(), 'agent-nexus-codex-verify-'));
  await mkdir(dir, { recursive: true });
  return { dir, owned: !requested };
}

function makeConfig(
  workingDir: string,
  opts: {
    model?: string;
    sandbox?: CodexConfig['sandbox'];
  } = {},
): CodexConfig {
  return {
    bin: CODEX_BIN,
    workingDir,
    ...(opts.model === undefined ? {} : { model: opts.model }),
    sandbox: opts.sandbox ?? 'read-only',
    addDirs: [],
    loadUserConfig: false,
    loadRules: false,
  };
}

function makeRuntime(config: CodexConfig): AgentRuntime {
  return createCodexRuntime({
    config,
    logger: silentLogger,
    gracefulInterruptMs: 1_000,
    sigtermGraceMs: 1_000,
  });
}

function sessionKey(caseName: string): SessionKey {
  return {
    platform: 'discord',
    channelId: `verify-codex-${caseName}`,
    initiatorUserId: 'verify-user',
  };
}

async function runDirectTurn(
  runtime: AgentRuntime,
  session: AgentSession,
  text: string,
  traceId: string,
): Promise<void> {
  await withTimeout(
    runtime.sendInput(session, { type: 'user_message', text, traceId }),
    CASE_TIMEOUT_MS,
    traceId,
  );
}

async function runTwoTurnCase(workdir: string): Promise<{
  agentSessionId: string;
  nonce: string;
}> {
  const config = makeConfig(workdir, { model: CODEX_MODEL });
  const recorder = new RuntimeRecorder(makeRuntime(config));
  const runtime = recorder.wrap();
  const session = runtime.startSession(sessionKey('resume'), {
    sessionId: randomUUID(),
    workingDir: workdir,
    toolWhitelist: [],
    timeoutMs: CASE_TIMEOUT_MS,
  });
  runtime.onEvent(session, () => {});
  const nonce = 'TOKEN=CODEX_E2E_TURN1_OK';

  try {
    const firstOffset = recorder.events.length;
    await runDirectTurn(
      runtime,
      session,
      'Reply exactly: CODEX_E2E_TURN1_OK',
      `codex-e2e-turn1-${randomUUID()}`,
    );
    const firstTurnEvents = recorder.sliceFrom(firstOffset);

    const secondOffset = recorder.events.length;
    await runDirectTurn(
      runtime,
      session,
      'What exact text did you output in the immediately previous assistant message in this session? Reply exactly TOKEN=<that_text>.',
      `codex-e2e-turn2-${randomUUID()}`,
    );
    const secondTurnEvents = recorder.sliceFrom(secondOffset);
    const result = assertTwoTurnResume(firstTurnEvents, secondTurnEvents, nonce);
    assertVerify(
      session.agentSessionId === result.agentSessionId,
      'contract_failure',
      'Codex session agentSessionId changed across resume verification',
      { expected: result.agentSessionId, actual: session.agentSessionId },
    );
    return result;
  } finally {
    runtime.stopSession(session);
  }
}

async function runErrorCase(workdir: string): Promise<void> {
  const config = makeConfig(workdir, {
    model: `agent-nexus-invalid-model-${randomUUID()}`,
  });
  const recorder = new RuntimeRecorder(makeRuntime(config));
  const runtime = recorder.wrap();
  const session = runtime.startSession(sessionKey('error'), {
    sessionId: randomUUID(),
    workingDir: workdir,
    toolWhitelist: [],
    timeoutMs: CASE_TIMEOUT_MS,
  });
  runtime.onEvent(session, () => {});

  try {
    await runDirectTurn(
      runtime,
      session,
      'Reply exactly: SHOULD_NOT_SUCCEED',
      `codex-e2e-error-${randomUUID()}`,
    );
    assertErrorTurn(recorder.events);
  } finally {
    runtime.stopSession(session);
  }
}

async function runInterruptCase(workdir: string): Promise<void> {
  const config = makeConfig(workdir, {
    model: CODEX_MODEL,
    sandbox: 'workspace-write',
  });
  const started = path.join(workdir, 'codex-e2e-interrupt-started.txt');
  const completed = path.join(workdir, 'codex-e2e-interrupt-completed.txt');
  const commandSleepMs = 5_000;
  const recorder = new RuntimeRecorder(makeRuntime(config));
  const runtime = recorder.wrap();
  const session = runtime.startSession(sessionKey('interrupt'), {
    sessionId: randomUUID(),
    workingDir: workdir,
    toolWhitelist: [],
    timeoutMs: CASE_TIMEOUT_MS,
  });
  runtime.onEvent(session, () => {});

  const turn = runtime.sendInput(session, {
    type: 'user_message',
    traceId: `codex-e2e-interrupt-${randomUUID()}`,
    text: [
      'Use the shell to run exactly this command and no other command:',
      `printf CODEX_E2E_INTERRUPT_STARTED > ${JSON.stringify(started)}; sleep ${Math.ceil(commandSleepMs / 1000)}; printf CODEX_E2E_INTERRUPT_COMPLETED > ${JSON.stringify(completed)}`,
      'Do not reply until the command completes.',
    ].join('\n'),
  });

  try {
    await recorder.waitFor(
      (event: AgentEvent) =>
        event.type === 'tool_call_started' &&
        event.payload.toolName === 'command_execution',
      60_000,
      'interrupt command_execution start',
      'model_behavior',
    );
    await withTimeout(
      (async () => {
        while (!(await pathExists(started))) {
          await sleep(100);
        }
      })(),
      10_000,
      'interrupt start sentinel',
    );

    runtime.interrupt(session);
    await recorder.waitFor(
      (event: AgentEvent) =>
        event.type === 'turn_finished' &&
        event.payload.reason === 'user_interrupt',
      10_000,
      'interrupt user_interrupt terminal',
    );
    await withTimeout(turn, CASE_TIMEOUT_MS, 'interrupt sendInput');
    await sleep(commandSleepMs + 2_000);

    assertInterruptTurn(recorder.events);
    assertVerify(
      !(await pathExists(completed)),
      'contract_failure',
      'interrupt command still wrote the post-sleep completion sentinel',
      { completed, events: recorder.events },
    );
  } finally {
    runtime.stopSession(session);
  }
}

function normalizeFailure(err: unknown): VerifyError {
  if (err instanceof VerifyError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const kind =
    isCodexAuthPrecondition(message) || isCodexBinaryPrecondition(message)
      ? 'environment_precondition'
      : 'contract_failure';
  return new VerifyError(kind, message);
}

async function main(): Promise<void> {
  const work = await prepareWorkdir();
  const startedAt = Date.now();
  const completed: string[] = [];
  let failed = false;

  try {
    const version = await runVersionPreflight();
    completed.push(`codex --version (${version})`);

    const resume = await runTwoTurnCase(work.dir);
    completed.push(`two-turn resume (${resume.agentSessionId})`);

    await runErrorCase(work.dir);
    completed.push('error path');

    await runInterruptCase(work.dir);
    completed.push('interrupt path');

    console.log(
      JSON.stringify(
        {
          ok: true,
          codexBin: CODEX_BIN,
          workdir: work.dir,
          elapsedMs: Date.now() - startedAt,
          completed,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    failed = true;
    const failure = normalizeFailure(err);
    const skipped = ALLOW_SKIP && failure.kind === 'environment_precondition';
    const payload = {
      ok: false,
      skipped,
      kind: failure.kind,
      message: failure.message,
      details: failure.details,
      codexBin: CODEX_BIN,
      workdir: work.dir,
      completed,
    };
    const out = skipped ? console.log : console.error;
    out(JSON.stringify(payload, null, 2));
    process.exitCode = skipped ? 0 : 1;
  } finally {
    if (work.owned && !KEEP_ARTIFACTS && !failed) {
      await rm(work.dir, { recursive: true, force: true });
    } else {
      console.error(`verify artifacts kept at ${work.dir}`);
    }
  }
}

void main();
