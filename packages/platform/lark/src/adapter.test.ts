import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  Engine,
  InMemoryIdempotencyStore,
  SessionStore,
  SqliteTrajectoryStore,
  type Logger,
} from '@agent-nexus/daemon';
import type {
  AgentCapabilitySet,
  AgentRuntime,
  AgentSession,
  NormalizedEvent,
  SessionKey,
} from '@agent-nexus/protocol';
import {
  LARK_CAPABILITIES,
  type LarkAdapterInternals,
  LarkPartialSendError,
  LarkPlatformError,
  LarkPlatformAdapter,
  type LarkPlatformOptions,
} from './adapter.js';
import type {
  LarkSdkClientPort,
  LarkSdkDispatcherPort,
  LarkSdkFactory,
  LarkSdkWsClientPort,
  LarkWsCallbacks,
} from './sdk-port.js';

const BASE_EVENT = JSON.parse(
  readFileSync(
    new URL(
      '../../../../testdata/lark/events/im_message_receive_v1_text_p2p.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  event_id?: string;
  sender: {
    sender_id: { open_id: string };
    sender_type: string;
  };
  message: {
    message_id: string;
    create_time?: unknown;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    thread_id?: string;
  };
};

const THREAD_EVENT = JSON.parse(
  readFileSync(
    new URL(
      '../../../../testdata/lark/events/im_message_receive_v1_text_group_thread.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as typeof BASE_EVENT;

class FakeSdkFactory implements LarkSdkFactory {
  public onMessage?: (event: unknown) => void;
  public callbacks?: LarkWsCallbacks;
  public readonly callbacksByGeneration: LarkWsCallbacks[] = [];
  public readonly wsClients: LarkSdkWsClientPort[] = [];
  public autoReady = true;
  public readonly replyMessage = vi.fn();
  public readonly getMessage = vi.fn();
  public readonly getChat = vi.fn();
  public readonly client: LarkSdkClientPort = {
    request: vi.fn(async () => ({
      code: 0,
      bot: { open_id: 'ou_bot_open_id' },
    })),
    createMessage: vi.fn(),
    replyMessage: this.replyMessage,
    getMessage: this.getMessage,
    getChat: this.getChat,
  } as LarkSdkClientPort;

  createClient(): LarkSdkClientPort {
    return this.client;
  }

  createDispatcher(
    onMessage: (event: unknown) => void,
  ): LarkSdkDispatcherPort {
    this.onMessage = onMessage;
    return { kind: 'lark-event-dispatcher' };
  }

  createWsClient(input: LarkWsCallbacks): LarkSdkWsClientPort {
    this.callbacks = input;
    this.callbacksByGeneration.push(input);
    let state: 'connecting' | 'connected' | 'failed' = 'connecting';
    const wsClient: LarkSdkWsClientPort = {
      start: vi.fn(async () => {
        if (this.autoReady) {
          state = 'connected';
          input.onReady();
        }
      }),
      close: vi.fn(),
      getConnectionStatus: vi.fn(() => ({ state })),
    };
    Object.defineProperty(wsClient, 'testState', {
      get: () => state,
      set: (value: typeof state) => {
        state = value;
      },
    });
    this.wsClients.push(wsClient);
    return wsClient;
  }
}

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

function makeAdapter(
  factory: FakeSdkFactory,
  logger: Logger = makeLogger(),
  internals: Partial<LarkAdapterInternals> = {},
): LarkPlatformAdapter {
  const options: LarkPlatformOptions = {
    appId: 'cli_0123456789abcdef',
    appSecret: 'app-secret-value',
    botOpenId: 'ou_bot_open_id',
    platformName: 'lark-main',
    logger,
  };
  return new LarkPlatformAdapter(options, {
    sdkFactory: factory,
    now: () => new Date('2026-07-24T12:00:00.000Z'),
    randomBytes: () => Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    random: () => 0.5,
    sleep: vi.fn(async () => {}),
    ...internals,
  });
}

function createThreadInput() {
  return {
    parentChannelId: 'oc_chat_1',
    initiatorUserId: 'ou_user_open_id',
    title: '已有 Codex session',
    visibility: 'public' as const,
    initialMessage: '最后一个完整回复',
    idempotencyKey: '0123456789abcdef0123456789abcdef',
    traceId: 'trace-recover-1',
  };
}

describe('LarkPlatformAdapter inbound', () => {
  it('声明话题纯文本和 thread creation 能力，但不声明 native slash', () => {
    const capabilities = makeAdapter(new FakeSdkFactory()).capabilities();
    expect(capabilities).toEqual(LARK_CAPABILITIES);
    expect(capabilities.supportsThreads).toBe(true);
    expect(capabilities.supportsThreadCreation).toBe(true);
    expect(capabilities.supportsThreadCreateIdempotencyKey).toBe(true);
    expect(capabilities.supportsSlashCommands).toBe(false);
  });

  it('不支持的 edit/delete/react 返回稳定 unsupported error，typing 为幂等 no-op', async () => {
    const adapter = makeAdapter(new FakeSdkFactory());
    const ref = {
      platform: 'lark',
      channelId: 'oc_chat_1',
      messageId: 'om_1',
      messageIds: ['om_1'],
      sentAt: new Date(0),
    };
    const message = {
      text: 'hello',
      traceId: 'trace-1',
      sessionKey: {
        platformName: 'lark-main',
        platform: 'lark',
        channelId: 'oc_chat_1',
        initiatorUserId: 'ou_user_open_id',
      },
    };

    await expect(adapter.edit(ref, message)).rejects.toMatchObject({
      code: 'lark_unsupported_operation',
      retryable: false,
    });
    await expect(adapter.delete(ref)).rejects.toMatchObject({
      code: 'lark_unsupported_operation',
      retryable: false,
    });
    await expect(adapter.react(ref, '👀')).rejects.toMatchObject({
      code: 'lark_unsupported_operation',
      retryable: false,
    });
    await expect(adapter.setTyping(message.sessionKey)).resolves.toBeUndefined();
    await expect(adapter.clearTyping(message.sessionKey)).resolves.toBeUndefined();
  });

  it('把真实 SDK 1.70.0 P2P 文本事件归一化并递归移除敏感 wire 字段', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const events: NormalizedEvent[] = [];
    await adapter.start((event) => {
      events.push(event);
    });

    factory.onMessage?.(BASE_EVENT);

    const tuple = [
      'ou_user_open_id',
      'oc_chat_1',
      '1720000000123',
      '{"text":"你好，飞书"}',
    ];
    const expectedIdempotencyKey =
      'lark-text-v1:' +
      createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'evt_1',
      platform: 'lark',
      sessionKey: {
        platform: 'lark',
        channelId: 'oc_chat_1',
        initiatorUserId: 'ou_user_open_id',
      },
      messageId: 'om_message_1',
      idempotencyKey: expectedIdempotencyKey,
      type: 'message',
      channelKind: 'direct',
      deliveryScope: 'control',
      text: '你好，飞书',
      rawContentType: 'lark-node-sdk:im.message.receive_v1@1.70.0',
      receivedAt: new Date('2026-07-24T12:00:00.000Z'),
      platformTimestamp: new Date(1720000000123),
      initiator: {
        userId: 'ou_user_open_id',
        displayName: 'ou_user_open_id',
        isBot: false,
      },
    });
    const rawPayload = JSON.stringify(events[0]!.rawPayload);
    expect(rawPayload).not.toContain('verification-token');
    expect(rawPayload).not.toContain('tenant-key');
    expect(rawPayload).not.toContain('cli_0123456789abcdef');
    expect(rawPayload).not.toMatch(/"token"|"tenant_key"|"app_id"/);
  });

  it('把话题群文本映射为独立 thread SessionKey、父群继承与 response target', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const events: NormalizedEvent[] = [];
    await adapter.start((event) => {
      events.push(event);
    });

    factory.onMessage?.(THREAD_EVENT);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'evt_thread_1',
      platform: 'lark',
      sessionKey: {
        platform: 'lark',
        channelId: 'omt_thread_1',
        initiatorUserId: 'ou_user_open_id',
      },
      messageId: 'om_thread_message_1',
      threadParentChannelId: 'oc_topic_group_1',
      channelKind: 'thread',
      deliveryScope: 'session',
      sessionContainer: {
        kind: 'thread',
        bindingMode: 'fixed',
        parentChannelId: 'oc_topic_group_1',
        rootMessageId: 'om_thread_root_1',
        parentUrl:
          'https://applink.feishu.cn/client/chat/open?openChatId=oc_topic_group_1',
      },
      responseTarget: {
        platform: 'lark',
        channelId: 'omt_thread_1',
        messageId: 'om_thread_message_1',
        messageIds: ['om_thread_message_1'],
        sentAt: new Date(1720000001123),
      },
      type: 'message',
      text: '话题里的任务',
    });
  });

  it('把不带 thread_id 的群主时间线标记为控制面', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const handler = vi.fn();
    await adapter.start(handler);

    factory.onMessage?.({
      ...THREAD_EVENT,
      message: {
        ...THREAD_EVENT.message,
        thread_id: undefined,
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channelKind: 'group',
        deliveryScope: 'control',
        sessionKey: expect.objectContaining({
          channelId: 'oc_topic_group_1',
        }),
      }),
    );
  });

  it('通过根消息查询补齐飞书话题精确链接', async () => {
    const factory = new FakeSdkFactory();
    factory.getMessage.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: 'om_thread_root_1',
            message_app_link:
              'https://applink.feishu.cn/client/message/link/open?token=topic-token',
          },
        ],
      },
    });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    await expect(
      adapter.resolveSessionContainer?.({
        sessionKey: {
          platformName: 'lark-main',
          platform: 'lark',
          channelId: 'omt_thread_1',
          initiatorUserId: 'ou_user_open_id',
        },
        container: {
          kind: 'thread',
          bindingMode: 'fixed',
          parentChannelId: 'oc_topic_group_1',
          rootMessageId: 'om_thread_root_1',
        },
        traceId: 'trace-topic-link',
      }),
    ).resolves.toEqual({
      url: 'https://applink.feishu.cn/client/message/link/open?token=topic-token',
    });
    expect(factory.getMessage).toHaveBeenCalledWith({
      path: { message_id: 'om_thread_root_1' },
    });
  });

  it('根消息没有 message_app_link 时用话题位置组装精确链接', async () => {
    const factory = new FakeSdkFactory();
    factory.getMessage.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: 'om_thread_root_1',
            chat_id: 'oc_topic_group_1',
            thread_id: 'omt_thread_1',
            thread_message_position: '-1',
            message_app_link: null,
          },
        ],
      },
    });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    const result = await adapter.resolveSessionContainer?.({
      sessionKey: {
        platformName: 'lark-main',
        platform: 'lark',
        channelId: 'omt_thread_1',
        initiatorUserId: 'ou_user_open_id',
      },
      container: {
        kind: 'thread',
        bindingMode: 'fixed',
        parentChannelId: 'oc_topic_group_1',
        rootMessageId: 'om_thread_root_1',
      },
      traceId: 'trace-topic-link-fallback',
    });

    expect(result).toBeDefined();
    const url = new URL(result!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://applink.feishu.cn/client/thread/open',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      openthreadid: 'omt_thread_1',
      openchatid: 'oc_topic_group_1',
      open_thread_id: 'omt_thread_1',
      open_chat_id: 'oc_topic_group_1',
      thread_position: '-1',
    });
  });

  it.each([
    ['chat_id', 'oc_other_group', 'omt_thread_1'],
    ['thread_id', 'oc_topic_group_1', 'omt_other_thread'],
  ] as const)(
    '拒绝为 %s 不匹配当前容器的根消息组装话题链接',
    async (_field, chatId, threadId) => {
      const factory = new FakeSdkFactory();
      factory.getMessage.mockResolvedValue({
        code: 0,
        data: {
          items: [
            {
              message_id: 'om_thread_root_1',
              chat_id: chatId,
              thread_id: threadId,
              thread_message_position: '-1',
              message_app_link: null,
            },
          ],
        },
      });
      const adapter = makeAdapter(factory);
      await adapter.start(vi.fn());

      await expect(
        adapter.resolveSessionContainer?.({
          sessionKey: {
            platformName: 'lark-main',
            platform: 'lark',
            channelId: 'omt_thread_1',
            initiatorUserId: 'ou_user_open_id',
          },
          container: {
            kind: 'thread',
            bindingMode: 'fixed',
            parentChannelId: 'oc_topic_group_1',
            rootMessageId: 'om_thread_root_1',
          },
          traceId: 'trace-topic-link-mismatch',
        }),
      ).rejects.toMatchObject({ code: 'lark_sdk_protocol_error' });
    },
  );

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['non-integer', 'not-a-position'],
  ] as const)(
    '根消息的 thread_message_position %s 时不组装话题链接',
    async (_case, threadPosition) => {
      const factory = new FakeSdkFactory();
      factory.getMessage.mockResolvedValue({
        code: 0,
        data: {
          items: [
            {
              message_id: 'om_thread_root_1',
              chat_id: 'oc_topic_group_1',
              thread_id: 'omt_thread_1',
              ...(threadPosition === undefined
                ? {}
                : { thread_message_position: threadPosition }),
              message_app_link: null,
            },
          ],
        },
      });
      const adapter = makeAdapter(factory);
      await adapter.start(vi.fn());

      await expect(
        adapter.resolveSessionContainer?.({
          sessionKey: {
            platformName: 'lark-main',
            platform: 'lark',
            channelId: 'omt_thread_1',
            initiatorUserId: 'ou_user_open_id',
          },
          container: {
            kind: 'thread',
            bindingMode: 'fixed',
            parentChannelId: 'oc_topic_group_1',
            rootMessageId: 'om_thread_root_1',
          },
          traceId: 'trace-topic-link-position-missing',
        }),
      ).resolves.toBeUndefined();
    },
  );

  it('根消息查询没有匹配项时保持 URL 未解析', async () => {
    const factory = new FakeSdkFactory();
    factory.getMessage.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: 'om_other_root',
            message_app_link:
              'https://applink.feishu.cn/client/message/link/open?token=other',
          },
        ],
      },
    });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    await expect(
      adapter.resolveSessionContainer({
        sessionKey: {
          platformName: 'lark-main',
          platform: 'lark',
          channelId: 'omt_thread_1',
          initiatorUserId: 'ou_user_open_id',
        },
        container: {
          kind: 'thread',
          bindingMode: 'fixed',
          parentChannelId: 'oc_topic_group_1',
          rootMessageId: 'om_thread_root_1',
        },
        traceId: 'trace-topic-link-miss',
      }),
    ).resolves.toBeUndefined();
  });

  it('只移除 bot mention，保留话题文本中的其他用户 mention', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const handler = vi.fn();
    await adapter.start(handler);

    factory.onMessage?.({
      ...THREAD_EVENT,
      message: {
        ...THREAD_EVENT.message,
        content: '{"text":"@_user_2 请问一下"}',
        mentions: [
          {
            key: '@_user_2',
            id: { open_id: 'ou_other_user' },
            name: 'Other User',
          },
        ],
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ text: '@_user_2 请问一下' }),
    );
  });

  it('不等待 daemon turn promise 即完成 EventDispatcher callback', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const pendingTurn = new Promise<void>(() => {});
    await adapter.start(() => pendingTurn);

    const result = factory.onMessage?.(BASE_EVENT);

    expect(result).toBeUndefined();
  });

  it('daemon handoff 同步抛错时记录失败但仍快速 ACK', async () => {
    const factory = new FakeSdkFactory();
    const logger = makeLogger();
    const adapter = makeAdapter(factory, logger);
    await adapter.start(() => {
      throw new Error('secret-value and private message body');
    });

    const result = factory.onMessage?.(BASE_EVENT);

    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'lark',
        platformName: 'lark-main',
        errorKind: 'platform',
        code: 'lark_event_handoff_failed',
        cause: 'Daemon event handoff failed',
      }),
      'error_reported',
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      'secret-value',
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      'private message body',
    );
  });

  it('真实 Engine 同步入队后立即 ACK，并用稳定 key 合并 messageId 不同的重投', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    let resolveTurn!: () => void;
    const pendingTurn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const sendInput = vi.fn(() => pendingTurn);
    const agentCapabilities: AgentCapabilitySet = {
      supportsThinking: false,
      supportsStreaming: false,
      supportsToolCallEvents: false,
      supportsInterrupt: false,
      supportsStdinInterrupt: false,
    };
    const runtime: AgentRuntime = {
      name: () => 'mock-agent',
      capabilities: () => agentCapabilities,
      startSession: (key: SessionKey): AgentSession => ({
        key,
        backend: 'mock',
        state: 'Ready',
        startedAt: new Date(0),
      }),
      stopSession: () => {},
      isAlive: () => true,
      sendInput,
      handleCommand: async () => ({ status: 'handled' }),
      onEvent: () => {},
      interrupt: () => {},
    };
    const engine = new Engine({
      platform: adapter,
      platformName: 'lark-main',
      platformType: 'lark',
      agent: runtime,
      defaultSessionConfig: {
        workingDir: '/workspace/project',
        timeoutMs: 30_000,
      },
      idempotencyStore: new InMemoryIdempotencyStore(),
      logger: makeLogger(),
      sessionStore: new SessionStore(),
    });
    await engine.start();

    const firstResult = factory.onMessage?.(THREAD_EVENT);
    const replayResult = factory.onMessage?.({
      ...THREAD_EVENT,
      event_id: 'evt_replay',
      message: {
        ...THREAD_EVENT.message,
        message_id: 'om_message_replay',
      },
    });

    expect(firstResult).toBeUndefined();
    expect(replayResult).toBeUndefined();
    await vi.waitFor(() => {
      expect(sendInput).toHaveBeenCalledTimes(1);
    });

    resolveTurn();
    await engine.stop();
  });

  it('真实 Engine 在同一飞书话题跨 turn 复用 session，并隔离不同话题', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const sendInput = vi.fn(async () => {});
    const startSession = vi.fn(
      (key: SessionKey): AgentSession => ({
        key,
        backend: 'mock',
        state: 'Ready',
        startedAt: new Date(0),
      }),
    );
    const runtime: AgentRuntime = {
      name: () => 'mock-agent',
      capabilities: () => ({
        supportsThinking: false,
        supportsStreaming: false,
        supportsToolCallEvents: false,
        supportsInterrupt: false,
        supportsStdinInterrupt: false,
      }),
      startSession,
      stopSession: async () => {},
      isAlive: () => true,
      sendInput,
      handleCommand: async () => ({ status: 'handled' }),
      onEvent: () => {},
      interrupt: () => {},
    };
    const engine = new Engine({
      platform: adapter,
      platformName: 'lark-main',
      platformType: 'lark',
      agent: runtime,
      defaultSessionConfig: {
        workingDir: '/workspace/project',
        timeoutMs: 30_000,
      },
      logger: makeLogger(),
      sessionStore: new SessionStore(),
    });
    await engine.start();

    factory.onMessage?.(THREAD_EVENT);
    factory.onMessage?.({
      ...THREAD_EVENT,
      event_id: 'evt_thread_2',
      message: {
        ...THREAD_EVENT.message,
        message_id: 'om_thread_message_2',
        create_time: '1720000002123',
        content: '{"text":"@_user_1 第二轮"}',
      },
    });
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(2));
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(sendInput.mock.calls[0]![0]).toBe(sendInput.mock.calls[1]![0]);

    factory.onMessage?.({
      ...THREAD_EVENT,
      event_id: 'evt_other_topic',
      message: {
        ...THREAD_EVENT.message,
        message_id: 'om_other_topic_message',
        thread_id: 'omt_thread_2',
        root_id: 'om_other_topic_root',
        parent_id: 'om_other_topic_root',
        create_time: '1720000003123',
        content: '{"text":"@_user_1 另一个话题"}',
      },
    });
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledTimes(3));
    expect(startSession).toHaveBeenCalledTimes(2);
    expect(sendInput.mock.calls[2]![0]).not.toBe(sendInput.mock.calls[0]![0]);

    await engine.stop();
  });

  it.each([
    ['P2P', BASE_EVENT],
    [
      '群主时间线',
      {
        ...THREAD_EVENT,
        event_id: 'evt_group_control',
        message: {
          ...THREAD_EVENT.message,
          message_id: 'om_group_control',
          thread_id: undefined,
          root_id: undefined,
          parent_id: undefined,
        },
      },
    ],
  ])('真实 Engine 对话题外 %s 普通文本保持静默', async (_name, event) => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const startSession = vi.fn((key: SessionKey): AgentSession => ({
      key,
      backend: 'mock',
      state: 'Ready',
      startedAt: new Date(0),
    }));
    const sendInput = vi.fn(async () => {});
    const engine = new Engine({
      platform: adapter,
      platformName: 'lark-main',
      platformType: 'lark',
      agent: {
        name: () => 'mock-agent',
        capabilities: () => ({
          supportsThinking: false,
          supportsStreaming: false,
          supportsToolCallEvents: false,
          supportsInterrupt: false,
          supportsStdinInterrupt: false,
        }),
        startSession,
        stopSession: async () => {},
        isAlive: () => true,
        sendInput,
        handleCommand: async () => ({ status: 'handled' }),
        onEvent: () => {},
        interrupt: () => {},
      },
      defaultSessionConfig: {
        workingDir: '/workspace/project',
        timeoutMs: 30_000,
      },
      logger: makeLogger(),
      sessionStore: new SessionStore(),
    });
    await engine.start();

    factory.onMessage?.(event);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startSession).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(factory.client.createMessage).not.toHaveBeenCalled();
    expect(factory.replyMessage).not.toHaveBeenCalled();

    await engine.stop();
  });

  it.each([
    ['image', { message: { ...BASE_EVENT.message, message_type: 'image' } }],
    ['invalid json', { message: { ...BASE_EVENT.message, content: '{' } }],
    ['missing event id', { event_id: undefined }],
    ['bot sender', { sender: { ...BASE_EVENT.sender, sender_type: 'bot' } }],
    ['app sender', { sender: { ...BASE_EVENT.sender, sender_type: 'app' } }],
    [
      'self sender',
      {
        sender: {
          ...BASE_EVENT.sender,
          sender_id: { open_id: 'ou_bot_open_id' },
        },
      },
    ],
  ])('丢弃不支持的 %s 事件', async (_name, override) => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const handler = vi.fn();
    await adapter.start(handler);

    factory.onMessage?.({
      ...BASE_EVENT,
      ...override,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('丢弃事件的日志不包含消息正文或原始 payload', async () => {
    const factory = new FakeSdkFactory();
    const logger = makeLogger();
    const adapter = makeAdapter(factory, logger);
    await adapter.start(vi.fn());
    const privateBody = 'private rejected body SECRET_PAYLOAD';

    factory.onMessage?.({
      ...BASE_EVENT,
      sender: { ...BASE_EVENT.sender, sender_type: 'app' },
      message: {
        ...BASE_EVENT.message,
        content: JSON.stringify({ text: privateBody }),
      },
    });

    const serializedLogs = JSON.stringify({
      trace: vi.mocked(logger.trace).mock.calls,
      debug: vi.mocked(logger.debug).mock.calls,
      info: vi.mocked(logger.info).mock.calls,
      warn: vi.mocked(logger.warn).mock.calls,
      error: vi.mocked(logger.error).mock.calls,
    });
    expect(serializedLogs).not.toContain(privateBody);
    expect(serializedLogs).not.toContain('SECRET_PAYLOAD');
  });

  it('真实 Engine 的 agent input 与 SQLite trajectory 不落 Lark 凭据或 wire secret', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const store = new SqliteTrajectoryStore();
    const sendInput = vi.fn(async () => {});
    const agentCapabilities: AgentCapabilitySet = {
      supportsThinking: false,
      supportsStreaming: false,
      supportsToolCallEvents: false,
      supportsInterrupt: false,
      supportsStdinInterrupt: false,
    };
    const runtime: AgentRuntime = {
      name: () => 'mock-agent',
      capabilities: () => agentCapabilities,
      startSession: (key: SessionKey): AgentSession => ({
        key,
        backend: 'mock',
        state: 'Ready',
        startedAt: new Date(0),
      }),
      stopSession: () => {},
      isAlive: () => true,
      sendInput,
      handleCommand: async () => ({ status: 'handled' }),
      onEvent: () => {},
      interrupt: () => {},
    };
    const engine = new Engine({
      platform: adapter,
      platformName: 'lark-main',
      platformType: 'lark',
      agent: runtime,
      defaultSessionConfig: {
        workingDir: '/workspace/project',
        timeoutMs: 30_000,
      },
      logger: makeLogger(),
      sessionStore: new SessionStore(),
      trajectory: { enabled: true, store },
    });
    await engine.start();

    factory.onMessage?.(THREAD_EVENT);
    await vi.waitFor(() => {
      expect(sendInput).toHaveBeenCalledTimes(1);
    });

    const segments = store.queryTrajectory({}).segments;
    expect(segments).toEqual([
      expect.objectContaining({
        kind: 'user-message',
        summary: '话题里的任务',
      }),
    ]);
    expect(sendInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'user_message',
        text: '话题里的任务',
      }),
    );
    const persisted = JSON.stringify(segments);
    const agentInput = JSON.stringify(sendInput.mock.calls);
    for (const secret of [
      'app-secret-value',
      'verification-token',
      'tenant-key',
      'cli_0123456789abcdef',
    ]) {
      expect(persisted).not.toContain(secret);
      expect(agentInput).not.toContain(secret);
    }

    await engine.stop();
    store.close();
  });

  it('稳定 tuple 相同但 eventId/messageId 不同时派生相同 idempotencyKey', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const events: NormalizedEvent[] = [];
    await adapter.start((event) => {
      events.push(event);
    });

    factory.onMessage?.(BASE_EVENT);
    factory.onMessage?.({
      ...BASE_EVENT,
      event_id: 'evt_2',
      message: { ...BASE_EVENT.message, message_id: 'om_message_2' },
    });

    expect(events).toHaveLength(2);
    expect(events[0]!.messageId).not.toBe(events[1]!.messageId);
    expect(events[0]!.idempotencyKey).toBe(events[1]!.idempotencyKey);
  });

  it('create_time 不同时派生不同 idempotencyKey', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    const events: NormalizedEvent[] = [];
    await adapter.start((event) => {
      events.push(event);
    });

    factory.onMessage?.(BASE_EVENT);
    factory.onMessage?.({
      ...BASE_EVENT,
      event_id: 'evt_2',
      message: {
        ...BASE_EVENT.message,
        message_id: 'om_message_2',
        create_time: '1720000000124',
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]!.idempotencyKey).not.toBe(events[1]!.idempotencyKey);
  });

  it.each([
    ['missing', undefined],
    ['invalid', '-1'],
    ['wrong type', 1720000000123],
  ])(
    'create_time %s 时仍接收事件，但省略稳定 key 与平台时间',
    async (_name, createTime) => {
      const factory = new FakeSdkFactory();
      const adapter = makeAdapter(factory);
      const handler = vi.fn();
      await adapter.start(handler);

      factory.onMessage?.({
        ...BASE_EVENT,
        message: {
          ...BASE_EVENT.message,
          create_time: createTime,
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]![0] as NormalizedEvent;
      expect(event).not.toHaveProperty('idempotencyKey');
      expect(event).not.toHaveProperty('platformTimestamp');
    },
  );
});

