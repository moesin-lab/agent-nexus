import { describe, expect, it } from 'vitest';
import type {
  AgentCapabilitySet,
  AgentEvent,
  ContentBlock,
  ToolCallStatus,
  ToolResultContent,
} from './agent.js';

const capabilities = {
  supportsThinking: true,
  supportsStreaming: true,
  supportsToolCallEvents: true,
  supportsInterrupt: true,
  supportsStdinInterrupt: true,
} satisfies AgentCapabilitySet;

const toolResultContents = [
  { kind: 'empty' },
  { kind: 'text', text: 'hello' },
  {
    kind: 'blocks',
    blocks: [{ type: 'custom_block', value: 1 } satisfies ContentBlock],
  },
  { kind: 'object', object: { ok: true } },
  { kind: 'unknown', raw: '{"unexpected":true}' },
] satisfies ToolResultContent[];

const toolStatus = ['ok', 'error', 'cancelled'] satisfies ToolCallStatus[];

const events = [
  {
    type: 'session_started',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 0,
    payload: {
      agentSessionId: 'agent-session-1',
      pid: 123,
      workingDir: '/workspace/agent-nexus',
      capabilities,
    },
  },
  {
    type: 'thinking',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 1,
    payload: { text: 'thinking' },
  },
  {
    type: 'text_delta',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 2,
    payload: { text: 'partial' },
  },
  {
    type: 'text_final',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 3,
    payload: { text: 'final' },
  },
  {
    type: 'tool_call_started',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 4,
    payload: {
      callId: 'toolu-1',
      toolName: 'Read',
      inputSummary: 'Read package.json',
    },
  },
  {
    type: 'tool_call_progress',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 5,
    payload: {
      callId: 'toolu-1',
      note: 'running',
    },
  },
  {
    type: 'tool_result',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 6,
    payload: {
      callId: 'toolu-1',
      resultSequence: 0,
      content: toolResultContents[1]!,
      isError: false,
    },
  },
  {
    type: 'tool_call_finished',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 7,
    payload: {
      callId: 'toolu-1',
      toolName: 'Read',
      status: toolStatus[0]!,
    },
  },
  {
    type: 'usage',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 8,
    payload: {
      model: 'claude-sonnet',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      turnSequence: 1,
      toolCallsThisTurn: 1,
      wallClockMs: 100,
      completeness: 'partial',
    },
  },
  {
    type: 'turn_finished',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 9,
    payload: {
      reason: 'wallclock_timeout',
      turnSequence: 1,
      source: 'runtime-synthesized',
    },
  },
  {
    type: 'error',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 10,
    payload: {
      errorKind: 'runtime',
      code: 'E_RUNTIME',
      message: 'failed',
      cause: { code: 1 },
    },
  },
  {
    type: 'session_stopped',
    traceId: 'trace-1',
    timestamp: new Date(0),
    sequence: 11,
    payload: { reason: 'wallclock_timeout' },
  },
] satisfies AgentEvent[];

function eventTypeName(event: AgentEvent): AgentEvent['type'] {
  switch (event.type) {
    case 'session_started':
    case 'thinking':
    case 'text_delta':
    case 'text_final':
    case 'tool_call_started':
    case 'tool_call_progress':
    case 'tool_result':
    case 'tool_call_finished':
    case 'usage':
    case 'turn_finished':
    case 'error':
    case 'session_stopped':
      return event.type;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

describe('AgentEvent protocol contract', () => {
  it('should_construct_stream_json_event_union_when_protocol_schema_is_complete', () => {
    expect(events.map(eventTypeName)).toEqual([
      'session_started',
      'thinking',
      'text_delta',
      'text_final',
      'tool_call_started',
      'tool_call_progress',
      'tool_result',
      'tool_call_finished',
      'usage',
      'turn_finished',
      'error',
      'session_stopped',
    ]);
    expect(toolResultContents.map((content) => content.kind)).toEqual([
      'empty',
      'text',
      'blocks',
      'object',
      'unknown',
    ]);
    expect(toolStatus).toEqual(['ok', 'error', 'cancelled']);
  });
});
