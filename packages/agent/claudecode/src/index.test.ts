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

  // issue #28：CC 输出完整 stream-json 后才非零退出（罕见 cleanup-after-output 失败），
  // 选 C 路径：textBuf 已收 partial 文本时不 emit text_final，但 logger.warn 记 textBufLength
  // 便于诊断。emit 序列：session_started + error + (usage if parsed) + turn_finished{error}，
  // 不含 text_final（不泄露未标识的 partial 内容到 IM）。
  it('textBuf 收满后子进程非零退出 → 日志记 textBufLength，不 emit text_final', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as import('@agent-nexus/daemon').Logger;

    // 构造 mock：stdout 给完整 stream-json（含 text 内容 + result.usage），但 await subproc
    // reject 模拟"stdout 流完整 + 非零 exit code"。usage 已 parse → catch 路径应 emit partial usage。
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-pf', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial answer that user must not see' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 42,
          output_tokens: 7,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.005,
      }),
    ];
    const stdout = Readable.from(lines.map((l) => l + '\n'));
    // 模拟真实 execa ExecaError：name/exitCode/message 都拼 `escapedCommand`（含 argv → input.text）。
    // buildSafeCause 必须从结构化字段拼 cause，不含 input.text。
    const sensitiveInput = 'EXFILTRATE_THIS_sk-bbbbbbbbbbbbbbbbbbbbbb';
    const execaErr = Object.assign(new Error(
      `Command failed with exit code 1: claude --print '${sensitiveInput}' --output-format stream-json`,
    ), {
      name: 'ExecaError',
      exitCode: 1,
      shortMessage: `Command failed with exit code 1: claude --print '${sensitiveInput}' --output-format stream-json`,
    });
    const settled = Promise.reject(execaErr);
    settled.catch(() => {}); // 防 unhandled rejection 噪声
    mockedExeca.mockReturnValueOnce({
      stdout,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    } as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    await runtime.sendInput(session, {
      type: 'user_message',
      text: sensitiveInput,
      traceId: 't-pf',
    });

    // emit 序列严格断言：session_started → error → usage(complete) → turn_finished；不含 text_final
    const types = events.map((e) => e.type);
    expect(types).toEqual(['session_started', 'error', 'usage', 'turn_finished']);

    // error payload：errorKind='spawn_failed'（AgentEvent 域名，daemon engine 转写需要）
    // 注：payload.message 仍透传 err.message（含 argv）是 pre-existing 行为；本 PR 不在
    // emit 路径脱敏（横切 daemon engine 转写到 IM 的脱敏问题；out-of-scope #5）。
    const errEvt = events[1];
    if (errEvt?.type !== 'error') throw new Error('expected error event at index 1');
    expect(errEvt.payload.errorKind).toBe('spawn_failed');

    // usage payload：completeness 按 CC contract §UsageCompleteness 字段完整度判定
    // （turn 失败由 turn_finished.reason='error' 表达，不靠 completeness）；
    // 本 fixture 给了 total_cost_usd → completeness='complete'，字段透传保证 daemon counters 不漏算
    const usageEvt = events[2];
    if (usageEvt?.type !== 'usage') throw new Error('expected usage event at index 2');
    expect(usageEvt.payload.completeness).toBe('complete');
    expect(usageEvt.payload.inputTokens).toBe(42);
    expect(usageEvt.payload.outputTokens).toBe(7);
    expect(usageEvt.payload.costUsd).toBe(0.005);

    // turn_finished.reason='error'
    const turnEvt = events[3];
    if (turnEvt?.type !== 'turn_finished') throw new Error('expected turn_finished at index 3');
    expect(turnEvt.payload.reason).toBe('error');

    // 日志 warn 必须含 textBufLength + errorKind='agent' + code='spawn_failed' + 序列化 sessionKey + 安全 cause
    const warnFn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const warnCalls = warnFn.mock.calls.filter((c: unknown[]) =>
      typeof c[1] === 'string' && (c[1] as string) === 'claudecode_subproc_error',
    );
    expect(warnCalls.length).toBe(1);
    const ctx = warnCalls[0]![0] as {
      sessionKey?: unknown;
      textBufLength?: number;
      errorKind?: string;
      code?: string;
      cause?: string;
    };
    expect(ctx.textBufLength).toBeGreaterThan(0);
    expect(ctx.errorKind).toBe('agent');
    expect(ctx.code).toBe('spawn_failed');
    // sessionKey 必须是序列化字符串（observability spec §强制字段），不是 object
    expect(typeof ctx.sessionKey).toBe('string');
    // 安全 cause 必须含 execa 结构化字段（ExecaError + exitCode），但**不含** input.text 子串
    expect(ctx.cause).toContain('ExecaError');
    expect(ctx.cause).toContain('exitCode=1');
    expect(ctx.cause ?? '').not.toContain(sensitiveInput);
    expect(ctx.cause ?? '').not.toContain('sk-bbbbbbbbbb');
  });

  // issue #28 补充 1：stdout 收到 assistant 行后 clean EOF 但没 result → usage 仍是 null，
  // emit 序列只有 session_started + error + turn_finished
  it('缺 result 行后子进程非零退出 → 不 emit usage，emit 序列只到 turn_finished', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as import('@agent-nexus/daemon').Logger;

    // stdout 只到 assistant 行就终止，没有 result → usage 仍是 null
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-half', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'half answer' }] },
      }),
    ];
    const stdout = Readable.from(lines.map((l) => l + '\n'));
    const settled = Promise.reject(new Error('subproc exited 137'));
    settled.catch(() => {});
    mockedExeca.mockReturnValueOnce({
      stdout,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    } as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-half' });

    const types = events.map((e) => e.type);
    expect(types).toEqual(['session_started', 'error', 'turn_finished']);
    expect(types).not.toContain('usage');
    expect(types).not.toContain('text_final');

    // textBufLength 仍记（诊断字段在 usage 缺失场景同样应该有意义）
    const warnFn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const warnCalls = warnFn.mock.calls.filter((c: unknown[]) =>
      typeof c[1] === 'string' && (c[1] as string) === 'claudecode_subproc_error',
    );
    expect(warnCalls.length).toBe(1);
    const ctx = warnCalls[0]![0] as { textBufLength?: number };
    expect(ctx.textBufLength).toBeGreaterThan(0);
  });

  // deriveCompleteness §UsageCompleteness 三档断言（complete 已被多个 happy path 覆盖；
  // 这里补 partial / missing 两路径，避免 cache_* 缺失误判 complete 的回归）
  it('usage cache_* 缺失 → completeness=partial', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-p1', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        // 只给 token，故意省略 cache_* 字段
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.01,
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
    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-p1' });
    const usageEvt = events.find((e) => e.type === 'usage');
    if (usageEvt?.type !== 'usage') throw new Error('expected usage');
    expect(usageEvt.payload.completeness).toBe('partial');
  });

  it('total_cost_usd=0（订阅路径）→ costUsd 归一成 null，completeness=partial', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-sub', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0, // 订阅路径下 CC 常报 0
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
    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-sub' });
    const usageEvt = events.find((e) => e.type === 'usage');
    if (usageEvt?.type !== 'usage') throw new Error('expected usage');
    // contract §UsageCompleteness：cost 缺失或 0 → costUsd 写 null
    expect(usageEvt.payload.costUsd).toBeNull();
    expect(usageEvt.payload.completeness).toBe('partial');
  });

  it('usage 缺 input_tokens → completeness=missing', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-m1', cwd: '/x' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'ok' }] },
      }),
      JSON.stringify({
        type: 'result',
        stop_reason: 'end_turn',
        // 完全没 usage block
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
    await runtime.sendInput(session, { type: 'user_message', text: 'hi', traceId: 't-m1' });
    const usageEvt = events.find((e) => e.type === 'usage');
    if (usageEvt?.type !== 'usage') throw new Error('expected usage');
    expect(usageEvt.payload.completeness).toBe('missing');
  });

  // issue #28 补充 2：stream-json 真正半截（malformed JSON tail）+ stdout stream error，
  // 模拟 CC 子进程在 emit 一半时 SIGSEGV/管道断裂——非 JSON 行 / 残缺行被 jsonparse 跳过，
  // 流销毁时触发 await reject。验证：textBuf 已捕到的内容不 emit text_final，
  // logger.warn 仍记 textBufLength，cause 不含 input.text（防泄露）。
  it('stream-json 半截 + stdout stream error → 不 emit text_final，cause 不泄露用户输入', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as import('@agent-nexus/daemon').Logger;

    // 构造一个会自毁的 Readable：先 push init + assistant 完整 JSON 行，再 push 残缺 JSON tail（无 newline 无闭合），
    // 然后 destroy(new Error)。runtime 用 readline `crlfDelay: Infinity` 按行扫，残缺尾行因无 newline 收不到行尾，
    // 而 stream destroy 让 `for await` 中断（等价于真实"CC 中途崩溃，stdout 被切断"）。
    const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-stm', cwd: '/x' }) + '\n';
    const asstLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'streamed before crash' }] },
    }) + '\n';
    const malformedTail = '{"type":"resu'; // 无 newline、无闭合
    const stdout = new Readable({
      read() {
        // no-op；我们用 push 主动控制时序
      },
    });
    // 主动喂数据 + 半截后 destroy
    setImmediate(() => {
      stdout.push(initLine);
      stdout.push(asstLine);
      stdout.push(malformedTail);
      stdout.destroy(new Error('ENOENT: stdout broken pipe'));
    });
    const settled = Promise.reject(new Error('subproc killed by SIGTERM'));
    settled.catch(() => {});
    mockedExeca.mockReturnValueOnce({
      stdout,
      then: settled.then.bind(settled),
      catch: settled.catch.bind(settled),
      finally: settled.finally.bind(settled),
    } as unknown as ReturnType<typeof execa>);

    const runtime = createClaudeCodeRuntime({
      claudeBin: 'claude',
      allowedTools: ['Bash'],
      defaultWorkingDir: '/x',
      logger,
    });
    const session = runtime.startSession(sessionKey, sessionConfig);
    const events = await collectEvents(runtime, session);

    // input.text 含可疑"密钥"前缀；safeCause 不能包含
    const sensitiveText = 'PROMPT_WITH_SECRET_sk-aaaaaaaaaaaaaaaaaaaaaa';
    await runtime.sendInput(session, {
      type: 'user_message',
      text: sensitiveText,
      traceId: 't-stm',
    });

    const types = events.map((e) => e.type);
    expect(types).not.toContain('text_final');
    expect(types).toContain('error');
    expect(types).toContain('turn_finished');

    const warnFn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const warnCalls = warnFn.mock.calls.filter((c: unknown[]) =>
      typeof c[1] === 'string' && (c[1] as string) === 'claudecode_subproc_error',
    );
    expect(warnCalls.length).toBe(1);
    const ctx = warnCalls[0]![0] as { textBufLength?: number; cause?: string };
    expect(ctx.textBufLength).toBeGreaterThan(0);
    // 安全：cause 不能含 input.text（即不能含敏感 prompt 子串）
    expect(ctx.cause ?? '').not.toContain(sensitiveText);
    expect(ctx.cause ?? '').not.toContain('sk-aaaaaaaaaa');
  });
});
