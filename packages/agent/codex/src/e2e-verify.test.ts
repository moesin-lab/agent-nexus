import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agent-nexus/protocol';
import {
  VerifyError,
  assertErrorTurn,
  assertInterruptTurn,
  assertTwoTurnResume,
  isCodexAuthPrecondition,
} from './e2e-verify.js';

function event(
  type: AgentEvent['type'],
  traceId: string,
  payload: AgentEvent['payload'],
  sequence = 0,
): AgentEvent {
  return {
    type,
    traceId,
    timestamp: new Date('2026-05-23T00:00:00.000Z'),
    sequence,
    payload,
  } as AgentEvent;
}

describe('codex e2e verify helpers', () => {
  it('验证两轮文本输出和同一个 Codex thread 续接', () => {
    const first = [
      event('session_started', 't1', {
        agentSessionId: 'thread-1',
        workingDir: '/tmp/w',
        capabilities: {
          supportsThinking: false,
          supportsStreaming: false,
          supportsToolCallEvents: true,
          supportsInterrupt: true,
          supportsStdinInterrupt: false,
        },
      }),
      event('text_final', 't1', { text: 'CODEX_E2E_TURN1_OK' }),
      event('usage', 't1', {
        model: 'gpt-5-codex',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: null,
        turnSequence: 1,
        toolCallsThisTurn: 0,
        wallClockMs: 1,
        completeness: 'partial',
      }),
      event('turn_finished', 't1', { reason: 'stop', turnSequence: 1 }),
    ];
    const second = [
      event('text_final', 't2', { text: 'CODEX_E2E_NONCE_123' }),
      event('turn_finished', 't2', { reason: 'stop', turnSequence: 2 }),
    ];

    const result = assertTwoTurnResume(first, second, 'CODEX_E2E_NONCE_123');

    expect(result.agentSessionId).toBe('thread-1');
  });

  it('缺少第二轮 nonce 时拒绝把续接验证判绿', () => {
    const first = [
      event('session_started', 't1', {
        agentSessionId: 'thread-1',
        workingDir: '/tmp/w',
        capabilities: {
          supportsThinking: false,
          supportsStreaming: false,
          supportsToolCallEvents: true,
          supportsInterrupt: true,
          supportsStdinInterrupt: false,
        },
      }),
      event('text_final', 't1', { text: 'CODEX_E2E_TURN1_OK' }),
      event('turn_finished', 't1', { reason: 'stop', turnSequence: 1 }),
    ];
    const second = [
      event('text_final', 't2', { text: 'wrong' }),
      event('turn_finished', 't2', { reason: 'stop', turnSequence: 2 }),
    ];

    expect(() => assertTwoTurnResume(first, second, 'CODEX_E2E_NONCE_123'))
      .toThrow(VerifyError);
  });

  it('验证错误路径必须同时有 error 和 error turn_finished', () => {
    const events = [
      event('error', 'err', {
        errorKind: 'agent',
        code: 'codex_turn_failed',
        message: 'invalid model',
      }),
      event('turn_finished', 'err', { reason: 'error', turnSequence: 1 }),
    ];

    expect(() => assertErrorTurn(events)).not.toThrow();
    expect(() =>
      assertErrorTurn([
        event('error', 'err', {
          errorKind: 'agent',
          code: 'codex_turn_failed',
          message: 'invalid model',
        }),
      ]),
    ).toThrow(VerifyError);
  });

  it('验证中断路径必须是 user_interrupt 且不能出现 ok tool completion', () => {
    const events = [
      event('tool_call_started', 'int', {
        callId: 'item_0',
        toolName: 'command_execution',
        inputSummary: 'sleep 30',
      }),
      event('turn_finished', 'int', {
        reason: 'user_interrupt',
        turnSequence: 1,
        source: 'runtime-synthesized',
      }),
    ];

    expect(() => assertInterruptTurn(events)).not.toThrow();
    expect(() =>
      assertInterruptTurn([
        ...events,
        event('tool_call_finished', 'int', {
          callId: 'item_0',
          toolName: 'command_execution',
          status: 'ok',
        }),
      ]),
    ).toThrow(VerifyError);
  });

  it('识别 Codex 认证缺失为环境前置条件失败', () => {
    expect(
      isCodexAuthPrecondition(
        '401 Unauthorized: Missing bearer or basic authentication',
      ),
    ).toBe(true);
    expect(isCodexAuthPrecondition('invalid_request_error: unknown model')).toBe(
      false,
    );
    expect(isCodexAuthPrecondition('please login before continuing')).toBe(false);
  });
});
