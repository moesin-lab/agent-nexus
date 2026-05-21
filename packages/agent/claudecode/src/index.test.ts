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

  // issue #27 / ADR-0013：completeness $ 视图可信度的语义合约（stream-json 集成路径）。
  // 这里只测 JSON-roundtrippable 输入；NaN / Infinity / -Infinity / 类型异常等非 JSON
  // 可表达分支由 usage-normalize.test.ts 纯函数单元测试覆盖（避免 JSON.stringify(NaN)
  // === "null" 造成的假覆盖）。
  describe.each<[unknown, number | null, 'complete' | 'partial']>([
    [0.01, 0.01, 'complete'],
    [0, 0, 'partial'],
    [undefined, null, 'partial'],
    [-1, null, 'partial'],
    ['0.01', null, 'partial'],
  ])('total_cost_usd=%p → costUsd=%p / completeness=%s', (rawCost, expectedCost, expected) => {
    it('maps backend cost field to UsageRecord per ADR-0013', async () => {
      const resultEvent: Record<string, unknown> = {
        type: 'result',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
      // undefined 表达"字段缺失"：不写进 JSON
      if (rawCost !== undefined) resultEvent['total_cost_usd'] = rawCost;
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-c', cwd: '/x' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'x' }] },
        }),
        JSON.stringify(resultEvent),
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

      await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: `t-c-${String(rawCost)}` });

      const usageEvt = events.find((e) => e.type === 'usage');
      if (usageEvt?.type !== 'usage') throw new Error('expected usage event');
      expect(usageEvt.payload.completeness).toBe(expected);
      expect(usageEvt.payload.costUsd).toBe(expectedCost);
      // ADR-0013：MVP 阶段任何路径都不产生 missing
      expect(usageEvt.payload.completeness).not.toBe('missing');
    });
  });

  // backend usage 形态无效场景（spec "缺事件 = 异常" 的形态校验扩展，见 usage-normalize.isValidCcUsage）
  describe.each<[string, unknown]>([
    ['empty object', {}],
    ['array', []],
    ['string token field', { input_tokens: '1', output_tokens: 2 }],
    ['missing output_tokens', { input_tokens: 1 }],
  ])('result.usage 形态无效（%s）', (label, badUsage) => {
    it('→ emit error{agent_no_usage} 不合成 usage', async () => {
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-bad', cwd: '/x' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'p' }] },
        }),
        JSON.stringify({ type: 'result', stop_reason: 'end_turn', usage: badUsage }),
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

      await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: `t-bad-${label}` });

      const types = events.map((e) => e.type);
      expect(types).not.toContain('usage');
      expect(types).not.toContain('text_final');
      const errEvt = events.find((e) => e.type === 'error');
      if (errEvt?.type !== 'error') throw new Error('expected error event');
      expect(errEvt.payload.errorKind).toBe('agent_no_usage');
    });
  });

  it('子进程正常退出但 result 缺 usage payload → emit error{agent_no_usage} 不合成 usage', async () => {
    // backend 异常路径：spawn 成功，result 事件来了但没 usage 字段
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-nu', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial' }] },
      }),
      JSON.stringify({ type: 'result', stop_reason: 'end_turn' }), // 注意：无 usage
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

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-nu' });

    const types = events.map((e) => e.type);
    expect(types).not.toContain('usage');
    expect(types).not.toContain('text_final');
    const errEvt = events.find((e) => e.type === 'error');
    if (errEvt?.type !== 'error') throw new Error('expected error event');
    expect(errEvt.payload.errorKind).toBe('agent_no_usage');
    const lastEvt = events[events.length - 1];
    if (lastEvt?.type !== 'turn_finished') throw new Error('expected turn_finished tail');
    expect(lastEvt.payload.reason).toBe('error');
  });

  it('子进程正常退出但无 result event → emit error{agent_no_result} 不合成 usage', async () => {
    // backend 异常路径：spawn 成功，stream-json 只发 system/init 与 assistant，无 result
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-nr', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial' }] },
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

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-nr' });

    const types = events.map((e) => e.type);
    // 不能出现 usage（spec "缺事件 = 异常"）也不能出现 text_final
    expect(types).not.toContain('usage');
    expect(types).not.toContain('text_final');
    // 必须以 error + turn_finished{error} 收尾
    const errEvt = events.find((e) => e.type === 'error');
    if (errEvt?.type !== 'error') throw new Error('expected error event');
    expect(errEvt.payload.errorKind).toBe('agent_no_result');
    const lastEvt = events[events.length - 1];
    if (lastEvt?.type !== 'turn_finished') throw new Error('expected turn_finished tail');
    expect(lastEvt.payload.reason).toBe('error');
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

  // stop_reason → TurnEndReason 映射的 envelope 级覆盖（取代旧 stop-reason.ts 单测）。
  // 锚点：docs/dev/spec/agent-backends/claude-code-cli.md §stop_reason 到 turn_finished.reason 的映射
  //
  // reason='error' 同时来自两条路径：switch default 与 catch 早退。下面每个用例都断言完整
  // 事件序列以锁死走的是 envelope 正常路径，避免和早退路径串味儿。tool_use 在 spec 标为
  // 中间态，真出现在 final result 时落到 switch default 的 error。
  it.each([
    ['end_turn', 'stop'],
    ['max_tokens', 'max_tokens'],
    ['interrupted', 'user_interrupt'],
    ['something_unknown', 'error'],
    ['tool_use', 'error'],
  ])('result.stop_reason=%s → turn_finished.reason=%s', async (cliReason, expected) => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-r', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: cliReason,
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
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: `t-${cliReason}` });

    expect(events.map((e) => e.type)).toEqual([
      'session_started',
      'text_final',
      'usage',
      'turn_finished',
    ]);
    const turnFinished = events.find((e) => e.type === 'turn_finished');
    if (turnFinished?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnFinished.payload.reason).toBe(expected);
  });

  it('result envelope 缺 stop_reason 字段 → turn_finished.reason=error', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-miss', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x' }] },
      }),
      JSON.stringify({
        type: 'result',
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
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-miss' });

    expect(events.map((e) => e.type)).toEqual([
      'session_started',
      'text_final',
      'usage',
      'turn_finished',
    ]);
    const turnFinished = events.find((e) => e.type === 'turn_finished');
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
      // 模拟 SIGINT/SIGTERM：close stdout → for-await 退出，subproc reject 模拟"因信号终止"的非零 exit。
      // 注意：这里是**同步**关闭 stdout + reject，跳过了真实信号传播的事件循环 tick；
      // 用于断言"interrupt/stop 触发后 subproc 一定退出"的最终态，不验证异步时序。
      // 关键：reject 的 error 带 signal/isTerminated 字段以匹配 execa 9.x 的真实形态，
      // 让实现里的 wasInterrupted 判定能拿到"clean 信号退出"的证据。
      stdout.push(null);
      const signalName = typeof signal === 'string' ? signal : 'SIGTERM';
      rejectFn(
        Object.assign(new Error(`killed with ${String(signal)}`), {
          signal: signalName,
          isTerminated: true,
        }),
      );
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

    // 用户 interrupt 是"正常收尾"，不应 emit error 事件——否则 daemon engine
    // 会把它当 agent 失败发回 IM。spec/agent-backends/claude-code-cli.md §stop_reason 映射：
    // SIGINT → turn_finished{user_interrupt}。无 usage 解析过则不 emit usage。
    await turn;
    const types = events.map((e) => e.type);
    expect(types).toEqual(['turn_finished']);
    const turnEvt = events[0];
    if (turnEvt?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnEvt.payload.reason).toBe('user_interrupt');
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
    // stopSession 在 in-flight 期间应走 stopRequested 分支：
    //   turn_finished{error}（子进程被切断属异常）+ session_stopped{user_stop}（lifecycle 焦点）。
    // 不要复用 user_interrupt 语义。
    expect(events.map((e) => e.type)).toEqual(['turn_finished', 'session_stopped']);
    const turnEvt = events[0];
    if (turnEvt?.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnEvt.payload.reason).toBe('error');
    const stoppedEvt = events[1];
    if (stoppedEvt?.type !== 'session_stopped') throw new Error('expected session_stopped');
    expect(stoppedEvt.payload.reason).toBe('user_stop');
  });

  it('CC 输出 stop_reason=interrupted 后再 reject（真实 SIGINT 路径）→ user_interrupt 而非 error，且 usage 不丢', async () => {
    // 模拟更接近真实的 CC SIGINT 行为：先 emit 一行 result{stop_reason:'interrupted', usage:...}，
    // 然后 stdout close + subproc 非零 exit reject。
    // 当前 mock `makeStuckMockSubproc` 在 kill 时同步 push(null) + reject，所以我们在调
    // interrupt 前手动把 result 行推进 stdout，再 trigger kill。
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
      traceId: 't-interrupted-line',
    });
    await new Promise((r) => setTimeout(r, 0));

    // 真实流序：CC 收到 SIGINT → 先冲 stdout 把 result 写出 → 再退出
    stuck.stdout.push(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        stop_reason: 'interrupted',
        usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }) + '\n',
    );
    // 让 for-await 处理这行
    await new Promise((r) => setTimeout(r, 0));

    runtime.interrupt(session);
    expect(stuck.kill).toHaveBeenCalledWith('SIGINT');

    await turn;
    // 事件流：interrupt 收尾路径不 emit error（contract：user SIGINT 是正常收尾）；
    //         必须保留已解析的 usage 满足 spec §UsageRecord 顺序保证。
    const types = events.map((e) => e.type);
    expect(types).not.toContain('error');
    expect(types).toContain('usage');
    expect(types).toContain('turn_finished');

    const turnEvt = events.find((e) => e.type === 'turn_finished');
    if (!turnEvt || turnEvt.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnEvt.payload.reason).toBe('user_interrupt');

    const usageEvt = events.find((e) => e.type === 'usage');
    if (!usageEvt || usageEvt.type !== 'usage') throw new Error('expected usage event in catch');
    expect(usageEvt.payload.inputTokens).toBe(3);
    expect(usageEvt.payload.outputTokens).toBe(2);
    expect(usageEvt.payload.completeness).toBe('partial');
  });

  it('CC 收到 SIGINT 后 exit 0 且无 stop_reason（成功路径兜底）→ turn_finished{user_interrupt}', async () => {
    // 模拟 CC 在某些异常下被 SIGINT 杀掉，但 await subproc resolve（exit 0）且 stdout 已 EOF；
    // 没有任何 result 行 → stopReason undefined → 默认 mapping 'error'。
    // 必须靠 inflightFlag.interruptRequested 兜底翻 user_interrupt。
    const stdout = new Readable({ read() {} });
    let resolveFn: () => void = () => {};
    const settled = new Promise<void>((res) => {
      resolveFn = res;
    });
    const kill = vi.fn((_signal?: NodeJS.Signals | number) => {
      stdout.push(null); // EOF
      resolveFn(); // exit 0
      return true;
    });
    const fakeSub = {
      stdout,
      kill,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    };
    mockedExeca.mockReturnValueOnce(fakeSub as unknown as ReturnType<typeof execa>);

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
      text: 'q',
      traceId: 't-int-resolve',
    });
    await new Promise((r) => setTimeout(r, 0));
    runtime.interrupt(session);

    await turn;
    const turnEvt = events.find((e) => e.type === 'turn_finished');
    if (!turnEvt || turnEvt.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnEvt.payload.reason).toBe('user_interrupt');
  });

  it('interrupt 时 kill 返回 false（进程已退出）→ 不翻 interruptRequested，按真实 exit 归类', async () => {
    // 模拟"已退出但 finally 没跑"的窗口：kill 返回 false。
    // 此时若实现盲翻 interruptRequested，下游真实错误（reject）会被误标 user_interrupt。
    const stdout = new Readable({ read() {} });
    let rejectFn: (err: Error) => void = () => {};
    const settled = new Promise<void>((_res, rej) => {
      rejectFn = rej;
    });
    const kill = vi.fn(() => false); // 关键：已退出
    const fakeSub = {
      stdout,
      kill,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    };
    mockedExeca.mockReturnValueOnce(fakeSub as unknown as ReturnType<typeof execa>);

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
      text: 'q',
      traceId: 't-kill-false',
    });
    await new Promise((r) => setTimeout(r, 0));

    runtime.interrupt(session);
    expect(kill).toHaveBeenCalledWith('SIGINT');
    expect(kill.mock.results[0]?.value).toBe(false); // sanity: 真返回 false

    // 现在 trigger 真实 reject 模拟"进程因 OOM 等无关原因死了"
    stdout.push(null);
    rejectFn(new Error('unrelated crash'));
    await turn;

    // 错误必须按 spawn_failed 走，不能被错误标记成 user_interrupt
    const errEvt = events.find((e) => e.type === 'error');
    if (!errEvt || errEvt.type !== 'error') throw new Error('expected error');
    expect(errEvt.payload.errorKind).toBe('spawn_failed');
    const turnEvt = events.find((e) => e.type === 'turn_finished');
    if (!turnEvt || turnEvt.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnEvt.payload.reason).toBe('error');
  });

  it('interrupt 后子进程因非中断原因失败（exit 1，无 SIGINT signal）→ 维持 error，不掩盖成 user_interrupt', async () => {
    // CC 捕获 SIGINT 后由于 OOM/exit 1 等无关原因失败：
    //   - execa error 没有 signal:'SIGINT' / isTerminated
    //   - 也没收到 stop_reason='interrupted'
    // 此时 wasInterrupted 判定收紧后应为 false，按 spawn_failed/error 归类，
    // 避免把"中断失败 + 实际崩溃"掩盖成"中断成功"。
    const stdout = new Readable({ read() {} });
    let rejectFn: (err: Error) => void = () => {};
    const settled = new Promise<void>((_res, rej) => {
      rejectFn = rej;
    });
    const kill = vi.fn(() => true);
    const fakeSub = {
      stdout,
      kill,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    };
    mockedExeca.mockReturnValueOnce(fakeSub as unknown as ReturnType<typeof execa>);

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
      text: 'q',
      traceId: 't-int-then-crash',
    });
    await new Promise((r) => setTimeout(r, 0));

    runtime.interrupt(session);

    // 关键：reject 的 error 没有 signal/isTerminated/timedOut，模拟 CC 自己 exit 1
    stdout.push(null);
    const crashErr = Object.assign(new Error('CC crashed exit 1'), { exitCode: 1 });
    rejectFn(crashErr);
    await turn;

    const errEvt = events.find((e) => e.type === 'error');
    if (!errEvt || errEvt.type !== 'error') throw new Error('expected error');
    expect(errEvt.payload.errorKind).toBe('spawn_failed');
    const turnEvt = events.find((e) => e.type === 'turn_finished');
    if (!turnEvt || turnEvt.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnEvt.payload.reason).toBe('error');
  });

  it('interrupt 后子进程因 SIGINT 真实终止（execa signal=SIGINT）→ user_interrupt（保留原快路径）', async () => {
    // 与上一个测试对照：execa error 带 signal:'SIGINT' + isTerminated:true 时认定 clean SIGINT 退出。
    const stdout = new Readable({ read() {} });
    let rejectFn: (err: Error) => void = () => {};
    const settled = new Promise<void>((_res, rej) => {
      rejectFn = rej;
    });
    const kill = vi.fn(() => true);
    const fakeSub = {
      stdout,
      kill,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    };
    mockedExeca.mockReturnValueOnce(fakeSub as unknown as ReturnType<typeof execa>);

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
      text: 'q',
      traceId: 't-sigint-clean',
    });
    await new Promise((r) => setTimeout(r, 0));

    runtime.interrupt(session);

    stdout.push(null);
    const sigintErr = Object.assign(new Error('killed by SIGINT'), {
      signal: 'SIGINT',
      isTerminated: true,
    });
    rejectFn(sigintErr);
    await turn;

    const types = events.map((e) => e.type);
    expect(types).not.toContain('error');
    const turnEvt = events.find((e) => e.type === 'turn_finished');
    if (!turnEvt || turnEvt.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnEvt.payload.reason).toBe('user_interrupt');
  });

  it('stopSession success 路径（CC 优雅 exit 0）→ 不发 text_final 给 daemon，emit turn_finished{error} + session_stopped{user_stop}', async () => {
    // CC 在收到 SIGTERM 前已经完成回复并 stop_reason=end_turn；之后 stopSession 才被调。
    // 但 stopRequested 流转的本质："session 已被强停" 而非"回合正常完成"。
    // 实现选择：忽略 buffered text，直接 emit usage（如有） + turn_finished{error} + session_stopped{user_stop}。
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-st', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'a partial answer' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        total_cost_usd: 0.005,
      }),
    ];

    // 自定义 mock：在 sendInput 跑到 await subproc 时让外部代码先调 stopSession 再 resolve
    const stdout = Readable.from(lines.map((l) => l + '\n'));
    let resolveFn: () => void = () => {};
    const settled = new Promise<void>((res) => {
      resolveFn = res;
    });
    const kill = vi.fn(() => true);
    const fakeSub = {
      stdout,
      kill,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    };
    mockedExeca.mockReturnValueOnce(fakeSub as unknown as ReturnType<typeof execa>);

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
      text: 'q',
      traceId: 't-stop-success',
    });
    // 让 stdout 行被消费完
    await new Promise((r) => setTimeout(r, 5));
    // 在 await subproc 前调 stopSession，触发 stopRequested=true
    runtime.stopSession(session);
    // 然后 subproc 优雅 exit 0
    resolveFn();
    await turn;

    const types = events.map((e) => e.type);
    expect(types).not.toContain('text_final'); // 不发给 daemon 当 happy path
    expect(types).toContain('usage');
    expect(types).toContain('turn_finished');
    expect(types).toContain('session_stopped');
    const turnEvt = events.find((e) => e.type === 'turn_finished');
    if (!turnEvt || turnEvt.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnEvt.payload.reason).toBe('error');
    const stoppedEvt = events.find((e) => e.type === 'session_stopped');
    if (!stoppedEvt || stoppedEvt.type !== 'session_stopped') throw new Error('expected session_stopped');
    expect(stoppedEvt.payload.reason).toBe('user_stop');
  });

  it('execa timeout（CC 忽略 SIGINT 或 wallclock 触发）→ wallclock_timeout，不被误标 user_interrupt', async () => {
    // 模拟用户调 interrupt 但 CC 忽略 SIGINT，最终 execa 内置 timeout 触发 reject（带 timedOut:true）。
    // 当前实现的 catch 分支必须用 err.timedOut 区分，不能因 interruptRequested=true 就翻 user_interrupt。
    const stdout = new Readable({ read() {} });
    let rejectFn: (err: Error & { timedOut?: boolean }) => void = () => {};
    const settled = new Promise<void>((_res, rej) => {
      rejectFn = rej as (err: Error & { timedOut?: boolean }) => void;
    });
    const kill = vi.fn(() => true);
    const fakeSub = {
      stdout,
      kill,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    };
    mockedExeca.mockReturnValueOnce(fakeSub as unknown as ReturnType<typeof execa>);

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
      text: 'q',
      traceId: 't-timeout',
    });
    await new Promise((r) => setTimeout(r, 0));

    // 用户调 interrupt（CC 假装忽略 SIGINT）
    runtime.interrupt(session);

    // 然后 execa timeout 触发
    stdout.push(null);
    const timeoutErr = Object.assign(new Error('Command timed out'), { timedOut: true });
    rejectFn(timeoutErr);

    await turn;

    // 必须按 wallclock_timeout 归类，不能因 interruptRequested=true 就翻 user_interrupt
    // 同时 contract 要求伴随 session_stopped{error}（spec/agent-backends/claude-code-cli.md §中断与超时）
    const errEvt = events.find((e) => e.type === 'error');
    if (!errEvt || errEvt.type !== 'error') throw new Error('expected error');
    expect(errEvt.payload.errorKind).toBe('wallclock_timeout');
    const turnEvt = events.find((e) => e.type === 'turn_finished');
    if (!turnEvt || turnEvt.type !== 'turn_finished') throw new Error('expected turn_finished');
    expect(turnEvt.payload.reason).toBe('wallclock_timeout');
    const stoppedEvt = events.find((e) => e.type === 'session_stopped');
    if (!stoppedEvt || stoppedEvt.type !== 'session_stopped') throw new Error('expected session_stopped');
    expect(stoppedEvt.payload.reason).toBe('error');
  });

  it('sendInput 在 session.state=Stopped 时 fail-fast（不再 spawn 子进程）', async () => {
    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger: fakeLogger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    // stopSession 在无 in-flight 时只翻 state，无 spawn
    runtime.stopSession(session);
    expect(session.state).toBe('Stopped');

    await runtime.sendInput(session, {
      type: 'user_message',
      text: 'should-be-rejected',
      traceId: 't-stopped',
    });

    expect(mockedExeca).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['error', 'turn_finished']);
    const errEvt = events[0];
    if (errEvt?.type !== 'error') throw new Error('expected error');
    expect(errEvt.payload.errorKind).toBe('session_stopped');
  });

  it('同 session 并发 sendInput（防御层 fail-fast）→ 第二轮 emit concurrent_send_input', async () => {
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

    // 第一轮 in-flight
    const turn1 = runtime.sendInput(session, {
      type: 'user_message',
      text: 'first',
      traceId: 't-c1',
    });
    await new Promise((r) => setTimeout(r, 0));

    // 第二轮：spec 已声明同 session 严格串行；此处 daemon 没排队，adapter 必须 fail-fast，
    // 否则 subprocMap 会被覆盖，第一轮 subproc 引用丢失。
    await runtime.sendInput(session, {
      type: 'user_message',
      text: 'second-overlap',
      traceId: 't-c2',
    });

    // 第二轮的事件
    const c2Events = events.filter((e) => e.traceId === 't-c2');
    expect(c2Events.map((e) => e.type)).toEqual(['error', 'turn_finished']);
    const errEvt = c2Events[0];
    if (errEvt?.type !== 'error') throw new Error('expected error');
    expect(errEvt.payload.errorKind).toBe('concurrent_send_input');

    // execa 只应被第一轮调用一次（第二轮 fail-fast 没进 spawn）
    expect(mockedExeca).toHaveBeenCalledTimes(1);

    // 清理：interrupt 第一轮以免测试 hang
    runtime.interrupt(session);
    await turn1;
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
