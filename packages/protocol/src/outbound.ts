import type { SessionKey } from './session-key.js';

/** docs/dev/spec/platform-adapter.md §OutboundMessage */
export interface OutboundMessage {
  text: string;
  traceId: string;
  sessionKey: SessionKey;
}

/** docs/dev/spec/platform-adapter.md §MessageRef */
export interface MessageRef {
  platform: string;
  channelId: string;
  messageId: string;
  sentAt: Date;
}

/** docs/dev/spec/platform-adapter.md §CapabilitySet */
export interface CapabilitySet {
  maxTextLength: number;
  supportsEdit: boolean;
  supportsDelete: boolean;
  supportsReactions: boolean;
  supportsEmbeds: boolean;
  supportsButtons: boolean;
  supportsThreads: boolean;
  supportsEphemeral: boolean;
  supportsAttachments: boolean;
  maxAttachmentsPerMessage: number;
  supportsTypingIndicator: boolean;
}
