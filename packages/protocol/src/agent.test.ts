/**
 * docs/dev/spec/agent-runtime.md §AgentEvent
 * ADR-0012 PR-A：protocol union 对齐 spec 全集的判别测试。
 *
 * 目标：
 * 1. 验证新增事件类型（text_delta / thinking / tool_call_started / tool_call_progress /
 *    tool_call_finished）能被构造并通过类型判别
 * 2. 验证 exhaustive switch 覆盖所有 AgentEvent.type（编译时保证，运行时通过"无 never fallthrough"验证）
 * 3. 验证 AgentCapabilitySet 包含 supportsStdinInterrupt
 */
import { describe, expect, it } from 'vitest';
import type { AgentCapabilitySet, AgentEvent } from './index.js';

// ── 类型构造辅助 ────────────────────────────────────────────────────────────
const BASE = {
  traceId: 'trace-1',
  timestamp: new Date('2026-01-01T00:00:00Z'),
  sequence: 0,
} as const;

// ── exhaustive switch 辅助 ──────────────────────────────────────────────────
/**
 * 对 AgentEvent 做 exhaustive switch，收集所有命中的 type 字符串。
 * 若 union 有漏掉的 branch，TypeScript 编译器会在 assertNever 处报错（never 不匹配）。
 */
function collectEventType(event: AgentEvent): string {
  switch (event.type) {
    case 'session_started':
      return event.type;
    case 'thinking':
      return event.type;
    case 'text_delta':
      return event.type;
    case 'text_final':
      return event.type;
    case 'tool_call_started':
      return event.type;
    case 'tool_call_progress':
      return event.type;
    case 'tool_call_finished':
      return event.type;
    case 'usage':
      return event.type;
    case 'turn_finished':
      return event.type;
    case 'error':
      return event.type;
    case 'session_stopped':
      return event.type;
    default: {
      // exhaustive check：若 union 有遗漏，此处 TypeScript 会报 "Type 'X' is not assignable to type 'never'"
      const _: never = event;
      return _;
    }
  }
}

// ── 测试 ────────────────────────────────────────────────────────────────────

describe('AgentEvent union（ADR-0012 PR-A）', () => {
  it('text_delta 事件可构造并被 collectEventType 识别', () => {
    const evt: AgentEvent = {
      ...BASE,
      type: 'text_delta',
      payload: { text: 'hello' },
    };
    expect(collectEventType(evt)).toBe('text_delta');
    if (evt.type === 'text_delta') {
      expect(evt.payload.text).toBe('hello');
    }
  });

  it('thinking 事件可构造并被 collectEventType 识别', () => {
    const evt: AgentEvent = {
      ...BASE,
      type: 'thinking',
      payload: { text: 'reasoning...' },
    };
    expect(collectEventType(evt)).toBe('thinking');
    if (evt.type === 'thinking') {
      expect(evt.payload.text).toBe('reasoning...');
    }
  });

  it('tool_call_started 事件可构造并被 collectEventType 识别', () => {
    const evt: AgentEvent = {
      ...BASE,
      type: 'tool_call_started',
      payload: { callId: 'toolu_1', toolName: 'Read', inputSummary: '{"file_path":"/x"}' },
    };
    expect(collectEventType(evt)).toBe('tool_call_started');
    if (evt.type === 'tool_call_started') {
      expect(evt.payload.callId).toBe('toolu_1');
      expect(evt.payload.toolName).toBe('Read');
    }
  });

  it('tool_call_progress 事件可构造并被 collectEventType 识别', () => {
    const evt: AgentEvent = {
      ...BASE,
      type: 'tool_call_progress',
      payload: { callId: 'toolu_1', note: 'reading...' },
    };
    expect(collectEventType(evt)).toBe('tool_call_progress');
    if (evt.type === 'tool_call_progress') {
      expect(evt.payload.note).toBe('reading...');
    }
  });

  it('tool_call_finished 事件可构造并被 collectEventType 识别（status=ok）', () => {
    const evt: AgentEvent = {
      ...BASE,
      type: 'tool_call_finished',
      payload: { callId: 'toolu_1', toolName: 'Read', status: 'ok', resultSummary: 'file contents' },
    };
    expect(collectEventType(evt)).toBe('tool_call_finished');
    if (evt.type === 'tool_call_finished') {
      expect(evt.payload.status).toBe('ok');
      expect(evt.payload.resultSummary).toBe('file contents');
    }
  });

  it('tool_call_finished 事件可构造并被 collectEventType 识别（status=error）', () => {
    const evt: AgentEvent = {
      ...BASE,
      type: 'tool_call_finished',
      payload: { callId: 'toolu_2', toolName: 'Bash', status: 'error', resultSummary: 'command failed' },
    };
    expect(collectEventType(evt)).toBe('tool_call_finished');
    if (evt.type === 'tool_call_finished') {
      expect(evt.payload.status).toBe('error');
    }
  });

  it('既有事件类型（session_started / text_final / usage / turn_finished / error / session_stopped）仍可构造', () => {
    const events: AgentEvent[] = [
      { ...BASE, type: 'session_started', payload: { agentSessionId: 's1', workingDir: '/x' } },
      { ...BASE, type: 'text_final', payload: { text: 'done' } },
      {
        ...BASE,
        type: 'usage',
        payload: {
          model: 'claude',
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
          turnSequence: 1,
          toolCallsThisTurn: 0,
          wallClockMs: 100,
          completeness: 'partial',
        },
      },
      { ...BASE, type: 'turn_finished', payload: { reason: 'stop', turnSequence: 1 } },
      { ...BASE, type: 'error', payload: { errorKind: 'agent', message: 'oops' } },
      { ...BASE, type: 'session_stopped', payload: { reason: 'user_stop' } },
    ];

    const types = events.map(collectEventType);
    expect(types).toEqual([
      'session_started',
      'text_final',
      'usage',
      'turn_finished',
      'error',
      'session_stopped',
    ]);
  });
});

describe('AgentCapabilitySet（ADR-0012 PR-A）', () => {
  it('supportsStdinInterrupt 字段存在（false 作为默认值）', () => {
    const caps: AgentCapabilitySet = {
      supportsThinking: false,
      supportsStreaming: false,
      supportsToolCallEvents: false,
      supportsInterrupt: true,
      supportsStdinInterrupt: false,
    };
    expect(caps.supportsStdinInterrupt).toBe(false);
  });

  it('supportsStdinInterrupt 可设置为 true（stdin control 主路径设施位）', () => {
    const caps: AgentCapabilitySet = {
      supportsThinking: false,
      supportsStreaming: true,
      supportsToolCallEvents: true,
      supportsInterrupt: true,
      supportsStdinInterrupt: true,
    };
    expect(caps.supportsStdinInterrupt).toBe(true);
  });
});
