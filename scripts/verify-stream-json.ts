import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createClaudeCodeRuntime,
  runCompatibilityProbe,
} from '../packages/agent/claudecode/src/index.ts';
import { Engine, SessionStore, type Logger } from '../packages/daemon/src/index.ts';
import type {
  AgentEvent,
  AgentEventHandler,
  AgentRuntime,
  AgentSession,
  CapabilitySet,
  EventHandler,
  MessageRef,
  NormalizedEvent,
  OutboundMessage,
  PlatformAdapter,
  SessionKey,
} from '../packages/protocol/src/index.ts';

type FailureKind =
  | 'environment_precondition'
  | 'model_behavior'
  | 'contract_failure';

type PlatformOp =
  | { kind: 'send'; at: number; text: string; ref: MessageRef }
  | { kind: 'edit'; at: number; text: string; ref: MessageRef }
  | { kind: 'setTyping'; at: number; sessionKey: SessionKey }
  | { kind: 'clearTyping'; at: number; sessionKey: SessionKey };

const CLAUDE_BIN = process.env['AGENT_NEXUS_VERIFY_CLAUDE_BIN'] ?? 'claude';
const KEEP_ARTIFACTS = process.env['AGENT_NEXUS_VERIFY_KEEP_ARTIFACTS'] === '1';
const CASE_TIMEOUT_MS = 180_000;

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
} as unknown as Logger;

class VerifyError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'VerifyError';
  }
}

function assertVerify(
  condition: unknown,
  kind: FailureKind,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new VerifyError(kind, message, details);
}

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

async function prepareWorkdir(): Promise<{ dir: string; owned: boolean }> {
  const requested = process.env['AGENT_NEXUS_VERIFY_WORKDIR'];
  const dir = requested
    ? path.resolve(requested)
    : await mkdtemp(path.join(tmpdir(), 'agent-nexus-stream-json-verify-'));
  await writeClaudeSettings(dir);
  return { dir, owned: !requested };
}

async function writeClaudeSettings(dir: string): Promise<void> {
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(
    path.join(dir, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { defaultMode: 'default' } }, null, 2)}\n`,
  );
}

function streamJsonArgs(allowedTools: string[]): string[] {
  return [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--permission-prompt-tool',
    'stdio',
    '--replay-user-messages',
    '--verbose',
    '--allowed-tools',
    allowedTools.join(','),
  ];
}

function writeJsonLine(child: ChildProcessWithoutNullStreams, value: unknown): void {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

async function runPermissionModePreflight(workdir: string): Promise<void> {
  const child = spawn(CLAUDE_BIN, streamJsonArgs(['Read']), {
    cwd: workdir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawInit = false;
  let settled = false;

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const finish = (err?: Error): void => {
          if (settled) return;
          settled = true;
          rl.close();
          child.kill('SIGTERM');
          if (err) reject(err);
          else resolve();
        };

        child.once('error', (err) => {
          finish(
            new VerifyError(
              'environment_precondition',
              `failed to spawn Claude Code: ${err.message}`,
            ),
          );
        });
        child.once('exit', (code, signal) => {
          if (!settled) {
            finish(
              new VerifyError(
                'environment_precondition',
                `Claude Code exited before system/init (code=${String(code)}, signal=${String(signal)}, stderr=${stderr.slice(0, 1000)})`,
              ),
            );
          }
        });
        rl.on('line', (line) => {
          let event: Record<string, unknown>;
          try {
            const parsed = JSON.parse(line) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              return;
            }
            event = parsed as Record<string, unknown>;
          } catch {
            return;
          }

          if (event['type'] === 'system' && event['subtype'] === 'init') {
            sawInit = true;
            const mode = event['permissionMode'];
            if (mode === 'bypassPermissions' || mode === 'acceptEdits') {
              finish(
                new VerifyError(
                  'environment_precondition',
                  `unsafe Claude Code permissionMode in verification workdir: ${String(mode)}`,
                ),
              );
              return;
            }
            finish();
          }
        });

        writeJsonLine(child, {
          type: 'user',
          message: { role: 'user', content: 'Reply exactly OK.' },
        });
      }),
      30_000,
      'permissionMode preflight',
    );
  } finally {
    if (!settled) {
      child.kill('SIGTERM');
      rl.close();
    }
  }

  assertVerify(
    sawInit,
    'environment_precondition',
    'permissionMode preflight did not observe system/init',
  );
}

class RuntimeRecorder {
  readonly events: AgentEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: AgentEvent) => boolean;
    resolve: (event: AgentEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(readonly runtime: AgentRuntime) {}

  waitFor(
    predicate: (event: AgentEvent) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<AgentEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<AgentEvent>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(
            new VerifyError(
              'model_behavior',
              `${label} was not observed within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  wrap(): AgentRuntime {
    const base = this.runtime;
    return {
      name: () => base.name(),
      capabilities: () => base.capabilities(),
      startSession: (key, config) => base.startSession(key, config),
      stopSession: (session) => base.stopSession(session),
      isAlive: (session) => base.isAlive(session),
      sendInput: (session, input) => base.sendInput(session, input),
      interrupt: (session) => base.interrupt(session),
      onEvent: (session: AgentSession, handler: AgentEventHandler): void => {
        base.onEvent(session, (event) => {
          this.record(event);
          return handler(event);
        });
      },
    };
  }

  private record(event: AgentEvent): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      this.removeWaiter(waiter);
      waiter.resolve(event);
    }
  }

  private removeWaiter(
    waiter: (typeof this.waiters)[number],
  ): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx !== -1) this.waiters.splice(idx, 1);
    clearTimeout(waiter.timer);
  }
}

