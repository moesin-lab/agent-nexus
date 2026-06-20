import type {
  AgentEvent,
  AgentInput,
  AgentSession,
  AgentCapabilitySet,
  SessionConfig,
} from './agent.js';
import type {
  AgentCommandEnvelope,
  AgentCommandResult,
} from './command.js';
import type { NormalizedEvent } from './events.js';
import type {
  CapabilitySet,
  MessageComponent,
  MessageRef,
  OutboundMessage,
} from './outbound.js';
import type { SessionKey } from './session-key.js';
import type {
  PlatformSettingsActionInput,
  PlatformSettingsActionResult,
  PlatformSettingsSnapshot,
  PlatformSettingsSnapshotInput,
} from './settings.js';

export interface EventCommandResponse {
  text: string;
  ephemeral?: boolean;
  components?: MessageComponent[];
}

export interface EventModalResponse {
  customId: string;
  title: string;
  textInputs: {
    customId: string;
    label: string;
    style: 'short' | 'paragraph';
    required?: boolean;
    placeholder?: string;
    value?: string;
  }[];
}

export interface EventHandlerResult {
  commandResponse?: EventCommandResponse;
  modalResponse?: EventModalResponse;
}

export interface CreateThreadInput {
  parentChannelId: string;
  initiatorUserId: string;
  title: string;
  visibility: 'private' | 'public';
  autoArchiveDurationMinutes: 60 | 1440 | 4320 | 10080;
  initialMessage?: string;
  traceId: string;
}

export interface CreateThreadResult {
  threadId: string;
  parentChannelId: string;
  url?: string;
}

export interface UpdateThreadInput {
  threadId: string;
  title?: string;
  traceId: string;
}

export type EventHandler = (
  event: NormalizedEvent,
) => void | EventHandlerResult | Promise<void | EventHandlerResult>;
export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

/** docs/dev/spec/platform-adapter.md §PlatformAdapter */
export interface PlatformAdapter {
  name(): string;
  capabilities(): CapabilitySet;

  start(handler: EventHandler): Promise<void>;
  stop(): Promise<void>;

  send(sessionKey: SessionKey, message: OutboundMessage): Promise<MessageRef>;
  edit(ref: MessageRef, message: OutboundMessage): Promise<void>;
  delete(ref: MessageRef): Promise<void>;
  react(ref: MessageRef, emoji: string): Promise<void>;
  createThread?(input: CreateThreadInput): Promise<CreateThreadResult>;
  updateThread?(input: UpdateThreadInput): Promise<void>;
  settingsSnapshot?(
    input: PlatformSettingsSnapshotInput,
  ): PlatformSettingsSnapshot | Promise<PlatformSettingsSnapshot>;
  applySettingsAction?(
    input: PlatformSettingsActionInput,
  ): PlatformSettingsActionResult | Promise<PlatformSettingsActionResult>;
  setTyping(sessionKey: SessionKey): Promise<void>;
  clearTyping(sessionKey: SessionKey): Promise<void>;
}

/** docs/dev/spec/agent-runtime.md §AgentRuntime */
export interface AgentRuntime {
  name(): string;
  capabilities(): AgentCapabilitySet;

  startSession(key: SessionKey, config: SessionConfig): AgentSession;
  stopSession(session: AgentSession): void;
  isAlive(session: AgentSession): boolean;

  sendInput(session: AgentSession, input: AgentInput): Promise<void>;
  handleCommand(
    session: AgentSession | undefined,
    command: AgentCommandEnvelope,
  ): Promise<AgentCommandResult>;

  onEvent(session: AgentSession, handler: AgentEventHandler): void;

  interrupt(session: AgentSession): void;
}