describe('LarkPlatformAdapter lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('SDK start 返回后仍等待 onReady 才完成启动', async () => {
    const factory = new FakeSdkFactory();
    factory.autoReady = false;
    const adapter = makeAdapter(factory);
    let settled = false;

    const start = adapter.start(vi.fn()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(false);
    factory.callbacksByGeneration[0]!.onReady();
    await expect(start).resolves.toBeUndefined();
  });

  it('重复 start fail-closed，不创建第二条连接', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    await expect(adapter.start(vi.fn())).rejects.toMatchObject({
      code: 'lark_already_started',
      retryable: false,
    });
    expect(factory.wsClients).toHaveLength(1);
  });

  it('probe 返回非零业务码时按 nonretryable 拒绝启动', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.request).mockResolvedValue({
      code: 99991663,
    });
    const adapter = makeAdapter(factory);

    const start = adapter.start(vi.fn());
    const rejection = expect(start).rejects.toMatchObject({
      code: 'lark_bot_probe_failed',
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
    expect(factory.wsClients).toHaveLength(0);
  });

  it('probe bot identity 不匹配时按 nonretryable 拒绝启动', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.request).mockResolvedValue({
      code: 0,
      bot: { open_id: 'ou_another_bot' },
    });
    const adapter = makeAdapter(factory);

    const start = adapter.start(vi.fn());
    const rejection = expect(start).rejects.toMatchObject({
      code: 'lark_bot_identity_mismatch',
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
    expect(factory.wsClients).toHaveLength(0);
  });

  it('生命周期日志记录真实 ready latency、连接时长与可能丢失窗口', async () => {
    const factory = new FakeSdkFactory();
    factory.autoReady = false;
    const logger = makeLogger();
    const adapter = makeAdapter(factory, logger);
    const start = adapter.start(vi.fn());
    await vi.advanceTimersByTimeAsync(125);

    factory.callbacksByGeneration[0]!.onReady();
    await start;
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ latencyMs: 125 }),
      'platform_connection_ready',
    );

    await vi.advanceTimersByTimeAsync(2_000);
    factory.callbacksByGeneration[0]!.onReconnecting();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ durationMs: 2_000 }),
      'platform_connection_lost',
    );

    await vi.advanceTimersByTimeAsync(3_000);
    factory.callbacksByGeneration[0]!.onReconnected();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        outageDurationMs: 3_000,
        possibleLossWindowMs: 3_000,
      }),
      'platform_connection_restored',
    );
  });

  it('ready timeout 关闭旧 generation、保持 start pending 并退避创建新 generation', async () => {
    const factory = new FakeSdkFactory();
    factory.autoReady = false;
    const adapter = makeAdapter(factory);
    const start = adapter.start(vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(factory.wsClients[0]!.close).toHaveBeenCalledWith({ force: false });
    expect(factory.callbacksByGeneration).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(factory.callbacksByGeneration).toHaveLength(2);

    factory.callbacksByGeneration[1]!.onReady();
    await expect(start).resolves.toBeUndefined();
  });

  it('首次 retryable onError 关闭旧 generation、保持 start pending 并重建连接', async () => {
    const factory = new FakeSdkFactory();
    factory.autoReady = false;
    const adapter = makeAdapter(factory);
    let settled = false;
    const start = adapter.start(vi.fn()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    const firstWs = factory.wsClients[0] as LarkSdkWsClientPort & {
      testState: 'connecting' | 'connected' | 'failed';
    };
    firstWs.testState = 'failed';

    factory.callbacksByGeneration[0]!.onError(new Error('initial failed'));
    expect(firstWs.close).toHaveBeenCalledWith({ force: false });
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(factory.callbacksByGeneration).toHaveLength(2);
    factory.callbacksByGeneration[1]!.onReady();
    await expect(start).resolves.toBeUndefined();
  });

  it('旧 generation 迟到 onReady 时强制关闭孤儿 socket', async () => {
    const factory = new FakeSdkFactory();
    factory.autoReady = false;
    const adapter = makeAdapter(factory);
    const start = adapter.start(vi.fn());
    await vi.advanceTimersByTimeAsync(30_500);
    expect(factory.callbacksByGeneration).toHaveLength(2);

    factory.callbacksByGeneration[0]!.onReady();

    expect(factory.wsClients[0]!.close).toHaveBeenLastCalledWith({
      force: true,
    });
    factory.callbacksByGeneration[1]!.onReady();
    await start;
  });

  it('SDK terminal failed 在运行期进入外层恢复并创建新 generation', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());
    const firstWs = factory.wsClients[0] as LarkSdkWsClientPort & {
      testState: 'connecting' | 'connected' | 'failed';
    };
    firstWs.testState = 'failed';

    factory.callbacksByGeneration[0]!.onError(new Error('terminal'));
    await vi.advanceTimersByTimeAsync(500);

    expect(firstWs.close).toHaveBeenCalledWith({ force: false });
    expect(factory.callbacksByGeneration).toHaveLength(2);
  });

  it('运行期恢复 generation 的 nonretryable probe 进入 failed，旧 callback 不得恢复状态', async () => {
    const factory = new FakeSdkFactory();
    const logger = makeLogger();
    const adapter = makeAdapter(factory, logger);
    await adapter.start(vi.fn());
    vi.mocked(factory.client.request).mockResolvedValueOnce({
      code: 99991663,
    });
    const firstWs = factory.wsClients[0] as LarkSdkWsClientPort & {
      testState: 'connecting' | 'connected' | 'failed';
    };
    firstWs.testState = 'failed';

    factory.callbacksByGeneration[0]!.onError(new Error('terminal'));
    await vi.advanceTimersByTimeAsync(500);

    expect(factory.client.request).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'lark_bot_probe_failed',
        retryable: false,
        stage: 'runtime',
      }),
      'platform_connection_failed',
    );
    await expect(
      adapter.send(
        {
          platformName: 'lark-main',
          platform: 'lark',
          channelId: 'oc_chat_1',
          initiatorUserId: 'ou_user_open_id',
        },
        {
          text: 'must fail',
          traceId: 'trace-failed',
          sessionKey: {
            platformName: 'lark-main',
            platform: 'lark',
            channelId: 'oc_chat_1',
            initiatorUserId: 'ou_user_open_id',
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'lark_not_running' });

    vi.mocked(logger.info).mockClear();
    factory.callbacksByGeneration[0]!.onReconnected();
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'platform_connection_restored',
    );
    await expect(
      adapter.send(
        {
          platformName: 'lark-main',
          platform: 'lark',
          channelId: 'oc_chat_1',
          initiatorUserId: 'ou_user_open_id',
        },
        {
          text: 'must still fail',
          traceId: 'trace-stale-callback',
          sessionKey: {
            platformName: 'lark-main',
            platform: 'lark',
            channelId: 'oc_chat_1',
            initiatorUserId: 'ou_user_open_id',
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'lark_not_running' });
  });

  it('SDK client 构造同步失败时拒绝 start，而不是留下 pending promise', async () => {
    const factory = new FakeSdkFactory();
    const logger = makeLogger();
    vi.spyOn(factory, 'createClient').mockImplementation(() => {
      throw new Error('invalid SDK configuration with app-secret-value');
    });
    const adapter = makeAdapter(factory, logger);

    const start = adapter.start(vi.fn());
    const rejection = expect(start).rejects.toMatchObject({
      code: 'lark_sdk_protocol_error',
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'lark',
        platformName: 'lark-main',
        errorKind: 'platform',
        code: 'lark_sdk_protocol_error',
        cause: 'Lark platform lifecycle failure',
      }),
      'platform_start_failed',
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      'app-secret-value',
    );
  });

  it('SDK websocket 构造同步失败时拒绝 start，而不是留下 pending promise', async () => {
    const factory = new FakeSdkFactory();
    vi.spyOn(factory, 'createWsClient').mockImplementation(() => {
      throw new Error('invalid websocket configuration');
    });
    const adapter = makeAdapter(factory);

    const start = adapter.start(vi.fn());
    const rejection = expect(start).rejects.toMatchObject({
      code: 'lark_sdk_protocol_error',
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    await rejection;
  });

  it('stop 在 starting 中取消恢复、幂等关闭且拒绝未完成的 start', async () => {
    const factory = new FakeSdkFactory();
    factory.autoReady = false;
    const adapter = makeAdapter(factory);
    const start = adapter.start(vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    const firstStop = adapter.stop();
    const secondStop = adapter.stop();

    await expect(firstStop).resolves.toBeUndefined();
    await expect(secondStop).resolves.toBeUndefined();
    await expect(start).rejects.toMatchObject({
      code: 'lark_start_stopped',
      retryable: false,
    });
    expect(factory.wsClients[0]!.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory.wsClients).toHaveLength(1);
  });

  it('stop 在 probe 失败退避期间取消后续 generation', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.request).mockRejectedValueOnce(
      Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    );
    const adapter = makeAdapter(factory);
    const start = adapter.start(vi.fn());
    const rejection = expect(start).rejects.toMatchObject({
      code: 'lark_start_stopped',
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(0);

    await adapter.stop();
    await rejection;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory.client.request).toHaveBeenCalledTimes(1);
    expect(factory.wsClients).toHaveLength(0);
  });

  it('running 状态 stop 幂等关闭当前连接', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    await adapter.stop();
    await adapter.stop();

    expect(factory.wsClients[0]!.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory.wsClients).toHaveLength(1);
  });
});

