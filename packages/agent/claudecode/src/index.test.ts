import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';

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
  platform: 'discord',
  channelId: 'C1',
  initiatorUserId: 'U1',
};

const sessionConfig: SessionConfig = {
  sessionId: 'sess-1',
  workingDir: '/x',
  toolWhitelist: ['Bash', 'Read'],
  timeoutMs: 300_000,
};

/**
 * 把 stdout 行流 + await 行为揉成一个 thenable mock subprocess。
 * 关键：execa(...) 既是 Promise（要 await），又有 .stdout 是 Readable。
 */
function makeMockSubproc(lines: string[]): {
  stdout: Readable;
  then: Promise<void>['then'];
  catch: Promise<void>['catch'];
  finally: Promise<void>['finally'];
} {
  const stdout = Readable.from(lines.map((l) => l + '\n'));
  const settled = Promise.resolve();
  return {
    stdout,
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

describe('createClaudeCodeRuntime.sendInput', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  it('happy path: stream-json 输出 → 顺序 emit session_started / text_final / usage / turn_finished{stop}', async () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sid-1',
        cwd: '/x',
        tools: [],
        model: 'claude',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'sid-1',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.01,
      }),
    ];
    mockedExeca.mockReturnValueOnce(
      makeMockSubproc(lines) as unknown as ReturnType<typeof execa>,
    );

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash', 'Read'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    await runtime.sendInput(session, { type: 'user_message', text: 'hello', traceId: 't-1' });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session_started',
      'text_final',
      'usage',
      'turn_finished',
    ]);

    const started = events[0];
    if (started?.type !== 'session_started') throw new Error('expected session_started');
    expect(started.payload.agentSessionId).toBe('sid-1');

    const textFinal = events[1];
    if (textFinal?.type !== 'text_final') throw new Error('expected text_final');
    expect(textFinal.payload.text).toBe('hi');

    const usageEvt = events[2];
    if (usageEvt?.type !== 'usage') throw new Error('expected usage');
    expect(usageEvt.payload.completeness).toBe('complete');
    expect(usageEvt.payload.inputTokens).toBe(10);
    expect(usageEvt.payload.outputTokens).toBe(5);
    expect(usageEvt.payload.costUsd).toBe(0.01);

    const turnFinished = events[3];
    if (turnFinished?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnFinished.payload.reason).toBe('stop');

    // agentSessionId 应该写回 session
    expect(session.agentSessionId).toBe('sid-1');
  });

  it('非 JSON 行被跳过', async () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sid-2',
        cwd: '/x',
      }),
      'this is not json',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.001,
      }),
    ];
    mockedExeca.mockReturnValueOnce(
      makeMockSubproc(lines) as unknown as ReturnType<typeof execa>,
    );

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-2' });

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'session_started',
      'text_final',
      'usage',
      'turn_finished',
    ]);
    const textFinal = events[1];
    if (textFinal?.type !== 'text_final') throw new Error('expected text_final');
    expect(textFinal.payload.text).toBe('hi');
  });

  it('per-session workingDir 进 execa cwd 选项（非 --cwd flag），toolWhitelist 写入 argv', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-x', cwd: '/per-sess' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        total_cost_usd: 0.001,
      }),
    ];
    mockedExeca.mockReturnValueOnce(
      makeMockSubproc(lines) as unknown as ReturnType<typeof execa>,
    );

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'], // runtime 默认（不该被使用）
      defaultWorkingDir: '/runtime-default', // runtime 默认（不该被使用）
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, {
      sessionId: 'sess-per',
      workingDir: '/per-sess',
      toolWhitelist: ['Read', 'Grep'],
      timeoutMs: 300_000,
    });

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-x' });

    const args = mockedExeca.mock.calls[0]![1] as string[];
    const opts = mockedExeca.mock.calls[0]![2] as { cwd?: string };
    // CC CLI 2.1.x 没有 --cwd flag；工作目录通过子进程 cwd 选项传入（OS 级 inherit-once 而非 flag）
    expect(args.indexOf('--cwd')).toBe(-1);
    expect(opts.cwd).toBe('/per-sess');
    const toolsIdx = args.indexOf('--allowed-tools');
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe('Read,Grep');
  });

  it('per-session timeoutMs 进 execa timeout 选项（不被 runtime 默认覆盖）', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-t', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        total_cost_usd: 0.001,
      }),
    ];
    mockedExeca.mockReturnValueOnce(
      makeMockSubproc(lines) as unknown as ReturnType<typeof execa>,
    );

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
      perInputTimeoutMs: 99_999, // runtime 兜底，不该被使用
    });
    const session = runtime.startSession(sessionKey, {
      sessionId: 'sess-timeout',
      workingDir: '/x',
      toolWhitelist: ['Bash'],
      timeoutMs: 123_456, // per-session 显式值，应当胜出
    });

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-timeout' });

    const opts = mockedExeca.mock.calls[0]![2] as { timeout?: number };
    expect(opts.timeout).toBe(123_456);
  });

  it('SessionConfig.timeoutMs 缺失且 runtime 也无 perInputTimeoutMs 时，fallback 到 spec 默认 300_000', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-fb', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        total_cost_usd: 0.001,
      }),
    ];
    mockedExeca.mockReturnValueOnce(
      makeMockSubproc(lines) as unknown as ReturnType<typeof execa>,
    );

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
      // 不传 perInputTimeoutMs，fallback 到 spec 默认 300_000
    });
    // SessionConfig.timeoutMs 在 spec 里标 required，但运行时 JS 可能传不进来；
    // runtime 必须用 ?? 兜住，避免 undefined 进 execa timeout 触发立即超时。
    const session = runtime.startSession(sessionKey, {
      sessionId: 'sess-fb',
      workingDir: '/x',
      toolWhitelist: ['Bash'],
    } as SessionConfig);

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-fb' });

    const opts = mockedExeca.mock.calls[0]![2] as { timeout?: number };
    expect(opts.timeout).toBe(300_000);
  });

  it('execa throw → emit error + turn_finished{error}', async () => {
    mockedExeca.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-3' });

    const types = events.map((e) => e.type);
    expect(types).toEqual(['error', 'turn_finished']);

    const errEvt = events[0];
    if (errEvt?.type !== 'error') throw new Error('expected error');
    expect(errEvt.payload.errorKind).toBe('spawn_failed');
    expect(errEvt.payload.message).toContain('spawn failed');

    const turnFinished = events[1];
    if (turnFinished?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnFinished.payload.reason).toBe('error');
  });
});

