import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
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

interface StreamJsonChild {
  stdin?: NodeJS.WritableStream | null;
  stdout?: NodeJS.ReadableStream | null;
  kill?: (signal?: NodeJS.Signals) => boolean;
}

interface PermissionScenario {
  behavior: 'allow' | 'deny';
  sentinelPath: string;
}

/**
 * MVP 探针：
 *   step 1 — `claude --version` 拿版本号
 *   step 2 — `claude --print 'ping' --output-format json` 看能否正常 end_turn
 *   step 3 — 不带 `--print` 的长驻 stream-json two-turn probe
 *   step 4 — stdio permission control deny / allow probe
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

  try {
    await runPersistentStreamJsonProbe(claudeBin);
  } catch (err) {
    throw new AgentSpawnFailedError(
      `cc cli stream-json probe failed: ${(err as Error).message}`,
      err,
    );
  }

  try {
    await runPermissionControlProbe(claudeBin);
  } catch (err) {
    throw new AgentSpawnFailedError(
      `cc cli permission control probe failed: ${(err as Error).message}`,
      err,
    );
  }
}

function streamJsonArgs(allowedTools: string[]): string[] {
  return [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--permission-prompt-tool',
    'stdio',
    '--replay-user-messages',
    '--verbose',
    '--allowed-tools',
    allowedTools.join(','),
  ];
}

function spawnStreamJsonProbe(
  claudeBin: string,
  allowedTools: string[],
  cwd?: string,
): StreamJsonChild {
  const child = execa(claudeBin, streamJsonArgs(allowedTools), {
    buffer: false,
    cwd,
    timeout: 30_000,
  }) as unknown as StreamJsonChild & Promise<unknown>;
  void Promise.resolve(child).catch(() => {});
  if (!child.stdin || !child.stdout) {
    child.kill?.('SIGTERM');
    throw new Error('stream-json probe did not expose stdin/stdout pipes');
  }
  return child;
}

function writeUser(child: StreamJsonChild, text: string): void {
  writeJsonLine(child, {
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
  });
}

function writeJsonLine(child: StreamJsonChild, value: unknown): void {
  if (!child.stdin) {
    throw new Error('stream-json probe stdin is unavailable');
  }
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

async function runPersistentStreamJsonProbe(claudeBin: string): Promise<void> {
  const child = spawnStreamJsonProbe(claudeBin, ['Read']);
  let resultCount = 0;
  let sawAssistant = false;
  let sawInit = false;

  try {
    await waitForStreamJson(child, {
      onEvent(event, done) {
        if (event['type'] === 'system' && event['subtype'] === 'init') {
          sawInit = true;
        } else if (event['type'] === 'assistant') {
          sawAssistant = true;
        } else if (event['type'] === 'result') {
          resultCount += 1;
          if (resultCount === 1) {
            writeUser(child, 'ping again');
          } else if (resultCount === 2) {
            done();
          }
        }
      },
      start() {
        writeUser(child, 'ping');
      },
    });
    if (!sawInit) {
      throw new Error('stream-json probe did not observe system/init');
    }
    if (!sawAssistant) {
      throw new Error('stream-json probe did not observe assistant output');
    }
  } finally {
    cleanupChild(child);
  }
}

async function runPermissionControlProbe(claudeBin: string): Promise<void> {
  const testDir = await mkdtemp(
    path.join(tmpdir(), 'agent-nexus-cc-permission-probe-'),
  );
  const denySentinel = path.join(testDir, 'deny-sentinel.txt');
  const allowSentinel = path.join(testDir, 'allow-sentinel.txt');

  try {
    await runPermissionScenario(claudeBin, testDir, {
      behavior: 'deny',
      sentinelPath: denySentinel,
    });
    if (await pathExists(denySentinel)) {
      throw new Error('deny scenario created sentinel file');
    }

    await runPermissionScenario(claudeBin, testDir, {
      behavior: 'allow',
      sentinelPath: allowSentinel,
    });
    if (!(await pathExists(allowSentinel))) {
      throw new Error('allow scenario did not create sentinel file');
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

async function runPermissionScenario(
  claudeBin: string,
  cwd: string,
  scenario: PermissionScenario,
): Promise<void> {
  const child = spawnStreamJsonProbe(claudeBin, ['Read'], cwd);
  let sawCanUseTool = false;
  const command = `printf ok > ${JSON.stringify(scenario.sentinelPath)}`;
  const prompt = `Use Bash to run exactly this command and no other command:\n${command}`;

  try {
    await waitForStreamJson(child, {
      onEvent(event, done) {
        const request = event['request'] as Record<string, unknown> | undefined;
        if (
          event['type'] === 'control_request' &&
          request?.['subtype'] === 'can_use_tool'
        ) {
          sawCanUseTool = true;
          const requestId = event['request_id'];
          if (typeof requestId !== 'string') {
            throw new Error('can_use_tool request missing request_id');
          }
          const response =
            scenario.behavior === 'allow'
              ? {
                  behavior: 'allow',
                  updatedInput: request['input'],
                }
              : {
                  behavior: 'deny',
                  message: 'agent-nexus compatibility probe deny',
                };
          writeJsonLine(child, {
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: requestId,
              response,
            },
          });
        } else if (event['type'] === 'result') {
          done();
        }
      },
      start() {
        writeUser(child, prompt);
      },
    });
    if (!sawCanUseTool) {
      throw new Error('permission probe did not observe can_use_tool');
    }
  } finally {
    cleanupChild(child);
  }
}

async function waitForStreamJson(
  child: StreamJsonChild,
  handlers: {
    start: () => void;
    onEvent: (event: Record<string, unknown>, done: () => void) => void;
  },
): Promise<void> {
  if (!child.stdout) {
    throw new Error('stream-json probe stdout is unavailable');
  }
  const rl = createInterface({ input: child.stdout });
  let settled = false;
  let sawLine = false;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error('stream-json probe timed out'));
    }, 30_000);

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rl.close();
      if (err) reject(err);
      else resolve();
    };

    rl.on('line', (line) => {
      sawLine = true;
      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return;
        }
        event = parsed as Record<string, unknown>;
      } catch {
        return;
      }

      try {
        handlers.onEvent(event, () => finish());
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    rl.on('error', (err) => finish(err));
    rl.on('close', () => {
      if (!settled) {
        finish(
          new Error(
            sawLine
              ? 'stream-json probe closed before completion'
              : 'stream-json probe produced no stdout',
          ),
        );
      }
    });

    try {
      handlers.start();
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function cleanupChild(child: StreamJsonChild): void {
  child.stdin?.end();
  child.kill?.('SIGTERM');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
