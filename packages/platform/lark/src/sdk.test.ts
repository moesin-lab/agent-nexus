import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@agent-nexus/daemon';

const sdkMocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  wsOptions: [] as unknown[],
  dispatcherOptions: [] as unknown[],
  registeredHandles: [] as unknown[],
  request: vi.fn(async () => ({ code: 0 })),
  createMessage: vi.fn(async () => ({ code: 0 })),
  wsStart: vi.fn(async () => {}),
  wsClose: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {
    im = {
      v1: {
        message: {
          create: sdkMocks.createMessage,
        },
      },
    };

    constructor(options: unknown) {
      sdkMocks.clientOptions.push(options);
    }

    request(input: unknown): Promise<unknown> {
      return sdkMocks.request(input);
    }
  }

  class EventDispatcher {
    constructor(options: unknown) {
      sdkMocks.dispatcherOptions.push(options);
    }

    register(handles: unknown): this {
      sdkMocks.registeredHandles.push(handles);
      return this;
    }
  }

  class WSClient {
    constructor(options: unknown) {
      sdkMocks.wsOptions.push(options);
    }

    start(input: unknown): Promise<void> {
      return sdkMocks.wsStart(input);
    }

    close(input?: unknown): void {
      sdkMocks.wsClose(input);
    }

    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    }
  }

  return {
    Client,
    EventDispatcher,
    WSClient,
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { error: 1 },
  };
});

import { ProductionLarkSdkFactory } from './sdk.js';

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

describe('ProductionLarkSdkFactory', () => {
  it('Client 与 WSClient 显式固定中国版 Domain.Feishu 和安全 lifecycle 参数', () => {
    const factory = new ProductionLarkSdkFactory(makeLogger());
    factory.createClient({
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret',
    });
    factory.createWsClient({
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret',
      onReady: vi.fn(),
      onError: vi.fn(),
      onReconnecting: vi.fn(),
      onReconnected: vi.fn(),
    });

    expect(sdkMocks.clientOptions.at(-1)).toMatchObject({
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret',
      domain: 0,
      loggerLevel: 1,
    });
    expect(sdkMocks.wsOptions.at(-1)).toMatchObject({
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret',
      domain: 0,
      loggerLevel: 1,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 10 },
    });
  });

  it('EventDispatcher 只注册 im.message.receive_v1', () => {
    const factory = new ProductionLarkSdkFactory(makeLogger());
    const onMessage = vi.fn();

    factory.createDispatcher(onMessage);

    expect(sdkMocks.registeredHandles.at(-1)).toEqual({
      'im.message.receive_v1': onMessage,
    });
  });

  it('SDK logger 不转发可能包含 app secret 或消息正文的原始参数', () => {
    const logger = makeLogger();
    const factory = new ProductionLarkSdkFactory(logger);
    factory.createClient({
      appId: 'cli_0123456789abcdef',
      appSecret: 'app-secret-value',
    });
    const options = sdkMocks.clientOptions.at(-1) as {
      logger: {
        error(...args: unknown[]): void;
      };
    };

    options.logger.error(
      new Error('app-secret-value'),
      { content: 'private message body' },
    );

    const serialized = JSON.stringify(
      vi.mocked(logger.error).mock.calls,
    );
    expect(serialized).not.toContain('app-secret-value');
    expect(serialized).not.toContain('private message body');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'lark',
        code: 'lark_sdk_error',
      }),
      'error_reported',
    );
  });

  it('Client port 把 bot probe 与 message.create 直接委托给 SDK', async () => {
    const factory = new ProductionLarkSdkFactory(makeLogger());
    const client = factory.createClient({
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret',
    });
    const messageInput = {
      params: { receive_id_type: 'chat_id' as const },
      data: {
        receive_id: 'oc_chat_1',
        msg_type: 'text' as const,
        content: '{"text":"hello"}',
        uuid: '00112233445566778899aabbccddeeff:0000',
      },
    };

    await client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    await client.createMessage(messageInput);

    expect(sdkMocks.request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    expect(sdkMocks.createMessage).toHaveBeenCalledWith(messageInput);
  });
});
