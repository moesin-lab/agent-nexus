import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
} from 'node:crypto';
import type { Logger } from '@agent-nexus/daemon';
import type {
  CapabilitySet,
  EventHandler,
  MessageRef,
  OutboundMessage,
  PlatformAdapter,
  ResolveSessionContainerInput,
  ResolveSessionContainerResult,
  SessionKey,
  NormalizedEvent,
} from '@agent-nexus/protocol';
import type {
  LarkSdkClientPort,
  LarkSdkFactory,
  LarkSdkWsClientPort,
} from './sdk-port.js';

export const LARK_CAPABILITIES: CapabilitySet = {
  maxTextLength: 4000,
  supportsEdit: false,
  supportsDelete: false,
  supportsReactions: false,
  supportsEmbeds: false,
  supportsButtons: false,
  supportsSelects: false,
  supportsModals: false,
  supportsThreads: true,
  supportsThreadCreation: false,
  supportsEphemeral: false,
  supportsAttachments: false,
  maxAttachmentsPerMessage: 0,
  supportsTypingIndicator: false,
  supportsSlashCommands: false,
};

export interface LarkPlatformOptions {
  appId: string;
  appSecret: string;
  botOpenId: string;
  platformName: string;
  logger: Logger;
}

export interface LarkAdapterInternals {
  sdkFactory: LarkSdkFactory;
  now?(): Date;
  randomBytes?(size: number): Buffer;
  random?(): number;
  sleep?(milliseconds: number): Promise<void>;
}

export class LarkPlatformError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = 'LarkPlatformError';
  }
}

export class LarkPartialSendError extends LarkPlatformError {
  constructor(
    public readonly sentIds: string[],
    public readonly totalSlices: number,
    cause: unknown,
  ) {
    super('lark_partial_send', false, { cause });
    this.name = 'LarkPartialSendError';
  }
}

type AdapterState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'reconnecting'
  | 'stopping'
  | 'stopped'
  | 'failed';

const RAW_CONTENT_TYPE =
  'lark-node-sdk:im.message.receive_v1@1.70.0';
const MAX_INBOUND_TEXT_LENGTH = 1024 * 1024;
const MAX_OUTBOUND_TEXT_LENGTH = 4000;
const MAX_SLICE_COUNT = 0xffff;
const BOT_PROBE_TIMEOUT_MS = 15_000;
const WS_READY_TIMEOUT_MS = 30_000;
const STABLE_CONNECTION_MS = 60_000;
const MAX_RETRY_BACKOFF_MS = 30_000;
const REMOVED_RAW_KEYS = new Set(['token', 'tenant_key', 'app_id']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeRawPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRawPayload(item));
  }
  if (!isRecord(value)) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!REMOVED_RAW_KEYS.has(key)) {
      sanitized[key] = sanitizeRawPayload(child);
    }
  }
  return sanitized;
}

function parseNonNegativeTimestamp(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return undefined;
  return timestamp;
}

function parseTextContent(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed['text'] !== 'string') {
    return undefined;
  }
  if (parsed['text'].length > MAX_INBOUND_TEXT_LENGTH) {
    return undefined;
  }
  return parsed['text'];
}

function stripBotMentions(
  text: string,
  mentions: unknown,
  botOpenId: string,
): string {
  if (!Array.isArray(mentions)) return text;
  let normalized = text;
  let removed = false;
  for (const mention of mentions) {
    if (!isRecord(mention) || typeof mention['key'] !== 'string') continue;
    const mentionId = mention['id'];
    if (
      isRecord(mentionId) &&
      mentionId['open_id'] === botOpenId
    ) {
      normalized = normalized.split(mention['key']).join('');
      removed = true;
    }
  }
  return removed ? normalized.trimStart() : text;
}

