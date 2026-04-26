import type { TurnEndReason } from '@agent-nexus/protocol';

/**
 * 把 CC CLI `result.stop_reason` 字段映射为 protocol 的 `TurnEndReason`。
 * 参考 docs/dev/spec/agent-backends/claude-code-cli.md §stop_reason 映射。
 */
export function stopReasonToEnum(reason: string | undefined): TurnEndReason {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'max_tokens';
    case 'interrupted':
      return 'user_interrupt';
    default:
      return 'error';
  }
}
