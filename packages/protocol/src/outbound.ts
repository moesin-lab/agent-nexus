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
  /**
   * Primary message ID (last slice for multi-slice sends). Kept for single-slice compat.
   * For the full ordered list of all sent slice IDs, use `messageIds`.
   */
  messageId: string;
  /**
   * Ordered list of all sent message IDs (≥ 1 element).
   * For single-message sends this is `[messageId]`.
   * For multi-slice sends this contains every slice's ID in send order,
   * enabling callers to edit or delete the complete long reply.
   */
  messageIds: string[];
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