function normalizeLarkEvent(
  raw: unknown,
  botOpenId: string,
  receivedAt: Date,
): NormalizedEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const eventId = raw['event_id'];
  const sender = raw['sender'];
  const message = raw['message'];
  if (
    typeof eventId !== 'string' ||
    eventId.length === 0 ||
    !isRecord(sender) ||
    !isRecord(message) ||
    sender['sender_type'] !== 'user' ||
    message['message_type'] !== 'text'
  ) {
    return undefined;
  }

  const senderId = sender['sender_id'];
  const openId = isRecord(senderId) ? senderId['open_id'] : undefined;
  const messageId = message['message_id'];
  const chatId = message['chat_id'];
  const chatType = message['chat_type'];
  const threadId = message['thread_id'];
  const rootId = message['root_id'];
  const createTime = message['create_time'];
  const content = message['content'];
  if (
    typeof openId !== 'string' ||
    openId.length === 0 ||
    openId === botOpenId ||
    typeof messageId !== 'string' ||
    messageId.length === 0 ||
    typeof chatId !== 'string' ||
    chatId.length === 0 ||
    (chatType !== 'p2p' && chatType !== 'group') ||
    typeof content !== 'string'
  ) {
    return undefined;
  }

  const parsedText = parseTextContent(content);
  if (parsedText === undefined) return undefined;
  const text = stripBotMentions(
    parsedText,
    message['mentions'],
    botOpenId,
  );

  const timestamp =
    typeof createTime === 'string'
      ? parseNonNegativeTimestamp(createTime)
      : undefined;
  const idempotencyKey =
    timestamp === undefined
      ? undefined
      : 'lark-text-v1:' +
        createHash('sha256')
          .update(
            JSON.stringify([openId, chatId, createTime, content]),
            'utf8',
          )
          .digest('hex');
  const isTopic =
    chatType === 'group' &&
    typeof threadId === 'string' &&
    threadId.length > 0;
  const channelId = isTopic ? threadId : chatId;
  const rootMessageId =
    typeof rootId === 'string' && rootId.length > 0
      ? rootId
      : isTopic
        ? messageId
        : undefined;

  return {
    eventId,
    platform: 'lark',
    sessionKey: {
      platform: 'lark',
      channelId,
      initiatorUserId: openId,
    },
    messageId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    traceId: randomUUID(),
    type: 'message',
    deliveryScope: isTopic ? 'session' : 'control',
    text,
    rawPayload: sanitizeRawPayload(raw),
    rawContentType: RAW_CONTENT_TYPE,
    receivedAt,
    ...(timestamp === undefined
      ? {}
      : { platformTimestamp: new Date(timestamp) }),
    ...(isTopic
      ? {
          threadParentChannelId: chatId,
          sessionContainer: {
            kind: 'thread',
            bindingMode: 'fixed',
            parentChannelId: chatId,
            ...(rootMessageId ? { rootMessageId } : {}),
            parentUrl:
              'https://applink.feishu.cn/client/chat/open?openChatId=' +
              encodeURIComponent(chatId),
          },
          responseTarget: {
            platform: 'lark',
            channelId,
            messageId,
            messageIds: [messageId],
            sentAt:
              timestamp === undefined ? receivedAt : new Date(timestamp),
          },
        }
      : {}),
    initiator: {
      userId: openId,
      displayName: openId,
      isBot: false,
    },
  };
}

function validateBotProbe(response: unknown, expectedBotOpenId: string): void {
  if (!isRecord(response) || typeof response['code'] !== 'number') {
    throw new LarkPlatformError('lark_sdk_protocol_error', false);
  }
  if (response['code'] !== 0) {
    throw new LarkPlatformError(
      'lark_bot_probe_failed',
      response['retryable'] === true,
    );
  }
  const bot = response['bot'];
  if (
    !isRecord(bot) ||
    typeof bot['open_id'] !== 'string' ||
    bot['open_id'].length === 0
  ) {
    throw new LarkPlatformError('lark_sdk_protocol_error', false);
  }
  if (bot['open_id'] !== expectedBotOpenId) {
    throw new LarkPlatformError('lark_bot_identity_mismatch', false);
  }
}

