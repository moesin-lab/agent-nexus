import { execa } from 'execa';
import type { Logger } from '@agent-nexus/daemon';

/**
 * spawn / probe 失败时抛出。daemon 可据此识别 CC CLI 兼容性问题。
 * 参考 docs/dev/spec/agent-backends/claude-code-cli.md §兼容性探针。
 */
/**
 * 判定一个候选值是否构成有效的 assistant 文本。仅接受：
 * - 非空 string
 * - content blocks 数组：含至少一个 `{ type: 'text' | 'text_delta', text: <非空 string> }`
 *
 * 不再接受"任意非空 object"——旧实现这一分支让任何 envelope-shaped object 假通过，
 * stop_reason 对、文本字段缺失时探针失去检测能力。raw object 必须命中 candidates
 * 列表的具体路径才进来（result.text / result / message.content / text）。
 */
function isAssistantText(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) {
    return value.some((item) => {
      if (!item || typeof item !== 'object') return false;
      const it = item as { type?: unknown; text?: unknown };
      return (
        (it.type === 'text' || it.type === 'text_delta') &&
        typeof it.text === 'string' &&
        it.text.length > 0
      );
    });
  }
  return false;
}

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
    const rawParsed = JSON.parse((stdout ?? '').toString());

    // CC CLI 2.1.x 在 --output-format json 下输出整段事件**数组**（流式事件全量），
    // 终止信号在末尾 `{type:"result", subtype:"success", stop_reason, result}` 事件里；
    // 旧版本可能直接返回单个 envelope object。两种形态都要兼容。
    let parsed: Record<string, unknown> | null = null;
    if (Array.isArray(rawParsed)) {
      const resultEvent = [...rawParsed]
        .reverse()
        .find(
          (e) =>
            e &&
            typeof e === 'object' &&
            (e as { type?: unknown }).type === 'result',
        ) as Record<string, unknown> | undefined;
      if (!resultEvent) {
        throw new Error('no result event in probe response array');
      }
      parsed = resultEvent;
    } else if (rawParsed && typeof rawParsed === 'object') {
      parsed = rawParsed as Record<string, unknown>;
    } else {
      throw new Error('probe response is not an object or array');
    }

    // stop_reason 在不同形态下位置不同：
    //  - object envelope（旧）：parsed.result.stop_reason
    //  - array result event（2.1.x）：parsed.stop_reason（顶层）
    const parsedResult = parsed['result'];
    const stopReason: unknown =
      (parsedResult && typeof parsedResult === 'object'
        ? (parsedResult as { stop_reason?: unknown }).stop_reason
        : undefined) ?? parsed['stop_reason'];
    if (stopReason !== 'end_turn') {
      throw new Error(
        `unexpected stop_reason: ${JSON.stringify(stopReason)}`,
      );
    }

    // assistant 文本宽松校验：跨版本字段位置不固定，但必须最终拿到非空 string。
    // 注意：旧实现允许"任意非空 object 即过"，会让 stop_reason 对、文本字段缺失的响应假通过——
    // 探针对 parser/format mismatch 失去检测能力。新实现强制递归找 string，找不到就 fail。
    //
    // candidate 路径覆盖已知 CC CLI envelope 变体：
    //   - parsed.result.text    : envelope-object 变体 + 显式 text 字段
    //   - parsed.result         : "result 直接就是 assistant 文本 string" 的旧变体（envelope-object 形态下 isAssistantText 自然 false，不会命中）
    //   - parsed.message.content: 顶层 message.content 形态（string 或 content blocks 数组）
    //   - parsed.text           : 顶层 text 字段
    const message = parsed['message'];
    const candidates: unknown[] = [
      parsedResult && typeof parsedResult === 'object'
        ? (parsedResult as { text?: unknown }).text
        : undefined,
      parsedResult,
      message && typeof message === 'object'
        ? (message as { content?: unknown }).content
        : undefined,
      parsed['text'],
    ];
    const hasText = candidates.some((c) => isAssistantText(c));
    if (!hasText) {
      throw new Error('assistant text empty in probe response');
    }
  } catch (err) {
    throw new AgentSpawnFailedError(
      `cc cli --print probe failed: ${(err as Error).message}`,
      err,
    );
  }
}