describe('LarkPlatformAdapter createThread', () => {
  it('预检话题群后，用稳定 uuid 创建根消息并返回精确 thread/root/link', async () => {
    const factory = new FakeSdkFactory();
    factory.getChat.mockResolvedValue({
      code: 0,
      data: { group_message_type: 'thread' },
    });
    vi.mocked(factory.client.createMessage).mockResolvedValue({
      code: 0,
      data: {
        message_id: 'om_root_1',
        chat_id: 'oc_chat_1',
        thread_id: 'omt_thread_1',
        root_id: 'om_root_1',
        message_app_link:
          'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_thread_1',
      },
    });
    const adapter = makeAdapter(factory);
    await adapter.start(() => undefined);

    await expect(
      adapter.createThread({
        parentChannelId: 'oc_chat_1',
        initiatorUserId: 'ou_user_open_id',
        title: '已有 Codex session',
        visibility: 'public',
        initialMessage: '最后一个完整回复',
        idempotencyKey: '0123456789abcdef0123456789abcdef',
        traceId: 'trace-recover-1',
      }),
    ).resolves.toEqual({
      threadId: 'omt_thread_1',
      parentChannelId: 'oc_chat_1',
      rootMessageId: 'om_root_1',
      url: 'https://applink.feishu.cn/client/thread/open?open_thread_id=omt_thread_1',
    });
    expect(factory.getChat).toHaveBeenCalledWith({
      path: { chat_id: 'oc_chat_1' },
    });
    expect(factory.client.createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '最后一个完整回复' }),
        uuid: '0123456789abcdef0123456789abcdef',
      },
    });
  });

  it('父群不是话题群时在 create 前 fail closed', async () => {
    const factory = new FakeSdkFactory();
    factory.getChat.mockResolvedValue({
      code: 0,
      data: { chat_id: 'oc_chat_1', group_message_type: 'chat' },
    });
    const adapter = makeAdapter(factory);
    await adapter.start(() => undefined);

    await expect(
      adapter.createThread(createThreadInput()),
    ).rejects.toMatchObject({
      code: 'lark_thread_parent_not_topic_group',
      retryable: false,
      creationOutcome: 'not-created',
    });
    expect(factory.client.createMessage).not.toHaveBeenCalled();
  });

  it('create 响应不带 AppLink 时立即查询根消息并保存 fallback 话题链接', async () => {
    const factory = new FakeSdkFactory();
    factory.getChat.mockResolvedValue({
      code: 0,
      data: { chat_id: 'oc_chat_1', group_message_type: 'thread' },
    });
    vi.mocked(factory.client.createMessage).mockResolvedValue({
      code: 0,
      data: {
        message_id: 'om_root_1',
        chat_id: 'oc_chat_1',
        thread_id: 'omt_thread_1',
      },
    });
    factory.getMessage.mockResolvedValue({
      code: 0,
      data: {
        items: [
          {
            message_id: 'om_root_1',
            chat_id: 'oc_chat_1',
            thread_id: 'omt_thread_1',
            thread_message_position: '-1',
          },
        ],
      },
    });
    const adapter = makeAdapter(factory);
    await adapter.start(() => undefined);

    const created = await adapter.createThread(createThreadInput());

    expect(created).toMatchObject({
      threadId: 'omt_thread_1',
      rootMessageId: 'om_root_1',
      url: expect.stringContaining('open_thread_id=omt_thread_1'),
    });
    expect(created.url).toContain('thread_position=-1');
    expect(factory.getMessage).toHaveBeenCalledWith({
      path: { message_id: 'om_root_1' },
    });
  });

  it('create 请求网络结果未知或成功响应缺 thread identity 时标记 ambiguous', async () => {
    const factory = new FakeSdkFactory();
    factory.getChat.mockResolvedValue({
      code: 0,
      data: { chat_id: 'oc_chat_1', group_message_type: 'thread' },
    });
    vi.mocked(factory.client.createMessage)
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_orphan', chat_id: 'oc_chat_1' },
      });
    const adapter = makeAdapter(factory);
    await adapter.start(() => undefined);

    await expect(adapter.createThread(createThreadInput())).rejects.toMatchObject({
      code: 'lark_thread_create_outcome_unknown',
      creationOutcome: 'unknown',
    });
    await expect(adapter.createThread(createThreadInput())).rejects.toMatchObject({
      code: 'lark_thread_create_outcome_unknown',
      creationOutcome: 'unknown',
    });
  });

  it('按飞书业务码区分安全重试的限频与结果未定的发送中', async () => {
    const factory = new FakeSdkFactory();
    factory.getChat.mockResolvedValue({
      code: 0,
      data: { chat_id: 'oc_chat_1', group_message_type: 'thread' },
    });
    vi.mocked(factory.client.createMessage)
      .mockResolvedValueOnce({ code: 230020, msg: 'rate limited' })
      .mockResolvedValueOnce({ code: 230049, msg: 'message is being sent' });
    const adapter = makeAdapter(factory);
    await adapter.start(() => undefined);

    await expect(adapter.createThread(createThreadInput())).rejects.toMatchObject({
      code: 'lark_thread_create_failed',
      retryable: true,
      creationOutcome: 'not-created',
    });
    await expect(adapter.createThread(createThreadInput())).rejects.toMatchObject({
      code: 'lark_thread_create_outcome_unknown',
      retryable: true,
      creationOutcome: 'unknown',
    });
  });

  it('从 SDK rejected response 读取飞书业务码，且不把发送中误判为未创建', async () => {
    const factory = new FakeSdkFactory();
    factory.getChat.mockResolvedValue({
      code: 0,
      data: { chat_id: 'oc_chat_1', group_message_type: 'thread' },
    });
    vi.mocked(factory.client.createMessage)
      .mockRejectedValueOnce(
        Object.assign(new Error('request rejected'), {
          response: { status: 400, data: { code: 230020 } },
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('request rejected'), {
          response: { status: 400, data: { code: 230049 } },
        }),
      );
    const adapter = makeAdapter(factory);
    await adapter.start(() => undefined);

    await expect(adapter.createThread(createThreadInput())).rejects.toMatchObject({
      retryable: true,
      creationOutcome: 'not-created',
    });
    await expect(adapter.createThread(createThreadInput())).rejects.toMatchObject({
      retryable: true,
      creationOutcome: 'unknown',
    });
  });

  it.each([
    [230001, false],
    [230002, true],
    [230006, true],
    [230013, true],
    [230018, true],
    [230022, false],
    [230025, false],
    [230027, true],
    [230034, false],
    [230054, false],
    [230055, false],
    [230075, false],
    [232009, false],
  ])(
    '把飞书明确拒绝的业务码 %i 分类为确定未创建',
    async (code, retryable) => {
      const factory = new FakeSdkFactory();
      factory.getChat.mockResolvedValue({
        code: 0,
        data: { chat_id: 'oc_chat_1', group_message_type: 'thread' },
      });
      vi.mocked(factory.client.createMessage).mockResolvedValue({
        code,
        msg: 'known rejection',
      });
      const adapter = makeAdapter(factory);
      await adapter.start(() => undefined);

      await expect(adapter.createThread(createThreadInput())).rejects.toMatchObject({
        code: 'lark_thread_create_failed',
        retryable,
        creationOutcome: 'not-created',
      });
    },
  );

  it('未知飞书业务码仍保守标记为结果未定', async () => {
    const factory = new FakeSdkFactory();
    factory.getChat.mockResolvedValue({
      code: 0,
      data: { chat_id: 'oc_chat_1', group_message_type: 'thread' },
    });
    vi.mocked(factory.client.createMessage).mockResolvedValue({
      code: 239999,
      msg: 'future error',
    });
    const adapter = makeAdapter(factory);
    await adapter.start(() => undefined);

    await expect(adapter.createThread(createThreadInput())).rejects.toMatchObject({
      code: 'lark_thread_create_outcome_unknown',
      retryable: false,
      creationOutcome: 'unknown',
    });
  });
});