function buildSlices(text: string): string[] {
  if (text.length <= MAX_OUTBOUND_TEXT_LENGTH) return [text];
  const slices: string[] = [];
  let current = '';
  for (const character of text) {
    if (
      current.length > 0 &&
      current.length + character.length > MAX_OUTBOUND_TEXT_LENGTH
    ) {
      slices.push(current);
      current = '';
    }
    current += character;
  }
  if (current.length > 0 || slices.length === 0) slices.push(current);
  return slices;
}

function readHttpStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const directStatus = error['status'];
  if (typeof directStatus === 'number') return directStatus;
  const response = error['response'];
  return isRecord(response) && typeof response['status'] === 'number'
    ? response['status']
    : undefined;
}

function readRetryAfterMs(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const response = error['response'];
  const headers = isRecord(response) ? response['headers'] : undefined;
  if (!isRecord(headers)) return undefined;
  const value = headers['retry-after'] ?? headers['Retry-After'];
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, 30_000);
}

function isRetryableSendFailure(error: unknown): boolean {
  if (error instanceof LarkPlatformError) return error.retryable;
  if (!isRecord(error)) return false;
  if (error['retryable'] === true) return true;
  const status = readHttpStatus(error);
  if (status === 429 || (status !== undefined && status >= 500)) return true;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED'].includes(
    typeof error['code'] === 'string' ? error['code'] : '',
  );
}

function parseMessageResponse(response: unknown): string {
  if (!isRecord(response) || typeof response['code'] !== 'number') {
    throw new LarkPlatformError('lark_sdk_protocol_error', false);
  }
  if (response['code'] !== 0) {
    throw new LarkPlatformError(
      'lark_message_send_failed',
      response['retryable'] === true,
    );
  }
  const data = response['data'];
  if (
    !isRecord(data) ||
    typeof data['message_id'] !== 'string' ||
    data['message_id'].length === 0 ||
    typeof data['chat_id'] !== 'string' ||
    data['chat_id'].length === 0
  ) {
    throw new LarkPlatformError('lark_sdk_protocol_error', false);
  }
  return data['message_id'];
}

