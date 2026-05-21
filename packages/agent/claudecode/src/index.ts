export {
  parseClaudeCodeConfig,
  type ClaudeCodeConfig,
  ClaudeCodeConfigError,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_BIN,
} from './config.js';

import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import type {
  AgentCapabilitySet,
  AgentEvent,
  AgentEventHandler,
  AgentInput,
  AgentRuntime,
  AgentSession,
  SessionConfig,
  SessionKey,
  TurnEndReason,
  UsageRecord,
} from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';
import type { Logger } from '@agent-nexus/daemon';

export { runCompatibilityProbe, AgentSpawnFailedError } from './probe.js';

export interface ClaudeCodeRuntimeOptions {
  claudeBin: string;
  allowedTools: string[];
  defaultWorkingDir: string;
  logger: Logger;
  /**
   * runtime 级 spawn 超时（ms）兜底；当 SessionConfig.timeoutMs 缺失时才生效。
   * 默认 300_000（5 分钟），与 spec/infra/cost-and-limits.md §perInputTimeoutMs 一致。
   * 该 timer 仅作为 backend 进程寿命的 wallclock 兜底，与 daemon 视角的回合 UX 上限分开（ADR-0011）。
   */
  perInputTimeoutMs?: number;
}

/**
 * 内部 session 句柄上挂的 EventEmitter + 原始 SessionConfig。
 * 不在 protocol AgentSession 表面暴露——通过 WeakMap 隔离。
 *
 * configMap 是把 spec 合约 SessionConfig.{workingDir,toolWhitelist} 接到
 * sendInput 的 argv 构造里——runtime 级 defaultWorkingDir/allowedTools 仅作为
 * config 缺失时的兜底，不允许覆盖 per-session 值。
 */
const emitterMap = new WeakMap<AgentSession, EventEmitter>();
const configMap = new WeakMap<AgentSession, SessionConfig>();

function getEmitter(session: AgentSession): EventEmitter {
  let em = emitterMap.get(session);
  if (!em) {
    em = new EventEmitter();
    emitterMap.set(session, em);
  }
  return em;
}

/**
 * 从 execa / 通用 Error 提取**不含 argv 的安全 cause 字符串**，用于 logger.warn 字段。
 *
 * 为什么不直接用 `err.message` / `err.shortMessage`：execa 在错误对象上拼了
 * `escapedCommand`（完整命令行，含 argv），而 argv 里有 `--print <input.text>` —
 * 即用户消息正文，可能含密钥 / PII。直接落日志会泄露。
 *
 * 策略：execa-shaped error → 用结构化字段拼；普通 Error → 用 `name`；其他 → 固定字符串。
 * 故意不取 `message`，宁可信息少也不冒泄露风险。
 */
/**
 * 按 [claude-code-cli.md §UsageCompleteness](../../docs/dev/spec/agent-backends/claude-code-cli.md)
 * 的三档定义判定 UsageRecord.completeness。turn 失败由 `turn_finished.reason='error'` 表达，
 * 与本字段解耦。
 *
 * - `complete`：token 全齐 + `total_cost_usd` 为 number > 0
 * - `partial`：token 齐但 `total_cost_usd` 缺失 / null / 0（订阅路径常见）
 * - `missing`：token 也缺
 */
function deriveCompleteness(
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null,
  totalCostUsd: number | null,
): 'complete' | 'partial' | 'missing' {
  // spec: `missing` = token 缺
  if (
    !usage ||
    typeof usage.input_tokens !== 'number' ||
    typeof usage.output_tokens !== 'number'
  ) {
    return 'missing';
  }
  // spec: `complete` 要求 input/output/cache_* 全齐 + total_cost_usd 是 number > 0
  const cacheReadOk = typeof usage.cache_read_input_tokens === 'number';
  const cacheWriteOk = typeof usage.cache_creation_input_tokens === 'number';
  const costOk = totalCostUsd !== null && totalCostUsd > 0;
  if (cacheReadOk && cacheWriteOk && costOk) {
    return 'complete';
  }
  // spec: `partial` = token 齐但 cost 缺失/0 或 cache_* 缺失
  return 'partial';
}

