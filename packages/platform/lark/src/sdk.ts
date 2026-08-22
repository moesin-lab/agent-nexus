import { randomUUID } from 'node:crypto';
import {
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  defaultHttpInstance,
  type HttpInstance,
  type HttpRequestOptions,
  type Logger as LarkSdkLogger,
} from '@larksuiteoapi/node-sdk';
import type { Logger } from '@agent-nexus/daemon';
import type {
  LarkSdkClientPort,
  LarkSdkDispatcherPort,
  LarkSdkFactory,
  LarkSdkWsClientPort,
  LarkWsCallbacks,
} from './sdk-port.js';

const LARK_HTTP_REQUEST_TIMEOUT_MS = 10_000;

function withRequestTimeout<D>(
  options: HttpRequestOptions<D> | undefined,
): HttpRequestOptions<D> {
  return {
    ...options,
    timeout: options?.timeout ?? LARK_HTTP_REQUEST_TIMEOUT_MS,
  };
}

// SDK 1.70.0 的共享 axios instance 默认无 timeout；显式包装后 token 与消息 API 都不会永久悬挂。
const timedHttpInstance: HttpInstance = {
  request: (options) =>
    defaultHttpInstance.request(withRequestTimeout(options)),
  get: (url, options) =>
    defaultHttpInstance.get(url, withRequestTimeout(options)),
  delete: (url, options) =>
    defaultHttpInstance.delete(url, withRequestTimeout(options)),
  head: (url, options) =>
    defaultHttpInstance.head(url, withRequestTimeout(options)),
  options: (url, options) =>
    defaultHttpInstance.options(url, withRequestTimeout(options)),
  post: (url, data, options) =>
    defaultHttpInstance.post(url, data, withRequestTimeout(options)),
  put: (url, data, options) =>
    defaultHttpInstance.put(url, data, withRequestTimeout(options)),
  patch: (url, data, options) =>
    defaultHttpInstance.patch(url, data, withRequestTimeout(options)),
};

function createSafeSdkLogger(logger: Logger): LarkSdkLogger {
  const ignore = (): void => {};
  return {
    error: () => {
      logger.error(
        {
          traceId: randomUUID(),
          platform: 'lark',
          errorKind: 'platform',
          code: 'lark_sdk_error',
          cause: 'Lark SDK reported an error',
        },
        'error_reported',
      );
    },
    warn: ignore,
    info: ignore,
    debug: ignore,
    trace: ignore,
  };
}

export class ProductionLarkSdkFactory implements LarkSdkFactory {
  private readonly sdkLogger: LarkSdkLogger;

  constructor(logger: Logger) {
    this.sdkLogger = createSafeSdkLogger(logger);
  }

  createClient(input: {
    appId: string;
    appSecret: string;
  }): LarkSdkClientPort {
    const client = new Client({
      appId: input.appId,
      appSecret: input.appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.error,
      logger: this.sdkLogger,
      httpInstance: timedHttpInstance,
    });
    return {
      request: (request) => client.request(request),
      createMessage: (message) => client.im.v1.message.create(message),
      replyMessage: (message) => client.im.v1.message.reply(message),
      getMessage: (message) => client.im.v1.message.get(message),
      getChat: (chat) => client.im.v1.chat.get(chat),
    };
  }

  createDispatcher(
    onMessage: (event: unknown) => void,
  ): LarkSdkDispatcherPort {
    const dispatcher = new EventDispatcher({
      loggerLevel: LoggerLevel.error,
      logger: this.sdkLogger,
    }).register({
      'im.message.receive_v1': onMessage,
    });
    return {
      kind: 'lark-event-dispatcher',
      raw: dispatcher,
    };
  }

  createWsClient(
    input: {
      appId: string;
      appSecret: string;
    } & LarkWsCallbacks,
  ): LarkSdkWsClientPort {
    const wsClient = new WSClient({
      appId: input.appId,
      appSecret: input.appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.error,
      logger: this.sdkLogger,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 10 },
      onReady: input.onReady,
      onError: input.onError,
      onReconnecting: input.onReconnecting,
      onReconnected: input.onReconnected,
    });
    return {
      start: ({ eventDispatcher }) => {
        if (!(eventDispatcher.raw instanceof EventDispatcher)) {
          return Promise.reject(
            new Error('lark_sdk_protocol_error: invalid EventDispatcher'),
          );
        }
        return wsClient.start({ eventDispatcher: eventDispatcher.raw });
      },
      close: (closeInput) => wsClient.close(closeInput),
      getConnectionStatus: () => wsClient.getConnectionStatus(),
    };
  }
}
