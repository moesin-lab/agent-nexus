import { describe, expect, it } from 'vitest';
import {
  costUsdToCompleteness,
  isValidCcUsage,
  normalizeTotalCostUsd,
} from './usage-normalize.js';

describe('normalizeTotalCostUsd', () => {
  // 直接喂 raw value，绕过 JSON.stringify(NaN/Infinity) === "null" 的丢失。
  it.each<[unknown, number | null]>([
    // 合法值原样返回
    [0.01, 0.01],
    [1.5, 1.5],
    [0, 0],
    // -0 在 JS 里 `-0 === 0` 为 true、`<0` 为 false，符合 normalizer 落到 0 分支
    [-0, -0],
    // null / undefined / 缺失 → null
    [undefined, null],
    [null, null],
    // 非数字 → null
    ['0.01', null],
    [{}, null],
    [[], null],
    [true, null],
    // 非有限 → null
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [Number.NEGATIVE_INFINITY, null],
    // 负数 → null（backend 异常）
    [-1, null],
    [-0.5, null],
  ])('raw=%p → %p', (raw, expected) => {
    expect(normalizeTotalCostUsd(raw)).toBe(expected);
  });
});

describe('costUsdToCompleteness', () => {
  it.each<[number | null, 'complete' | 'partial']>([
    // 归一化后只可能是 finite >= 0 或 null
    [0.01, 'complete'],
    [1.5, 'complete'],
    [Number.MIN_VALUE, 'complete'], // 任何 > 0 的有限数
    [0, 'partial'],
    [-0, 'partial'], // 注意 -0 > 0 为 false
    [null, 'partial'],
  ])('costUsd=%p → %s', (cost, expected) => {
    expect(costUsdToCompleteness(cost)).toBe(expected);
  });

  it('MVP backend producer 不产生 missing', () => {
    // 函数返回类型只允许 complete | partial；这条测试断言类型约束本身
    const result: 'complete' | 'partial' = costUsdToCompleteness(0);
    expect(result).not.toBe('missing');
  });
});

describe('isValidCcUsage', () => {
  // 拒绝条件：防止合成 0 token 的"假 usage"掩盖 backend 异常
  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['array', []],
    ['number', 42],
    ['string', 'usage'],
    ['empty object', {}],
    ['missing output_tokens', { input_tokens: 1 }],
    ['missing input_tokens', { output_tokens: 1 }],
    ['string input_tokens', { input_tokens: '1', output_tokens: 2 }],
    ['negative input_tokens', { input_tokens: -1, output_tokens: 2 }],
    ['NaN input_tokens', { input_tokens: Number.NaN, output_tokens: 2 }],
    ['Infinity output_tokens', { input_tokens: 1, output_tokens: Number.POSITIVE_INFINITY }],
    ['invalid cache_read', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 'x' }],
    ['negative cache_creation', { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: -1 }],
  ])('rejects %s', (_label, raw) => {
    expect(isValidCcUsage(raw)).toBe(false);
  });

  it.each<[string, unknown]>([
    ['minimum valid', { input_tokens: 0, output_tokens: 0 }],
    ['typical', { input_tokens: 100, output_tokens: 50 }],
    ['with cache fields', {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    }],
    ['extra unknown field ok', { input_tokens: 1, output_tokens: 2, future_field: 'x' }],
  ])('accepts %s', (_label, raw) => {
    expect(isValidCcUsage(raw)).toBe(true);
  });
});
