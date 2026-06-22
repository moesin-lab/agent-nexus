import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { execa } from 'execa';
import type {
  AgentCommandEnvelope,
  AgentEvent,
  AgentSession,
  SessionConfig,
  SessionKey,
} from '@agent-nexus/protocol';
import { createCodexRuntime } from './index.js';
import type { CodexConfig } from './config.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const mockedExeca = vi.mocked(execa);

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
} as unknown as import('@agent-nexus/daemon').Logger;

const codexConfig: CodexConfig = {
  bin: 'codex',
  workingDir: '/workspace/project',
  sandbox: 'read-only',
  addDirs: [],
  loadUserConfig: false,
  loadRules: false,
};

const sessionKey: SessionKey = {
  platformName: 'discord-main',
  platform: 'discord',
  channelId: 'C1',
  initiatorUserId: 'U1',
};

const sessionConfig: SessionConfig = {
  sessionId: 'sess-1',
  workingDir: '/workspace/project',
  timeoutMs: 300_000,
};

function nextTick(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function fixture(name: string): string {
  return readFileSync(
    new URL(`../testdata/jsonl/${name}.jsonl`, import.meta.url),
    'utf8',
  );
}

function makeExecSubproc(): {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  emitLine: (line: string) => void;
  emitFixture: (body: string) => void;
  resolve: () => void;
  reject: (err: Error) => void;
  then: Promise<void>['then'];
  catch: Promise<void>['catch'];
  finally: Promise<void>['finally'];
  pid: number;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveFn: () => void = () => {};
  let rejectFn: (err: Error) => void = () => {};
  const settled = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  settled.catch(() => {});
  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === 'SIGINT') return true;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      stdout.end();
      rejectFn(
        Object.assign(new Error(`killed ${String(signal)}`), {
          signal: typeof signal === 'string' ? signal : 'SIGTERM',
        }),
      );
    }
    return true;
  });

  return {
    stdout,
    stderr,
    kill,
    pid: 1234,
    emitLine(line: string): void {
      stdout.write(`${line}\n`);
    },
    emitFixture(body: string): void {
      for (const line of body.split('\n')) {
        if (line.trim().length > 0) stdout.write(`${line}\n`);
      }
    },
    resolve(): void {
      stdout.end();
      setImmediate(resolveFn);
    },
    reject(err: Error): void {
      stdout.end();
      setImmediate(() => rejectFn(err));
    },
    then: settled.then.bind(settled),
    catch: settled.catch.bind(settled),
    finally: settled.finally.bind(settled),
  };
}

function makeRuntime() {
  return createCodexRuntime({
    config: codexConfig,
    logger: fakeLogger,
    gracefulInterruptMs: 20,
    sigtermGraceMs: 30,
  });
}

function collectEvents(
  runtime: ReturnType<typeof createCodexRuntime>,
  session: AgentSession,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  runtime.onEvent(session, (event) => {
    events.push(event);
  });
  return events;
}

function commandEnvelope(handlerKey: string): AgentCommandEnvelope {
  return {
    canonicalId: `agent:codex:${handlerKey}`,
    localName: handlerKey,
    handlerKey,
    args: {},
    traceId: `trace-command-${handlerKey}`,
    routingSession: {
      sessionKey,
      platformName: 'discord-main',
      platformType: 'discord',
      channelId: 'C1',
      userId: 'U1',
    },
  };
}

