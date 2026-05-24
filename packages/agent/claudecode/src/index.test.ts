import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import type {
  AgentEvent,
  AgentSession,
  SessionConfig,
  SessionKey,
} from '@agent-nexus/protocol';
import { createClaudeCodeRuntime } from './index.js';

const mockedExeca = vi.mocked(execa);

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
} as unknown as import('@agent-nexus/daemon').Logger;

const sessionKey: SessionKey = {
  platformName: 'discord-main',
  platform: 'discord',
  channelId: 'C1',
  initiatorUserId: 'U1',
};

const sessionConfig: SessionConfig = {
  sessionId: 'sess-1',
  workingDir: '/x',
  toolWhitelist: ['Read', 'Bash'],
  timeoutMs: 300_000,
};

function nextTick(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function makeInteractiveSubproc(): {
  stdout: PassThrough;
  stdin: PassThrough;
  writes: string[];
  kill: ReturnType<typeof vi.fn>;
  emitJson: (value: unknown) => void;
  closeStdout: () => void;
  resolve: () => void;
  reject: (err: Error) => void;
  then: Promise<void>['then'];
  catch: Promise<void>['catch'];
  finally: Promise<void>['finally'];
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const writes: string[] = [];
  stdin.on('data', (chunk: Buffer) => {
    writes.push(chunk.toString('utf8'));
  });

  let resolveFn: () => void = () => {};
  let rejectFn: (err: Error) => void = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  settled.catch(() => {});

  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === 'SIGINT') return true;
    stdout.end();
    rejectFn(
      Object.assign(new Error(`killed ${String(signal)}`), {
        signal: typeof signal === 'string' ? signal : 'SIGTERM',
        isTerminated: true,
      }),
    );
    return true;
  });

  return {
    stdout,
    stdin,
    writes,
    kill,
    emitJson(value: unknown): void {
      stdout.write(`${JSON.stringify(value)}\n`);
    },
    closeStdout(): void {
      stdout.end();
    },
    resolve: resolveFn,
    reject: rejectFn,
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  };
}

async function collectEvents(
  runtime: ReturnType<typeof createClaudeCodeRuntime>,
  session: AgentSession,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  runtime.onEvent(session, (e) => {
    events.push(e);
  });
  return events;
}

