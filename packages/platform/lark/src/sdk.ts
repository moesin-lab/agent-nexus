import { randomUUID } from 'node:crypto';
import {
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
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
    });
    return {
      request: (request) => client.request(request),
      createMessage: (message) => client.im.v1.message.create(message),
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
