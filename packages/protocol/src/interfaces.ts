import type {
  AgentEvent,
  AgentInput,
  AgentSession,
  SessionConfig,
} from './agent.js';
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
}

/** 能力声明；完整版见 docs/dev/spec/agent-runtime.md */
export interface AgentCapabilitySet {
  supportsThinking: boolean;
  supportsStreaming: boolean;
  supportsToolCallEvents: boolean;
  supportsInterrupt: boolean;
  /**
   * stdin `control/interrupt` 路径是否启用。
   * false（默认）→ interrupt() 走 SIGINT；true → 走 stdin control 消息，SIGINT 退化为 fallback。
   * ADR-0012 决策点 2 / Option 2A：暂保持 SIGINT 主路径；反转走独立 ADR。
   */
  supportsStdinInterrupt: boolean;
}

/** docs/dev/spec/agent-runtime.md §AgentRuntime */
export interface AgentRuntime {
  name(): string;
  capabilities(): AgentCapabilitySet;

  startSession(key: SessionKey, config: SessionConfig): AgentSession;
  stopSession(session: AgentSession): void;
  isAlive(session: AgentSession): boolean;

  sendInput(session: AgentSession, input: AgentInput): Promise<void>;

  onEvent(session: AgentSession, handler: AgentEventHandler): void;

  interrupt(session: AgentSession): void;
}
