import { execa } from 'execa';
import type { Logger } from '@agent-nexus/daemon';

/**
 * spawn / probe 失败时抛出。daemon 可据此识别 CC CLI 兼容性问题。
 * 参考 docs/dev/spec/agent-backends/claude-code-cli.md §兼容性探针。
 */
export class AgentSpawnFailedError extends Error {
  override readonly name = 'AgentSpawnFailedError';
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

export interface CompatibilityProbeOptions {
  claudeBin: string;
  logger: Logger;
}

/**
 * MVP 探针：
 *   step 1 — `claude --version` 拿版本号
 *   step 2 — `claude --print 'ping' --output-format json` 看能否正常 end_turn
 *   step 3（spec 标记 optional）— 不做
 *
 * 任一步失败 → 抛 AgentSpawnFailedError。
 */
export async function runCompatibilityProbe(
  opts: CompatibilityProbeOptions,
): Promise<void> {
  const { claudeBin, logger } = opts;

  // step 1: --version
  let version: string;
  try {
    const { stdout } = await execa(claudeBin, ['--version']);
    version = (stdout ?? '').toString().trim();
    if (!version) {
      throw new Error('empty stdout from --version');
    }
  } catch (err) {
    throw new AgentSpawnFailedError(
      `cc cli --version probe failed: ${(err as Error).message}`,
      err,
    );
  }
  logger.info({ version }, 'cc_cli_version');

  // step 2: --print ping
  try {
    const { stdout } = await execa(
      claudeBin,
      ['--print', 'ping', '--output-format', 'json'],
      { timeout: 30_000 },
    );
    const parsed = JSON.parse((stdout ?? '').toString());

    // stop_reason 在不同版本可能位于 result.stop_reason 或顶层 stop_reason
    const stopReason: unknown =
      parsed?.result?.stop_reason ?? parsed?.stop_reason;
    if (stopReason !== 'end_turn') {
      throw new Error(
        `unexpected stop_reason: ${JSON.stringify(stopReason)}`,
      );
    }

    // assistant 文本宽松校验：尝试若干路径
    const text: unknown =
      parsed?.result?.text ??
      parsed?.result ??
      parsed?.message?.content ??
      parsed?.text;
    const textOk =
      (typeof text === 'string' && text.length > 0) ||
      (Array.isArray(text) && text.length > 0) ||
      (typeof text === 'object' && text !== null);
    if (!textOk) {
      throw new Error('assistant text empty in probe response');
    }
  } catch (err) {
    throw new AgentSpawnFailedError(
      `cc cli --print probe failed: ${(err as Error).message}`,
      err,
    );
  }
}
