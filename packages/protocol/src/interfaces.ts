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
import type { CapabilitySet, MessageRef, OutboundMessage } from './outbound.js';
import type { SessionKey } from './session-key.js';

export type EventHandler = (event: NormalizedEvent) => void | Promise<void>;
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
