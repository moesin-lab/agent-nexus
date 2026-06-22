import { describe, expect, it, vi } from 'vitest';
import type {
  AgentCapabilitySet,
  AgentCommandEnvelope,
  AgentCommandResult,
  AgentEvent,
  AgentEventHandler,
  AgentInput,
  AgentRuntime,
  AgentSession,
  CapabilitySet,
  CommandDescriptor,
  CommandRegistrationScope,
  EventHandler,
  MessageRef,
  NormalizedEvent,
  OutboundMessage,
  PlatformSessionKey,
  PlatformAdapter,
  SessionConfig,
  SessionKey,
} from '@agent-nexus/protocol';
import { withPlatformName } from '@agent-nexus/protocol';
import {
  ActiveCommandRegistry,
  buildCommandRegistrationPlan,
  DEFAULT_COMMAND_NAME_POLICY,
} from './command-registry.js';
import { Engine } from './engine.js';
import { InMemoryIdempotencyStore } from './idempotency.js';
import { createLogger, type Logger } from './logger.js';
import type { RoutingEntry } from './router.js';
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
  supportsSlashCommands: false,
};

const agentCaps: AgentCapabilitySet = {
  supportsThinking: false,
  supportsStreaming: false,
  supportsToolCallEvents: false,
  supportsInterrupt: false,
  supportsStdinInterrupt: false,
};

const SESSION_KEY: PlatformSessionKey = {
  platform: 'discord',
  channelId: 'C1',
  initiatorUserId: 'U1',
};
const ROUTED_SESSION_KEY: SessionKey = withPlatformName(
  SESSION_KEY,
  'mock-platform',
);

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

