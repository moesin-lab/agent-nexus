/**
 * UsageRecord.costUsd / completeness 归一化纯函数。
 *
 * 语义 SSOT：docs/dev/spec/infra/cost-and-limits.md §UsageRecord.completeness 语义。
 *
 * 拆分原因：JSON 不能 round-trip NaN / Infinity（ECMA-262 24.5.2 二者序列化为 null），
 * 所以"backend 返回 NaN / Infinity"的归一化分支无法用 stream-json 集成测试断言；
 * 抽成纯函数后可单元化覆盖所有异常输入。
 */

/**
 * 把 backend 原始 `total_cost_usd` 字段归一化为 UsageRecord.costUsd。
 *
 * 规则：只接受有限非负数；其他（undefined / 非数字 / NaN / Infinity / 负数 / 字符串）一律 → null。
 */
export function normalizeTotalCostUsd(raw: unknown): number | null {
  if (typeof raw !== 'number') return null;
  if (!Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  return raw;
}

/**
 * 把归一化后的 costUsd 映射到 UsageRecord.completeness。
 *
 * 前提：raw 已经过 normalizeTotalCostUsd（即 finite >= 0 或 null）。
 * 规则：> 0 → complete；其他（null / 0）→ partial。
 * `missing` 由本函数不产生（见 spec：MVP backend producer 不产生 missing）。
 */
export function costUsdToCompleteness(
  costUsd: number | null,
): 'complete' | 'partial' {
  return costUsd !== null && costUsd > 0 ? 'complete' : 'partial';
}

/**
 * CC stream-json result.usage 形态。
 * cache_* 字段允许缺失（CC 旧版本可能不报，默认 0）；input/output 必须存在。
 */
export interface CcUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function isFiniteNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * 校验 backend `result.usage` 是否为有效 usage payload。
 *
 * 拒绝条件（防止合成 0 token 的"假 usage"掩盖 backend 异常）：
 * - 非 plain object（null / 数组 / 原始值）
 * - 缺 input_tokens 或 output_tokens
 * - input_tokens / output_tokens 不是 finite >= 0 number
 * - cache_* 字段存在但非 finite >= 0 number
 */
export function isValidCcUsage(raw: unknown): raw is CcUsage {
  if (raw === null || typeof raw !== 'object') return false;
  if (Array.isArray(raw)) return false;
  const u = raw as Record<string, unknown>;
  if (!isFiniteNonNegativeInt(u['input_tokens'])) return false;
  if (!isFiniteNonNegativeInt(u['output_tokens'])) return false;
  if (
    u['cache_read_input_tokens'] !== undefined &&
    !isFiniteNonNegativeInt(u['cache_read_input_tokens'])
  )
    return false;
  if (
    u['cache_creation_input_tokens'] !== undefined &&
    !isFiniteNonNegativeInt(u['cache_creation_input_tokens'])
  )
    return false;
  return true;
}
