import { describe, expect, it, vi } from 'vitest';
import type {
  AgentCapabilitySet,
  AgentEvent,
  AgentEventHandler,
  AgentInput,
  AgentRuntime,
  AgentSession,
  CapabilitySet,
  EventHandler,
  MessageRef,
  NormalizedEvent,
  OutboundMessage,
  PlatformAdapter,
  SessionConfig,
  SessionKey,
} from '@agent-nexus/protocol';
import { Engine } from './engine.js';
import { createLogger, type Logger } from './logger.js';
import { SessionStore } from './session-store.js';

// ----- mocks -----

const platformCaps: CapabilitySet = {
  maxTextLength: 2000,
  supportsEdit: false,
  supportsDelete: false,
  supportsReactions: false,
  supportsEmbeds: false,
  supportsButtons: false,
  supportsThreads: false,
  supportsEphemeral: false,
  supportsAttachments: false,
  maxAttachmentsPerMessage: 0,
  supportsTypingIndicator: false,
};

const agentCaps: AgentCapabilitySet = {
  supportsThinking: false,
  supportsStreaming: false,
  supportsToolCallEvents: false,
  supportsInterrupt: false,
  supportsStdinInterrupt: false,
};

const SESSION_KEY: SessionKey = {
  platform: 'discord',
  channelId: 'C1',
  initiatorUserId: 'U1',
};

let eventCounter = 0;
function makeEvent(text: string, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  eventCounter += 1;
  return {
    eventId: `e-${eventCounter}`,
    platform: 'discord',
    sessionKey: SESSION_KEY,
    messageId: 'm-1',
    traceId: 't-1',
    type: 'message',
    text,
    rawPayload: {},
    rawContentType: 'application/json',
    receivedAt: new Date(0),
    initiator: { userId: 'U1', displayName: 'U1', isBot: false },
    ...overrides,
  };
}

function makePlatform(): PlatformAdapter & {
  send: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const ref: MessageRef = {
    platform: 'discord',
    channelId: 'C1',
    messageId: 'out-1',
    messageIds: ['out-1'],
    sentAt: new Date(0),
  };
  return {
    name: () => 'mock-platform',
    capabilities: () => platformCaps,
    start: vi.fn(async (_h: EventHandler) => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async (_k: SessionKey, _m: OutboundMessage) => ref),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
  };
}

/**
 * Mock agent：sendInput 触发"下一组"预排好的事件序列给当前 session 的 handler。
 *
 * - `queueEvents(events)` 入队一组；多次入队按 FIFO 取——支持多 dispatch 并发场景
 * - `queueEventsAfter(events, ms)` 入队一组并在事件分发前等 `ms` 毫秒（用于显式制造异步窗口）
 */
function makeAgent() {
  const handlers = new Map<AgentSession, AgentEventHandler>();
  type QueueEntry = { events: AgentEvent[]; delayMs: number };
  const queue: QueueEntry[] = [];
  let counter = 0;

  const startSession = vi.fn(
    (key: SessionKey, _config: SessionConfig): AgentSession => {
      counter += 1;
      const session: AgentSession = {
        key,
        backend: 'mock',
        state: 'Ready',
        startedAt: new Date(0),
      };
      // session 唯一性靠对象引用即可；用 counter 防止 startedAt 相同时被误判
      Object.defineProperty(session, '__id', { value: counter });
      return session;
    },
  );

  const stopSession = vi.fn((s: AgentSession) => {
    handlers.delete(s);
  });

  const isAlive = vi.fn(() => true);

  const onEvent = vi.fn((s: AgentSession, h: AgentEventHandler) => {
    handlers.set(s, h);
  });

  const sendInput = vi.fn(async (s: AgentSession, _input: AgentInput) => {
    const h = handlers.get(s);
    if (!h) return;
    const entry = queue.shift();
    if (!entry) return;
    if (entry.delayMs > 0) {
      await new Promise((r) => setTimeout(r, entry.delayMs));
    }
    for (const e of entry.events) {
      await h(e);
    }
  });

  const interrupt = vi.fn(() => {});

  const runtime: AgentRuntime = {
    name: () => 'mock-agent',
    capabilities: () => agentCaps,
    startSession,
    stopSession,
    isAlive,
    sendInput,
    onEvent,
    interrupt,
  };

  return {
    runtime,
    startSession,
    stopSession,
    onEvent,
    sendInput,
    queueEvents(events: AgentEvent[]): void {
      queue.push({ events, delayMs: 0 });
    },
    queueEventsAfter(events: AgentEvent[], delayMs: number): void {
      queue.push({ events, delayMs });
    },
  };
}