function parseSessionContainerLink(
  response: unknown,
  rootMessageId: string,
  expectedParentChannelId: string,
  expectedThreadId: string,
): string | undefined {
  if (!isRecord(response) || response['code'] !== 0) {
    throw new LarkPlatformError(
      'lark_message_query_failed',
      isRecord(response) && response['retryable'] === true,
    );
  }
  const data = response['data'];
  const items = isRecord(data) ? data['items'] : undefined;
  if (!Array.isArray(items)) {
    throw new LarkPlatformError('lark_sdk_protocol_error', false);
  }
  const matches = items.filter(
    (item) => isRecord(item) && item['message_id'] === rootMessageId,
  );
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw new LarkPlatformError('lark_sdk_protocol_error', false);
  }
  const item = matches[0]!;
  const link = item['message_app_link'];
  if (link !== undefined && link !== null && link !== '') {
    if (typeof link !== 'string') {
      throw new LarkPlatformError('lark_sdk_protocol_error', false);
    }
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      throw new LarkPlatformError('lark_sdk_protocol_error', false);
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'applink.feishu.cn'
    ) {
      throw new LarkPlatformError('lark_sdk_protocol_error', false);
    }
    return link;
  }

  const parentChannelId = item['chat_id'];
  const threadId = item['thread_id'];
  const threadPosition = item['thread_message_position'];
  if (
    typeof parentChannelId !== 'string' ||
    parentChannelId.length === 0 ||
    typeof threadId !== 'string' ||
    threadId.length === 0 ||
    typeof threadPosition !== 'string' ||
    !/^-?\d+$/.test(threadPosition)
  ) {
    return undefined;
  }
  if (
    parentChannelId !== expectedParentChannelId ||
    threadId !== expectedThreadId
  ) {
    throw new LarkPlatformError('lark_sdk_protocol_error', false);
  }

  const fallback = new URL('https://applink.feishu.cn/client/thread/open');
  // Feishu desktop and mobile currently consume different parameter spellings.
  fallback.searchParams.set('openthreadid', threadId);
  fallback.searchParams.set('openchatid', parentChannelId);
  fallback.searchParams.set('open_thread_id', threadId);
  fallback.searchParams.set('open_chat_id', parentChannelId);
  fallback.searchParams.set('thread_position', threadPosition);
  return fallback.toString();
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LarkPlatformAdapter implements PlatformAdapter {
  private state: AdapterState = 'idle';
  private generation = 0;
  private retryAttempt = 0;
  private hasReachedReady = false;
  private client?: LarkSdkClientPort;
  private wsClient?: LarkSdkWsClientPort;
  private startPromise?: Promise<void>;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private stopPromise?: Promise<void>;
  private probeTimer?: ReturnType<typeof setTimeout>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stableTimer?: ReturnType<typeof setTimeout>;
  private startInitiatedAtMs = 0;
  private connectedAtMs?: number;
  private outageStartedAtMs?: number;

  constructor(
    private readonly options: LarkPlatformOptions,
    private readonly internals: LarkAdapterInternals,
  ) {}

  name(): string {
    return 'lark';
  }

  capabilities(): CapabilitySet {
    return LARK_CAPABILITIES;
  }

  async start(handler: EventHandler): Promise<void> {
    if (this.state !== 'idle') {
      throw new LarkPlatformError('lark_already_started', false);
    }
    this.state = 'starting';
    this.startInitiatedAtMs = Date.now();
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    void this.startGeneration(handler);
    return this.startPromise;
  }

  private async startGeneration(handler: EventHandler): Promise<void> {
    const generation = ++this.generation;
    let client: LarkSdkClientPort;
    try {
      client = this.internals.sdkFactory.createClient({
        appId: this.options.appId,
        appSecret: this.options.appSecret,
      });
    } catch (error) {
      this.handleGenerationFailure(
        generation,
        new LarkPlatformError('lark_sdk_protocol_error', false, {
          cause: error,
        }),
        handler,
      );
      return;
    }
    this.client = client;

    let probe: unknown;
    try {
      probe = await this.runBotProbe(client, generation);
      if (generation !== this.generation) return;
      validateBotProbe(probe, this.options.botOpenId);
    } catch (error) {
      const classified =
        error instanceof LarkPlatformError
          ? error
          : new LarkPlatformError(
              'lark_bot_probe_failed',
              isRetryableSendFailure(error),
              { cause: error },
            );
      this.handleGenerationFailure(generation, classified, handler);
      return;
    }

    let dispatcher;
    let wsClient!: LarkSdkWsClientPort;
    try {
      dispatcher = this.internals.sdkFactory.createDispatcher((raw) => {
        if (generation !== this.generation || this.state !== 'running') return;
        this.handleRawEvent(raw, handler);
      });
      wsClient = this.internals.sdkFactory.createWsClient({
        appId: this.options.appId,
        appSecret: this.options.appSecret,
        onReady: () => this.handleReady(generation, wsClient),
        onError: (error) => {
          if (
            generation === this.generation &&
            wsClient.getConnectionStatus().state === 'failed'
          ) {
            this.handleGenerationFailure(
              generation,
              new LarkPlatformError(
                this.hasReachedReady
                  ? 'lark_ws_terminal_failed'
                  : 'lark_ws_start_failed',
                true,
                { cause: error },
              ),
              handler,
            );
          }
        },
        onReconnecting: () => {
          if (generation !== this.generation || this.state !== 'running') return;
          const now = Date.now();
          this.outageStartedAtMs = now;
          this.state = 'reconnecting';
          this.logLifecycle('warn', 'platform_connection_lost', {
            reason: 'sdk_reconnecting',
            durationMs: Math.max(0, now - (this.connectedAtMs ?? now)),
          });
        },
        onReconnected: () => {
          if (
            generation !== this.generation ||
            this.state !== 'reconnecting'
          ) {
            return;
          }
          const now = Date.now();
          const outageDurationMs = Math.max(
            0,
            now - (this.outageStartedAtMs ?? now),
          );
          this.state = 'running';
          this.connectedAtMs = now;
          this.outageStartedAtMs = undefined;
          this.scheduleStableReset(generation);
          this.logLifecycle('info', 'platform_connection_restored', {
            outageDurationMs,
            possibleLossWindowMs: outageDurationMs,
          });
        },
      });
    } catch (error) {
      this.handleGenerationFailure(
        generation,
        new LarkPlatformError('lark_sdk_protocol_error', false, {
          cause: error,
        }),
        handler,
      );
      return;
    }
    if (generation !== this.generation) {
      wsClient.close({ force: true });
      return;
    }
    this.wsClient = wsClient;
    this.readyTimer = setTimeout(() => {
      this.handleGenerationFailure(
        generation,
        new LarkPlatformError('lark_ws_ready_timeout', true),
        handler,
      );
    }, WS_READY_TIMEOUT_MS);
    void wsClient
      .start({ eventDispatcher: dispatcher })
      .catch((error: unknown) => {
        this.handleGenerationFailure(
          generation,
          new LarkPlatformError('lark_ws_start_failed', true, {
            cause: error,
          }),
          handler,
        );
      });
  }

  private async runBotProbe(
    client: LarkSdkClientPort,
    generation: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.probeTimer = setTimeout(() => {
        reject(new LarkPlatformError('lark_bot_probe_failed', true));
      }, BOT_PROBE_TIMEOUT_MS);
      void client
        .request({
          method: 'GET',
          url: '/open-apis/bot/v3/info',
        })
        .then(resolve, reject)
        .finally(() => {
          if (generation === this.generation && this.probeTimer) {
            clearTimeout(this.probeTimer);
            this.probeTimer = undefined;
          }
        });
    });
  }

  private handleRawEvent(raw: unknown, handler: EventHandler): void {
    const event = normalizeLarkEvent(
      raw,
      this.options.botOpenId,
      this.internals.now?.() ?? new Date(),
    );
    if (!event) return;
    try {
      const result = handler(event);
      if (
        result &&
        typeof (result as PromiseLike<unknown>).then === 'function'
      ) {
        void Promise.resolve(result).catch((error: unknown) => {
          this.logHandoffFailure(event, error);
        });
      }
    } catch (error) {
      this.logHandoffFailure(event, error);
    }
  }

  private logHandoffFailure(
    event: NormalizedEvent,
    _error: unknown,
  ): void {
    this.options.logger.error(
      {
        traceId: event.traceId,
        platform: 'lark',
        platformName: this.options.platformName,
        errorKind: 'platform',
        code: 'lark_event_handoff_failed',
        cause: 'Daemon event handoff failed',
      },
      'error_reported',
    );
  }

  private handleReady(
    generation: number,
    wsClient: LarkSdkWsClientPort,
  ): void {
    if (
      generation !== this.generation ||
      this.state === 'stopping' ||
      this.state === 'stopped'
    ) {
      wsClient.close({ force: true });
      return;
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
    const isFirstReady = !this.hasReachedReady;
    const now = Date.now();
    const outageDurationMs = Math.max(
      0,
      now - (this.outageStartedAtMs ?? now),
    );
    this.hasReachedReady = true;
    this.state = 'running';
    this.connectedAtMs = now;
    this.outageStartedAtMs = undefined;
    this.scheduleStableReset(generation);
    this.logLifecycle(
      'info',
      isFirstReady
        ? 'platform_connection_ready'
        : 'platform_connection_restored',
      isFirstReady
        ? { latencyMs: Math.max(0, now - this.startInitiatedAtMs) }
        : {
            outageDurationMs,
            possibleLossWindowMs: outageDurationMs,
          },
    );
    if (isFirstReady) {
      this.resolveStart?.();
      this.resolveStart = undefined;
      this.rejectStart = undefined;
    }
  }

  private handleGenerationFailure(
    generation: number,
    error: LarkPlatformError,
    handler: EventHandler,
  ): void {
    if (
      generation !== this.generation ||
      this.state === 'stopping' ||
      this.state === 'stopped'
    ) {
      return;
    }
    const now = Date.now();
    if (this.hasReachedReady && this.state === 'running') {
      this.outageStartedAtMs = now;
      this.logLifecycle('warn', 'platform_connection_lost', {
        reason: error.code,
        durationMs: Math.max(0, now - (this.connectedAtMs ?? now)),
      });
    } else if (this.hasReachedReady && this.outageStartedAtMs === undefined) {
      this.outageStartedAtMs = now;
    }
    this.clearGenerationTimers();
    this.wsClient?.close({ force: false });
    this.generation += 1;

    if (!error.retryable) {
      this.state = 'failed';
      this.logLifecycle(
        'error',
        this.hasReachedReady
          ? 'platform_connection_failed'
          : 'platform_start_failed',
        {
          stage: this.hasReachedReady ? 'runtime' : 'startup',
          code: error.code,
          retryable: false,
        },
      );
      this.rejectStart?.(error);
      this.resolveStart = undefined;
      this.rejectStart = undefined;
      return;
    }

    this.state = this.hasReachedReady ? 'reconnecting' : 'starting';
    const attempt = ++this.retryAttempt;
    const maximumDelay = Math.min(
      1000 * 2 ** Math.min(attempt - 1, 30),
      MAX_RETRY_BACKOFF_MS,
    );
    const backoffMs = Math.floor(
      (this.internals.random?.() ?? Math.random()) * maximumDelay,
    );
    this.logLifecycle(
      'warn',
      this.hasReachedReady
        ? 'platform_connection_retrying'
        : 'platform_start_failed',
      {
        stage: this.hasReachedReady ? 'runtime' : 'startup',
        code: error.code,
        retryable: true,
        attempt,
        backoffMs,
      },
    );
    const retryGeneration = this.generation;
    this.retryTimer = setTimeout(() => {
      if (
        retryGeneration !== this.generation ||
        this.state === 'stopping' ||
        this.state === 'stopped'
      ) {
        return;
      }
      this.retryTimer = undefined;
      void this.startGeneration(handler);
    }, backoffMs);
  }

  private scheduleStableReset(generation: number): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      if (generation === this.generation && this.state === 'running') {
        this.retryAttempt = 0;
      }
    }, STABLE_CONNECTION_MS);
  }

  private clearGenerationTimers(): void {
    for (const timer of [this.probeTimer, this.readyTimer, this.stableTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.probeTimer = undefined;
    this.readyTimer = undefined;
    this.stableTimer = undefined;
  }

  private logLifecycle(
    level: 'info' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown>,
  ): void {
    this.options.logger[level](
      {
        traceId: randomUUID(),
        platform: 'lark',
        platformName: this.options.platformName,
        transport: 'lark-node-sdk-ws',
        ...(level === 'error'
          ? {
              errorKind: 'platform',
              cause: 'Lark platform lifecycle failure',
            }
          : {}),
        ...fields,
      },
      event,
    );
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.state = 'stopping';
    this.generation += 1;
    this.clearGenerationTimers();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.wsClient?.close({ force: false });
    this.rejectStart?.(
      new LarkPlatformError('lark_start_stopped', false),
    );
    this.resolveStart = undefined;
    this.rejectStart = undefined;
    this.state = 'stopped';
    this.stopPromise = Promise.resolve();
    return this.stopPromise;
  }

  async send(
    sessionKey: SessionKey,
    message: OutboundMessage,
  ): Promise<MessageRef> {
    if (
      !this.client ||
      (this.state !== 'running' && this.state !== 'reconnecting')
    ) {
      throw new LarkPlatformError('lark_not_running', false);
    }
    if (
      message.replyTo &&
      (message.replyTo.platform !== 'lark' ||
        message.replyTo.channelId !== sessionKey.channelId)
    ) {
      throw new LarkPlatformError('lark_reply_target_mismatch', false);
    }
    const slices = buildSlices(message.text);
    if (slices.length > MAX_SLICE_COUNT) {
      throw new LarkPlatformError('message_too_large', false);
    }
    const sendId = (
      this.internals.randomBytes?.(16) ?? nodeRandomBytes(16)
    ).toString('hex');
    const sentIds: string[] = [];

    for (const [sliceIndex, slice] of slices.entries()) {
      const uuid = `${sendId}:${sliceIndex.toString(16).padStart(4, '0')}`;
      try {
        const messageId = await this.sendSlice(
          sessionKey.channelId,
          slice,
          uuid,
          message.replyTo?.messageId,
        );
        sentIds.push(messageId);
      } catch (error) {
        if (sentIds.length > 0) {
          throw new LarkPartialSendError(sentIds, slices.length, error);
        }
        throw error;
      }
    }

    return {
      platform: 'lark',
      channelId: sessionKey.channelId,
      messageId: sentIds.at(-1)!,
      messageIds: sentIds,
      sentAt: this.internals.now?.() ?? new Date(),
    };
  }

  async resolveSessionContainer(
    input: ResolveSessionContainerInput,
  ): Promise<ResolveSessionContainerResult | undefined> {
    const rootMessageId = input.container.rootMessageId;
    if (
      input.sessionKey.platform !== 'lark' ||
      input.container.kind !== 'thread' ||
      !rootMessageId
    ) {
      return undefined;
    }
    if (
      !this.client ||
      (this.state !== 'running' && this.state !== 'reconnecting')
    ) {
      throw new LarkPlatformError('lark_not_running', false);
    }
    try {
      const response = await this.client.getMessage({
        path: { message_id: rootMessageId },
      });
      const url = parseSessionContainerLink(
        response,
        rootMessageId,
        input.container.parentChannelId,
        input.sessionKey.channelId,
      );
      return url ? { url } : undefined;
    } catch (error) {
      if (error instanceof LarkPlatformError) throw error;
      throw new LarkPlatformError(
        'lark_message_query_failed',
        isRetryableSendFailure(error),
        { cause: error },
      );
    }
  }

  private async sendSlice(
    chatId: string,
    text: string,
    uuid: string,
    replyToMessageId?: string,
  ): Promise<string> {
    const client = this.client!;
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = replyToMessageId
          ? await client.replyMessage({
              path: { message_id: replyToMessageId },
              data: {
                msg_type: 'text',
                content: JSON.stringify({ text }),
                reply_in_thread: true,
                uuid,
              },
            })
          : await client.createMessage({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text }),
                uuid,
              },
            });
        return parseMessageResponse(response);
      } catch (error) {
        const classified =
          error instanceof LarkPlatformError
            ? error
            : new LarkPlatformError(
                'lark_message_send_failed',
                isRetryableSendFailure(error),
                { cause: error },
              );
        if (attempt === 1 || !classified.retryable) throw classified;
        firstError = classified;
        const retryAfterMs = readRetryAfterMs(error);
        const backoffMs =
          retryAfterMs ??
          Math.floor((this.internals.random?.() ?? Math.random()) * 1000);
        await (this.internals.sleep ?? defaultSleep)(backoffMs);
      }
    }
    throw firstError;
  }

  async edit(_ref: MessageRef, _message: OutboundMessage): Promise<void> {
    throw new LarkPlatformError('lark_unsupported_operation', false);
  }

  async delete(_ref: MessageRef): Promise<void> {
    throw new LarkPlatformError('lark_unsupported_operation', false);
  }

  async react(_ref: MessageRef, _emoji: string): Promise<void> {
    throw new LarkPlatformError('lark_unsupported_operation', false);
  }

  async setTyping(_sessionKey: SessionKey): Promise<void> {}

  async clearTyping(_sessionKey: SessionKey): Promise<void> {}
}
