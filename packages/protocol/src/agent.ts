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
  /**
   * `costUsd` 是否可信用于 $-based 决策（非"字段全填了没"）。
   * 归一化前提：`costUsd` 已被 backend 适配层折叠为有限非负数或 null。
   * `complete`：`costUsd > 0` 有限正数 → 可参与 $ 预算 / metrics。
   * `partial`：`costUsd === null || costUsd === 0`（订阅 / Max plan、字段缺失、
   *           backend 原始非法值被折叠）→ 不应用于 $ 累加。
   * `missing`：协议保留位，MVP backend producer 不产生；仅留给未来 daemon-side
   *           audit record（"usage 事件本身没产生"）。
   * 消费方硬契约：`$` 累加 / 美元 metrics 唯一条件是
   * `completeness === 'complete' && costUsd > 0`；不得用 `costUsd != null` 推断可计费。
   * 完整定义见 `docs/dev/spec/infra/cost-and-limits.md` §UsageRecord.completeness 语义、ADR-0013。
   */
  completeness: 'complete' | 'partial' | 'missing';
}

/**
 * docs/dev/spec/agent-runtime.md §AgentEvent
 *
 * Protocol union 已对齐 spec 全集（ADR-0012 决策点 1 / Option 1A）。
 * Runtime 本期 PR-B 只实际 emit text_delta / tool_call_started / tool_call_finished；
 * thinking / tool_call_progress 在 protocol 上声明但当前无 runtime 来源——
 * 见 docs/dev/spec/agent-runtime.md §"声明位 vs 实际产出"。
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
      /** 内部推理片段（可选；声明位——当前无 runtime 来源，CC thinking content part 预留） */
      type: 'thinking';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: { text: string };
    }
  | {
      /** 文本增量（流式输出，token-by-token）；拼合等于随后的 text_final.text */
      type: 'text_delta';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: { text: string };
    }
  | {
      type: 'text_final';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: { text: string };
    }
  | {
      /** 工具调用开始；必有对应 tool_call_finished（顺序保证见 spec §顺序保证） */
      type: 'tool_call_started';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: {
        callId: string;
        toolName: string;
        inputSummary: string;
      };
    }
  | {
      /** 工具调用中间进度（可选；声明位——当前无 runtime 来源） */
      type: 'tool_call_progress';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: {
        callId: string;
        note: string;
      };
    }
  | {
      /**
       * 工具调用完成。
       * resultSummary 含义：ADR-0012 决策点 1-tr-A——CC user/tool_result 合入此字段。
       * 前提：CC 对每个 tool_use_id 恰好回一条终态 tool_result（fixture 验证义务见 PR-B）。
       */
      type: 'tool_call_finished';
      traceId: string;
      timestamp: Date;
      sequence: number;
      payload: {
        callId: string;
        toolName: string;
        status: 'ok' | 'error';
        resultSummary: string;
      };
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