class RecordingPlatform implements PlatformAdapter {
  readonly ops: PlatformOp[] = [];
  private handler?: EventHandler;
  private nextMessage = 1;

  constructor(private readonly sessionKey: SessionKey) {}

  name(): string {
    return 'verify-platform';
  }

  capabilities(): CapabilitySet {
    return {
      maxTextLength: 2000,
      supportsEdit: true,
      supportsDelete: false,
      supportsReactions: false,
      supportsEmbeds: false,
      supportsButtons: false,
      supportsThreads: false,
      supportsEphemeral: false,
      supportsAttachments: false,
      maxAttachmentsPerMessage: 0,
      supportsTypingIndicator: true,
    };
  }

  async start(handler: EventHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async send(sessionKey: SessionKey, message: OutboundMessage): Promise<MessageRef> {
    const id = `verify-${this.nextMessage++}`;
    const ref: MessageRef = {
      platform: 'discord',
      channelId: sessionKey.channelId,
      messageId: id,
      messageIds: [id],
      sentAt: new Date(),
    };
    this.ops.push({ kind: 'send', at: Date.now(), text: message.text, ref });
    return ref;
  }

  async edit(ref: MessageRef, message: OutboundMessage): Promise<void> {
    this.ops.push({ kind: 'edit', at: Date.now(), text: message.text, ref });
  }

  async delete(_ref: MessageRef): Promise<void> {
    throw new Error('delete is not supported by RecordingPlatform');
  }

  async react(_ref: MessageRef, _emoji: string): Promise<void> {
    throw new Error('react is not supported by RecordingPlatform');
  }

  async setTyping(sessionKey: SessionKey): Promise<void> {
    this.ops.push({ kind: 'setTyping', at: Date.now(), sessionKey });
  }

  async clearTyping(sessionKey: SessionKey): Promise<void> {
    this.ops.push({ kind: 'clearTyping', at: Date.now(), sessionKey });
  }

  async dispatch(text: string): Promise<void> {
    assertVerify(this.handler, 'contract_failure', 'platform was not started');
    const event: NormalizedEvent = {
      eventId: `verify-event-${randomUUID()}`,
      platform: 'discord',
      sessionKey: this.sessionKey,
      messageId: `in-${randomUUID()}`,
      traceId: `verify-${randomUUID()}`,
      type: 'message',
      text,
      rawPayload: { source: 'verify-stream-json' },
      rawContentType: 'application/json',
      receivedAt: new Date(),
      platformTimestamp: new Date(),
      initiator: {
        userId: this.sessionKey.initiatorUserId,
        displayName: 'verify-user',
        isBot: false,
      },
    };
    await this.handler(event);
  }
}

function makeRuntime(workdir: string, tools: string[]): AgentRuntime {
  return createClaudeCodeRuntime({
    claudeBin: CLAUDE_BIN,
    allowedTools: tools,
    defaultWorkingDir: workdir,
    logger,
    perInputTimeoutMs: CASE_TIMEOUT_MS,
    syntheticTurnFinishedDeliveryMs: 250,
    gracefulInterruptMs: 1_000,
    sigtermGraceMs: 1_000,
  });
}

function sessionKey(caseName: string): SessionKey {
  return {
    platform: 'discord',
    channelId: `verify-${caseName}`,
    initiatorUserId: 'verify-user',
  };
}

async function runCaseA(workdir: string): Promise<void> {
  const caseDir = path.join(workdir, 'case-a');
  await mkdir(caseDir, { recursive: true });
  await writeClaudeSettings(caseDir);
  const runtimeRecorder = new RuntimeRecorder(makeRuntime(caseDir, ['Bash']));
  const platform = new RecordingPlatform(sessionKey('case-a'));
  const engine = new Engine({
    platform,
    agent: runtimeRecorder.wrap(),
    logger,
    sessionStore: new SessionStore(),
    defaultSessionConfig: {
      workingDir: caseDir,
      toolWhitelist: ['Bash'],
      timeoutMs: CASE_TIMEOUT_MS,
    },
    streaming: { streamEditThrottleMs: 200, typingRefreshMs: 1_000 },
  });

  const start = Date.now();
  const prompt = [
    'This is an automated stream-json verification.',
    'First, reply with exactly STREAM_JSON_VERIFY_START before using tools.',
    'Then use Bash exactly three separate times, one tool call per command, in this order:',
    `1. printf 'one\\n' > ${JSON.stringify(path.join(caseDir, 'one.txt'))}`,
    '2. sleep 11',
    `3. printf 'three\\n' > ${JSON.stringify(path.join(caseDir, 'three.txt'))}`,
    'Do not combine the commands.',
    'After the third tool result, reply with exactly STREAM_JSON_VERIFY_DONE.',
  ].join('\n');

  try {
    await engine.start();
    await withTimeout(platform.dispatch(prompt), CASE_TIMEOUT_MS, 'case A dispatch');
  } finally {
    await engine.stop();
  }

  const elapsedMs = Date.now() - start;
  const events = runtimeRecorder.events;
  const runtimeError = events.find((event) => event.type === 'error');
  if (runtimeError?.type === 'error') {
    throw new VerifyError(
      runtimeError.payload.errorKind === 'permission_mode_unsafe'
        ? 'environment_precondition'
        : 'contract_failure',
      `case A runtime error: ${runtimeError.payload.errorKind}: ${runtimeError.payload.message}`,
      { events },
    );
  }
  const toolStarts = events.filter(
    (event) =>
      event.type === 'tool_call_started' && event.payload.toolName === 'Bash',
  );
  const toolResults = events.filter((event) => event.type === 'tool_result');
  const textEvents = events.filter(
    (event): event is Extract<AgentEvent, { type: 'text_delta' | 'text_final' }> =>
      event.type === 'text_delta' || event.type === 'text_final',
  );
  const sendOps = platform.ops.filter((op) => op.kind === 'send');
  const editOps = platform.ops.filter((op) => op.kind === 'edit');

  assertVerify(
    elapsedMs >= 10_000,
    'model_behavior',
    `case A finished too quickly (${elapsedMs}ms); long Bash tool did not gate delivery`,
    { events },
  );
  assertVerify(
    toolStarts.length >= 3,
    'model_behavior',
    `case A expected at least 3 Bash tool starts, saw ${toolStarts.length}`,
    { events },
  );
  assertVerify(
    toolResults.length >= 1,
    'contract_failure',
    'case A did not emit any tool_result event',
    { events },
  );
  assertVerify(
    textEvents.some((event) => event.payload.text.includes('STREAM_JSON_VERIFY_START')),
    'model_behavior',
    'case A model did not emit the start sentinel before final delivery',
    { events },
  );
  assertVerify(
    textEvents.some((event) => event.payload.text.includes('STREAM_JSON_VERIFY_DONE')),
    'model_behavior',
    'case A model did not emit the done sentinel',
    { events },
  );
  assertVerify(
    sendOps.length === 1,
    'contract_failure',
    `case A expected exactly one platform send, saw ${sendOps.length}`,
    { ops: platform.ops },
  );
  assertVerify(
    editOps.length >= 1,
    'contract_failure',
    'case A expected at least one platform edit',
    { ops: platform.ops },
  );
  assertVerify(
    platform.ops.some((op) => op.kind === 'setTyping') &&
      platform.ops.some((op) => op.kind === 'clearTyping'),
    'contract_failure',
    'case A expected typing to be started and cleared',
    { ops: platform.ops },
  );
  assertVerify(
    platform.ops.some((op) => 'text' in op && op.text.includes('[tool:')),
    'contract_failure',
    'case A did not expose tool status through platform delivery',
    { ops: platform.ops },
  );
  assertVerify(
    platform.ops.some(
      (op) => 'text' in op && op.text.includes('STREAM_JSON_VERIFY_START'),
    ),
    'contract_failure',
    'case A did not expose non-tool partial text before final delivery',
    { ops: platform.ops },
  );
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

async function runCaseB(workdir: string): Promise<void> {
  const caseDir = path.join(workdir, 'case-b');
  await mkdir(caseDir, { recursive: true });
  await writeClaudeSettings(caseDir);
  const sentinel = path.join(caseDir, 'denied.txt');
  const recorder = new RuntimeRecorder(makeRuntime(caseDir, ['Read', 'Bash']));
  const runtime = recorder.wrap();
  const key = sessionKey('case-b');
  const session = runtime.startSession(key, {
    sessionId: randomUUID(),
    workingDir: caseDir,
    toolWhitelist: ['Read'],
    timeoutMs: CASE_TIMEOUT_MS,
  });
  runtime.onEvent(session, () => {});

  try {
    await runDirectTurn(
      runtime,
      session,
      [
        'Use Bash exactly once to run this command and no other command:',
        `printf denied > ${JSON.stringify(sentinel)}`,
      ].join('\n'),
      `case-b-${randomUUID()}`,
    );
  } finally {
    runtime.stopSession(session);
  }

  assertVerify(
    recorder.events.some(
      (event) =>
        event.type === 'tool_call_started' && event.payload.toolName === 'Bash',
    ),
    'model_behavior',
    'case B model did not attempt the requested Bash tool call',
    { events: recorder.events },
  );
  assertVerify(
    recorder.events.some(
      (event) => event.type === 'tool_result' && event.payload.isError,
    ),
    'contract_failure',
    'case B did not receive an error tool_result for denied Bash',
    { events: recorder.events },
  );
  assertVerify(
    !(await pathExists(sentinel)),
    'contract_failure',
    'case B denied Bash still created the sentinel file',
    { sentinel },
  );
}

async function runCaseC(workdir: string): Promise<void> {
  const caseDir = path.join(workdir, 'case-c');
  await mkdir(caseDir, { recursive: true });
  await writeClaudeSettings(caseDir);
  const started = path.join(caseDir, 'started.txt');
  const completed = path.join(caseDir, 'completed.txt');
  const recorder = new RuntimeRecorder(makeRuntime(caseDir, ['Bash']));
  const runtime = recorder.wrap();
  const key = sessionKey('case-c');
  const session = runtime.startSession(key, {
    sessionId: randomUUID(),
    workingDir: caseDir,
    toolWhitelist: ['Bash'],
    timeoutMs: CASE_TIMEOUT_MS,
  });
  runtime.onEvent(session, () => {});

  const turn = runtime.sendInput(session, {
    type: 'user_message',
    traceId: `case-c-${randomUUID()}`,
    text: [
      'Use Bash exactly once to run this command and no other command:',
      `printf started > ${JSON.stringify(started)}; sleep 30; printf completed > ${JSON.stringify(completed)}`,
      'Do not summarize until the command completes.',
    ].join('\n'),
  });

  try {
    await recorder.waitFor(
      (event) =>
        event.type === 'tool_call_started' && event.payload.toolName === 'Bash',
      60_000,
      'case C Bash tool_call_started',
    );
    await withTimeout(
      (async () => {
        while (!(await pathExists(started))) {
          await sleep(100);
        }
      })(),
      10_000,
      'case C Bash start sentinel',
    );

    const interruptAt = Date.now();
    runtime.interrupt(session);
    let terminal: AgentEvent;
    try {
      terminal = await recorder.waitFor(
        (event) =>
          event.type === 'turn_finished' &&
          event.payload.reason === 'user_interrupt',
        10_000,
        'case C user_interrupt turn_finished',
      );
    } catch (err) {
      throw new VerifyError(
        'contract_failure',
        err instanceof Error ? err.message : String(err),
        { events: recorder.events },
      );
    }
    const interruptMs = terminal.timestamp.getTime() - interruptAt;
    assertVerify(
      interruptMs < 10_000,
      'contract_failure',
      `case C interrupt terminal delivery was too slow (${interruptMs}ms)`,
      { events: recorder.events },
    );
    assertVerify(
      terminal.type === 'turn_finished' &&
        (!terminal.payload.source ||
          terminal.payload.source === 'runtime-synthesized'),
      'contract_failure',
      'case C turn_finished source is invalid',
      { terminal },
    );
    await withTimeout(turn, CASE_TIMEOUT_MS, 'case C sendInput');
    await sleep(31_000);
  } finally {
    runtime.stopSession(session);
  }

  assertVerify(
    !(await pathExists(completed)),
    'contract_failure',
    'case C interrupted Bash still completed the post-sleep sentinel write',
    { completed, events: recorder.events },
  );
  assertVerify(
    !recorder.events.some(
      (event) =>
        event.type === 'tool_call_finished' && event.payload.status === 'ok',
    ),
    'contract_failure',
    'case C observed an ok tool_call_finished after interrupt',
    { events: recorder.events },
  );
}

async function main(): Promise<void> {
  const work = await prepareWorkdir();
  const startedAt = Date.now();
  const completed: string[] = [];
  let failed = false;

  try {
    await runPermissionModePreflight(work.dir);
    completed.push('permissionMode preflight');

    await runCompatibilityProbe({
      claudeBin: CLAUDE_BIN,
      logger,
      workingDir: work.dir,
    });
    completed.push('compatibility probe');

    await runCaseA(work.dir);
    completed.push('case A: engine delivery');

    await runCaseB(work.dir);
    completed.push('case B: permission deny');

    await runCaseC(work.dir);
    completed.push('case C: interrupt');

    console.log(
      JSON.stringify(
        {
          ok: true,
          claudeBin: CLAUDE_BIN,
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
    const payload =
      err instanceof VerifyError
        ? {
            ok: false,
            kind: err.kind,
            message: err.message,
            details: err.details,
            workdir: work.dir,
            completed,
          }
        : {
            ok: false,
            kind: 'contract_failure',
            message: err instanceof Error ? err.message : String(err),
            workdir: work.dir,
            completed,
          };
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  } finally {
    if (work.owned && !KEEP_ARTIFACTS && !failed) {
      await rm(work.dir, { recursive: true, force: true });
    } else {
      console.error(`verify artifacts kept at ${work.dir}`);
    }
  }
}

void main();
