import { describe, expect, it } from 'vitest';
import {
  safeJson,
  summarizeUsageRecord,
  titleFromMetadataJson,
} from './trajectory-utils.js';

describe('trajectory-utils', () => {
  it('formats usage summaries consistently for trajectory producers', () => {
    expect(
      summarizeUsageRecord({
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        costUsd: null,
        turnSequence: 1,
        toolCallsThisTurn: 0,
        wallClockMs: 1000,
        completeness: 'partial',
      }),
    ).toBe('gpt-5, input 10, output 5, cost unknown');
    expect(
      summarizeUsageRecord({
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        costUsd: 0.1234567,
        turnSequence: 1,
        toolCallsThisTurn: 0,
        wallClockMs: 1000,
        completeness: 'complete',
      }),
    ).toBe('gpt-5, input 10, output 5, cost $0.123457');
  });

  it('serializes unsafe metadata without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(safeJson(circular)).toBe('{"serialization":"failed"}');
  });

  it('extracts title metadata without exposing parser exceptions', () => {
    expect(titleFromMetadataJson('{"title":"Imported Session"}')).toBe(
      'Imported Session',
    );
    expect(titleFromMetadataJson('{"title":""}')).toBeUndefined();
    expect(titleFromMetadataJson('{not json')).toBeUndefined();
  });
});