function writtenLines(fake: { writes: string[] }): string[] {
  return fake.writes
    .join('')
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('createClaudeCodeRuntime persistent stream-json session', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns one headless stream-json subprocess and writes multiple turns to the same stdin', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/fallback',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const first = runtime.sendInput(session, {
      type: 'user_message',
      text: 'hello',
      traceId: 't-1',
    });
    await nextTick();

    const args = mockedExeca.mock.calls[0]![1] as string[];
    const opts = mockedExeca.mock.calls[0]![2] as { cwd?: string; buffer?: boolean };
    expect(args).not.toContain('--print');
    expect(args).toEqual(
      expect.arrayContaining([
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--permission-prompt-tool',
        'stdio',
        '--replay-user-messages',
        '--verbose',
        '--allowed-tools',
        'Read,Bash',
        '--permission-mode',
        'default',
      ]),
    );
    expect(opts.cwd).toBe('/x');
    expect(opts.buffer).toBe(false);
    expect(JSON.parse(writtenLines(child)[0]!)).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });

    child.emitJson({
      type: 'system',
      subtype: 'init',
      session_id: 'sid-1',
      cwd: '/x',
      permissionMode: 'default',
    });
    child.emitJson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    });
    await first;

    const second = runtime.sendInput(session, {
      type: 'user_message',
      text: 'again',
      traceId: 't-2',
    });
    await nextTick();
    expect(mockedExeca).toHaveBeenCalledTimes(1);
    expect(JSON.parse(writtenLines(child)[1]!)).toMatchObject({
      type: 'user',
      message: { role: 'user', content: 'again' },
    });
    child.emitJson({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }] },
    });
    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    });
    await second;

    const started = events.find((event) => event.type === 'session_started');
    if (started?.type !== 'session_started') throw new Error('expected session_started');
    expect(started.payload.capabilities).toMatchObject({
      supportsStreaming: true,
      supportsToolCallEvents: true,
      supportsInterrupt: true,
      supportsStdinInterrupt: false,
      supportsNativeToolWhitelist: true,
    });
    expect(events.filter((event) => event.type === 'text_final')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'turn_finished')).toHaveLength(2);
  });

  it('maps tool_use and tool_result into ordered tool events', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      toolWhitelist: ['Read'],
    });
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'read',
      traceId: 't-tool',
    });
    await nextTick();
    child.emitJson({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu-1', name: 'Read', input: { file_path: 'a.txt' } }],
      },
    });
    child.emitJson({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-1',
            content: [{ type: 'text', text: 'file' }],
            is_error: false,
          },
        ],
      },
    });
    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 1 },
      total_cost_usd: 0.01,
    });
    await turn;

    expect(events.map((event) => event.type)).toEqual([
      'tool_call_started',
      'tool_result',
      'tool_call_finished',
      'usage',
      'turn_finished',
    ]);
    const started = events[0];
    if (started?.type !== 'tool_call_started') {
      throw new Error('expected tool_call_started');
    }
    expect(started.payload.inputSummary).toBe('a.txt');
    const result = events[1];
    if (result?.type !== 'tool_result') throw new Error('expected tool_result');
    expect(result.payload.content).toEqual({
      kind: 'blocks',
      blocks: [{ type: 'text', text: 'file' }],
    });
    const finished = events[2];
    if (finished?.type !== 'tool_call_finished') throw new Error('expected finished');
    expect(finished.payload.status).toBe('ok');
  });

  it('summarizes Bash tool input as command text', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      toolWhitelist: ['Bash'],
    });
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'run tests',
      traceId: 't-bash',
    });
    await nextTick();
    child.emitJson({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu-bash',
            name: 'Bash',
            input: { command: 'npm test' },
          },
        ],
      },
    });
    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await turn;

    const started = events.find((event) => event.type === 'tool_call_started');
    if (started?.type !== 'tool_call_started') {
      throw new Error('expected tool_call_started');
    }
    expect(started.payload.inputSummary).toBe('npm test');
  });

  it('summarizes file and search tools by target fields', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      toolWhitelist: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
    });
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'inspect',
      traceId: 't-targets',
    });
    await nextTick();
    child.emitJson({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'toolu-read', name: 'Read', input: { file_path: 'src/a.ts' } },
          { type: 'tool_use', id: 'toolu-edit', name: 'Edit', input: { file_path: 'src/b.ts', old_string: 'x' } },
          { type: 'tool_use', id: 'toolu-write', name: 'Write', input: { file_path: 'src/c.ts', content: 'x' } },
          { type: 'tool_use', id: 'toolu-grep', name: 'Grep', input: { pattern: 'TODO' } },
          { type: 'tool_use', id: 'toolu-glob', name: 'Glob', input: { pattern: '**/*.ts' } },
        ],
      },
    });
    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await turn;

    const summaries = events
      .filter((event): event is Extract<AgentEvent, { type: 'tool_call_started' }> =>
        event.type === 'tool_call_started',
      )
      .map((event) => [event.payload.toolName, event.payload.inputSummary]);
    expect(summaries).toEqual([
      ['Read', 'src/a.ts'],
      ['Edit', 'src/b.ts'],
      ['Write', 'src/c.ts'],
      ['Grep', 'TODO'],
      ['Glob', '**/*.ts'],
    ]);
  });

  it('normalizes tool_result content shapes', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      toolWhitelist: ['Read'],
    });
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'tool results',
      traceId: 't-results',
    });
    await nextTick();
    child.emitJson({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'missing' },
          { type: 'tool_result', tool_use_id: 'null', content: null },
          { type: 'tool_result', tool_use_id: 'text', content: 'hello' },
          { type: 'tool_result', tool_use_id: 'empty-text', content: '' },
          { type: 'tool_result', tool_use_id: 'blocks', content: [{ type: 'text', text: 'file' }] },
          { type: 'tool_result', tool_use_id: 'empty-array', content: [] },
          { type: 'tool_result', tool_use_id: 'bad-array', content: [1] },
          { type: 'tool_result', tool_use_id: 'object', content: { ok: true } },
          { type: 'tool_result', tool_use_id: 'scalar', content: 42 },
        ],
      },
    });
    child.emitJson({ type: 'result', stop_reason: 'end_turn' });
    await turn;

    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.payload.content.kind)).toEqual([
      'empty',
      'empty',
      'text',
      'text',
      'blocks',
      'blocks',
      'unknown',
      'object',
      'unknown',
    ]);
  });

  it('responds to can_use_tool with allow or deny based on bare tool whitelist', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      toolWhitelist: ['Read'],
    });
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'maybe bash',
      traceId: 't-perm',
    });
    await nextTick();
    child.emitJson({
      type: 'control_request',
      request_id: 'req-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'echo no' },
        tool_use_id: 'toolu-bash',
      },
    });
    await nextTick();

    const response = JSON.parse(writtenLines(child)[1]!);
    expect(response).toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: { behavior: 'deny' },
      },
    });

    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    });
    await turn;
    expect(events.at(-1)?.type).toBe('turn_finished');

    const allowTurn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'read',
      traceId: 't-perm-allow',
    });
    await nextTick();
    child.emitJson({
      type: 'control_request',
      request_id: 'req-2',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Read',
        input: { file_path: 'README.md' },
        tool_use_id: 'toolu-read',
      },
    });
    await nextTick();

    const allowResponse = JSON.parse(writtenLines(child)[3]!);
    expect(allowResponse).toMatchObject({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-2',
        response: {
          behavior: 'allow',
          updatedInput: { file_path: 'README.md' },
        },
      },
    });

    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    });
    await allowTurn;
  });

  it('terminates fail-closed when control_response cannot be written', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      toolWhitelist: ['Read'],
    });
    const events = await collectEvents(runtime, session);
    const originalWrite = child.stdin.write.bind(child.stdin);
    let failWrites = false;
    child.stdin.write = ((...args: Parameters<typeof child.stdin.write>) => {
      if (failWrites) throw new Error('broken stdin');
      return originalWrite(...args);
    }) as typeof child.stdin.write;

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'maybe bash',
      traceId: 't-control-fail',
    });
    await nextTick();
    failWrites = true;
    child.emitJson({
      type: 'control_request',
      request_id: 'req-fail',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'echo no' },
      },
    });
    await turn;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    const err = events.find((event) => event.type === 'error');
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload.errorKind).toBe('permission_control_write_failed');
    expect(events.at(-1)?.type).toBe('session_stopped');
  });

  it('fails closed when init reports bypassPermissions', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'hi',
      traceId: 't-bypass',
    });
    await nextTick();
    child.emitJson({
      type: 'system',
      subtype: 'init',
      session_id: 'sid-bypass',
      cwd: '/x',
      permissionMode: 'bypassPermissions',
    });
    await turn;

    expect(child.kill).toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual([
      'error',
      'turn_finished',
      'session_stopped',
    ]);
    const err = events[0];
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload.errorKind).toBe('permission_mode_unsafe');
  });

  it.each([
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'dontAsk',
    'plan',
  ] as const)(
    'passes configured permissionLevel=%s through argv and accepts matching init',
    async (permissionLevel) => {
      const child = makeInteractiveSubproc();
      mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

      const runtime = createClaudeCodeRuntime({
        claudeBin: 'claude',
        allowedTools: ['Read'],
        permissionLevel,
        defaultWorkingDir: '/x',
        logger: fakeLogger,
      });
      const session = runtime.startSession(sessionKey, sessionConfig);
      const events = await collectEvents(runtime, session);

      const turn = runtime.sendInput(session, {
        type: 'user_message',
        text: 'hi',
        traceId: `t-${permissionLevel}-configured`,
      });
      await nextTick();
      const args = mockedExeca.mock.calls[0]![1] as string[];
      expect(args).toEqual(
        expect.arrayContaining(['--permission-mode', permissionLevel]),
      );
      child.emitJson({
        type: 'system',
        subtype: 'init',
        session_id: `sid-${permissionLevel}-ok`,
        cwd: '/x',
        permissionMode: permissionLevel,
      });
      child.emitJson({ type: 'result', stop_reason: 'end_turn' });
      await turn;

      expect(child.kill).not.toHaveBeenCalled();
      expect(events.map((event) => event.type)).toEqual([
        'session_started',
        'turn_finished',
      ]);
    },
  );

  it('fails closed when configured bypassPermissions but init reports a different mode', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      permissionLevel: 'bypassPermissions',
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'hi',
      traceId: 't-bypass-mismatch',
    });
    await nextTick();
    child.emitJson({
      type: 'system',
      subtype: 'init',
      session_id: 'sid-bypass-mismatch',
      cwd: '/x',
      permissionMode: 'default',
    });
    await turn;

    const err = events[0];
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload.errorKind).toBe('permission_mode_unsafe');
    expect(err.payload.message).toMatch(/permissionMode mismatch/);
  });

  it('fails closed when default config init reports acceptEdits', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'hi',
      traceId: 't-accept-edits',
    });
    await nextTick();
    child.emitJson({
      type: 'system',
      subtype: 'init',
      session_id: 'sid-accept',
      cwd: '/x',
      permissionMode: 'acceptEdits',
    });
    await turn;

    const err = events[0];
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload.errorKind).toBe('permission_mode_unsafe');
    expect(err.payload.message).toMatch(/permissionMode mismatch/);
  });

  it('fails closed when init does not report permissionMode', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'hi',
      traceId: 't-missing-permission-mode',
    });
    await nextTick();
    child.emitJson({
      type: 'system',
      subtype: 'init',
      session_id: 'sid-missing-permission-mode',
      cwd: '/x',
    });
    await turn;

    const err = events[0];
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload.errorKind).toBe('permission_mode_unsafe');
    expect(err.payload.message).toMatch(/permissionMode missing or invalid/);
  });

  it('rejects unsupported tool subpatterns instead of degrading them to bare tool allow', async () => {
    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      toolWhitelist: ['Bash(git *)'],
    });
    const events = await collectEvents(runtime, session);

    await runtime.sendInput(session, {
      type: 'user_message',
      text: 'git status',
      traceId: 't-subpattern',
    });

    expect(mockedExeca).not.toHaveBeenCalled();
    const err = events[0];
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload.errorKind).toBe('tool_whitelist_invalid');
  });

  it('delays the next stdin write after synthetic interrupt until cleanup ack arrives', async () => {
    vi.useFakeTimers();
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
      syntheticTurnFinishedDeliveryMs: 250,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const first = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 't-int-1',
    });
    await nextTick();
    expect(writtenLines(child)).toHaveLength(1);

    runtime.interrupt(session);
    await vi.advanceTimersByTimeAsync(250);
    await first;

    const second = runtime.sendInput(session, {
      type: 'user_message',
      text: 'next',
      traceId: 't-int-2',
    });
    await nextTick();
    expect(writtenLines(child)).toHaveLength(1);

    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 0 },
      total_cost_usd: 0,
    });
    await nextTick();
    await nextTick();
    await nextTick();
    expect(writtenLines(child)).toHaveLength(2);

    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    });
    await second;

    const synthetic = events.find(
      (event) =>
        event.type === 'turn_finished' &&
        event.traceId === 't-int-1',
    );
    if (synthetic?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(synthetic.payload).toMatchObject({
      reason: 'user_interrupt',
      source: 'runtime-synthesized',
    });
  });

  it('maps aborted_streaming result before synthetic interrupt delay as user_interrupt', async () => {
    vi.useFakeTimers();
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
      syntheticTurnFinishedDeliveryMs: 250,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 't-aborted',
    });
    await nextTick();
    runtime.interrupt(session);
    child.emitJson({
      type: 'result',
      stop_reason: null,
      terminal_reason: 'aborted_streaming',
    });
    await turn;
    await vi.advanceTimersByTimeAsync(250);

    const finished = events.find((event) => event.type === 'turn_finished');
    if (finished?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(finished.payload).toMatchObject({ reason: 'user_interrupt' });
    expect(finished.payload).not.toHaveProperty('source');
  });

  it('maps a real error result after SIGINT but before synthetic delay as user_interrupt', async () => {
    vi.useFakeTimers();
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
      syntheticTurnFinishedDeliveryMs: 250,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 't-interrupt-error',
    });
    await nextTick();
    child.emitJson({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu-1',
            name: 'Bash',
            input: { command: 'sleep 30' },
          },
        ],
      },
    });
    runtime.interrupt(session);
    child.emitJson({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-1',
            content: 'The user does not want to proceed.',
            is_error: true,
          },
        ],
      },
    });
    child.emitJson({
      type: 'result',
      subtype: 'error_during_execution',
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    });
    await turn;
    await vi.advanceTimersByTimeAsync(250);

    const finished = events.find(
      (event) => event.type === 'turn_finished',
    );
    if (finished?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(finished.payload).toMatchObject({ reason: 'user_interrupt' });
    expect(finished.payload).not.toHaveProperty('source');

    const toolFinished = events.find(
      (event) => event.type === 'tool_call_finished',
    );
    if (toolFinished?.type !== 'tool_call_finished') {
      throw new Error('expected tool_call_finished');
    }
    expect(toolFinished.payload.status).toBe('cancelled');
  });

  it('does not rewrite a successful real result after SIGINT as user_interrupt', async () => {
    vi.useFakeTimers();
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
      syntheticTurnFinishedDeliveryMs: 250,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'almost done',
      traceId: 't-interrupt-success',
    });
    await nextTick();
    child.emitJson({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu-1',
            name: 'Bash',
            input: { command: 'printf done' },
          },
        ],
      },
    });
    runtime.interrupt(session);
    child.emitJson({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-1',
            content: 'done',
            is_error: false,
          },
        ],
      },
    });
    child.emitJson({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    });
    await turn;
    await vi.advanceTimersByTimeAsync(250);

    const finished = events.find(
      (event) => event.type === 'turn_finished',
    );
    if (finished?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(finished.payload).toMatchObject({ reason: 'stop' });
    expect(finished.payload).not.toHaveProperty('source');

    const toolFinished = events.find(
      (event) => event.type === 'tool_call_finished',
    );
    if (toolFinished?.type !== 'tool_call_finished') {
      throw new Error('expected tool_call_finished');
    }
    expect(toolFinished.payload.status).toBe('ok');
  });

  it('marks wallclock timeout as synthetic terminal and stops the session with error', async () => {
    vi.useFakeTimers();
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
      perInputTimeoutMs: 100,
    });
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      timeoutMs: 100,
    });
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'slow',
      traceId: 't-timeout',
    });
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    await turn;

    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    expect(events.map((event) => event.type)).toEqual([
      'turn_finished',
      'error',
      'session_stopped',
    ]);
    const finished = events[0];
    if (finished?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(finished.payload).toMatchObject({
      reason: 'wallclock_timeout',
      source: 'runtime-synthesized',
    });
  });

  it('upgrades interrupted turn cleanup from SIGTERM to SIGKILL', async () => {
    vi.useFakeTimers();
    const child = makeInteractiveSubproc();
    child.kill.mockImplementation(() => true);
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
      syntheticTurnFinishedDeliveryMs: 10,
      gracefulInterruptMs: 20,
      sigtermGraceMs: 30,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 't-cleanup',
    });
    await nextTick();
    runtime.interrupt(session);
    await vi.advanceTimersByTimeAsync(10);
    await turn;
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(30);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    const err = events.find((event) => event.type === 'error');
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload.errorKind).toBe('interrupt_cleanup_failed');
  });

  it('rejects a third sendInput while one turn is running and one is queued', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const first = runtime.sendInput(session, {
      type: 'user_message',
      text: 'first',
      traceId: 't-q-1',
    });
    await nextTick();
    const second = runtime.sendInput(session, {
      type: 'user_message',
      text: 'second',
      traceId: 't-q-2',
    });
    await nextTick();
    await runtime.sendInput(session, {
      type: 'user_message',
      text: 'third',
      traceId: 't-q-3',
    });

    const err = events.find(
      (event) => event.type === 'error' && event.traceId === 't-q-3',
    );
    if (err?.type !== 'error') throw new Error('expected queue error');
    expect(err.payload.errorKind).toBe('concurrent_send_input');

    child.emitJson({ type: 'result', stop_reason: 'end_turn' });
    await first;
    await nextTick();
    child.emitJson({ type: 'result', stop_reason: 'end_turn' });
    await second;
  });

  it('stops the session when a persistent child fails while idle', async () => {
    const child = makeInteractiveSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'hi',
      traceId: 't-idle',
    });
    await nextTick();
    child.emitJson({ type: 'result', stop_reason: 'end_turn' });
    await turn;

    child.reject(new Error('idle crash'));
    await nextTick();

    const err = events.find((event) => event.type === 'error');
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload.errorKind).toBe('spawn_failed');
    expect(events.at(-1)?.type).toBe('session_stopped');
  });
});