function buildSafeCause(err: unknown): string {
  if (err === null || typeof err !== 'object') return 'subprocess failure';
  const e = err as {
    name?: unknown;
    code?: unknown;
    exitCode?: unknown;
    signal?: unknown;
    timedOut?: unknown;
    isCanceled?: unknown;
  };
  const name = typeof e.name === 'string' ? e.name : 'Error';
  // execa error 一般有 code / exitCode / signal / timedOut 之一
  const isExecaError =
    e.code !== undefined ||
    e.exitCode !== undefined ||
    e.signal !== undefined ||
    e.timedOut !== undefined;
  if (!isExecaError) return name;
  const parts: string[] = [name];
  if (typeof e.code === 'string') parts.push(`code=${e.code}`);
  if (typeof e.exitCode === 'number') parts.push(`exitCode=${e.exitCode}`);
  if (typeof e.signal === 'string') parts.push(`signal=${e.signal}`);
  if (e.timedOut === true) parts.push('timedOut=true');
  if (e.isCanceled === true) parts.push('isCanceled=true');
  return parts.join(' ');
}

export function createClaudeCodeRuntime(
  opts: ClaudeCodeRuntimeOptions,
): AgentRuntime {
  const { claudeBin, allowedTools, defaultWorkingDir, logger } = opts;
  const defaultTimeoutMs = opts.perInputTimeoutMs ?? 300_000;

  const capabilities: AgentCapabilitySet = {
    supportsThinking: false,
    supportsStreaming: false,
    supportsToolCallEvents: false,
    supportsInterrupt: false,
  };

  const runtime: AgentRuntime = {
    name(): string {
      return 'claudecode';
    },

    capabilities(): AgentCapabilitySet {
      return capabilities;
    },

    startSession(key: SessionKey, config: SessionConfig): AgentSession {
      const session: AgentSession = {
        key,
        backend: 'claudecode',
        state: 'Idle',
        startedAt: new Date(),
        agentSessionId: config.resumeFromAgentSessionId,
      };
      // 预创建 emitter，确保 onEvent 在 sendInput 之前就能挂上
      getEmitter(session);
      // 存 config 供 sendInput 取 workingDir / toolWhitelist
      configMap.set(session, config);
      return session;
    },

    isAlive(session: AgentSession): boolean {
      return session.state !== 'Stopped';
    },

    onEvent(session: AgentSession, handler: AgentEventHandler): void {
      const em = getEmitter(session);
      em.on('event', (e: AgentEvent) => {
        // handler 可能是 async；不 await，但要捕获 reject 防止 unhandled rejection
        try {
          const ret = handler(e);
          if (ret && typeof (ret as Promise<void>).then === 'function') {
            (ret as Promise<void>).catch((err) => {
              logger.error({ err }, 'agent_event_handler_rejected');
            });
          }
        } catch (err) {
          logger.error({ err }, 'agent_event_handler_threw');
        }
      });
    },

    interrupt(session: AgentSession): void {
      // MVP no-op：CC CLI --print 单次调用不支持 interrupt。
      logger.warn(
        { sessionKey: session.key },
        'claudecode_interrupt_noop_in_mvp',
      );
    },

    stopSession(session: AgentSession): void {
      session.state = 'Stopped';
    },

    async sendInput(
      session: AgentSession,
      input: AgentInput,
    ): Promise<void> {
      // TODO 升级到 stream-json 主路径（--input-format stream-json + 子进程持久化 + 流式 edit Discord）
      // → docs/dev/spec/agent-backends/claude-code-cli.md §交互式 session

      const emitter = getEmitter(session);
      let sequence = 0;
      const traceId = input.traceId;
      const turnStartedAt = Date.now();

      const emitEvent = (evt: AgentEvent): void => {
        emitter.emit('event', evt);
      };

      // per-session config 优先；runtime 级 default 仅作 config 缺失兜底（spec 要求 --cwd / --allowed-tools 必须显式）
      const sessionConfig = configMap.get(session);
      const cwd = sessionConfig?.workingDir ?? defaultWorkingDir;
      const tools = sessionConfig?.toolWhitelist ?? allowedTools;
      const timeoutMs = sessionConfig?.timeoutMs ?? defaultTimeoutMs;
      // CC CLI 2.1.x 不接受 `--cwd` flag（出现 → exit 1 "unknown option"）；
      // 工作目录改由子进程 cwd option 传入。安全语义不变（子进程不继承 daemon cwd，
      // 必须显式锁定到 SessionConfig.workingDir）。
      const args: string[] = [
        '--print',
        input.text ?? '',
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowed-tools',
        tools.join(','),
      ];
      if (session.agentSessionId) {
        args.push('--resume', session.agentSessionId);
      }

      interface CcUsage {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }

      let textBuf = '';
      let stopReason: string | undefined;
      let usage: CcUsage | null = null;
      let totalCostUsd: number | null = null;

      try {
        const subproc = execa(claudeBin, args, {
          timeout: timeoutMs,
          buffer: false,
          cwd,
        });

        if (!subproc.stdout) {
          throw new Error('subprocess stdout is null');
        }

        const rl = createInterface({
          input: subproc.stdout,
          crlfDelay: Infinity,
        });

        for await (const line of rl) {
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            logger.debug({ line }, 'cc_non_json_line');
            continue;
          }

          if (!parsed || typeof parsed !== 'object') continue;
          const e = parsed as Record<string, unknown>;

          if (e['type'] === 'system' && e['subtype'] === 'init') {
            const sid = e['session_id'];
            const cwd = e['cwd'];
            if (typeof sid === 'string') {
              // agentSessionId 写回 session：protocol 把它标了可选 string，直接赋值即可
              session.agentSessionId = sid;
            }
            emitEvent({
              type: 'session_started',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: {
                agentSessionId: typeof sid === 'string' ? sid : undefined,
                workingDir: typeof cwd === 'string' ? cwd : undefined,
              },
            });
            continue;
          }

          if (e['type'] === 'assistant') {
            const message = e['message'] as
              | { content?: unknown }
              | undefined;
            const content = message?.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                if (
                  part &&
                  typeof part === 'object' &&
                  ((part as { type?: unknown }).type === 'text' ||
                    (part as { type?: unknown }).type === 'text_delta')
                ) {
                  const t = (part as { text?: unknown }).text;
                  if (typeof t === 'string') {
                    textBuf += t;
                  }
                }
              }
            }
            continue;
          }

          if (e['type'] === 'result') {
            const sr = e['stop_reason'];
            if (typeof sr === 'string') stopReason = sr;
            const u = e['usage'];
            if (u && typeof u === 'object') {
              usage = u as CcUsage;
            }
            const cost = e['total_cost_usd'];
            // contract: `total_cost_usd` 缺失或 `0`（订阅路径常见）→ costUsd 写 null
            // （见 docs/dev/spec/agent-backends/claude-code-cli.md §UsageCompleteness 表第 2 行）
            totalCostUsd = typeof cost === 'number' && cost > 0 ? cost : null;
            continue;
          }

          // 其他事件类型（user/tool_result 等）MVP 忽略
        }

        await subproc;
      } catch (err) {
        // spawn 失败 / 子进程非零退出 / 行扫错误。
        // 日志侧的 `cause` 必须**不含 argv**——execa 的 `err.message` 和 `err.shortMessage`
        // 都会拼接 `escapedCommand`（即完整命令行包括 argv，含 `input.text` 用户消息正文 /
        // 可能含密钥 / PII，见 execa/lib/return/message.js）。改用 execa error 的结构化字段
        // （`code` / `exitCode` / `signal` / `timedOut` / `name`）拼安全 cause；普通 Error 退化为 `name`。
        // emit 的 error event payload.message 仍传 err.message 是 pre-existing 行为
        // （daemon engine 转写到 IM `[agent error: ...] <message>`）；全链路脱敏属于
        // 另一个 issue，本 PR 仅约束 PR 新引入的 logger.warn 一处不放大泄露面。
        const safeCause = buildSafeCause(err);
        const message = err instanceof Error ? err.message : String(err);
        // issue #28 选 C：textBuf 已收满但子进程非零退出时不发 partial 文本到 IM
        // （避免没有"这是断片"标识的部分内容混淆用户），仅在日志记录 textBuf 长度
        // 便于诊断"CC 完整输出后才异常退出"这一罕见路径。stream-json 主路径
        // （ADR-0012）落地后该路径会被流式 assistant 增量 emit 重新定义失败收尾语义
        // （见 ADR-0012 §Consequences）。
        // 日志字段对齐 observability spec：errorKind ∈ {user,platform,agent,internal}
        // （spec §错误日志必含，warn 级 error-like 事件同样适用），cause 与 code 是 spec 注册字段。
        // textBufLength 单位：JS string length（UTF-16 code unit），窗口为 since turn start。
        logger.warn(
          {
            sessionKey: serializeSessionKey(session.key),
            traceId,
            errorKind: 'agent',
            code: 'spawn_failed',
            textBufLength: textBuf.length,
            cause: safeCause,
          },
          'claudecode_subproc_error',
        );
        emitEvent({
          type: 'error',
          traceId,
          timestamp: new Date(),
          sequence: sequence++,
          payload: {
            errorKind: 'spawn_failed',
            message,
          },
        });
        // catch 前若 stream-json 解析循环已收到 `result.usage`（CC 完整输出后才异常退出
        // 的罕见路径），仍 emit usage 事件，避免 daemon counters / `$ 预算` 把已产生 token 成本
        // 的一回合误算成零成本。`completeness` 按 CC contract §UsageCompleteness 的字段完整度
        // 定义判定（与 happy path 一致），turn 失败由 turn_finished.reason='error' 表达；
        // 不靠 completeness 区分 "turn 失败 vs usage 数据缺失"。
        if (usage) {
          const wallClockMs = Date.now() - turnStartedAt;
          const partialUsage: UsageRecord = {
            model: 'claude-code',
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            costUsd: totalCostUsd,
            turnSequence: 1,
            toolCallsThisTurn: 0,
            wallClockMs,
            completeness: deriveCompleteness(usage, totalCostUsd),
          };
          emitEvent({
            type: 'usage',
            traceId,
            timestamp: new Date(),
            sequence: sequence++,
            payload: partialUsage,
          });
        }
        emitEvent({
          type: 'turn_finished',
          traceId,
          timestamp: new Date(),
          sequence: sequence++,
          payload: {
            reason: 'error',
            turnSequence: 1,
          },
        });
        return;
      }

      // 顺序 emit 收尾事件
      emitEvent({
        type: 'text_final',
        traceId,
        timestamp: new Date(),
        sequence: sequence++,
        payload: { text: textBuf },
      });

      const wallClockMs = Date.now() - turnStartedAt;
      const usageRecord: UsageRecord = {
        model: 'claude-code',
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
        costUsd: totalCostUsd,
        turnSequence: 1,
        toolCallsThisTurn: 0,
        wallClockMs,
        completeness: deriveCompleteness(usage, totalCostUsd),
      };
      emitEvent({
        type: 'usage',
        traceId,
        timestamp: new Date(),
        sequence: sequence++,
        payload: usageRecord,
      });

      // docs/dev/spec/agent-backends/claude-code-cli.md §stop_reason 到 turn_finished.reason 的映射
      let turnReason: TurnEndReason;
      switch (stopReason) {
        case 'end_turn':
          turnReason = 'stop';
          break;
        case 'max_tokens':
          turnReason = 'max_tokens';
          break;
        case 'interrupted':
          turnReason = 'user_interrupt';
          break;
        default:
          turnReason = 'error';
      }
      emitEvent({
        type: 'turn_finished',
        traceId,
        timestamp: new Date(),
        sequence: sequence++,
        payload: {
          reason: turnReason,
          turnSequence: 1,
        },
      });
    },
  };

  return runtime;
}
