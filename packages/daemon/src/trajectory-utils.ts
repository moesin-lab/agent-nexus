import type { UsageRecord } from '@agent-nexus/protocol';

export function summarizeUsageRecord(usage: UsageRecord): string {
  const cost =
    usage.costUsd === null ? 'cost unknown' : `cost $${usage.costUsd.toFixed(6)}`;
  return [
    usage.model,
    `input ${usage.inputTokens}`,
    `output ${usage.outputTokens}`,
    cost,
  ].join(', ');
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"serialization":"failed"}';
  }
}

export function titleFromMetadataJson(metadataJson: string): string | undefined {
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const title = (parsed as Record<string, unknown>)['title'];
    return typeof title === 'string' && title.length > 0 ? title : undefined;
  } catch {
    return undefined;
  }
}
