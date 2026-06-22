import type { CommandPayload } from './command.js';
import type { MessageRef } from './outbound.js';
import type { PlatformSessionKey } from './session-key.js';

/** docs/dev/spec/message-protocol.md §EventType */
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

export interface InteractionPayload {
  componentId: string;
  kind: 'button' | 'select' | 'modal_submit';
  values: string[];
}

export interface ReactionPayload {
  emoji: string;
  action: 'add' | 'remove';
  targetMessageId: string;
}

interface NormalizedEventBase {
  eventId: string;
  platform: string;
  sessionKey: PlatformSessionKey;
  messageId?: string;
  traceId: string;

  replyTo?: MessageRef;

  rawPayload: unknown;
  rawContentType: string;

  receivedAt: Date;
  platformTimestamp?: Date;
  guildId?: string;
  initiatorRoleIds?: string[];
  threadParentChannelId?: string;

  initiator: Initiator;
}

type MessageContent =
  | {
      text: string;
      attachments?: Attachment[];
    }
  | {
      text?: never;
      attachments: Attachment[];
    };

export type NormalizedEvent =
  | (NormalizedEventBase &
      MessageContent & {
        type: 'message';
        command?: never;
        interaction?: never;
        reaction?: never;
      })
  | (NormalizedEventBase & {
      type: 'command';
      text?: never;
      attachments?: never;
      command: CommandPayload;
      interaction?: never;
      reaction?: never;
    })
  | (NormalizedEventBase & {
      type: 'interaction';
      text?: never;
      attachments?: never;
      command?: never;
      interaction: InteractionPayload;
      reaction?: never;
    })
  | (NormalizedEventBase & {
      type: 'reaction';
      text?: never;
      attachments?: never;
      command?: never;
      interaction?: never;
      reaction: ReactionPayload;
    })
  | (NormalizedEventBase & {
      type: 'typing_start';
      text?: never;
      attachments?: never;
      command?: never;
      interaction?: never;
      reaction?: never;
    })
  | (NormalizedEventBase & {
      type: 'control';
      text?: never;
      attachments?: never;
      command?: never;
      interaction?: never;
      reaction?: never;
    });
