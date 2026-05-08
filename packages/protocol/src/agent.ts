import type { SessionKey } from './session-key.js';

/** docs/dev/spec/agent-runtime.md §AgentInput */
export interface AgentInput {
  type: 'user_message' | 'tool_result' | 'interrupt_ack';
  text?: string;
  traceId: string;
}

/** docs/dev/spec/agent-runtime.md §TurnEndReason */
export type TurnEndReason =
  | 'stop'
  | 'max_tokens'
  | 'user_interrupt'
  | 'error'
  | 'tool_limit'
  | 'wallclock_timeout'
  | 'budget_exceeded';

/** docs/dev/spec/agent-runtime.md §UsageRecord */
export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  turnSequence: number;
  toolCallsThisTurn: number;
  wallClockMs: number;
  completeness: 'complete' | 'partial' | 'missing';
}

/**
 * docs/dev/spec/agent-runtime.md §AgentEvent
 *
 * MVP 子集：仅 session_started / text_final / turn_finished / usage / error / session_stopped。
 * thinking / text_delta / tool_call_* 留给 stream-json 升级 PR。
 */
export type AgentEvent =
  | {
      type: 'session_started';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: {
        agentSessionId?: string;
        workingDir?: string;
      };
    }
  | {
      type: 'text_final';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: { text: string };
    }
  | {
      type: 'usage';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: UsageRecord;
    }
  | {
      type: 'turn_finished';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: { reason: TurnEndReason; turnSequence: number };
    }
  | {
      type: 'error';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: {
        errorKind: string;
        code?: string;
        message: string;
        cause?: unknown;
      };
    }
  | {
      type: 'session_stopped';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: {
        reason:
          | 'idle_timeout'
          | 'user_stop'
          | 'error'
          | 'budget_exceeded'
          | 'turn_limit'
          | 'wallclock_timeout';
      };
    };

/** docs/dev/spec/agent-runtime.md §SessionConfig（MVP 子集） */
export interface SessionConfig {
  sessionId: string;
  workingDir: string;
  toolWhitelist: string[];
  timeoutMs: number;
  /** 若非空 → agent 启动时透传给后端做 multi-turn 续话（如恢复某条已知 agent 会话） */
  resumeFromAgentSessionId?: string;
}

export type AgentSessionState =
  | 'Spawning'
  | 'Ready'
  | 'Busy'
  | 'Idle'
  | 'Errored'
  | 'Stopped';

/** docs/dev/spec/agent-runtime.md §AgentSession */
export interface AgentSession {
  key: SessionKey;
  backend: string;
  state: AgentSessionState;
  startedAt: Date;
  pid?: number;
  /** 后端会话 ID（由 agent runtime 在 session_started 时回传），用于 multi-turn 续话 */
  agentSessionId?: string;
}