describe('createClaudeCodeRuntime.capabilities', () => {
  it('supportsInterrupt 翻 true（issue #54 真实信号路径）', () => {
    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    expect(runtime.capabilities().supportsInterrupt).toBe(true);
  });
});

describe('createClaudeCodeRuntime.interrupt / stopSession（subproc 句柄真实信号）', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  /**
   * 构造一个"卡住"的 mock subprocess：stdout 永远不 close、await subproc 永远不 settle。
   * 让 sendInput 进入 for-await 但不结束，给测试时间调 interrupt 触发 SIGINT。
   *
   * `kill` 是 spy；可通过 settle.resolve / reject 在测试里手动模拟"kill 后子进程退出"。
   */
  function makeStuckMockSubproc(): {
    stdout: Readable;
    kill: ReturnType<typeof vi.fn>;
    settle: { resolve: () => void; reject: (err: Error) => void };
    then: Promise<void>['then'];
    catch: Promise<void>['catch'];
    finally: Promise<void>['finally'];
  } {
    // 永不 push、永不 end 的 stdout
    const stdout = new Readable({ read() {} });
    let resolveFn: () => void = () => {};
    let rejectFn: (err: Error) => void = () => {};
    const settled = new Promise<void>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    const kill = vi.fn((signal?: NodeJS.Signals | number) => {
      // 模拟 SIGINT：close stdout → for-await 退出，subproc reject 模拟非零 exit。
      // 注意：这里是**同步**关闭 stdout + reject，跳过了真实信号传播的事件循环 tick；
      // 用于断言"interrupt 触发后 subproc 一定退出"的最终态，不验证异步时序。
      stdout.push(null);
      rejectFn(new Error(`killed with ${String(signal)}`));
      return true;
    });
    return {
      stdout,
      kill,
      settle: { resolve: resolveFn, reject: rejectFn },
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    };
  }

  it('interrupt 在 sendInput in-flight 期间 SIGINT 子进程，sendInput 走 error 路径返回', async () => {
    const stuck = makeStuckMockSubproc();
    mockedExeca.mockReturnValueOnce(stuck as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    // 启动一个永远不会自然结束的 turn
    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long task',
      traceId: 't-int',
    });

    // 让 event loop 转一圈，确保 sendInput 进了 try / subprocMap.set
    await new Promise((r) => setTimeout(r, 0));

    runtime.interrupt(session);
    expect(stuck.kill).toHaveBeenCalledWith('SIGINT');

    // turn 应当走 catch 分支 emit error + turn_finished{error} 然后返回
    await turn;
    const types = events.map((e) => e.type);
    expect(types).toEqual(['error', 'turn_finished']);
    const errEvt = events[0];
    if (errEvt?.type !== 'error') throw new Error('expected error');
    expect(errEvt.payload.message).toContain('SIGINT');
  });

  it('interrupt 在无 in-flight turn 时是 no-op（不抛、不调 kill）', () => {
    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    // 没有 sendInput → subprocMap 没条目
    expect(() => runtime.interrupt(session)).not.toThrow();
  });

  it('stopSession 在 in-flight 期间 SIGTERM 子进程，且 session.state=Stopped', async () => {
    const stuck = makeStuckMockSubproc();
    mockedExeca.mockReturnValueOnce(stuck as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    const turn = runtime.sendInput(session, {
      type: 'user_message',
      text: 'long',
      traceId: 't-stop',
    });
    await new Promise((r) => setTimeout(r, 0));

    runtime.stopSession(session);
    expect(stuck.kill).toHaveBeenCalledWith('SIGTERM');
    expect(session.state).toBe('Stopped');

    await turn;
    // catch 分支应 emit error + turn_finished
    expect(events.map((e) => e.type)).toEqual(['error', 'turn_finished']);
  });

  it('turn 自然结束后 interrupt 退化为 no-op（finally 已释放 subproc 绑定）', async () => {
    // 走一次完整 happy-path turn，结束后再 interrupt
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-int', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        total_cost_usd: 0.001,
      }),
    ];
    const stdout = Readable.from(lines.map((l) => l + '\n'));
    const settled = Promise.resolve();
    const kill = vi.fn(() => true);
    mockedExeca.mockReturnValueOnce({
      stdout,
      kill,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    } as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-late' });

    // turn 已结束 → subprocMap 应被 finally 清空
    runtime.interrupt(session);
    expect(kill).not.toHaveBeenCalled();
  });
});
