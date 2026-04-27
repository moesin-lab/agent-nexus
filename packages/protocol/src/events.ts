import type { SessionKey } from './session-key.js';

/** docs/dev/spec/message-protocol.md §EventType。MVP 仅实现 message。 */
export type EventType =
  | 'message'
  | 'command'
  | 'interaction'
  | 'reaction'
  | 'typing_start'
  | 'control';

export interface Initiator {
  userId: string;
  displayName: string;
  isBot: boolean;
}

/** 占位类型；MVP 不处理附件 */
export interface Attachment {
  url: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  platformId?: string;
}

/**
 * 平台入站事件的归一化形态。Adapter 构造，daemon 消费。
 * 字段对齐 docs/dev/spec/message-protocol.md §NormalizedEvent。
 */
export interface NormalizedEvent {
  eventId: string;
  platform: string;
  sessionKey: SessionKey;
  messageId?: string;
  traceId: string;

  type: EventType;

  text?: string;
  attachments?: Attachment[];

  rawPayload: unknown;
  rawContentType: string;

  receivedAt: Date;
  platformTimestamp?: Date;

  initiator: Initiator;
}
