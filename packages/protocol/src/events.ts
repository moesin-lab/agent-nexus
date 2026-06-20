import type { PlatformSessionKey } from './session-key.js';
import type { CommandPayload } from './command.js';

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

export interface ComponentInteractionPayload {
  customId: string;
  componentType: 'button' | 'string-select' | 'modal-submit';
  values: string[];
  fields?: Record<string, string>;
}

/**
 * 平台入站事件的归一化形态。Adapter 构造，daemon 消费。
 * 字段对齐 docs/dev/spec/message-protocol.md §NormalizedEvent。
 */
export interface NormalizedEvent {
  eventId: string;
  platform: string;
  sessionKey: PlatformSessionKey;
  messageId?: string;
  traceId: string;

  type: EventType;

  text?: string;
  command?: CommandPayload;
  interaction?: ComponentInteractionPayload;
  attachments?: Attachment[];

  rawPayload: unknown;
  rawContentType: string;

  receivedAt: Date;
  platformTimestamp?: Date;
  guildId?: string;
  initiatorRoleIds?: string[];
  threadParentChannelId?: string;

  initiator: Initiator;
}
