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
import { createLogger } from './logger.js';
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
};

const SESSION_KEY: SessionKey = {
  platform: 'discord',
  channelId: 'C1',
  initiatorUserId: 'U1',
};

function makeEvent(text: string, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: 'e-1',
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
 * Mock agent：sendInput 同步触发预先排好的事件序列给最近一次注册的 handler。
 * 测试 setup 里通过 `queueEvents` 把事件队列塞进来。
 */
function makeAgent() {
  const handlers = new Map<AgentSession, AgentEventHandler>();
  let nextEvents: AgentEvent[] = [];
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
    // 同步触发已排队的事件序列；保留 await 以让 handler 内的 platform.send 推进
    for (const e of nextEvents) {
      await h(e);
    }
    nextEvents = [];
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
      nextEvents = events;
    },
  };
}

function ev<T extends AgentEvent['type']>(
  type: T,
  payload: Extract<AgentEvent, { type: T }>['payload'],
  sequence = 0,
): AgentEvent {
  return {
    type,
    traceId: 't-1',
    timestamp: new Date(0),
    sequence,
    payload,
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
      ev('session_started', { ccSessionID: 'cc-123' }),
      ev('text_final', { text: 'hi from cc' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    // 通过 start() 路径让 platform 拿到 dispatch 句柄；这里直接走 dispatch
    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello'));

    expect(agent.startSession).toHaveBeenCalledTimes(1);
    const startArgs = agent.startSession.mock.calls[0]!;
    const cfg = startArgs[1] as SessionConfig;
    expect(cfg.resumeFromCcSessionID).toBeUndefined();
    expect(cfg.sessionId).toBeTruthy();

    expect(store.get(SESSION_KEY)?.ccSessionID).toBe('cc-123');

    expect(platform.send).toHaveBeenCalledTimes(1);
    const sendArgs = platform.send.mock.calls[0]!;
    const out = sendArgs[1] as OutboundMessage;
    expect(out.text).toBe('hi from cc');

    expect(agent.stopSession).toHaveBeenCalledTimes(1);
  });

  it('第二轮：复用同 sessionKey，agent.startSession 收到 prev ccSessionID 作 resumeFromCcSessionID', async () => {
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

    // 首轮：写入 cc-123
    agent.queueEvents([
      ev('session_started', { ccSessionID: 'cc-123' }),
      ev('text_final', { text: 'first' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('first prompt'));
    expect(store.get(SESSION_KEY)?.ccSessionID).toBe('cc-123');

    // 第二轮：startSession 必须收到 cc-123 作 resume
    agent.queueEvents([
      ev('session_started', { ccSessionID: 'cc-456' }),
      ev('text_final', { text: 'second' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 2 }),
    ]);
    await dispatchHandler(makeEvent('second prompt'));

    expect(agent.startSession).toHaveBeenCalledTimes(2);
    const cfg2 = agent.startSession.mock.calls[1]![1] as SessionConfig;
    expect(cfg2.resumeFromCcSessionID).toBe('cc-123');

    expect(store.get(SESSION_KEY)?.ccSessionID).toBe('cc-456');
  });

  it('/new 带后续文本：清 store + 用 trim 后的剩余作 prompt', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    // 预置一条旧的
    store.set(SESSION_KEY, { ccSessionID: 'cc-123', lastTurnAt: new Date(0) });

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
      ev('session_started', { ccSessionID: 'cc-new' }),
      ev('text_final', { text: 'answer' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('/new what is X?'));

    expect(agent.startSession).toHaveBeenCalledTimes(1);
    const cfg = agent.startSession.mock.calls[0]![1] as SessionConfig;
    expect(cfg.resumeFromCcSessionID).toBeUndefined();

    expect(agent.sendInput).toHaveBeenCalledTimes(1);
    const input = agent.sendInput.mock.calls[0]![1] as AgentInput;
    expect(input.text).toBe('what is X?');

    // 新一轮 session_started 写回 cc-new；旧的 cc-123 已被清掉
    expect(store.get(SESSION_KEY)?.ccSessionID).toBe('cc-new');
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

  it('error 路径：agent emit error → platform.send 收到 [CC error: ...]', async () => {
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
    expect(out.text).toContain('CC error');
    expect(out.text).toContain('spawn_failed');
    expect(out.text).toContain('boom');
  });
});
