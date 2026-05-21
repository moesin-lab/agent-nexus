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
});