function makePlatform(capOverrides: Partial<CapabilitySet> = {}): PlatformAdapter & {
  capabilities: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  setTyping: ReturnType<typeof vi.fn>;
  clearTyping: ReturnType<typeof vi.fn>;
  createThread: ReturnType<typeof vi.fn>;
  updateThread: ReturnType<typeof vi.fn>;
  settingsSnapshot: ReturnType<typeof vi.fn>;
  applySettingsAction: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const caps = { ...platformCaps, ...capOverrides };
  const ref: MessageRef = {
    platform: 'discord',
    channelId: 'C1',
    messageId: 'out-1',
    messageIds: ['out-1'],
    sentAt: new Date(0),
  };
  return {
    name: () => 'mock-platform',
    capabilities: vi.fn(() => caps),
    start: vi.fn(async (_h: EventHandler) => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async (_k: SessionKey, _m: OutboundMessage) => ref),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    createThread: vi.fn(async () => ({
      threadId: 'T1',
      parentChannelId: 'C1',
      url: 'https://discord.com/channels/G1/T1',
    })),
    updateThread: vi.fn(async () => undefined),
    settingsSnapshot: vi.fn(async () => ({ items: [] })),
    applySettingsAction: vi.fn(async () => ({
      status: 'handled',
      message: '[reply mode changed]',
    })),
    setTyping: vi.fn(async () => {}),
    clearTyping: vi.fn(async () => {}),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Mock agent：sendInput 触发"下一组"预排好的事件序列给当前 session 的 handler。
 *
 * - `queueEvents(events)` 入队一组；多次入队按 FIFO 取——支持多 dispatch 并发场景
 * - `queueEventsAfter(events, ms)` 入队一组并在事件分发前等 `ms` 毫秒（用于显式制造异步窗口）
 */
function makeAgent() {
  const handlers = new Map<AgentSession, AgentEventHandler[]>();
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

  const isAlive = vi.fn((s: AgentSession) => s.state !== 'Stopped');

  const onEvent = vi.fn((s: AgentSession, h: AgentEventHandler) => {
    const existing = handlers.get(s) ?? [];
    existing.push(h);
    handlers.set(s, existing);
  });

  const sendInput = vi.fn(async (s: AgentSession, _input: AgentInput) => {
    const sessionHandlers = handlers.get(s);
    if (!sessionHandlers) return;
    const entry = queue.shift();
    if (!entry) return;
    if (entry.delayMs > 0) {
      await new Promise((r) => setTimeout(r, entry.delayMs));
    }
    for (const e of entry.events) {
      for (const h of sessionHandlers) {
        try {
          const ret = h(e);
          if (ret && typeof (ret as Promise<void>).then === 'function') {
            void (ret as Promise<void>).catch(() => {});
          }
        } catch (err) {
          return Promise.reject(err);
        }
      }
    }
  });

  const interrupt = vi.fn(() => {});
  const handleCommand = vi.fn(
    async (
      s: AgentSession | undefined,
      command: AgentCommandEnvelope,
    ): Promise<AgentCommandResult> => {
      if (command.handlerKey === 'new') {
        if (s) s.state = 'Stopped';
        return {
          status: 'handled',
          message: '[new session ready]',
          updatedAgentSessionId: null,
        };
      }
      if (command.handlerKey === 'stop') {
        if (!s) return { status: 'rejected', message: '[no active output]' };
        interrupt(s);
        return { status: 'handled', message: '[stop requested]' };
      }
      return { status: 'handled', message: `[${command.handlerKey} handled]` };
    },
  );

  const runtime: AgentRuntime = {
    name: () => 'mock-agent',
    capabilities: () => agentCaps,
    startSession,
    stopSession,
    isAlive,
    sendInput,
    handleCommand,
    onEvent,
    interrupt,
  };

  return {
    runtime,
    startSession,
    stopSession,
    isAlive,
    onEvent,
    sendInput,
    handleCommand,
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
  timeoutMs: 60_000,
};

const PLATFORM_AUTH_ALLOW_U1 = {
  allowlist: {
    userIds: ['U1'],
    roleIds: [],
    allowedGuildIds: [],
    allowedChannelIds: [],
    allowDM: true,
    requireMentionOrSlash: true,
  },
};

const COMMAND_SCOPE: CommandRegistrationScope = {
  platformName: 'discord-main',
  platformType: 'discord',
  nativeScope: { kind: 'global' },
};

const CODEX_NEW_COMMAND: CommandDescriptor = {
  canonicalId: 'agent:codex:new',
  owner: { type: 'agent', agentOwner: 'codex' },
  localName: 'new',
  summary: 'Start a new Codex conversation',
  options: [],
  handlerKey: 'new',
  applicability: { requiredCapabilities: ['slash-command-registration'] },
  legacyNames: [],
};

const CODEX_STOP_COMMAND: CommandDescriptor = {
  canonicalId: 'agent:codex:stop',
  owner: { type: 'agent', agentOwner: 'codex' },
  localName: 'stop',
  summary: 'Stop the current agent output',
  options: [],
  handlerKey: 'stop',
  applicability: {
    requiredCapabilities: ['slash-command-registration'],
  },
  legacyNames: [],
};

const CODEX_INSPECT_COMMAND: CommandDescriptor = {
  canonicalId: 'agent:codex:inspect',
  owner: { type: 'agent', agentOwner: 'codex' },
  localName: 'inspect',
  summary: 'Inspect through Codex',
  options: [],
  handlerKey: 'inspect',
  applicability: {
    requiredCapabilities: ['slash-command-registration'],
  },
  legacyNames: [],
};

const DAEMON_KILL_COMMAND: CommandDescriptor = {
  canonicalId: 'daemon:kill',
  owner: { type: 'daemon' },
  localName: 'kill',
  summary: 'Terminate the current Nexus routing session',
  options: [],
  handlerKey: 'kill',
  applicability: {
    requiredCapabilities: ['slash-command-registration'],
  },
  legacyNames: [],
};

const DAEMON_RELOAD_CONFIG_COMMAND: CommandDescriptor = {
  canonicalId: 'daemon:reload-config',
  owner: { type: 'daemon' },
  localName: 'reload-config',
  summary: 'Reload config.json and apply runtime-safe fields',
  options: [],
  handlerKey: 'reload-config',
  applicability: {
    requiredCapabilities: ['slash-command-registration'],
  },
  legacyNames: [],
};

const DAEMON_SESSIONS_COMMAND: CommandDescriptor = {
  canonicalId: 'daemon:sessions',
  owner: { type: 'daemon' },
  localName: 'sessions',
  summary: 'List resumable Nexus routing sessions',
  options: [],
  handlerKey: 'sessions',
  applicability: {
    requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
  },
  legacyNames: [],
};

const DAEMON_NEW_THREAD_COMMAND: CommandDescriptor = {
  canonicalId: 'daemon:new-thread',
  owner: { type: 'daemon' },
  localName: 'new-thread',
  summary: 'Create a Discord thread for a new Nexus routing session',
  options: [
    {
      name: 'title',
      type: 'string',
      required: false,
      description: 'Optional thread title',
      choices: [],
    },
  ],
  handlerKey: 'new-thread',
  applicability: {
    requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
  },
  legacyNames: [],
};

const DAEMON_WORKING_DIR_COMMAND: CommandDescriptor = {
  canonicalId: 'daemon:working-dir',
  owner: { type: 'daemon' },
  localName: 'working-dir',
  summary: 'Set the working directory for the next Nexus routing session',
  options: [
    {
      name: 'path',
      type: 'string',
      required: true,
      description: 'Absolute working directory path',
      choices: [],
    },
  ],
  handlerKey: 'working-dir',
  applicability: {
    requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
  },
  legacyNames: [],
};

const DAEMON_SETTINGS_COMMAND: CommandDescriptor = {
  canonicalId: 'daemon:settings',
  owner: { type: 'daemon' },
  localName: 'settings',
  summary: 'Show Nexus settings for this Discord channel',
  options: [],
  handlerKey: 'settings',
  applicability: {
    requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
  },
  legacyNames: [],
};

const DAEMON_QUEUE_COMMAND: CommandDescriptor = {
  canonicalId: 'daemon:queue',
  owner: { type: 'daemon' },
  localName: 'queue',
  summary: 'Show or clear the current Nexus queue',
  options: [
    {
      name: 'action',
      type: 'string',
      required: false,
      description: 'Queue action',
      choices: [
        { name: 'status', value: 'status' },
        { name: 'clear', value: 'clear' },
        { name: 'next', value: 'next' },
      ],
    },
  ],
  handlerKey: 'queue',
  applicability: {
    requiredCapabilities: ['slash-command-registration', 'ephemeral-response'],
  },
  legacyNames: [],
};

function makeCommandEvent(
  commandName: string,
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return makeEvent('', {
    type: 'command',
    text: undefined,
    command: {
      name: commandName,
      args: {},
      registrationScope: COMMAND_SCOPE,
    },
    rawContentType: 'discord:interaction',
    ...overrides,
  });
}

function makeComponentEvent(
  customId: string,
  values: string[],
  overrides: Partial<NormalizedEvent> = {},
): NormalizedEvent {
  return makeEvent('', {
    type: 'interaction',
    text: undefined,
    interaction: {
      customId,
      componentType: 'string-select',
      values,
    },
    rawContentType: 'discord:component-interaction',
    ...overrides,
  });
}

function makeActiveRegistry(
  extraDescriptors: readonly CommandDescriptor[] = [],
): ActiveCommandRegistry {
  const registry = new ActiveCommandRegistry();
  const plan = buildCommandRegistrationPlan({
    descriptors: [
      CODEX_NEW_COMMAND,
      CODEX_STOP_COMMAND,
      DAEMON_KILL_COMMAND,
      ...extraDescriptors,
    ],
    scope: COMMAND_SCOPE,
    capabilities: {
      ...platformCaps,
      supportsSlashCommands: true,
      supportsEphemeral: true,
    },
    policy: DEFAULT_COMMAND_NAME_POLICY,
    agentOwnersInScope: ['codex'],
    generation: 'g-command',
  });
  registry.activate(plan, new Date(0));
  return registry;
}

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

    expect(store.get(ROUTED_SESSION_KEY)?.agentSessionId).toBe('sid-123');
    expect(store.get(ROUTED_SESSION_KEY)?.title).toBe('hello');

    expect(platform.send).toHaveBeenCalledTimes(1);
    const sendArgs = platform.send.mock.calls[0]!;
    const out = sendArgs[1] as OutboundMessage;
    expect(out.text).toBe('hi from agent');

    expect(agent.stopSession).not.toHaveBeenCalled();
  });

  it('第二轮：复用同 sessionKey 的活跃 AgentSession，不重新 startSession', async () => {
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
    expect(store.get(ROUTED_SESSION_KEY)?.agentSessionId).toBe('sid-123');

    const firstSession = agent.sendInput.mock.calls[0]![0] as AgentSession;

    // 第二轮：活跃 session 仍 alive，直接复用同一 AgentSession
    agent.queueEvents([
      ev('text_final', { text: 'second' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 2 }),
    ]);
    await dispatchHandler(makeEvent('second prompt'));

    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(agent.onEvent).toHaveBeenCalledTimes(1);
    expect(agent.sendInput.mock.calls[1]![0]).toBe(firstSession);
    expect(store.get(ROUTED_SESSION_KEY)?.agentSessionId).toBe('sid-123');
    expect(agent.stopSession).not.toHaveBeenCalled();
  });

  it('第二轮发现活跃 AgentSession 不 alive：关闭旧句柄并用 store 里的 agentSessionId resume 新 session', async () => {
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
      ev('session_started', { agentSessionId: 'sid-123' }),
      ev('text_final', { text: 'first' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('first prompt'));

    agent.isAlive.mockReturnValueOnce(false);
    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-456' }),
      ev('text_final', { text: 'second' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 2 }),
    ]);
    await dispatchHandler(makeEvent('second prompt'));

    expect(agent.stopSession).toHaveBeenCalledTimes(1);
    expect(agent.startSession).toHaveBeenCalledTimes(2);
    const cfg2 = agent.startSession.mock.calls[1]![1] as SessionConfig;
    expect(cfg2.resumeFromAgentSessionId).toBe('sid-123');
    expect(store.get(ROUTED_SESSION_KEY)?.agentSessionId).toBe('sid-456');
  });

  it('/new 带后续文本：清 store + 用 trim 后的剩余作 prompt', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    // 预置一条旧的
    store.set(ROUTED_SESSION_KEY, { agentSessionId: 'sid-123', lastTurnAt: new Date(0) });

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
    expect(store.get(ROUTED_SESSION_KEY)?.agentSessionId).toBe('sid-new');
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

  it('textPrefixes.newSession=false 时 /new 文本按普通 prompt 转给 agent', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
      textPrefixes: { newSession: false },
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    agent.queueEvents([
      ev('session_started', { agentSessionId: 'sid-new' }),
      ev('text_final', { text: 'answer' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('/new'));

    expect(platform.send).toHaveBeenCalledTimes(1);
    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(agent.sendInput).toHaveBeenCalledTimes(1);
    expect((agent.sendInput.mock.calls[0]![1] as AgentInput).text).toBe('/new');
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
      ev('text_final', { text: 'second reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 2 }),
    ]);

    const p1 = dispatchHandler(makeEvent('first'));
    const p2 = dispatchHandler(makeEvent('second'));
    await Promise.all([p1, p2]);

    expect(agent.startSession).toHaveBeenCalledTimes(1);
    expect(agent.onEvent).toHaveBeenCalledTimes(1);
    expect(agent.sendInput).toHaveBeenCalledTimes(2);
    expect(agent.sendInput.mock.calls[1]![0]).toBe(agent.sendInput.mock.calls[0]![0]);

    // store 仍保留当前活跃 agent session id；第二轮未重启 session。
    expect(store.get(ROUTED_SESSION_KEY)?.agentSessionId).toBe('sid-first');
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

    const KEY_A: PlatformSessionKey = { platform: 'discord', channelId: 'C1', initiatorUserId: 'A' };
    const KEY_B: PlatformSessionKey = { platform: 'discord', channelId: 'C1', initiatorUserId: 'B' };

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

    expect(store.get(withPlatformName(KEY_A, 'mock-platform'))?.agentSessionId).toBe('sid-a');
    expect(store.get(withPlatformName(KEY_B, 'mock-platform'))?.agentSessionId).toBe('sid-b');
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

  it('注入 IdempotencyStore 后同 session/messageId 重放不触发第二次 agent 调用', async () => {
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
      idempotencyStore: new InMemoryIdempotencyStore(),
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    agent.queueEvents([
      ev('text_final', { text: 'first' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('first', {
      eventId: 'e-replay-1',
      messageId: 'm-replay',
    }));
    await dispatchHandler(makeEvent('second', {
      eventId: 'e-replay-2',
      messageId: 'm-replay',
    }));

    expect(agent.sendInput).toHaveBeenCalledTimes(1);
    expect(platform.send).toHaveBeenCalledTimes(1);
    expect((mockLogger.info as ReturnType<typeof vi.fn>).mock.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.any(Object), 'idempotency_insert']),
        expect.arrayContaining([expect.any(Object), 'idempotency_hit']),
      ]),
    );
  });

  it('auth_denied 不占用幂等键，后续同 messageId 授权事件仍可处理', async () => {
    const platform = makePlatform();
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      idempotencyStore: new InMemoryIdempotencyStore(),
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      defaultSessionConfig: DEFAULT_CFG,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    await dispatchHandler(makeEvent('denied', {
      eventId: 'e-denied',
      messageId: 'm-same',
      initiator: { userId: 'U2', displayName: 'U2', isBot: false },
      sessionKey: { ...SESSION_KEY, initiatorUserId: 'U2' },
    }));

    agent.queueEvents([
      ev('text_final', { text: 'allowed' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('allowed', {
      eventId: 'e-allowed',
      messageId: 'm-same',
    }));

    expect(agent.sendInput).toHaveBeenCalledTimes(1);
    expect(platform.send).toHaveBeenCalledTimes(1);
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

  it('routingTable 未命中：打 route_not_found 且不调用任何 agent', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const claude = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
        {
          agentName: 'claude-prod',
          agent: claude.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello', {
      sessionKey: { ...SESSION_KEY, channelId: 'C9' },
    }));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(claude.startSession).not.toHaveBeenCalled();
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    expect(warnCalls.find(([, msg]) => msg === 'route_not_found')).toBeDefined();
  });

  it('routingTable 多重命中：打 route_ambiguous 且不调用任何 agent', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const claude = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex-a',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
      {
        bindingName: 'discord-main-codex-b',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello'));

    expect(codex.startSession).not.toHaveBeenCalled();
    const warnCalls = (mockLogger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const routeLog = warnCalls.find(([, msg]) => msg === 'route_ambiguous');
    expect(routeLog).toBeDefined();
    expect(routeLog![0]).toMatchObject({
      bindingNames: ['discord-main-codex-a', 'discord-main-codex-b'],
    });
  });

  it('routingTable 缺 platformAuth 时启动前失败，避免多平台路径静默跳过鉴权', () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];

    expect(
      () =>
        new Engine({
          platform,
          platformName: 'discord-main',
          platformType: 'discord',
          agents: [
            {
              agentName: 'codex-dev',
              agent: codex.runtime,
              defaultSessionConfig: DEFAULT_CFG,
            },
          ],
          routingTable,
          logger: SILENT_LOGGER,
          sessionStore: new SessionStore(),
        }),
    ).toThrow(/requires platformAuth/);
  });

  it('routing 命中后 user 不在 platform auth allowlist 时 auth_denied 且不调用 agent / 不创建 session', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const claude = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      platformAuth: {
        allowlist: {
          userIds: ['U-allowed'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: [],
          allowDM: true,
          requireMentionOrSlash: true,
        },
      },
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello', {
      initiator: { userId: 'U-denied', displayName: 'denied', isBot: false },
      sessionKey: {
        platform: 'discord',
        channelId: 'C1',
        initiatorUserId: 'U-denied',
      },
    }));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(codex.sendInput).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const authLog = infoCalls.find(([, msg]) => msg === 'auth_denied');
    expect(authLog).toBeDefined();
    expect(authLog![0]).toMatchObject({
      platformName: 'discord-main',
      channelId: 'C1',
      userId: 'U-denied',
      reason: 'user_not_allowed',
    });
  });

  it('daemon-created thread messages route and authorize through the parent channel for the owner', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const store = new SessionStore();
    store.set(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      {
        lastTurnAt: new Date(0),
        title: 'Thread shell',
      },
    );
    store.registerThread(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      {
        parentChannelId: 'C1',
        ownerUserId: 'U1',
        autoArchiveDurationMinutes: 1440,
        renameOnFirstPrompt: true,
      },
    );
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      platformAuth: {
        allowlist: {
          userIds: ['U1'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: ['C1'],
          allowDM: false,
          requireMentionOrSlash: true,
        },
      },
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-thread' }),
      ev('text_final', { text: 'thread reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('hello from thread', {
      sessionKey: {
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      guildId: 'G1',
      threadParentChannelId: 'C1',
    }));

    expect(codex.startSession).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(platform.updateThread).toHaveBeenCalledWith({
      threadId: 'T1',
      title: 'hello from thread',
      traceId: 't-1',
    });
    expect(store.get({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'T1',
      initiatorUserId: 'U1',
    })).toMatchObject({
      agentSessionId: 'sid-thread',
    });
    expect(store.findThreadByChannelId({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'T1',
    })).toMatchObject({
      parentChannelId: 'C1',
      ownerUserId: 'U1',
      renameOnFirstPrompt: false,
    });
  });

  it('daemon-created thread with an existing title does not rename on first prompt', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const store = new SessionStore();
    store.set(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      {
        lastTurnAt: new Date(0),
        title: 'Design auth flow',
      },
    );
    store.registerThread(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      {
        parentChannelId: 'C1',
        ownerUserId: 'U1',
        autoArchiveDurationMinutes: 1440,
        renameOnFirstPrompt: false,
      },
    );
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      platformAuth: {
        allowlist: {
          userIds: ['U1'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: ['C1'],
          allowDM: false,
          requireMentionOrSlash: true,
        },
      },
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-thread' }),
      ev('text_final', { text: 'thread reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('new implementation idea', {
      sessionKey: {
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      guildId: 'G1',
      threadParentChannelId: 'C1',
    }));

    expect(codex.startSession).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(platform.updateThread).not.toHaveBeenCalled();
    expect(store.get({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'T1',
      initiatorUserId: 'U1',
    })).toMatchObject({
      agentSessionId: 'sid-thread',
      title: 'Design auth flow',
    });
  });

  it('daemon-created thread rejects messages from non-owner users', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const store = new SessionStore();
    const logger = makeMockLogger();
    store.registerThread(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      {
        parentChannelId: 'C1',
        ownerUserId: 'U1',
        autoArchiveDurationMinutes: 1440,
      },
    );
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      platformAuth: {
        allowlist: {
          userIds: ['U1', 'U2'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: ['C1'],
          allowDM: false,
          requireMentionOrSlash: true,
        },
      },
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      logger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello from another user', {
      sessionKey: {
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U2',
      },
      guildId: 'G1',
      initiator: { userId: 'U2', displayName: 'U2', isBot: false },
      threadParentChannelId: 'C1',
    }));

    expect(codex.startSession).not.toHaveBeenCalled();
    const authLog = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, msg]) => msg === 'auth_denied',
    );
    expect(authLog?.[0]).toMatchObject({
      channelId: 'T1',
      userId: 'U2',
      ownerUserId: 'U1',
      reason: 'thread_owner_mismatch',
    });
  });

  it('thread messages with parent channel metadata still work after in-memory placeholders are lost', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      platformAuth: {
        allowlist: {
          userIds: ['U1'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: ['C1'],
          allowDM: false,
          requireMentionOrSlash: true,
        },
      },
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-thread' }),
      ev('text_final', { text: 'thread reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('hello after restart', {
      sessionKey: {
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      guildId: 'G1',
      threadParentChannelId: 'C1',
    }));

    expect(codex.startSession).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(platform.updateThread).not.toHaveBeenCalled();
    expect(store.get({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'T1',
      initiatorUserId: 'U1',
    })).toMatchObject({
      agentSessionId: 'sid-thread',
    });
    expect(store.findThreadByChannelId({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'T1',
    })).toBeUndefined();
  });

  it('routing 命中后 guild 不在 platform auth allowlist 时 auth_denied 且不调用 agent / 不创建 session', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      platformAuth: {
        allowlist: {
          userIds: ['U1'],
          roleIds: [],
          allowedGuildIds: ['G-allowed'],
          allowedChannelIds: [],
          allowDM: true,
          requireMentionOrSlash: true,
        },
      },
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello', { guildId: 'G-denied' }));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(codex.sendInput).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const authLog = infoCalls.find(([, msg]) => msg === 'auth_denied');
    expect(authLog).toBeDefined();
    expect(authLog![0]).toMatchObject({
      platformName: 'discord-main',
      guildId: 'G-denied',
      channelId: 'C1',
      userId: 'U1',
      reason: 'guild_not_allowed',
    });
  });

  it('routing 命中后 channel 不在 platform auth allowlist 时 auth_denied 且不调用 agent / 不创建 session', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      platformAuth: {
        allowlist: {
          userIds: ['U1'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: ['C-allowed'],
          allowDM: true,
          requireMentionOrSlash: true,
        },
      },
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello'));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(codex.sendInput).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const authLog = infoCalls.find(([, msg]) => msg === 'auth_denied');
    expect(authLog).toBeDefined();
    expect(authLog![0]).toMatchObject({
      platformName: 'discord-main',
      channelId: 'C1',
      userId: 'U1',
      reason: 'channel_not_allowed',
    });
  });

  it('routingTable 按 platformName + channel 选择 agent，并用 platformName 隔离 session key', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const claude = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
      {
        bindingName: 'discord-main-claude',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'claude-prod',
        match: { discord: { channelIds: ['C2'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
        {
          agentName: 'claude-prod',
          agent: claude.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    claude.queueEvents([
      ev('session_started', { agentSessionId: 'claude-sid' }),
      ev('text_final', { text: 'from claude' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello', {
      sessionKey: { ...SESSION_KEY, channelId: 'C2' },
    }));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(claude.startSession).toHaveBeenCalledTimes(1);
    const startedKey = claude.startSession.mock.calls[0]![0] as SessionKey;
    expect(startedKey).toMatchObject({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C2',
      initiatorUserId: 'U1',
    });
    expect(
      store.get({
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C2',
        initiatorUserId: 'U1',
      })?.agentSessionId,
    ).toBe('claude-sid');
  });

  it('command event 通过 active reverse map 路由 agent /new，不从 commandName 拆 owner', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const claude = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
        {
          agentName: 'claude-prod',
          agentOwner: 'claudecode',
          agent: claude.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
        {
          agentName: 'claude-prod',
          agentOwner: 'claudecode',
          agent: claude.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeCommandEvent('new'));

    expect(platform.send).toHaveBeenCalledTimes(1);
    expect((platform.send.mock.calls[0]![1] as OutboundMessage).text).toBe(
      '[new session ready]',
    );
    expect(codex.startSession).not.toHaveBeenCalled();
    expect(codex.handleCommand).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        canonicalId: 'agent:codex:new',
        localName: 'new',
        handlerKey: 'new',
      }),
    );
    expect(codex.sendInput).not.toHaveBeenCalled();
  });

  it('agent /stop 立即转发给 route 命中的 runtime，不等待当前 turn 完成', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      daemonCommandHandlerKeys: ['kill'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEventsAfter(
      [
        ev('text_final', { text: 'late reply' }),
        ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
      ],
      30,
    );
    const runningTurn = dispatchHandler(makeEvent('long task'));
    await new Promise((resolve) => setTimeout(resolve, 1));

    await dispatchHandler(makeCommandEvent('stop'));

    expect(codex.handleCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        canonicalId: 'agent:codex:stop',
        localName: 'stop',
        handlerKey: 'stop',
      }),
    );
    expect(platform.send).toHaveBeenCalledWith(
      expect.objectContaining({ platformName: 'discord-main' }),
      expect.objectContaining({ text: '[stop requested]' }),
    );

    await runningTurn;
  });

  it('queued agent command 等待同 RoutingSession 当前 turn 完成', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEventsAfter(
      [
        ev('text_final', { text: 'done' }),
        ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
      ],
      30,
    );
    const runningTurn = dispatchHandler(makeEvent('long task'));
    await new Promise((resolve) => setTimeout(resolve, 1));

    const queuedNew = dispatchHandler(makeCommandEvent('new'));
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(codex.handleCommand).not.toHaveBeenCalled();

    await runningTurn;
    await queuedNew;

    expect(codex.handleCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        canonicalId: 'agent:codex:new',
        handlerKey: 'new',
      }),
    );
  });

  it('/nexus-queue status shows and clear cancels only current pending messages', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const idempotencyStore = new InMemoryIdempotencyStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_QUEUE_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'queue'],
      idempotencyStore,
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEventsAfter(
      [
        ev('text_final', { text: 'first done' }),
        ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
      ],
      30,
    );
    const runningTurn = dispatchHandler(makeEvent('running', {
      eventId: 'e-running',
      messageId: 'm-running',
    }));
    await new Promise((resolve) => setTimeout(resolve, 1));

    const pendingTurn = dispatchHandler(makeEvent('pending', {
      eventId: 'e-pending',
      messageId: 'm-pending',
    }));
    await new Promise((resolve) => setTimeout(resolve, 1));

    const status = await dispatchHandler(
      makeCommandEvent('nexus-queue', {
        command: {
          name: 'nexus-queue',
          args: { action: 'status' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );
    expect(status?.commandResponse?.text).toContain('Pending: `1 / 20`');

    const clear = await dispatchHandler(
      makeCommandEvent('nexus-queue', {
        command: {
          name: 'nexus-queue',
          args: { action: 'clear' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );
    expect(clear?.commandResponse?.text).toContain('Cancelled: `1`');
    expect(clear?.commandResponse?.text).toContain('Pending: `0 / 20`');

    await pendingTurn;
    await runningTurn;

    expect(codex.sendInput).toHaveBeenCalledTimes(1);
    expect(idempotencyStore.checkAndSet(
      withPlatformName(SESSION_KEY, 'discord-main'),
      'm-pending',
    )).toEqual({
      kind: 'hit',
      status: 'cancelled',
    });
  });

  it('/nexus-queue next interrupts the running turn and preserves pending messages', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_QUEUE_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'queue'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });
    store.set(withPlatformName(SESSION_KEY, 'discord-main'), {
      agentSessionId: 'sid-existing',
      lastTurnAt: new Date(0),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEventsAfter(
      [
        ev('session_started', { agentSessionId: 'sid-1' }),
        ev('turn_finished', { reason: 'user_interrupt', turnSequence: 1 }),
      ],
      30,
    );
    const runningTurn = dispatchHandler(
      makeEvent('running', { traceId: 't-running' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));

    codex.queueEvents([
      ev('text_final', { text: 'pending done' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 2 }),
    ]);
    const pendingTurn = dispatchHandler(
      makeEvent('pending', { traceId: 't-pending' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));

    const next = await dispatchHandler(
      makeCommandEvent('nexus-queue', {
        traceId: 't-next',
        command: {
          name: 'nexus-queue',
          args: { action: 'next' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );

    expect(next?.commandResponse?.text).toContain(
      'Interrupted current turn; next queued item will run.',
    );
    expect(codex.runtime.interrupt).toHaveBeenCalledTimes(1);
    expect(store.get(withPlatformName(SESSION_KEY, 'discord-main'))).toMatchObject({
      agentSessionId: 'sid-existing',
    });

    const duplicateNext = await dispatchHandler(
      makeCommandEvent('nexus-queue', {
        traceId: 't-next-duplicate',
        command: {
          name: 'nexus-queue',
          args: { action: 'next' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );
    expect(duplicateNext?.commandResponse?.text).toContain(
      'Run next already requested.',
    );
    expect(codex.runtime.interrupt).toHaveBeenCalledTimes(1);

    await Promise.all([runningTurn, pendingTurn]);

    const inputTexts = codex.sendInput.mock.calls.map(
      (call) => (call[1] as AgentInput).text,
    );
    expect(inputTexts).toEqual(['running', 'pending']);
  });

  it('/nexus-queue lets the user edit and reorder pending message items', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_QUEUE_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'queue'],
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEventsAfter([], 30);
    const runningTurn = dispatchHandler(makeEvent('running'));
    await new Promise((resolve) => setTimeout(resolve, 1));
    codex.queueEvents([]);
    const alphaTurn = dispatchHandler(makeEvent('alpha'));
    codex.queueEvents([]);
    const betaTurn = dispatchHandler(makeEvent('beta'));
    await new Promise((resolve) => setTimeout(resolve, 1));

    const status = await dispatchHandler(
      makeCommandEvent('nexus-queue', {
        command: {
          name: 'nexus-queue',
          args: { action: 'status' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );
    const select = status?.commandResponse?.components?.find(
      (component) => component.type === 'string-select',
    );
    expect(select).toMatchObject({
      customId: 'nexus:queue:select',
      options: [
        expect.objectContaining({ label: expect.stringContaining('alpha') }),
        expect.objectContaining({ label: expect.stringContaining('beta') }),
      ],
    });
    const alphaId = select?.type === 'string-select' ? select.options[0]!.value : '';
    const betaId = select?.type === 'string-select' ? select.options[1]!.value : '';

    const selectedPanel = await dispatchHandler(
      makeComponentEvent('nexus:queue:select', [alphaId]),
    );
    const selectedCustomIds = selectedPanel?.commandResponse?.components?.map(
      (component) => component.customId,
    );
    expect(selectedPanel?.commandResponse?.components?.length).toBeLessThanOrEqual(5);
    expect(selectedCustomIds).toEqual([
      'nexus:queue:select',
      `nexus:queue:up:${alphaId}`,
      `nexus:queue:down:${alphaId}`,
      `nexus:queue:edit:${alphaId}`,
      `nexus:queue:cancel:${alphaId}`,
    ]);

    const editModal = await dispatchHandler(
      makeComponentEvent(`nexus:queue:edit:${alphaId}`, [], {
        interaction: {
          customId: `nexus:queue:edit:${alphaId}`,
          componentType: 'button',
          values: [],
        },
      }),
    );
    expect(editModal).toMatchObject({
      modalResponse: {
        customId: `nexus:queue:edit-modal:${alphaId}`,
      },
    });
    const edited = await dispatchHandler(
      makeComponentEvent(`nexus:queue:edit-modal:${alphaId}`, [], {
        interaction: {
          customId: `nexus:queue:edit-modal:${alphaId}`,
          componentType: 'modal-submit',
          values: [],
          fields: { prompt: 'alpha edited' },
        },
      }),
    );
    expect(edited?.commandResponse?.text).toContain('Updated: `alpha edited`');

    const moved = await dispatchHandler(
      makeComponentEvent(`nexus:queue:up:${betaId}`, [], {
        interaction: {
          customId: `nexus:queue:up:${betaId}`,
          componentType: 'button',
          values: [],
        },
      }),
    );
    expect(moved?.commandResponse?.text).toContain('Moved up');

    await Promise.all([runningTurn, betaTurn, alphaTurn]);

    const inputTexts = codex.sendInput.mock.calls.map(
      (call) => (call[1] as AgentInput).text,
    );
    expect(inputTexts).toEqual(['running', 'beta', 'alpha edited']);
  });

  it('/nexus-queue insert modal inserts a prompt before existing pending messages', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_QUEUE_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'queue'],
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEventsAfter([], 30);
    const runningTurn = dispatchHandler(makeEvent('running'));
    await new Promise((resolve) => setTimeout(resolve, 1));
    codex.queueEvents([]);
    const pendingTurn = dispatchHandler(makeEvent('pending'));
    await new Promise((resolve) => setTimeout(resolve, 1));

    const insertModal = await dispatchHandler(
      makeComponentEvent('nexus:queue:insert', [], {
        interaction: {
          customId: 'nexus:queue:insert',
          componentType: 'button',
          values: [],
        },
      }),
    );
    expect(insertModal).toMatchObject({
      modalResponse: { customId: 'nexus:queue:insert-modal' },
    });
    codex.queueEvents([]);
    const inserted = await dispatchHandler(
      makeComponentEvent('nexus:queue:insert-modal', [], {
        interaction: {
          customId: 'nexus:queue:insert-modal',
          componentType: 'modal-submit',
          values: [],
          fields: { prompt: 'inserted prompt' },
        },
      }),
    );
    expect(inserted?.commandResponse?.text).toContain('Inserted next: `inserted prompt`');

    await Promise.all([runningTurn, pendingTurn]);
    await new Promise((resolve) => setTimeout(resolve, 1));

    const inputTexts = codex.sendInput.mock.calls.map(
      (call) => (call[1] as AgentInput).text,
    );
    expect(inputTexts).toEqual(['running', 'inserted prompt', 'pending']);
  });

  it('agent /new 清除 inactive active handle，下一条消息重新 startSession', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-before-new' }),
      ev('text_final', { text: 'first' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('hello'));

    await dispatchHandler(makeCommandEvent('new'));

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-after-new' }),
      ev('text_final', { text: 'second' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('again'));

    expect(codex.startSession).toHaveBeenCalledTimes(2);
    expect(
      store.get({
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C1',
        initiatorUserId: 'U1',
      })?.agentSessionId,
    ).toBe('sid-after-new');
  });

  it('immediate agent command without active session does not create a phantom AgentSession', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    const result = await dispatchHandler(makeCommandEvent('stop'));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(codex.handleCommand).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ canonicalId: 'agent:codex:stop' }),
    );
    expect(platform.send).not.toHaveBeenCalled();
    expect(result).toEqual({
      commandResponse: {
        text: '[no active output]',
        ephemeral: true,
      },
    });
  });

  it('agent command 不做 handler 校验，按 handlerKey 和参数转发给当前 backend', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([CODEX_INSPECT_COMMAND]),
      daemonCommandHandlerKeys: ['kill'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeCommandEvent('codex-inspect', {
      command: {
        name: 'codex-inspect',
        args: { target: 'src/index.ts' },
        registrationScope: COMMAND_SCOPE,
      },
    }));

    expect(codex.sendInput).not.toHaveBeenCalled();
    expect(codex.handleCommand).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        canonicalId: 'agent:codex:inspect',
        localName: 'inspect',
        handlerKey: 'inspect',
        args: { target: 'src/index.ts' },
        routingSession: expect.objectContaining({
          platformName: 'discord-main',
          platformType: 'discord',
          channelId: 'C1',
          userId: 'U1',
        }),
      }),
    );
  });

  it('agent command in a thread inherits the parent channel binding for dispatch', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: {
        allowlist: {
          userIds: ['U1'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: ['C1'],
          allowDM: false,
          requireMentionOrSlash: true,
        },
      },
      commandRegistry: makeActiveRegistry(),
      daemonCommandHandlerKeys: ['kill'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeCommandEvent('codex-stop', {
      sessionKey: {
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      guildId: 'G1',
      threadParentChannelId: 'C1',
    }));

    expect(codex.handleCommand).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        canonicalId: 'agent:codex:stop',
        routingSession: expect.objectContaining({
          channelId: 'T1',
        }),
      }),
    );
  });

  it('daemon /nexus-kill 停止活跃 session 并清除 resume store', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      daemonCommandHandlerKeys: ['kill'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-123' }),
      ev('text_final', { text: 'first' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('hello'));

    await dispatchHandler(makeCommandEvent('nexus-kill'));

    expect(codex.stopSession).toHaveBeenCalledTimes(1);
    expect(store.get({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: 'U1',
    })).toBeUndefined();
    expect(platform.send).toHaveBeenCalledWith(
      expect.objectContaining({ platformName: 'discord-main' }),
      expect.objectContaining({ text: '[session killed]' }),
    );
  });

  it('daemon /nexus-sessions 返回当前用户可恢复 session 的 select 组件', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const claude = makeAgent();
    const store = new SessionStore();
    store.set(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C-old',
        initiatorUserId: 'U1',
      },
      {
        agentSessionId: 'sid-old',
        lastTurnAt: new Date(10),
        title: 'Investigate failing tests',
      },
    );
    store.set(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C-other-user',
        initiatorUserId: 'U2',
      },
      { agentSessionId: 'sid-other', lastTurnAt: new Date(20) },
    );
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1', 'C-old'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_SESSIONS_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'sessions'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('nexus-sessions'));

    expect(result).toMatchObject({
      commandResponse: {
        text: 'Select a session to resume.',
        ephemeral: true,
        components: [
          {
            type: 'string-select',
            customId: 'nexus:sessions:resume',
            options: [
              {
                label: 'Investigate failing tests',
                description: 'C-old · sid-old',
              },
            ],
          },
        ],
      },
    });
  });

  it('session select interaction binds selected session id to current key and next message resumes it', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const claude = makeAgent();
    const store = new SessionStore();
    store.set(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C-old',
        initiatorUserId: 'U1',
      },
      {
        agentSessionId: 'sid-old',
        lastTurnAt: new Date(10),
        title: 'Continue deployment work',
      },
    );
    const [oldSession] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });
    expect(oldSession).toBeDefined();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1', 'C-old'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_SESSIONS_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'sessions'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(
      makeComponentEvent('nexus:sessions:resume', [oldSession!.sessionId]),
    );

    expect(result).toEqual({
      commandResponse: {
        text: '[session resumed: sid-old]',
        ephemeral: true,
      },
    });
    expect(store.get({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: 'U1',
    })).toMatchObject({
      agentSessionId: 'sid-old',
      title: 'Continue deployment work',
    });

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-resumed' }),
      ev('text_final', { text: 'resumed reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('continue'));

    expect(codex.startSession).toHaveBeenCalledTimes(1);
    expect(codex.startSession.mock.calls[0]![1]).toMatchObject({
      resumeFromAgentSessionId: 'sid-old',
    });
  });

  it('daemon /nexus-settings returns a user-scoped settings snapshot with actions', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
      supportsThreadCreation: true,
    });
    platform.settingsSnapshot.mockResolvedValueOnce({
      items: [
        {
          key: 'discord.replyMode',
          label: 'Reply mode',
          owner: 'platform',
          value: 'mention',
          source: 'discord state',
          durability: 'durable',
          canChange: true,
        },
      ],
    });
    const codex = makeAgent();
    const claude = makeAgent();
    const store = new SessionStore();
    store.set(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C-old',
        initiatorUserId: 'U1',
      },
      {
        agentSessionId: 'sid-old',
        lastTurnAt: new Date(10),
        title: 'Investigate settings',
      },
    );
    store.setChannelWorkingDir(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C1',
      },
      '/tmp/channel',
    );
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
        {
          agentName: 'claude-prod',
          agentOwner: 'claudecode',
          agent: claude.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1', 'C-old'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_SETTINGS_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'settings'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('nexus-settings'));

    expect(platform.settingsSnapshot).toHaveBeenCalledWith({
      userId: 'U1',
      channelId: 'C1',
    });
    expect(result).toMatchObject({
      commandResponse: {
        ephemeral: true,
        components: expect.arrayContaining([
          expect.objectContaining({
            type: 'string-select',
            customId: 'nexus:settings:reply-mode',
          }),
          expect.objectContaining({
            type: 'string-select',
            customId: 'nexus:settings:resume',
          }),
          expect.objectContaining({
            type: 'button',
            customId: 'nexus:settings:new-thread',
          }),
          expect.objectContaining({
            type: 'button',
            customId: 'nexus:settings:working-dir',
          }),
          expect.objectContaining({
            type: 'string-select',
            customId: 'nexus:settings:agent',
          }),
        ]),
      },
    });
    expect(result?.commandResponse?.text).toContain('**Nexus settings**');
    expect(result?.commandResponse?.text).toContain('**Current state**');
    expect(result?.commandResponse?.text).toContain('Reply mode: `mention` · discord state · durable');
    expect(result?.commandResponse?.text).toContain('WorkingDir: `/tmp/channel` · channel default · in-memory');
    expect(result?.commandResponse?.text).toContain('Resumable sessions: `1`');
    expect(result?.commandResponse?.text).toContain('Values marked `in-memory` reset when the daemon restarts.');
  });

  it('daemon /nexus-settings redacts text and visible component copy', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
      supportsThreadCreation: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    store.set(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C-secret',
        initiatorUserId: 'U1',
      },
      {
        agentSessionId: 'sk-ant-agent-secret',
        lastTurnAt: new Date(10),
        title: 'Inspect /home/node/private sk-ant-title-secret',
      },
    );
    store.setChannelWorkingDir(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C1',
      },
      '/home/node/private/project',
    );
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1', 'C-secret'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_SETTINGS_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'settings'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('nexus-settings'));

    const text = result?.commandResponse?.text ?? '';
    expect(text).toContain('WorkingDir: `~/private/project` · channel default · in-memory');
    expect(text).not.toContain('/home/node/private');
    expect(text).not.toContain('sk-ant');
    const resume = result?.commandResponse?.components?.find(
      (component) =>
        component.type === 'string-select' &&
        component.customId === 'nexus:settings:resume',
    );
    expect(resume?.type).toBe('string-select');
    if (!resume || resume.type !== 'string-select') {
      throw new Error('expected settings resume select');
    }
    const option = resume.options[0];
    expect(option?.label).toContain('~/private');
    expect(option?.label).toContain('<redacted:secret>');
    expect(option?.label).not.toContain('/home/node/private');
    expect(option?.label).not.toContain('sk-ant');
    expect(option?.description).toContain('<redacted:secret>');
    expect(option?.description).not.toContain('sk-ant');
  });

  it('settings reply-mode interaction dispatches to the platform owner and returns a fresh snapshot', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    platform.settingsSnapshot.mockResolvedValue({
      items: [
        {
          key: 'discord.replyMode',
          label: 'Reply mode',
          owner: 'platform',
          value: 'all',
          source: 'discord state',
          durability: 'durable',
          canChange: true,
        },
      ],
    });
    const codex = makeAgent();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_SETTINGS_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'settings'],
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(
      makeComponentEvent('nexus:settings:reply-mode', ['all']),
    );

    expect(platform.applySettingsAction).toHaveBeenCalledWith({
      action: 'discord.replyMode',
      value: 'all',
      userId: 'U1',
      channelId: 'C1',
    });
    expect(result?.commandResponse?.text).toContain('Result: [reply mode changed]');
    expect(result?.commandResponse?.text).toContain('Reply mode: `all` · discord state · durable');
    expect(result?.commandResponse?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'string-select',
          customId: 'nexus:settings:reply-mode',
        }),
      ]),
    );
  });

  it('settings resume interaction reuses daemon session resume and returns a fresh snapshot', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    store.set(
      {
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C-old',
        initiatorUserId: 'U1',
      },
      {
        agentSessionId: 'sid-old',
        lastTurnAt: new Date(10),
        title: 'Resume from settings',
      },
    );
    const [oldSession] = store.listForUser({
      platformName: 'discord-main',
      platform: 'discord',
      initiatorUserId: 'U1',
      limit: 10,
    });
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1', 'C-old'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_SETTINGS_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'settings'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(
      makeComponentEvent('nexus:settings:resume', [oldSession!.sessionId]),
    );

    expect(store.get({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C1',
      initiatorUserId: 'U1',
    })).toMatchObject({
      agentSessionId: 'sid-old',
      title: 'Resume from settings',
    });
    expect(result?.commandResponse?.text).toContain('[session resumed: sid-old]');
    expect(result?.commandResponse?.text).toContain('Resumable sessions: `2`');
  });

  it('settings workingDir button opens a modal and modal submit changes the channel default', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_SETTINGS_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'settings'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const modal = await dispatchHandler(
      makeComponentEvent('nexus:settings:working-dir', [], {
        interaction: {
          customId: 'nexus:settings:working-dir',
          componentType: 'button',
          values: [],
        },
      }),
    );

    expect(modal).toEqual({
      modalResponse: {
        customId: 'nexus:settings:working-dir-modal',
        title: 'Set working directory',
        textInputs: [
          expect.objectContaining({
            customId: 'path',
            label: 'Absolute path',
          }),
        ],
      },
    });

    const result = await dispatchHandler(
      makeComponentEvent('nexus:settings:working-dir-modal', [], {
        interaction: {
          customId: 'nexus:settings:working-dir-modal',
          componentType: 'modal-submit',
          values: [],
          fields: { path: '/tmp/settings' },
        },
      }),
    );

    expect(store.getChannelWorkingDir({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C1',
    })).toBe('/tmp/settings');
    expect(result?.commandResponse?.text).toContain('[channel workingDir: /tmp/settings]');
    expect(result?.commandResponse?.text).toContain('WorkingDir: `/tmp/settings` · channel default · in-memory');
  });

  it('settings agent binding select changes the channel route for subsequent messages', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const claude = makeAgent();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
        {
          agentName: 'claude-prod',
          agentOwner: 'claudecode',
          agent: claude.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_SETTINGS_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'settings'],
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(
      makeComponentEvent('nexus:settings:agent', ['claude-prod']),
    );

    expect(result?.commandResponse?.text).toContain('[agent binding: claude-prod]');
    expect(result?.commandResponse?.text).toContain('Agent: `claude-prod` · channel override · in-memory');

    claude.queueEvents([
      ev('session_started', { agentSessionId: 'sid-claude' }),
      ev('text_final', { text: 'claude reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('hello after binding'));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(claude.startSession).toHaveBeenCalledTimes(1);
  });

  it('daemon /nexus-new-thread creates a private thread placeholder without starting an agent', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
      supportsThreadCreation: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_NEW_THREAD_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'new-thread'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(
      makeCommandEvent('nexus-new-thread', {
        command: {
          name: 'nexus-new-thread',
          args: { title: 'Design auth flow' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );

    expect(platform.createThread).toHaveBeenCalledWith({
      parentChannelId: 'C1',
      initiatorUserId: 'U1',
      title: 'Design auth flow',
      visibility: 'private',
      autoArchiveDurationMinutes: 1440,
      initialMessage: '[new Nexus session: Design auth flow]',
      traceId: 't-1',
    });
    expect(codex.startSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      commandResponse: {
        text: '[thread created] https://discord.com/channels/G1/T1',
        ephemeral: true,
      },
    });
    expect(
      store.get({
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      }),
    ).toMatchObject({
      title: 'Design auth flow',
    });
    expect(
      store.findThreadByChannelId({
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'T1',
      }),
    ).toMatchObject({
      parentChannelId: 'C1',
      ownerUserId: 'U1',
      autoArchiveDurationMinutes: 1440,
      renameOnFirstPrompt: false,
    });
    expect(
      store.listForUser({
        platformName: 'discord-main',
        platform: 'discord',
        initiatorUserId: 'U1',
        limit: 10,
      }),
    ).toEqual([]);
  });

  it('daemon /nexus-new-thread redacts title before thread creation', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
      supportsThreadCreation: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_NEW_THREAD_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'new-thread'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(
      makeCommandEvent('nexus-new-thread', {
        command: {
          name: 'nexus-new-thread',
          args: { title: 'Plan /home/node/private sk-ant-thread-secret' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );

    expect(platform.createThread).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Plan ~/private <redacted:secret>',
        initialMessage: '[new Nexus session: Plan ~/private <redacted:secret>]',
      }),
    );
    expect(platform.createThread.mock.calls[0]![0].title).not.toContain('/home/node/private');
    expect(platform.createThread.mock.calls[0]![0].title).not.toContain('sk-ant');
  });

  it('daemon /nexus-new-thread returns an actionable failure and does not create a store entry', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
      supportsThreadCreation: true,
    });
    platform.createThread.mockRejectedValueOnce(new Error('Missing Permissions'));
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_NEW_THREAD_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'new-thread'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('nexus-new-thread'));

    expect(result).toEqual({
      commandResponse: {
        text: 'Could not create a thread. Check bot permissions and try again.',
        ephemeral: true,
      },
    });
    expect(store.size).toBe(0);
    expect(codex.startSession).not.toHaveBeenCalled();
  });

  it('daemon /nexus-working-dir queues mutation behind the current turn', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_WORKING_DIR_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'working-dir'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEventsAfter(
      [
        ev('session_started', { agentSessionId: 'sid-running' }),
        ev('text_final', { text: 'running done' }),
        ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
      ],
      30,
    );
    const runningTurn = dispatchHandler(makeEvent('running'));
    await new Promise((resolve) => setTimeout(resolve, 1));

    const result = await dispatchHandler(
      makeCommandEvent('nexus-working-dir', {
        command: {
          name: 'nexus-working-dir',
          args: { path: '/tmp/channel' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );

    expect(result).toEqual({
      commandResponse: {
        text: '[workingDir update queued: /tmp/channel]',
        ephemeral: true,
      },
    });
    expect(store.getChannelWorkingDir({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C1',
    })).toBeUndefined();
    expect(codex.startSession.mock.calls[0]![1]).toMatchObject({
      workingDir: DEFAULT_CFG.workingDir,
    });

    await runningTurn;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store.getChannelWorkingDir({
      platformName: 'discord-main',
      platform: 'discord',
      channelId: 'C1',
    })).toBe('/tmp/channel');
    expect(platform.send).toHaveBeenCalledWith(
      expect.objectContaining({
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C1',
      }),
      expect.objectContaining({ text: '[channel workingDir: /tmp/channel]' }),
    );
  });

  it('daemon /nexus-working-dir rejects non-absolute paths', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_WORKING_DIR_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'working-dir'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(
      makeCommandEvent('nexus-working-dir', {
        command: {
          name: 'nexus-working-dir',
          args: { path: 'relative/path' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );

    expect(result).toEqual({
      commandResponse: {
        text: 'Working directory must be an absolute path.',
        ephemeral: true,
      },
    });
    expect(store.size).toBe(0);
  });

  it('daemon /nexus-working-dir rejects paths outside the bound agent workingDir root', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_WORKING_DIR_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'working-dir'],
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(
      makeCommandEvent('nexus-working-dir', {
        command: {
          name: 'nexus-working-dir',
          args: { path: '/workspace/other' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );

    expect(result).toEqual({
      commandResponse: {
        text: 'Working directory must be inside the configured root: /tmp',
        ephemeral: true,
      },
    });
  });

  it('daemon /nexus-working-dir in a thread affects only that thread next session', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: {
        allowlist: {
          userIds: ['U1'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: ['C1'],
          allowDM: false,
          requireMentionOrSlash: true,
        },
      },
      commandRegistry: makeActiveRegistry([DAEMON_WORKING_DIR_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'working-dir'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(
      makeCommandEvent('nexus-working-dir', {
        sessionKey: {
          platform: 'discord',
          channelId: 'T1',
          initiatorUserId: 'U1',
        },
        guildId: 'G1',
        threadParentChannelId: 'C1',
        command: {
          name: 'nexus-working-dir',
          args: { path: '/tmp/thread', scope: 'session' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );

    expect(result).toEqual({
      commandResponse: {
        text: '[next session workingDir: /tmp/thread]',
        ephemeral: true,
      },
    });

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-parent' }),
      ev('text_final', { text: 'parent reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('parent prompt', {
      sessionKey: {
        platform: 'discord',
        channelId: 'C1',
        initiatorUserId: 'U1',
      },
      guildId: 'G1',
    }));

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-thread' }),
      ev('text_final', { text: 'thread reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('thread prompt', {
      sessionKey: {
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      guildId: 'G1',
      threadParentChannelId: 'C1',
    }));

    expect(codex.startSession).toHaveBeenCalledTimes(2);
    expect(codex.startSession.mock.calls[0]![1]).toMatchObject({
      workingDir: DEFAULT_CFG.workingDir,
    });
    expect(codex.startSession.mock.calls[1]![1]).toMatchObject({
      workingDir: '/tmp/thread',
    });
  });

  it('thread sessions inherit the parent channel workingDir default', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_WORKING_DIR_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'working-dir'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(
      makeCommandEvent('nexus-working-dir', {
        command: {
          name: 'nexus-working-dir',
          args: { path: '/tmp/channel' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );

    expect(result).toEqual({
      commandResponse: {
        text: '[channel workingDir: /tmp/channel]',
        ephemeral: true,
      },
    });

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-thread' }),
      ev('text_final', { text: 'thread reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('thread prompt', {
      sessionKey: {
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      guildId: 'G1',
      threadParentChannelId: 'C1',
    }));

    expect(codex.startSession).toHaveBeenCalledTimes(1);
    expect(codex.startSession.mock.calls[0]![1]).toMatchObject({
      workingDir: '/tmp/channel',
    });
  });

  it('thread channel workingDir default overrides the inherited parent channel default', async () => {
    const platform = makePlatform({
      supportsSlashCommands: true,
      supportsEphemeral: true,
    });
    const codex = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: {
        allowlist: {
          userIds: ['U1'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: ['C1'],
          allowDM: false,
          requireMentionOrSlash: true,
        },
      },
      commandRegistry: makeActiveRegistry([DAEMON_WORKING_DIR_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'working-dir'],
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(
      makeCommandEvent('nexus-working-dir', {
        command: {
          name: 'nexus-working-dir',
          args: { path: '/tmp/channel' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );
    await dispatchHandler(
      makeCommandEvent('nexus-working-dir', {
        sessionKey: {
          platform: 'discord',
          channelId: 'T1',
          initiatorUserId: 'U1',
        },
        guildId: 'G1',
        threadParentChannelId: 'C1',
        command: {
          name: 'nexus-working-dir',
          args: { path: '/tmp/thread' },
          registrationScope: COMMAND_SCOPE,
        },
      }),
    );

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-thread' }),
      ev('text_final', { text: 'thread reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('thread prompt', {
      sessionKey: {
        platform: 'discord',
        channelId: 'T1',
        initiatorUserId: 'U1',
      },
      guildId: 'G1',
      threadParentChannelId: 'C1',
    }));

    expect(codex.startSession).toHaveBeenCalledTimes(1);
    expect(codex.startSession.mock.calls[0]![1]).toMatchObject({
      workingDir: '/tmp/thread',
    });
  });

  it('daemon /nexus-reload-config 把注入 reloader 的成功结果作为 ephemeral response 返回', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const configReloader = vi.fn(async () => ({
      status: 'reloaded' as const,
      message: '[config reloaded] applied: bindings, auth, ui, text prefixes',
    }));
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_RELOAD_CONFIG_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'reload-config'],
      configReloader,
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('nexus-reload-config'));

    expect(configReloader).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      commandResponse: {
        text: '[config reloaded] applied: bindings, auth, ui, text prefixes',
        ephemeral: true,
      },
    });
    expect(platform.send).not.toHaveBeenCalled();
  });

  it('daemon /nexus-reload-config reloader 报失败时把错误文本返回触发者', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const configReloader = vi.fn(async () => ({
      status: 'failed' as const,
      message: '[config reload failed] previous config kept:\nconfig.json 不是合法 JSON',
    }));
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_RELOAD_CONFIG_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'reload-config'],
      configReloader,
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('nexus-reload-config'));

    expect(result).toEqual({
      commandResponse: {
        text: '[config reload failed] previous config kept:\nconfig.json 不是合法 JSON',
        ephemeral: true,
      },
    });
  });

  it('daemon /nexus-reload-config reloader 抛错时返回通用失败反馈并记日志', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const mockLogger = makeMockLogger();
    const configReloader = vi.fn(async () => {
      throw new Error('boom');
    });
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_RELOAD_CONFIG_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'reload-config'],
      configReloader,
      logger: mockLogger,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('nexus-reload-config'));

    expect(result).toEqual({
      commandResponse: {
        text: 'Command failed.',
        ephemeral: true,
      },
    });
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.find(([, msg]) => msg === 'config_reload_failed')).toBeDefined();
  });

  it('daemon /nexus-reload-config 未注入 reloader 时返回未就绪反馈', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const mockLogger = makeMockLogger();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry([DAEMON_RELOAD_CONFIG_COMMAND]),
      daemonCommandHandlerKeys: ['kill', 'reload-config'],
      logger: mockLogger,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('nexus-reload-config'));

    expect(result).toEqual({
      commandResponse: {
        text: 'Slash commands are not ready yet. Try again later.',
        ephemeral: true,
      },
    });
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.find(([, msg]) => msg === 'command_handler_missing')).toBeDefined();
  });

  it('applyRuntimeUpdate 生效后按新 routing table 与 auth 处理后续事件', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable: [
        {
          bindingName: 'discord-main-codex',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C1'] } },
        },
      ],
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    engine.applyRuntimeUpdate({
      routingTable: [
        {
          bindingName: 'discord-main-codex-c2',
          platformName: 'discord-main',
          platformType: 'discord',
          agentName: 'codex-dev',
          match: { discord: { channelIds: ['C2'] } },
        },
      ],
      platformAuth: {
        allowlist: {
          userIds: ['U2'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: [],
          allowDM: true,
          requireMentionOrSlash: true,
        },
      },
      toolMessageMode: 'append',
      newSessionTextPrefix: true,
    });

    // 旧表里 C1 的 U1：新 auth 不再放行
    await dispatchHandler(makeEvent('hello'));
    expect(codex.sendInput).not.toHaveBeenCalled();

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-1' }),
      ev('text_final', { text: 'hi' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(
      makeEvent('hello', {
        sessionKey: { platform: 'discord', channelId: 'C2', initiatorUserId: 'U2' },
        initiator: { userId: 'U2', displayName: 'U2', isBot: false },
      }),
    );
    expect(codex.sendInput).toHaveBeenCalledTimes(1);
  });

  it('applyRuntimeUpdate 切到 role-only allowlist 后按 role 维度判定', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    engine.applyRuntimeUpdate({
      routingTable,
      platformAuth: {
        allowlist: {
          userIds: [],
          roleIds: ['R1'],
          allowedGuildIds: [],
          allowedChannelIds: [],
          allowDM: true,
          requireMentionOrSlash: true,
        },
      },
      toolMessageMode: 'append',
      newSessionTextPrefix: true,
    });

    // 旧 userIds 用户、无 role：拒绝
    await dispatchHandler(makeEvent('hello', { guildId: 'G1' }));
    expect(codex.sendInput).not.toHaveBeenCalled();

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-1' }),
      ev('text_final', { text: 'hi' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(
      makeEvent('hello', {
        guildId: 'G1',
        initiatorRoleIds: ['R1'],
        sessionKey: { platform: 'discord', channelId: 'C1', initiatorUserId: 'U9' },
        initiator: { userId: 'U9', displayName: 'U9', isBot: false },
      }),
    );
    expect(codex.sendInput).toHaveBeenCalledTimes(1);
  });

  it('turn 进行中 applyRuntimeUpdate 切换 toolMessages 不影响当前 turn 渲染', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
      toolMessages: { mode: 'append' },
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    codex.queueEventsAfter(
      [
        ev('session_started', { agentSessionId: 'sid-1' }),
        ev('tool_call_started', {
          callId: 'tc-1',
          toolName: 'Bash',
          inputSummary: 'ls',
        }),
        ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
      ],
      40,
    );
    const dispatchPromise = dispatchHandler(makeEvent('hello'));
    // turn 已开始（snapshot 应已取），事件 40ms 后才到——窗口内切 compact
    await new Promise((resolve) => setTimeout(resolve, 10));
    engine.applyRuntimeUpdate({
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      toolMessageMode: 'compact',
      newSessionTextPrefix: true,
    });
    await dispatchPromise;

    // 当前 turn 仍按 append 渲染：tool message 独立发送、不补 [empty response]
    expect(platform.send).toHaveBeenCalledTimes(1);
    const texts = platform.send.mock.calls.map(
      (call) => (call[1] as OutboundMessage).text,
    );
    expect(texts[0]).toContain('Bash');
    expect(texts).not.toContain('[empty response]');
  });

  it('applyRuntimeUpdate 关闭 newSession text prefix 后 /new 文本按普通 prompt 转发', async () => {
    const platform = makePlatform();
    const codex = makeAgent();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      logger: SILENT_LOGGER,
      sessionStore: new SessionStore(),
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    engine.applyRuntimeUpdate({
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      toolMessageMode: 'append',
      newSessionTextPrefix: false,
    });

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-1' }),
      ev('text_final', { text: 'hi' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    await dispatchHandler(makeEvent('/new'));

    expect(codex.sendInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: '/new' }),
    );
  });

  it('command event scope 与当前 Engine platform 不一致时 fail-closed', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('new', {
      command: {
        name: 'new',
        args: {},
        registrationScope: {
          ...COMMAND_SCOPE,
          platformName: 'discord-side',
        },
      },
    }));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(platform.send).not.toHaveBeenCalled();
    expect(result).toEqual({
      commandResponse: {
        text: 'This command is not available in this channel.',
        ephemeral: true,
      },
    });
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.find(([, msg]) => msg === 'command_scope_mismatch')).toBeDefined();
  });

  it('command event 当前 channel 未命中 binding 时返回用户可见拒绝反馈', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('new', {
      sessionKey: {
        platform: 'discord',
        channelId: 'C2',
        initiatorUserId: 'U1',
      },
    }));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(codex.handleCommand).not.toHaveBeenCalled();
    expect(platform.send).not.toHaveBeenCalled();
    expect(result).toEqual({
      commandResponse: {
        text: 'This command is not available in this channel.',
        ephemeral: true,
      },
    });
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.find(([, msg]) => msg === 'command_agent_binding_miss')).toBeDefined();
  });

  it('command event 未命中 active reverse map 时返回用户可见拒绝反馈', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('discord-reply-mode'));

    expect(codex.handleCommand).not.toHaveBeenCalled();
    expect(platform.send).not.toHaveBeenCalled();
    expect(result).toEqual({
      commandResponse: {
        text: 'This command is not available in this channel.',
        ephemeral: true,
      },
    });
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.find(([, msg]) => msg === 'command_reverse_map_miss')).toBeDefined();
  });

  it('daemon command handler 缺失时返回用户可见未就绪反馈', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('nexus-kill'));

    expect(codex.handleCommand).not.toHaveBeenCalled();
    expect(platform.send).not.toHaveBeenCalled();
    expect(result).toEqual({
      commandResponse: {
        text: 'Slash commands are not ready yet. Try again later.',
        ephemeral: true,
      },
    });
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.find(([, msg]) => msg === 'command_handler_missing')).toBeDefined();
  });

  it('agent command handler 抛错时返回用户可见失败反馈', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    codex.handleCommand.mockRejectedValueOnce(new Error('boom'));
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      commandRegistry: makeActiveRegistry(),
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('new'));

    expect(platform.send).not.toHaveBeenCalled();
    expect(result).toEqual({
      commandResponse: {
        text: 'Command failed.',
        ephemeral: true,
      },
    });
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.find(([, msg]) => msg === 'agent_command_failed')).toBeDefined();
  });

  it('command event user 不在 platform auth allowlist 时 auth_denied 且不调用 agent command', async () => {
    const platform = makePlatform({ supportsSlashCommands: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: {
        allowlist: {
          userIds: ['U-allowed'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: [],
          allowDM: true,
          requireMentionOrSlash: true,
        },
      },
      commandRegistry: makeActiveRegistry(),
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const result = await dispatchHandler(makeCommandEvent('new', {
      initiator: { userId: 'U-denied', displayName: 'denied', isBot: false },
      sessionKey: {
        platform: 'discord',
        channelId: 'C1',
        initiatorUserId: 'U-denied',
      },
    }));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(codex.sendInput).not.toHaveBeenCalled();
    expect(codex.handleCommand).not.toHaveBeenCalled();
    expect(platform.send).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(result).toEqual({
      commandResponse: {
        text: 'You are not allowed to use this command.',
        ephemeral: true,
      },
    });
    const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const authLog = infoCalls.find(([, msg]) => msg === 'auth_denied');
    expect(authLog).toBeDefined();
    expect(authLog![0]).toMatchObject({
      platformName: 'discord-main',
      channelId: 'C1',
      userId: 'U-denied',
      reason: 'user_not_allowed',
    });
  });

  it('settings modal submit interaction user 不在 platform auth allowlist 时不进入 agent', async () => {
    const platform = makePlatform({ supportsButtons: true });
    const codex = makeAgent();
    const store = new SessionStore();
    const mockLogger = makeMockLogger();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const engine = new Engine({
      platform,
      platformName: 'discord-main',
      platformType: 'discord',
      agents: [
        {
          agentName: 'codex-dev',
          agentOwner: 'codex',
          agent: codex.runtime,
          defaultSessionConfig: DEFAULT_CFG,
        },
      ],
      routingTable,
      platformAuth: {
        allowlist: {
          userIds: ['U-allowed'],
          roleIds: [],
          allowedGuildIds: [],
          allowedChannelIds: [],
          allowDM: true,
          requireMentionOrSlash: true,
        },
      },
      logger: mockLogger,
      sessionStore: store,
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('', {
      type: 'interaction',
      text: undefined,
      rawContentType: 'discord:modal-submit',
      interaction: {
        componentId: 'nexus:settings:working-dir-modal',
        kind: 'modal_submit',
        values: ['path=/tmp/app'],
      },
      initiator: { userId: 'U-denied', displayName: 'denied', isBot: false },
      sessionKey: {
        platform: 'discord',
        channelId: 'C1',
        initiatorUserId: 'U-denied',
      },
    }));

    expect(codex.startSession).not.toHaveBeenCalled();
    expect(codex.sendInput).not.toHaveBeenCalled();
    expect(codex.handleCommand).not.toHaveBeenCalled();
    expect(platform.send).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const authLog = infoCalls.find(([, msg]) => msg === 'auth_denied');
    expect(authLog).toBeDefined();
    expect(authLog![0]).toMatchObject({
      platformName: 'discord-main',
      channelId: 'C1',
      userId: 'U-denied',
      reason: 'user_not_allowed',
    });
  });

  it('两个同 type Engine 共享 SessionStore 时，同 channel/user 仍按 platformName 隔离', async () => {
    const platformMain = makePlatform();
    const platformSide = makePlatform();
    const codex = makeAgent();
    const store = new SessionStore();
    const routingTable: RoutingEntry[] = [
      {
        bindingName: 'discord-main-codex',
        platformName: 'discord-main',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
      {
        bindingName: 'discord-side-codex',
        platformName: 'discord-side',
        platformType: 'discord',
        agentName: 'codex-dev',
        match: { discord: { channelIds: ['C1'] } },
      },
    ];
    const agents = [
      {
        agentName: 'codex-dev',
        agent: codex.runtime,
        defaultSessionConfig: DEFAULT_CFG,
      },
    ];

    const mainEngine = new Engine({
      platform: platformMain,
      platformName: 'discord-main',
      platformType: 'discord',
      agents,
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      logger: SILENT_LOGGER,
      sessionStore: store,
    });
    const sideEngine = new Engine({
      platform: platformSide,
      platformName: 'discord-side',
      platformType: 'discord',
      agents,
      routingTable,
      platformAuth: PLATFORM_AUTH_ALLOW_U1,
      logger: SILENT_LOGGER,
      sessionStore: store,
    });

    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-main' }),
      ev('text_final', { text: 'main' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);
    codex.queueEvents([
      ev('session_started', { agentSessionId: 'sid-side' }),
      ev('text_final', { text: 'side' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await mainEngine.start();
    await sideEngine.start();
    const mainDispatch = (platformMain.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    const sideDispatch = (platformSide.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    await mainDispatch(makeEvent('hello'));
    await sideDispatch(makeEvent('hello'));

    expect(codex.startSession).toHaveBeenCalledTimes(2);
    expect(codex.startSession.mock.calls[0]![0]).toMatchObject({
      platformName: 'discord-main',
      channelId: 'C1',
      initiatorUserId: 'U1',
    });
    expect(codex.startSession.mock.calls[1]![0]).toMatchObject({
      platformName: 'discord-side',
      channelId: 'C1',
      initiatorUserId: 'U1',
    });
    expect(store.size).toBe(2);
    expect(
      store.get({
        platformName: 'discord-main',
        platform: 'discord',
        channelId: 'C1',
        initiatorUserId: 'U1',
      })?.agentSessionId,
    ).toBe('sid-main');
    expect(
      store.get({
        platformName: 'discord-side',
        platform: 'discord',
        channelId: 'C1',
        initiatorUserId: 'U1',
      })?.agentSessionId,
    ).toBe('sid-side');
  });

  it('supportsEdit=false：text_delta 只缓冲，turn_finished 发送 text_final 且不调用 edit/typing', async () => {
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
      ev('text_delta', { text: 'hel' }),
      ev('text_delta', { text: 'lo' }),
      ev('text_final', { text: 'hello' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('hello'));

    expect(platform.send).toHaveBeenCalledTimes(1);
    expect((platform.send.mock.calls[0]![1] as OutboundMessage).text).toBe('hello');
    expect(platform.edit).not.toHaveBeenCalled();
    expect(platform.setTyping).not.toHaveBeenCalled();
    expect(platform.clearTyping).not.toHaveBeenCalled();
  });

  it('supportsEdit=true：首个 text_delta send 建 ref，turn_finished 立即 final edit 且不 double append text_final', async () => {
    const platform = makePlatform({ supportsEdit: true });
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
      streaming: { streamEditThrottleMs: 1000 },
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    agent.queueEvents([
      ev('text_delta', { text: 'he' }),
      ev('text_delta', { text: 'llo' }),
      ev('text_final', { text: 'hello' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('hello'));

    expect(platform.send).toHaveBeenCalledTimes(1);
    expect((platform.send.mock.calls[0]![1] as OutboundMessage).text).toBe('he');
    expect(platform.edit).toHaveBeenCalledTimes(1);
    expect((platform.edit.mock.calls[0]![1] as OutboundMessage).text).toBe('hello');
  });

  it('长回复 edit 交给 platform adapter 维护切片与 messageIds', async () => {
    const platform = makePlatform({ supportsEdit: true, maxTextLength: 5 });
    const agent = makeAgent();
    const store = new SessionStore();
    const initialRef: MessageRef = {
      platform: 'discord',
      channelId: 'C1',
      messageId: 'out-1',
      messageIds: ['out-1'],
      sentAt: new Date(0),
    };
    platform.send.mockResolvedValue(initialRef);
    platform.edit.mockImplementation(async (ref: MessageRef) => {
      ref.messageIds = ['out-1', 'out-2'];
      ref.messageId = 'out-2';
    });
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
      streaming: { streamEditThrottleMs: 1000 },
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    agent.queueEvents([
      ev('text_delta', { text: 'ab' }),
      ev('text_final', { text: 'abcdefghijkl' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('hello'));

    expect(platform.send).toHaveBeenCalledTimes(1);
    expect(platform.edit).toHaveBeenCalledTimes(1);
    const editedRef = platform.edit.mock.calls[0]![0] as MessageRef;
    expect((platform.edit.mock.calls[0]![1] as OutboundMessage).text).toBe(
      'abcdefghijkl',
    );
    expect(editedRef.messageIds).toEqual(['out-1', 'out-2']);
    expect(editedRef.messageId).toBe('out-2');
  });

  it('outbound send 前会脱敏 secret 和用户 home 绝对路径', async () => {
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
      ev('text_final', {
        text: 'ANTHROPIC_API_KEY=sk-ant-abc123 path=/home/node/secret/file.ts',
      }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('hello'));

    const out = platform.send.mock.calls[0]![1] as OutboundMessage;
    expect(out.text).toContain('ANTHROPIC_API_KEY=<redacted>');
    expect(out.text).toContain('path=~/secret/file.ts');
    expect(out.text).not.toContain('sk-ant-abc123');
    expect(out.text).not.toContain('/home/node/secret');
  });

  it('默认 append：tool start 单独发送，tool_result 不编辑用户可见消息，final 追加新消息', async () => {
    const platform = makePlatform({ supportsEdit: true });
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
      ev('tool_call_started', {
        callId: 'tool-1',
        toolName: 'Bash',
        inputSummary: 'npm test',
      }),
      ev('tool_result', {
        callId: 'tool-1',
        resultSequence: 1,
        content: { kind: 'text', text: 'private output' },
        isError: false,
      }),
      ev('text_final', { text: 'done' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('run tests'));

    expect(platform.send).toHaveBeenCalledTimes(2);
    expect((platform.send.mock.calls[0]![1] as OutboundMessage).text).toBe(
      'Bash:\n```bash\nnpm test\n```',
    );
    expect(platform.edit).not.toHaveBeenCalled();
    expect((platform.send.mock.calls[1]![1] as OutboundMessage).text).toBe('done');
  });

  it('默认 append：同一 turn 的 tool start send 完成前不发送 final reply', async () => {
    const platform = makePlatform({ supportsEdit: true });
    const firstSend = deferred<MessageRef>();
    const ref: MessageRef = {
      platform: 'discord',
      channelId: 'C1',
      messageId: 'out-delayed',
      sentAt: new Date(0),
    };
    platform.send.mockImplementationOnce(async () => firstSend.promise);
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
      ev('tool_call_started', {
        callId: 'tool-1',
        toolName: 'Bash',
        inputSummary: 'npm test',
      }),
      ev('text_final', { text: 'done' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    const dispatchPromise = dispatchHandler(makeEvent('run tests'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(platform.send).toHaveBeenCalledTimes(1);
    expect((platform.send.mock.calls[0]![1] as OutboundMessage).text).toBe(
      'Bash:\n```bash\nnpm test\n```',
    );

    firstSend.resolve(ref);
    await dispatchPromise;

    expect(platform.send).toHaveBeenCalledTimes(2);
    expect((platform.send.mock.calls[1]![1] as OutboundMessage).text).toBe('done');
  });

  it('默认 append：tool 前已有 assistant 文本时，tool 后 final reply 追加新消息而不编辑旧消息', async () => {
    const platform = makePlatform({ supportsEdit: true });
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
      streaming: { streamEditThrottleMs: 1000 },
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    agent.queueEvents([
      ev('text_delta', { text: 'message' }),
      ev('tool_call_started', {
        callId: 'tool-1',
        toolName: 'Bash',
        inputSummary: 'npm test',
      }),
      ev('text_final', { text: 'message final' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('run tests'));

    expect(platform.send).toHaveBeenCalledTimes(3);
    expect((platform.send.mock.calls[0]![1] as OutboundMessage).text).toBe(
      'message',
    );
    expect((platform.send.mock.calls[1]![1] as OutboundMessage).text).toBe(
      'Bash:\n```bash\nnpm test\n```',
    );
    expect((platform.send.mock.calls[2]![1] as OutboundMessage).text).toBe(
      'message final',
    );
    expect(platform.edit).not.toHaveBeenCalled();
  });

  it('compact：tool 状态沿用当前回复消息，final edit 覆盖为最终回复', async () => {
    const platform = makePlatform({ supportsEdit: true });
    const agent = makeAgent();
    const store = new SessionStore();
    const engine = new Engine({
      platform,
      agent: agent.runtime,
      logger: SILENT_LOGGER,
      sessionStore: store,
      defaultSessionConfig: DEFAULT_CFG,
      toolMessages: { mode: 'compact' },
    });

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    agent.queueEvents([
      ev('tool_call_started', {
        callId: 'tool-1',
        toolName: 'Read',
        inputSummary: 'src/index.ts',
      }),
      ev('tool_result', {
        callId: 'tool-1',
        resultSequence: 1,
        content: { kind: 'text', text: 'file content' },
        isError: false,
      }),
      ev('text_final', { text: 'done' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('read file'));

    expect(platform.send).toHaveBeenCalledTimes(1);
    expect((platform.send.mock.calls[0]![1] as OutboundMessage).text).toBe(
      'Read: src/index.ts',
    );
    expect(platform.edit).toHaveBeenCalledTimes(1);
    expect((platform.edit.mock.calls[0]![1] as OutboundMessage).text).toBe('done');
  });

  it('默认 append：Read 等非 Bash 工具 result 不展示用户可见内容或状态', async () => {
    const platform = makePlatform({ supportsEdit: true });
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
      ev('tool_call_started', {
        callId: 'tool-read',
        toolName: 'Read',
        inputSummary: 'src/index.ts',
      }),
      ev('tool_result', {
        callId: 'tool-read',
        resultSequence: 1,
        content: {
          kind: 'text',
          text: '1    secret line\n2    more content',
        },
        isError: false,
      }),
      ev('text_final', { text: 'done' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('read file'));

    expect(platform.send).toHaveBeenCalledTimes(2);
    expect((platform.send.mock.calls[0]![1] as OutboundMessage).text).toBe(
      'Read: src/index.ts',
    );
    expect(platform.edit).not.toHaveBeenCalled();
    expect((platform.send.mock.calls[1]![1] as OutboundMessage).text).toBe('done');
  });

  it('supportsEdit=false：孤立 tool_result 不追加用户可见消息', async () => {
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
      ev('tool_result', {
        callId: 'tool-1',
        resultSequence: 1,
        content: { kind: 'text', text: 'secret result' },
        isError: false,
      }),
      ev('text_final', { text: 'done' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await dispatchHandler(makeEvent('run tool'));

    expect(platform.send).toHaveBeenCalledTimes(1);
    expect((platform.send.mock.calls[0]![1] as OutboundMessage).text).toBe('done');
    expect(platform.edit).not.toHaveBeenCalled();
  });

  it('tool event 写 lifecycle info 日志，input/result 只进 trace', async () => {
    const platform = makePlatform();
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

    const toolContent = { kind: 'text' as const, text: 'private output' };
    agent.queueEvents([
      ev('tool_call_started', {
        callId: 'tool-1',
        toolName: 'Bash',
        inputSummary: 'npm test',
      }),
      ev('tool_result', {
        callId: 'tool-1',
        resultSequence: 0,
        content: toolContent,
        isError: false,
      }),
      ev('tool_call_finished', {
        callId: 'tool-1',
        toolName: 'Bash',
        status: 'ok',
      }),
      ev('text_final', { text: 'done' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('run tests'));

    const infoCalls = (mockLogger.info as ReturnType<typeof vi.fn>).mock.calls;
    const startedInfo = infoCalls.find(([, msg]) => msg === 'tool_call_started');
    expect(startedInfo).toBeDefined();
    expect(startedInfo![0]).toMatchObject({
      traceId: 't-1',
      callId: 'tool-1',
      toolName: 'Bash',
    });
    expect(startedInfo![0]).not.toHaveProperty('inputSummary');
    expect(startedInfo![0]).not.toHaveProperty('content');

    const finishedInfo = infoCalls.find(([, msg]) => msg === 'tool_call_finished');
    expect(finishedInfo).toBeDefined();
    expect(finishedInfo![0]).toMatchObject({
      traceId: 't-1',
      callId: 'tool-1',
      toolName: 'Bash',
      status: 'ok',
    });
    expect(finishedInfo![0]).toHaveProperty('latencyMs');
    expect(finishedInfo![0]).not.toHaveProperty('content');

    const traceCalls = (mockLogger.trace as ReturnType<typeof vi.fn>).mock.calls;
    const inputTrace = traceCalls.find(([, msg]) => msg === 'tool_call_input');
    expect(inputTrace).toBeDefined();
    expect(inputTrace![0]).toMatchObject({
      traceId: 't-1',
      callId: 'tool-1',
      toolName: 'Bash',
      inputSummary: 'npm test',
    });

    const resultTrace = traceCalls.find(([, msg]) => msg === 'tool_result');
    expect(resultTrace).toBeDefined();
    expect(resultTrace![0]).toMatchObject({
      traceId: 't-1',
      callId: 'tool-1',
      resultSequence: 0,
      isError: false,
      content: toolContent,
    });
  });

  it('supportsTypingIndicator=true：turn start setTyping，周期续期，turn end clearTyping 并停 timer', async () => {
    vi.useFakeTimers();
    try {
      const platform = makePlatform({ supportsTypingIndicator: true });
      const agent = makeAgent();
      const store = new SessionStore();
      const engine = new Engine({
        platform,
        agent: agent.runtime,
        logger: SILENT_LOGGER,
        sessionStore: store,
        defaultSessionConfig: DEFAULT_CFG,
        streaming: { typingRefreshMs: 10 },
      });

      await engine.start();
      const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

      agent.queueEventsAfter(
        [
          ev('text_final', { text: 'slow reply' }),
          ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
        ],
        25,
      );

      const dispatchPromise = dispatchHandler(makeEvent('slow'));
      await vi.advanceTimersByTimeAsync(0);
      expect(platform.setTyping).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(platform.setTyping).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10);
      expect(platform.setTyping).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(10);
      await dispatchPromise;
      await vi.advanceTimersByTimeAsync(0);

      expect(platform.clearTyping).toHaveBeenCalledTimes(1);
      const typingCallsAfterClear = platform.setTyping.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30);
      expect(platform.setTyping).toHaveBeenCalledTimes(typingCallsAfterClear);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sendInput reject 且无 agent error 时仍清理 typing timer', async () => {
    vi.useFakeTimers();
    try {
      const platform = makePlatform({ supportsTypingIndicator: true });
      const agent = makeAgent();
      const sendErr = new Error('send failed');
      agent.sendInput.mockRejectedValueOnce(sendErr);
      const store = new SessionStore();
      const engine = new Engine({
        platform,
        agent: agent.runtime,
        logger: SILENT_LOGGER,
        sessionStore: store,
        defaultSessionConfig: DEFAULT_CFG,
        streaming: { typingRefreshMs: 10 },
      });

      await engine.start();
      const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

      const dispatchPromise = dispatchHandler(makeEvent('hello'));
      await vi.advanceTimersByTimeAsync(0);
      await dispatchPromise;
      await vi.advanceTimersByTimeAsync(0);

      expect(platform.setTyping).toHaveBeenCalledTimes(1);
      expect(platform.clearTyping).toHaveBeenCalledTimes(1);

      const typingCallsAfterClear = platform.setTyping.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30);
      expect(platform.setTyping).toHaveBeenCalledTimes(typingCallsAfterClear);
    } finally {
      vi.useRealTimers();
    }
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

  function assertNoHandlerOrDispatchFailure(mockLogger: Logger): void {
    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
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

  it('platform.send 失败（turn_finished 回送路径）：错误被吞 + 写 platform_send_failed + 不关闭长驻 session', async () => {
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
    expect(agent.stopSession).not.toHaveBeenCalled();
  });

  it('platform.edit 失败（final edit 路径）：错误被吞 + 写 platform_edit_failed', async () => {
    const platform = makePlatform({ supportsEdit: true });
    const editErr = new Error('platform down edit');
    platform.edit.mockRejectedValueOnce(editErr);

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
      ev('text_delta', { text: 'reply' }),
      ev('text_final', { text: 'reply final' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    await expect(dispatchHandler(makeEvent('hello'))).resolves.toBeUndefined();

    const errorCalls = (mockLogger.error as ReturnType<typeof vi.fn>).mock.calls;
    const editFailedLog = errorCalls.find(([, msg]) => msg === 'platform_edit_failed');
    expect(editFailedLog).toBeDefined();
    expect(editFailedLog![0]).toMatchObject({
      traceId: 't-1',
      err: editErr,
    });
    expect(editFailedLog![0]).toHaveProperty('sessionKey');
    assertNoHandlerOrDispatchFailure(mockLogger);
  });

  it('agent.stopSession 抛出（/new 关闭旧 session）：错误被吞 + 写 agent_stop_session_failed 含 traceId/sessionKey/err', async () => {
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
      ev('text_final', { text: 'reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;

    await expect(dispatchHandler(makeEvent('hello'))).resolves.toBeUndefined();
    expect(agent.stopSession).not.toHaveBeenCalled();

    const stopErr = new Error('stop boom');
    (agent.stopSession as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw stopErr;
    });

    await expect(dispatchHandler(makeEvent('/new'))).resolves.toBeUndefined();

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

  it('engine.stop 关闭仍活跃的 agent session 并清空 store', async () => {
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
      ev('session_started', { agentSessionId: 'sid-1' }),
      ev('text_final', { text: 'reply' }),
      ev('turn_finished', { reason: 'stop', turnSequence: 1 }),
    ]);

    await engine.start();
    const dispatchHandler = (platform.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as EventHandler;
    await dispatchHandler(makeEvent('hello'));

    expect(store.get(ROUTED_SESSION_KEY)?.agentSessionId).toBe('sid-1');
    expect(agent.stopSession).not.toHaveBeenCalled();

    await engine.stop();

    expect(platform.stop).toHaveBeenCalledTimes(1);
    expect(agent.stopSession).toHaveBeenCalledTimes(1);
    expect(store.get(ROUTED_SESSION_KEY)).toBeUndefined();
  });
});
