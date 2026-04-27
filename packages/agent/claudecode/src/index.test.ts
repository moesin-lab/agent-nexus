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
  timeoutMs: 60_000,
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
    expect(started.payload.ccSessionID).toBe('sid-1');

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

    // ccSessionID 应该写回 session
    expect(session.ccSessionID).toBe('sid-1');
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
      timeoutMs: 60_000,
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