describe('LarkPlatformAdapter outbound', () => {
  const sessionKey = {
    platformName: 'lark-main',
    platform: 'lark',
    channelId: 'oc_chat_1',
    initiatorUserId: 'ou_user_open_id',
  };

  it('用 chat_id/text/sendId:hex4 发送单片并返回 MessageRef', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.createMessage).mockResolvedValue({
      code: 0,
      data: {
        message_id: 'om_reply_1',
        chat_id: 'oc_chat_1',
      },
    });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    const result = await adapter.send(sessionKey, {
      text: '回复内容',
      traceId: 'trace-1',
      sessionKey,
    });

    expect(factory.client.createMessage).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat_1',
        msg_type: 'text',
        content: '{"text":"回复内容"}',
        uuid: '00112233445566778899aabbccddeeff:0000',
      },
    });
    expect(result).toEqual({
      platform: 'lark',
      channelId: 'oc_chat_1',
      messageId: 'om_reply_1',
      messageIds: ['om_reply_1'],
      sentAt: new Date('2026-07-24T12:00:00.000Z'),
    });
  });

  it('带 replyTo 时用 reply_in_thread 回复原消息，不向 thread_id 调 create', async () => {
    const factory = new FakeSdkFactory();
    factory.replyMessage.mockResolvedValue({
      code: 0,
      data: {
        message_id: 'om_thread_reply_1',
        chat_id: 'oc_topic_group_1',
      },
    });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());
    const threadSessionKey = {
      ...sessionKey,
      channelId: 'omt_thread_1',
    };

    const result = await adapter.send(threadSessionKey, {
      text: '话题回复',
      traceId: 'trace-thread-1',
      sessionKey: threadSessionKey,
      replyTo: {
        platform: 'lark',
        channelId: 'omt_thread_1',
        messageId: 'om_thread_message_1',
        messageIds: ['om_thread_message_1'],
        sentAt: new Date(1720000001123),
      },
    });

    expect(factory.client.createMessage).not.toHaveBeenCalled();
    expect(factory.replyMessage).toHaveBeenCalledWith({
      path: { message_id: 'om_thread_message_1' },
      data: {
        msg_type: 'text',
        content: '{"text":"话题回复"}',
        reply_in_thread: true,
        uuid: '00112233445566778899aabbccddeeff:0000',
      },
    });
    expect(result).toMatchObject({
      channelId: 'omt_thread_1',
      messageId: 'om_thread_reply_1',
    });
  });

  it('话题 reply 按 4000 UTF-16 code unit 串行切片并聚合全部 message id', async () => {
    const factory = new FakeSdkFactory();
    factory.replyMessage
      .mockResolvedValueOnce({
        code: 0,
        data: {
          message_id: 'om_thread_reply_1',
          chat_id: 'oc_topic_group_1',
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          message_id: 'om_thread_reply_2',
          chat_id: 'oc_topic_group_1',
        },
      });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());
    const threadSessionKey = {
      ...sessionKey,
      channelId: 'omt_thread_1',
    };

    const result = await adapter.send(threadSessionKey, {
      text: 'a'.repeat(4001),
      traceId: 'trace-thread-slices',
      sessionKey: threadSessionKey,
      replyTo: {
        platform: 'lark',
        channelId: 'omt_thread_1',
        messageId: 'om_thread_message_1',
        messageIds: ['om_thread_message_1'],
        sentAt: new Date(0),
      },
    });

    expect(factory.replyMessage).toHaveBeenCalledTimes(2);
    expect(
      factory.replyMessage.mock.calls.map(
        ([input]) =>
          (JSON.parse(input.data.content) as { text: string }).text.length,
      ),
    ).toEqual([4000, 1]);
    expect(
      factory.replyMessage.mock.calls.map(
        ([input]) => input.path.message_id,
      ),
    ).toEqual(['om_thread_message_1', 'om_thread_message_1']);
    expect(result.messageIds).toEqual([
      'om_thread_reply_1',
      'om_thread_reply_2',
    ]);
    expect(result.messageId).toBe('om_thread_reply_2');
  });

  it('话题 reply 多切片中途失败时保留已发送 id', async () => {
    const factory = new FakeSdkFactory();
    factory.replyMessage
      .mockResolvedValueOnce({
        code: 0,
        data: {
          message_id: 'om_thread_reply_1',
          chat_id: 'oc_topic_group_1',
        },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('bad request'), {
          response: { status: 400, headers: {} },
        }),
      );
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());
    const threadSessionKey = {
      ...sessionKey,
      channelId: 'omt_thread_1',
    };

    const error = await adapter
      .send(threadSessionKey, {
        text: 'a'.repeat(4001),
        traceId: 'trace-thread-partial',
        sessionKey: threadSessionKey,
        replyTo: {
          platform: 'lark',
          channelId: 'omt_thread_1',
          messageId: 'om_thread_message_1',
          messageIds: ['om_thread_message_1'],
          sentAt: new Date(0),
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LarkPartialSendError);
    expect(error).toMatchObject({
      sentIds: ['om_thread_reply_1'],
      totalSlices: 2,
    });
    expect(factory.replyMessage).toHaveBeenCalledTimes(2);
  });

  it('话题 reply 的 retry 复用同一 target 与 uuid', async () => {
    const factory = new FakeSdkFactory();
    const rateLimitError = Object.assign(new Error('rate limited'), {
      response: {
        status: 429,
        headers: { 'retry-after': '0' },
      },
    });
    factory.replyMessage
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        code: 0,
        data: {
          message_id: 'om_thread_reply_retry',
          chat_id: 'oc_topic_group_1',
        },
      });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());
    const threadSessionKey = {
      ...sessionKey,
      channelId: 'omt_thread_1',
    };
    const replyTo = {
      platform: 'lark',
      channelId: 'omt_thread_1',
      messageId: 'om_thread_message_1',
      messageIds: ['om_thread_message_1'],
      sentAt: new Date(0),
    };

    await adapter.send(threadSessionKey, {
      text: 'retry thread reply',
      traceId: 'trace-thread-retry',
      sessionKey: threadSessionKey,
      replyTo,
    });

    expect(factory.replyMessage).toHaveBeenCalledTimes(2);
    const [first, second] = factory.replyMessage.mock.calls;
    expect(first![0].path).toEqual(second![0].path);
    expect(first![0].data.uuid).toBe(second![0].data.uuid);
  });

  it('replyTo 的 platform 或 channel 不匹配时在发送前拒绝', async () => {
    const factory = new FakeSdkFactory();
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    await expect(
      adapter.send(sessionKey, {
        text: 'wrong target',
        traceId: 'trace-thread-mismatch',
        sessionKey,
        replyTo: {
          platform: 'lark',
          channelId: 'omt_other_thread',
          messageId: 'om_thread_message_1',
          messageIds: ['om_thread_message_1'],
          sentAt: new Date(0),
        },
      }),
    ).rejects.toMatchObject({
      code: 'lark_reply_target_mismatch',
      retryable: false,
    });
    expect(factory.client.createMessage).not.toHaveBeenCalled();
    expect(factory.replyMessage).not.toHaveBeenCalled();
  });

  it('WebSocket 重连期间仍通过独立 REST client 发送已完成的回复', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.createMessage).mockResolvedValue({
      code: 0,
      data: {
        message_id: 'om_reply_during_reconnect',
        chat_id: 'oc_chat_1',
      },
    });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());
    factory.callbacksByGeneration[0]!.onReconnecting();

    await expect(
      adapter.send(sessionKey, {
        text: '断线前已开始处理的回复',
        traceId: 'trace-1',
        sessionKey,
      }),
    ).resolves.toMatchObject({
      messageId: 'om_reply_during_reconnect',
    });
  });

  it('按 4000 UTF-16 code unit 串行切片并聚合全部 message id', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.createMessage)
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_reply_1', chat_id: 'oc_chat_1' },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_reply_2', chat_id: 'oc_chat_1' },
      });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());
    const text = 'a'.repeat(3999) + '😀';

    const result = await adapter.send(sessionKey, {
      text,
      traceId: 'trace-1',
      sessionKey,
    });

    const sentTexts = vi
      .mocked(factory.client.createMessage)
      .mock.calls.map(
        ([input]) =>
          (JSON.parse(input.data.content) as { text: string }).text,
      );
    expect(sentTexts).toHaveLength(2);
    expect(sentTexts.every((slice) => slice.length <= 4000)).toBe(true);
    expect(sentTexts.join('')).toBe(text);
    expect(result.messageIds).toEqual(['om_reply_1', 'om_reply_2']);
    expect(result.messageId).toBe('om_reply_2');
  });

  it('429 重试一次并在重试中复用同一 uuid', async () => {
    const factory = new FakeSdkFactory();
    const rateLimitError = Object.assign(new Error('rate limited'), {
      response: {
        status: 429,
        headers: { 'retry-after': '0' },
      },
    });
    vi.mocked(factory.client.createMessage)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_reply_1', chat_id: 'oc_chat_1' },
      });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    await adapter.send(sessionKey, {
      text: 'retry me',
      traceId: 'trace-1',
      sessionKey,
    });

    expect(factory.client.createMessage).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(factory.client.createMessage).mock.calls;
    expect(first![0].data.uuid).toBe(second![0].data.uuid);
  });

  it('同一 trace 的两次 send 使用不同 sendId', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.createMessage)
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_reply_1', chat_id: 'oc_chat_1' },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_reply_2', chat_id: 'oc_chat_1' },
      });
    let sequence = 0;
    const adapter = makeAdapter(factory, makeLogger(), {
      randomBytes: () => Buffer.alloc(16, sequence++),
    });
    await adapter.start(vi.fn());
    const message = {
      text: 'same trace',
      traceId: 'trace-1',
      sessionKey,
    };

    await adapter.send(sessionKey, message);
    await adapter.send(sessionKey, message);

    const [first, second] = vi.mocked(factory.client.createMessage).mock.calls;
    expect(first![0].data.uuid.split(':')[0]).not.toBe(
      second![0].data.uuid.split(':')[0],
    );
  });

  it('429 第二次仍失败时返回 retryable send error', async () => {
    const factory = new FakeSdkFactory();
    const rateLimitError = Object.assign(new Error('rate limited'), {
      response: {
        status: 429,
        headers: { 'retry-after': '0' },
      },
    });
    vi.mocked(factory.client.createMessage).mockRejectedValue(rateLimitError);
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    await expect(
      adapter.send(sessionKey, {
        text: 'retry twice',
        traceId: 'trace-1',
        sessionKey,
      }),
    ).rejects.toMatchObject({
      code: 'lark_message_send_failed',
      retryable: true,
    });
    expect(factory.client.createMessage).toHaveBeenCalledTimes(2);
  });

  it('多切片中途失败时保留已发送 id 且不重发成功切片', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.createMessage)
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_reply_1', chat_id: 'oc_chat_1' },
      })
      .mockRejectedValueOnce(
        Object.assign(new Error('bad request'), {
          response: { status: 400, headers: {} },
        }),
      );
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    const error = await adapter
      .send(sessionKey, {
        text: 'a'.repeat(4001),
        traceId: 'trace-1',
        sessionKey,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LarkPartialSendError);
    expect(error).toMatchObject({
      sentIds: ['om_reply_1'],
      totalSlices: 2,
    });
    expect(factory.client.createMessage).toHaveBeenCalledTimes(2);
  });

  it('响应 code/data 形状非法时抛 protocol error', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.createMessage).mockResolvedValue({
      code: 0,
      data: {},
    });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    await expect(
      adapter.send(sessionKey, {
        text: 'hello',
        traceId: 'trace-1',
        sessionKey,
      }),
    ).rejects.toMatchObject<LarkPlatformError>({
      code: 'lark_sdk_protocol_error',
      retryable: false,
    });
  });

  it('响应 code 非零时抛按 structured 字段分类的 send error', async () => {
    const factory = new FakeSdkFactory();
    vi.mocked(factory.client.createMessage).mockResolvedValue({
      code: 230001,
      retryable: false,
    });
    const adapter = makeAdapter(factory);
    await adapter.start(vi.fn());

    await expect(
      adapter.send(sessionKey, {
        text: 'hello',
        traceId: 'trace-business-error',
        sessionKey,
      }),
    ).rejects.toMatchObject<LarkPlatformError>({
      code: 'lark_message_send_failed',
      retryable: false,
    });
    expect(factory.client.createMessage).toHaveBeenCalledTimes(1);
  });
});
