export interface LarkSdkClientPort {
  request(input: {
    method: 'GET';
    url: '/open-apis/bot/v3/info';
  }): Promise<unknown>;
  createMessage(input: {
    params: { receive_id_type: 'chat_id' };
    data: {
      receive_id: string;
      msg_type: 'text';
      content: string;
      uuid: string;
    };
  }): Promise<unknown>;
  replyMessage(input: {
    path: { message_id: string };
    data: {
      msg_type: 'text';
      content: string;
      reply_in_thread: true;
      uuid: string;
    };
  }): Promise<unknown>;
  getMessage(input: {
    path: { message_id: string };
  }): Promise<unknown>;
}

export interface LarkSdkDispatcherPort {
  readonly kind: 'lark-event-dispatcher';
  readonly raw?: unknown;
}

export type LarkConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface LarkSdkWsClientPort {
  start(input: { eventDispatcher: LarkSdkDispatcherPort }): Promise<void>;
  close(input?: { force?: boolean }): void;
  getConnectionStatus(): { state: LarkConnectionState };
}

export interface LarkWsCallbacks {
  onReady(): void;
  onError(error: Error): void;
  onReconnecting(): void;
  onReconnected(): void;
}

export interface LarkSdkFactory {
  createClient(input: {
    appId: string;
    appSecret: string;
  }): LarkSdkClientPort;
  createDispatcher(
    onMessage: (event: unknown) => void,
  ): LarkSdkDispatcherPort;
  createWsClient(
    input: {
      appId: string;
      appSecret: string;
    } & LarkWsCallbacks,
  ): LarkSdkWsClientPort;
}