type SessionStartedPayload = Extract<
  AgentEvent,
  { type: 'session_started' }
>['payload'];

function ev<T extends AgentEvent['type']>(
  type: T,
  payload: T extends 'session_started'
    ? Partial<SessionStartedPayload>
    : Extract<AgentEvent, { type: T }>['payload'],
  sequence = 0,
): AgentEvent {
  const fullPayload =
    type === 'session_started'
      ? {
          workingDir: DEFAULT_CFG.workingDir,
          capabilities: agentCaps,
          ...payload,
        }
      : payload;
  return {
    type,
    traceId: 't-1',
    timestamp: new Date(0),
    sequence,
    payload: fullPayload,
  } as AgentEvent;
}

const SILENT_LOGGER = createLogger({ level: 'fatal', pretty: false });

const DEFAULT_CFG = {
  workingDir: '/tmp',
  toolWhitelist: [],
  timeoutMs: 60_000,
};

// ----- tests -----

describe('Engine', () => {
  it('首轮：dispatch 触发 sessionStore 回写 + platform.send 收到 text_final 内容', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-123' }),
      ev('text_final', { text: 'hi from agent' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    // 通过 start() 路径让 platform 拿到 dispatch 句柄；这里直接走 dispatch
    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello'));

    expect(agent.startSession).toHaveBeenCalledTimes(1);
    const startArgs = agent.startSession.mock.calls[0]!;
    const cfg = startArgs[1] as SessionConfig;
    expect(cfg.resumeFromAgentSessionId).toBeUndefined();
    expect(cfg.sessionId).toBeTruthy();

    expect(store.get(SESSION_KEY)?.agentSessionId).toBe('sid-123');

    expect(platform.send).toHaveBeenCalledTimes(1);
    const sendArgs = platform.send.mock.calls[0]!;
    const out = sendArgs[1] as OutboundMessage;
    expect(out.text).toBe('hi from agent');

    expect(agent.stopSession).toHaveBeenCalledTimes(1);
  });

  it('第二轮：复用同 sessionKey，agent.startSession 收到 prev agentSessionId 作 resumeFromAgentSessionId', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    // 首轮：写入 sid-123
    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-123' }),
      ev('text_final', { text: 'first' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('first prompt'));
    expect(store.get(SESSION_KEY)?.agentSessionId).toBe('sid-123');

    // 第二轮：startSession 必须收到 sid-123 作 resume
    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-456' }),
      ev('text_final', { text: 'second' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 2 }),
    ]);
    await dispatchHandler(makeEvent('second prompt'));

    expect(agent.startSession).toHaveBeenCalledTimes(2);
    const cfg2 = agent.startSession.mock.calls[1]![1] as SessionConfig;
    expect(cfg2.resumeFromAgentSessionId).toBe('sid-123');

    expect(store.get(SESSION_KEY)?.agentSessionId).toBe('sid-456');
  });

  it('/new 带后续文本：清 store + 用 trim 后的剩余作 prompt', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    // 预置一条旧的
    store.set(SESSION_KEY, { agentSessionId: 'sid-123', lastTurnAt: new Date(0) });

    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-new' }),
      ev('text_final', { text: 'answer' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('/new what is X?'));

    expect(agent.startSession).toHaveBeenCalledTimes(1);
    const cfg = agent.startSession.mock.calls[0]![1] as SessionConfig;
    expect(cfg.resumeFromAgentSessionId).toBeUndefined();

    expect(agent.sendInput).toHaveBeenCalledTimes(1);
    const input = agent.sendInput.mock.calls[0]![1] as AgentInput;
    expect(input.text).toBe('what is X?');

    // 新一轮 session_started 写回 sid-new；旧的 sid-123 已被清掉
    expect(store.get(SESSION_KEY)?.agentSessionId).toBe('sid-new');
  });

  it('/new 单独：发 [new session ready] 不调 agent', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    await dispatchHandler(makeEvent('/new'));

    expect(agent.sendInput).not.toHaveBeenCalled();
    expect(agent.startSession).not.toHaveBeenCalled();

    expect(platform.send).toHaveBeenCalledTimes(1);
    const out = platform.send.mock.calls[0]![1] as OutboundMessage;
    expect(out.text).toBe('[new session ready]');
  });

  it('同 SessionKey 并发：第二条 dispatch 必须串行在第一条之后，看到首轮 agentSessionId 作 resume', async () => {
    // race regression：两条来自同一频道+同一用户的 @mention 几乎同时到达。
    // 期望：第二条 startSession 的 config.resumeFromAgentSessionId === 首轮的 agentSessionId。
    // 旧实现里两次 dispatch 都同步读 sessionStore（仍为 undefined），都启新 session 并互相覆盖。
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    // 第一条 dispatch 故意慢——session_started 在 8ms 后才进 store
    agent.queueEventsAfter(
      [
        ev('session_started', { agentSessionId: 'sid-first' }),
        ev('text_final', { text: 'first reply' }),
        ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
      ],
      8,
    );
    // 第二条 dispatch 紧随其后
    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-second' }),
      ev('text_final', { text: 'second reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 2 }),
    ]);

    const p1 = dispatchHandler(makeEvent('first'));
    const p2 = dispatchHandler(makeEvent('second'));
    await Promise.all([p1, p2]);

    expect(agent.startSession).toHaveBeenCalledTimes(2);
    const cfg2 = agent.startSession.mock.calls[1]![1] as SessionConfig;
    expect(cfg2.resumeFromAgentSessionId).toBe('sid-first');

    // store 终态是第二轮写入的 sid-second（顺序写）
    expect(store.get(SESSION_KEY)?.agentSessionId).toBe('sid-second');
  });

  it('不同 SessionKey 并发不串行：互不阻塞', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    const KEY_A: SessionKey = { platform: 'discord', channelId: 'C1', initiatorUserId: 'A' };
    const KEY_B: SessionKey = { platform: 'discord', channelId: 'C1', initiatorUserId: 'B' };

    // A 慢；B 应该不被 A 拖累，可以早于 A 完成
    agent.queueEventsAfter(
      [
        ev('session_started', { agentSessionId: 'sid-a' }),
        ev('text_final', { text: 'a' }),
        ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
      ],
      30,
    );
    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-b' }),
      ev('text_final', { text: 'b' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    const tStart = Date.now();
    const pA = dispatchHandler(makeEvent('hi A', { sessionKey: KEY_A }));
    const pB = dispatchHandler(makeEvent('hi B', { sessionKey: KEY_B }));
    await pB;
    const tBDone = Date.now() - tStart;
    await pA;

    // B 不应等满 A 的 30ms 延迟；给 25ms 余量足够区分串行/并行
    expect(tBDone).toBeLessThan(25);

    expect(store.get(KEY_A)?.agentSessionId).toBe('sid-a');
    expect(store.get(KEY_B)?.agentSessionId).toBe('sid-b');
  });

  it('turn_finished 后写 outbound info 日志（含 length、无 text），debug 日志含 text', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;

    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: mockLogger,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-1' }),
      ev('text_final', { text: 'hello reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello'));

    const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const outboundInfo = infoCalls.find(([, msg]) => msg === 'outbound');
    expect(outboundInfo).toBeDefined();
    expect(outboundInfo![0]).toMatchObject({ length: 'hello reply'.length, traceId: 't-1' });
    expect(outboundInfo![0]).not.toHaveProperty('text');

    const debugCalls = (mockLogger.debug as ReturnType<typeof vi.fn>).mock.calls;
    const outboundDebug = debugCalls.find(([, msg]) => msg === 'outbound');
    expect(outboundDebug).toBeDefined();
    expect(outboundDebug![0]).toMatchObject({ text: 'hello reply', traceId: 't-1' });
  });

  it('eventId 去重：同 eventId 二次投递被丢弃，agent.startSession 只调一次，info 日志 dispatch_dedup', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;

    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: mockLogger,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-1' }),
      ev('text_final', { text: 'first reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    // 第二次 dispatch 不入 agent 队列；若代码漏 dedup，agent.sendInput 会等待空队列
    // 然后立即返回，但 startSession 已被多调一次——这是 fixture 设计的关键。

    const dup = makeEvent('hello');
    await dispatchHandler(dup);
    await dispatchHandler(dup);

    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(platform.send).toHaveBeenCalledTimes(1);

    const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const dedupLog = infoCalls.find(([, msg]) => msg === 'dispatch_dedup');
    expect(dedupLog).toBeDefined();
    expect(dedupLog![0]).toMatchObject({ eventId: dup.eventId, traceId: 't-1' });
  });

  it('eventId 去重 cap 淘汰：最早 entry 被淘汰，最新 entry 仍被 dedup（非整表 clear）', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    // 用 /new 快路径填表（不动 agent），共 1024 + 1 条独立 eventId
    // /new 不调 agent.startSession，但仍走 dispatchImpl 入口的 dedup 检查
    for (let i = 0; i <= 1024; i++) {
      await dispatchHandler(makeEvent('/new', { eventId: `fill-${i}` }));
    }
    // 此时 fill-0 应已被淘汰；fill-1024 仍在表内

    // 用 fill-0 重投触发完整 agent 路径——若被淘汰，agent.startSession 会调一次
    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-evicted' }),
      ev('text_final', { text: 're' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('hello', { eventId: 'fill-0' }));
    expect(agent.startSession).toHaveBeenCalledTimes(1);

    // 用 fill-1024 重投——还在表内，应被 dedup，agent.startSession 不再增加
    await dispatchHandler(makeEvent('hello', { eventId: 'fill-1024' }));
    expect(agent.startSession).toHaveBeenCalledTimes(1);
  });

  it('error 路径：agent emit error → platform.send 收到 [agent error: ...]', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    agent.queueEvents([
      ev('error', { errorKind: 'spawn_failed', message: 'boom' }),
      ev('turn_finished', { reason: 'error', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('hello'));

    expect(platform.send).toHaveBeenCalledTimes(1);
    const out = platform.send.mock.calls[0]![1] as OutboundMessage;
    expect(out.text).toContain('agent error');
    expect(out.text).toContain('spawn_failed');
    expect(out.text).toContain('boom');
  });

  // inline safeSend 后三处 send 失败的本地 try/catch 行为各自 lock 一遍，
  // 防止任一 callsite 的字段 / await / catch 漂移到 handlerErr 兜底路径。
  //
  // 每个 case 都断言：dispatch 不 throw + 日志事件名 platform_send_failed +
  // 字段含 traceId/sessionKey/err + 没有升级为 agent_event_handler_failed。

  function makeMockLogger(): Logger {
    return {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;
  }

  function assertSendFailedLog(
    mockLogger: Logger,
    expectedErr: Error,
  ): void {
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const sendFailedLog = errorCalls.find(([, msg]) => msg === 'platform_send_failed');
    expect(sendFailedLog).toBeDefined();
    expect(sendFailedLog![0]).toMatchObject({
      traceId: 't-1',
      err: expectedErr,
    });
    expect(sendFailedLog![0]).toHaveProperty('sessionKey');
    // 同步/异步 throw 都必须被本地 catch 抓住，不能升级到 handlerErr / 外层 dispatch catch
    const handlerErrLog = errorCalls.find(([, msg]) => msg === 'agent_event_handler_failed');
    expect(handlerErrLog).toBeUndefined();
    const dispatchFailedLog = errorCalls.find(([, msg]) => msg === 'dispatch_failed');
    expect(dispatchFailedLog).toBeUndefined();
  }

  it('platform.send 失败（/new ack 路径）：错误被吞 + 写 platform_send_failed 含 traceId/sessionKey/err', async () => {
    const platform = makePlatform();
    const sendErr = new Error('platform down /new');
    (platform.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(sendErr);

    const agent = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();

    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: mockLogger,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    await expect(dispatchHandler(makeEvent('/new'))).resolves.toBeUndefined();

    assertSendFailedLog(mockLogger, sendErr);
    // /new ack 路径不走 agent
    expect(agent.startSession).not.toHaveBeenCalled();
    expect(agent.stopSession).not.toHaveBeenCalled();
  });

  it('platform.send 失败（agent error 回送路径）：错误被吞 + 写 platform_send_failed + 后续仍走 stopSession', async () => {
    const platform = makePlatform();
    const sendErr = new Error('platform down agent_error');
    (platform.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(sendErr);

    const agent = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();

    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: mockLogger,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    agent.queueEvents([
      ev('error', { errorKind: 'spawn_failed', message: 'boom' }),
      ev('turn_finished', { reason: 'error', turnSequence: 1 }),
    ]);

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    await expect(dispatchHandler(makeEvent('hello'))).resolves.toBeUndefined();

    assertSendFailedLog(mockLogger, sendErr);
    // error 后 turn_finished 仍要 stopSession（资源清理）
    expect(agent.stopSession).toHaveBeenCalledTimes(1);
  });

  it('platform.send 失败（turn_finished 回送路径）：错误被吞 + 写 platform_send_failed + 仍走 stopSession', async () => {
    const platform = makePlatform();
    const sendErr = new Error('platform down turn_finished');
    (platform.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(sendErr);

    const agent = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();

    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: mockLogger,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-1' }),
      ev('text_final', { text: 'reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    await expect(dispatchHandler(makeEvent('hello'))).resolves.toBeUndefined();

    assertSendFailedLog(mockLogger, sendErr);
    expect(agent.stopSession).toHaveBeenCalledTimes(1);
  });

  it('agent.stopSession 抛出：错误被吞 + 写 agent_stop_session_failed 含 traceId/sessionKey/err', async () => {
    // 7a1f916 改了 stopSession 失败日志字段（加了 traceId/sessionKey），
    // 这里 lock 住，防止后续误删字段或 inline 时漏带 context。
    const platform = makePlatform();
    const agent = makeAgent();
    const stopErr = new Error('stop boom');
    (agent.stopSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw stopErr;
    });

    const store = new SessionStore();
    const mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as Logger;

    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: mockLogger,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
    });

    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-1' }),
      ev('text_final', { text: 'reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    await expect(dispatchHandler(makeEvent('hello'))).resolves.toBeUndefined();

    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const stopFailedLog = errorCalls.find(([, msg]) => msg === 'agent_stop_session_failed');
    expect(stopFailedLog).toBeDefined();
    expect(stopFailedLog![0]).toMatchObject({
      traceId: 't-1',
      err: stopErr,
    });
    expect(stopFailedLog![0]).toHaveProperty('sessionKey');

    // 同步 throw 应被本地 catch 兜住，不应升级成 handlerErr / agent_event_handler_failed
    const handlerErrLog = errorCalls.find(([, msg]) => msg === 'agent_event_handler_failed');
    expect(handlerErrLog).toBeUndefined();
  });
});