describe('createCodexRuntime', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('返回 codex runtime name 与已验证 capability', () => {
    const runtime = makeRuntime();

    expect(runtime.name()).toBe('codex');
    expect(runtime.capabilities()).toEqual({
      supportsThinking: false,
      supportsStreaming: false,
      supportsToolCallEvents: true,
      supportsInterrupt: true,
      supportsStdinInterrupt: false,
    });
  });

  it('handleCommand new 停止当前 session 并清除 opaque conversation ref', async () => {
    const child = makeExecSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 'trace-new-active',
    });
    await nextTick();
    child.emitLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-new' }),
    );
    await nextTick();

    const result = await runtime.handleCommand(session, commandEnvelope('new'));

    expect(result).toEqual({
      status: 'handled',
      message: '[new session ready]',
      updatedAgentSessionId: null,
    });
    expect(session.state).toBe('Stopped');
    expect(runtime.isAlive(session)).toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(events.at(-1)).toMatchObject({
      type: 'session_stopped',
      traceId: 'trace-command-new',
      payload: { reason: 'user_stop' },
    });
    await turn;
  });

  it('handleCommand stop 复用 interrupt 路径并返回明确结果', async () => {
    vi.useFakeTimers();
    const child = makeExecSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 'trace-stop-active',
    });
    await nextTick();
    child.emitLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-stop' }),
    );
    child.emitLine(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: "/bin/zsh -lc 'sleep 60'",
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      }),
    );
    await nextTick();

    const result = await runtime.handleCommand(session, commandEnvelope('stop'));

    expect(result).toEqual({ status: 'handled', message: '[stop requested]' });
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    await vi.advanceTimersByTimeAsync(20);
    await turn;
    await vi.advanceTimersByTimeAsync(30);

    const terminal = events.find((event) => event.type === 'turn_finished');
    expect(terminal).toMatchObject({
      type: 'turn_finished',
      payload: {
        reason: 'user_interrupt',
        source: 'runtime-synthesized',
      },
    });
  });

  it('handleCommand stop 没有 active turn 时返回 rejected', async () => {
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);

    await expect(runtime.handleCommand(undefined, commandEnvelope('stop'))).resolves.toEqual({
      status: 'rejected',
      message: '[no active output]',
    });
    await expect(runtime.handleCommand(session, commandEnvelope('stop'))).resolves.toEqual({
      status: 'rejected',
      message: '[no active output]',
    });
  });

  it('首轮用 codex exec --json 并把 baseline JSONL 映射成 AgentEvent', async () => {
    const child = makeExecSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'hello',
      traceId: 'trace-1',
    });
    await nextTick();

    expect(mockedExeca).toHaveBeenCalledWith(
      'codex',
      [
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
        '--cd',
        '/workspace/project',
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--ignore-rules',
        'hello',
      ],
      { buffer: false, stdin: 'ignore' },
    );

    child.emitFixture(fixture('baseline-text'));
    child.resolve();
    await turn;

    expect(session.agentSessionId).toBe('thread-baseline');
    expect(session.state).toBe('Idle');
    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'text_final',
      'usage',
      'turn_finished',
    ]);
    const started = events[0];
    if (started?.type !== 'session_started') throw new Error('expected started');
    expect(started.payload).toMatchObject({
      agentSessionId: 'thread-baseline',
      pid: 1234,
      workingDir: '/workspace/project',
      capabilities: { supportsStreaming: false },
    });
    const text = events[1];
    if (text?.type !== 'text_final') throw new Error('expected text');
    expect(text.payload.text).toBe('P4_OK');
    const usage = events[2];
    if (usage?.type !== 'usage') throw new Error('expected usage');
    expect(usage.payload).toMatchObject({
      model: 'unknown',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
      costUsd: null,
      turnSequence: 1,
      toolCallsThisTurn: 0,
      completeness: 'partial',
    });
    const finished = events[3];
    if (finished?.type !== 'turn_finished') throw new Error('expected finished');
    expect(finished.payload).toEqual({ reason: 'stop', turnSequence: 1 });
  });

  it('第二轮用 exec resume thread_id 且同一 thread 不重复 session_started', async () => {
    const firstChild = makeExecSubproc();
    const secondChild = makeExecSubproc();
    mockedExeca
      .mockReturnValueOnce(firstChild as unknown as ReturnType<typeof execa>)
      .mockReturnValueOnce(secondChild as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const first = runtime.sendInput(session, {
      type: 'user_message',
      text: 'first',
      traceId: 'trace-1',
    });
    await nextTick();
    firstChild.emitFixture(fixture('baseline-text'));
    firstChild.resolve();
    await first;

    const second = runtime.sendInput(session, {
      type: 'user_message',
      text: 'second',
      traceId: 'trace-2',
    });
    await nextTick();
    expect(mockedExeca.mock.calls[1]![1]).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      '--cd',
      '/workspace/project',
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      'thread-baseline',
      'second',
    ]);
    secondChild.emitFixture(fixture('resume-text'));
    secondChild.resolve();
    await second;

    expect(session.agentSessionId).toBe('thread-baseline');
    expect(events.filter((event) => event.type === 'session_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'text_final')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'turn_finished')).toHaveLength(2);
  });

  it('resumeFromAgentSessionId 作为首轮 thread，返回不一致时 fail closed', async () => {
    const child = makeExecSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      resumeFromAgentSessionId: 'expected-thread',
    });
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'resume',
      traceId: 'trace-mismatch',
    });
    await nextTick();
    expect(mockedExeca.mock.calls[0]![1]).toEqual([
      '--sandbox',
      'read-only',
      '--ask-for-approval',
      'never',
      '--cd',
      '/workspace/project',
      'exec',
      'resume',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      'expected-thread',
      'resume',
    ]);
    child.emitLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'different-thread' }),
    );
    child.reject(new Error('codex exit'));
    await turn;

    expect(session.state).toBe('Errored');
    expect(events.map((event) => event.type)).toEqual([
      'error',
      'turn_finished',
      'session_stopped',
    ]);
    const err = events[0];
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload).toMatchObject({
      errorKind: 'agent',
      code: 'codex_thread_mismatch',
    });
  });

  it('command_execution 映射为工具 start/result/finished 顺序', async () => {
    const child = makeExecSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'tool',
      traceId: 'trace-tool',
    });
    await nextTick();
    child.emitFixture(fixture('command-execution'));
    child.resolve();
    await turn;

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'tool_call_started',
      'tool_result',
      'tool_call_finished',
      'text_final',
      'usage',
      'turn_finished',
    ]);
    const started = events[1];
    if (started?.type !== 'tool_call_started') {
      throw new Error('expected tool_call_started');
    }
    expect(started.payload).toEqual({
      callId: 'item_0',
      toolName: 'command_execution',
      inputSummary: "/bin/zsh -lc 'printf TOOL_OK'",
    });
    const result = events[2];
    if (result?.type !== 'tool_result') throw new Error('expected result');
    expect(result.payload).toEqual({
      callId: 'item_0',
      resultSequence: 0,
      content: { kind: 'text', text: 'TOOL_OK' },
      isError: false,
    });
    const finished = events[3];
    if (finished?.type !== 'tool_call_finished') throw new Error('expected finished');
    expect(finished.payload.status).toBe('ok');
  });

  it('error 加 turn.failed 映射为诊断 error 和 terminal error', async () => {
    const child = makeExecSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'fail',
      traceId: 'trace-fail',
    });
    await nextTick();
    child.emitFixture(fixture('turn-failed'));
    child.reject(Object.assign(new Error('codex exit 1'), { exitCode: 1 }));
    await turn;

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'error',
      'error',
      'turn_finished',
    ]);
    const terminal = events.at(-1);
    if (terminal?.type !== 'turn_finished') throw new Error('expected terminal');
    expect(terminal.payload).toEqual({ reason: 'error', turnSequence: 1 });
    expect(session.state).toBe('Idle');
  });

  it('未知 JSONL event 只打 debug 日志且不阻断 turn', async () => {
    const child = makeExecSubproc();
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'unknown',
      traceId: 'trace-unknown',
    });
    await nextTick();
    child.emitFixture(fixture('unknown-events'));
    child.resolve();
    await turn;

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'usage',
      'turn_finished',
    ]);
    expect(fakeLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'mystery.event' }),
      'codex_unknown_event',
    );
    expect(fakeLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: 'mystery_item' }),
      'codex_unknown_item',
    );
  });

  it('interrupt 终止当前子进程并只合成一次 user_interrupt terminal', async () => {
    vi.useFakeTimers();
    const child = makeExecSubproc();
    child.kill.mockImplementation(() => true);
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 'trace-int',
    });
    await nextTick();
    child.emitLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-int' }),
    );
    child.emitLine(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: "/bin/zsh -lc 'sleep 60'",
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      }),
    );
    await nextTick();

    runtime.interrupt(session);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    await vi.advanceTimersByTimeAsync(10);
    await turn;
    child.emitFixture(fixture('late-terminal-after-interrupt'));
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(30);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    const terminals = events.filter((event) => event.type === 'turn_finished');
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0];
    if (terminal?.type !== 'turn_finished') throw new Error('expected terminal');
    expect(terminal.payload).toEqual({
      reason: 'user_interrupt',
      turnSequence: 1,
      source: 'runtime-synthesized',
    });
    const toolFinished = events.find(
      (event) => event.type === 'tool_call_finished',
    );
    if (toolFinished?.type !== 'tool_call_finished') {
      throw new Error('expected tool_call_finished');
    }
    expect(toolFinished.payload.status).toBe('cancelled');
  });

  it('interrupt 后子进程立刻退出也保持 user_interrupt terminal', async () => {
    const child = makeExecSubproc();
    child.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
      if (signal === 'SIGINT') {
        child.reject(Object.assign(new Error('interrupted'), { signal: 'SIGINT' }));
        return true;
      }
      return true;
    });
    mockedExeca.mockReturnValueOnce(child as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 'trace-int-fast-exit',
    });
    await nextTick();
    child.emitLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-int-fast' }),
    );
    child.emitLine(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: "/bin/zsh -lc 'sleep 60'",
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      }),
    );
    await nextTick();

    runtime.interrupt(session);
    await turn;

    const terminals = events.filter((event) => event.type === 'turn_finished');
    expect(terminals).toHaveLength(1);
    const terminal = terminals[0];
    if (terminal?.type !== 'turn_finished') throw new Error('expected terminal');
    expect(terminal.payload).toEqual({
      reason: 'user_interrupt',
      turnSequence: 1,
      source: 'runtime-synthesized',
    });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('interrupt 后下一轮等待旧进程清理完成再 resume', async () => {
    vi.useFakeTimers();
    const firstChild = makeExecSubproc();
    firstChild.kill.mockImplementation(() => true);
    const secondChild = makeExecSubproc();
    mockedExeca
      .mockReturnValueOnce(firstChild as unknown as ReturnType<typeof execa>)
      .mockReturnValueOnce(secondChild as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = collectEvents(runtime, session);

    const first = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 'trace-int-1',
    });
    await nextTick();
    firstChild.emitLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-int' }),
    );
    runtime.interrupt(session);
    await vi.advanceTimersByTimeAsync(10);
    await first;

    const second = runtime.sendInput(session, {
      type: 'user_message',
      text: 'next',
      traceId: 'trace-int-2',
    });
    await nextTick();
    expect(mockedExeca).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(30);
    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL');
    await nextTick();
    expect(mockedExeca).toHaveBeenCalledTimes(2);
    expect(mockedExeca.mock.calls[1]![1]).toEqual(
      expect.arrayContaining(['exec', 'resume', 'thread-int', 'next']),
    );

    secondChild.emitLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-int' }),
    );
    secondChild.emitLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'agent_message', text: 'after' },
      }),
    );
    secondChild.emitLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      }),
    );
    secondChild.resolve();
    await second;

    expect(events.filter((event) => event.type === 'turn_finished')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'text_final')).toHaveLength(1);
  });

  it('timeout 合成 wallclock_timeout 并保留 session 可恢复', async () => {
    vi.useFakeTimers();
    const firstChild = makeExecSubproc();
    firstChild.kill.mockImplementation(() => true);
    const secondChild = makeExecSubproc();
    mockedExeca
      .mockReturnValueOnce(firstChild as unknown as ReturnType<typeof execa>)
      .mockReturnValueOnce(secondChild as unknown as ReturnType<typeof execa>);
    const runtime = makeRuntime();
    const session = runtime.startSession(sessionKey, {
      ...sessionConfig,
      timeoutMs: 100,
    });
    const events = collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'slow',
      traceId: 'trace-timeout',
    });
    await nextTick();
    await vi.advanceTimersByTimeAsync(100);
    await turn;

    expect(firstChild.kill).toHaveBeenCalledWith('SIGINT');
    expect(events.map((event) => event.type)).toEqual([
      'turn_finished',
      'error',
    ]);
    const terminal = events[0];
    if (terminal?.type !== 'turn_finished') throw new Error('expected terminal');
    expect(terminal.payload).toMatchObject({
      reason: 'wallclock_timeout',
      source: 'runtime-synthesized',
    });
    const err = events[1];
    if (err?.type !== 'error') throw new Error('expected error');
    expect(err.payload).toMatchObject({
      errorKind: 'agent',
      code: 'codex_wallclock_timeout',
    });

    const second = runtime.sendInput(session, {
      type: 'user_message',
      text: 'after-timeout',
      traceId: 'trace-after-timeout',
    });
    await nextTick();
    expect(mockedExeca).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(30);
    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL');
    await nextTick();
    expect(session.state).toBe('Busy');
    expect(mockedExeca).toHaveBeenCalledTimes(2);
    secondChild.emitLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-after-timeout' }),
    );
    secondChild.emitLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 },
      }),
    );
    secondChild.resolve();
    await second;
    expect(session.state).toBe('Idle');
  });
});
