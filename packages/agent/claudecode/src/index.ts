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
  UsageRecord,
} from '@agent-nexus/protocol';
import type { Logger } from '@agent-nexus/daemon';
import { stopReasonToEnum } from './stop-reason.js';

export { runCompatibilityProbe, AgentSpawnFailedError } from './probe.js';
export { stopReasonToEnum } from './stop-reason.js';

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
/**
 * Per-session 正在运行的子进程句柄。`sendInput` 进 try 前 set，finally 清。
 * interrupt / stopSession 通过 .kill(SIGINT|SIGTERM) 真实打断当前回合。
 * 无 in-flight turn 时 get → undefined，kill 调用是 no-op。
 */
type KillableSubproc = { kill(signal?: NodeJS.Signals | number): boolean };
const subprocMap = new WeakMap<AgentSession, KillableSubproc>();

/**
 * Per-session 本回合内主动信号请求的两类区分（互斥语义不同，必须分两个 flag）：
 * - `interruptRequested`：用户主动 interrupt（SIGINT），收尾走 `turn_finished{user_interrupt}`，
 *   按 contract 不发 `error` 事件——避免 daemon engine 把"用户中断成功"当 agent 失败发回 IM
 * - `stopRequested`：lifecycle stopSession（SIGTERM），收尾走 `turn_finished{reason:'error'}` +
 *   `session_stopped{reason:'user_stop'}`——sigterm 切断进行中的回合属于异常退出，
 *   语义焦点在"session 已停止"，由 session_stopped 事件承载
 *
 * 也作为单回合互斥锁：set 但还没 delete 表示 in-flight，新一轮 sendInput 直接 fail-fast，
 * 避免并发覆盖 subprocMap 指错 kill 对象（spec/architecture/session-model.md §同 session 内 严格串行
 * 已由 daemon 队列保证，此处只做防御兜底）。
 */
interface InflightFlag {
  interruptRequested: boolean;
  stopRequested: boolean;
}
const inflightFlagMap = new WeakMap<AgentSession, InflightFlag>();

function getEmitter(session: AgentSession): EventEmitter {
  let em = emitterMap.get(session);
  if (!em) {
    em = new EventEmitter();
    emitterMap.set(session, em);
  }
  return em;
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
    supportsInterrupt: true,
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
      // 走 SIGINT 路径；CC CLI 收到 SIGINT 会清理 stdio buffer 并以非零 exit code 退出，
      // 或先输出 `result{stop_reason:'interrupted'}` 再退出。sendInput 收尾路径按
      // contract 翻 turn_finished{reason:user_interrupt}（不是 error），依赖
      // inflightFlagMap 区分。没 in-flight turn 时 get → undefined，本调用变 no-op。
      // 详见 spec/agent-runtime.md §AgentRuntime.interrupt。
      //
      // `kill()` 返回值很重要：Node 上对"已退出但 finally 尚未 reap"的进程返回 false。
      // 只有 signaled=true 才把 interruptRequested 翻 true；否则真信号没发，让 catch / success
      // 分支按真实 exit/error 归类，避免把无关错误误标 user_interrupt。
      const sp = subprocMap.get(session);
      const flag = inflightFlagMap.get(session);
      if (sp && flag) {
        const signaled = sp.kill('SIGINT');
        if (signaled) {
          flag.interruptRequested = true;
          logger.info({ sessionKey: session.key }, 'claudecode_interrupt_signaled');
        } else {
          logger.debug(
            { sessionKey: session.key },
            'claudecode_interrupt_target_already_exited',
          );
        }
      } else {
        logger.debug({ sessionKey: session.key }, 'claudecode_interrupt_no_inflight');
      }
    },

    stopSession(session: AgentSession): void {
      // 真实 SIGTERM；正在跑的 turn 会以非零 exit 在 sendInput 收尾走 stopRequested 分支，
      // 该分支 emit turn_finished{error} + session_stopped{user_stop}（不复用 user_interrupt
      // 语义；详见 inflightFlagMap 注释）。没 in-flight turn 时仅 state 翻 Stopped（旧语义保留）。
      // kill 返回 false（进程已退出）时不翻 flag，避免下一个错误被误归 user_stop。
      const sp = subprocMap.get(session);
      const flag = inflightFlagMap.get(session);
      if (sp && flag) {
        const signaled = sp.kill('SIGTERM');
        if (signaled) {
          flag.stopRequested = true;
          logger.info({ sessionKey: session.key }, 'claudecode_stop_session_signaled');
        } else {
          logger.debug(
            { sessionKey: session.key },
            'claudecode_stop_session_target_already_exited',
          );
        }
      }
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

      // 防御性 fail-fast #1：session 已 Stopped → 直接 emit error 返回，
      // 不允许在终态 session 上重 spawn 子进程。
      if (session.state === 'Stopped') {
        emitEvent({
          type: 'error',
          traceId,
          timestamp: new Date(),
          sequence: sequence++,
          payload: {
            errorKind: 'session_stopped',
            message: 'sendInput called on stopped session',
          },
        });
        emitEvent({
          type: 'turn_finished',
          traceId,
          timestamp: new Date(),
          sequence: sequence++,
          payload: { reason: 'error', turnSequence: 1 },
        });
        return;
      }

      // 防御性 fail-fast #2：同 session 已有 in-flight turn 时立即 emit error 并退出。
      // 串行由 daemon 队列保证（spec/architecture/session-model.md §同 session 内 严格串行），
      // 此处只兜底防止 subprocMap 被覆盖导致 interrupt 指向错误的 subproc。
      if (inflightFlagMap.has(session)) {
        emitEvent({
          type: 'error',
          traceId,
          timestamp: new Date(),
          sequence: sequence++,
          payload: {
            errorKind: 'concurrent_send_input',
            message: 'sendInput called while previous turn still in-flight',
          },
        });
        emitEvent({
          type: 'turn_finished',
          traceId,
          timestamp: new Date(),
          sequence: sequence++,
          payload: { reason: 'error', turnSequence: 1 },
        });
        return;
      }

      const inflightFlag: InflightFlag = { interruptRequested: false, stopRequested: false };
      inflightFlagMap.set(session, inflightFlag);

      let subproc: ReturnType<typeof execa> | undefined;
      try {
        try {
          subproc = execa(claudeBin, args, {
            timeout: timeoutMs,
            buffer: false,
            cwd,
          });
          // 子进程刚 spawn 就挂到 session，让 interrupt / stopSession 立刻能 SIGINT / SIGTERM。
          // 即便后续 stdout 检查或行扫失败，subproc 已 spawn，必须经 finally 释放。
          subprocMap.set(session, subproc);
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
              const reportedCwd = e['cwd'];
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
                  workingDir: typeof reportedCwd === 'string' ? reportedCwd : undefined,
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
              totalCostUsd = typeof cost === 'number' ? cost : null;
              continue;
            }

            // 其他事件类型（user/tool_result 等）MVP 忽略
          }

          await subproc;
        } catch (err) {
          // spawn 失败 / 子进程非零退出 / 行扫错误 / execa timeout。
          // 收尾分流（顺序固定，优先级从高到低）：
          //   1. execa timeout（wallclock）→ wallclock_timeout，与 interrupt 无关
          //   2. stopRequested → turn_finished{error} + session_stopped{user_stop}
          //   3. interruptRequested 或 stopReason='interrupted' → 不 emit error，
          //      emit usage(if any) + turn_finished{user_interrupt}（contract：
          //      用户主动中断属"正常收尾"，不该让 daemon 当 agent 失败发回 IM）
          //   4. 其余 → spawn_failed + turn_finished{error}
          // spec 锚点：agent-runtime.md §TurnEndReason 枚举 / agent-backends/claude-code-cli.md §stop_reason 映射
          const message = err instanceof Error ? err.message : String(err);
          // 从 execa error 上挖辨别字段（execa 9.x 提供 timedOut / signal / isTerminated）
          const execaErr = (typeof err === 'object' && err !== null
            ? (err as {
                timedOut?: boolean;
                signal?: string;
                isTerminated?: boolean;
              })
            : {}) as { timedOut?: boolean; signal?: string; isTerminated?: boolean };
          const timedOut = execaErr.timedOut === true;
          // SIGINT 来源辨别：进程必须真因 SIGINT 终止（execa.isTerminated 且 signal===SIGINT），
          // 或 CC 已在 stdout 写出 stop_reason='interrupted'。
          // 仅靠"我们发了 SIGINT"不足以证明"中断成功"——CC 可能捕获信号后因别的原因失败。
          const interruptCleanExit =
            execaErr.signal === 'SIGINT' ||
            (execaErr.isTerminated === true && execaErr.signal === 'SIGINT');

          // helper：emit 已解析到的 usage（catch 分支也要保 spec §UsageRecord 顺序）
          const emitUsageIfAny = (): void => {
            if (!usage) return;
            const usageRecord: UsageRecord = {
              model: 'claude-code',
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
              costUsd: totalCostUsd,
              turnSequence: 1,
              toolCallsThisTurn: 0,
              wallClockMs: 0,
              completeness: totalCostUsd === null ? 'partial' : 'complete',
            };
            emitEvent({
              type: 'usage',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: usageRecord,
            });
          };

          if (timedOut) {
            // spec/agent-backends/claude-code-cli.md §中断与超时：
            // "整个过程产出 turn_finished{wallclock_timeout} + error + session_stopped{error}"
            emitEvent({
              type: 'error',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: { errorKind: 'wallclock_timeout', message },
            });
            emitUsageIfAny();
            emitEvent({
              type: 'turn_finished',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: { reason: 'wallclock_timeout', turnSequence: 1 },
            });
            emitEvent({
              type: 'session_stopped',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: { reason: 'error' },
            });
            return;
          }

          if (inflightFlag.stopRequested) {
            emitUsageIfAny();
            emitEvent({
              type: 'turn_finished',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: { reason: 'error', turnSequence: 1 },
            });
            emitEvent({
              type: 'session_stopped',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: { reason: 'user_stop' },
            });
            return;
          }

          // 收紧 wasInterrupted 判定：必须有真实证据（CC 已输出 interrupted 行
          // 或 execa 报子进程因 SIGINT 终止），不能仅凭"我们发了 SIGINT"就归类。
          // 否则 CC 捕获信号后因 OOM/exit 1 等失败会被错误掩盖。
          const wasInterrupted =
            stopReason === 'interrupted' ||
            (inflightFlag.interruptRequested && interruptCleanExit);
          if (wasInterrupted) {
            emitUsageIfAny();
            emitEvent({
              type: 'turn_finished',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: { reason: 'user_interrupt', turnSequence: 1 },
            });
            return;
          }

          emitEvent({
            type: 'error',
            traceId,
            timestamp: new Date(),
            sequence: sequence++,
            payload: { errorKind: 'spawn_failed', message },
          });
          emitEvent({
            type: 'turn_finished',
            traceId,
            timestamp: new Date(),
            sequence: sequence++,
            payload: { reason: 'error', turnSequence: 1 },
          });
          return;
        }

        // 顺序 emit 收尾事件。
        // stopSession 路径优先：即便 CC 优雅 exit 0，也不能把"被强停的回合"当正常回复发出去。
        // 不 emit text_final（daemon engine 看到 text_final + turn_finished{stop} 会 safeSend 给用户）；
        // 保留 usage emit（成本归因仍有效）；turn_finished.reason='error'；末尾 emit session_stopped{user_stop}。
        if (inflightFlag.stopRequested) {
          if (usage) {
            const usageRecord: UsageRecord = {
              model: 'claude-code',
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
              costUsd: totalCostUsd,
              turnSequence: 1,
              toolCallsThisTurn: 0,
              wallClockMs: 0,
              completeness: totalCostUsd === null ? 'partial' : 'complete',
            };
            emitEvent({
              type: 'usage',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: usageRecord,
            });
          }
          emitEvent({
            type: 'turn_finished',
            traceId,
            timestamp: new Date(),
            sequence: sequence++,
            payload: { reason: 'error', turnSequence: 1 },
          });
          emitEvent({
            type: 'session_stopped',
            traceId,
            timestamp: new Date(),
            sequence: sequence++,
            payload: { reason: 'user_stop' },
          });
        } else {
          emitEvent({
            type: 'text_final',
            traceId,
            timestamp: new Date(),
            sequence: sequence++,
            payload: { text: textBuf },
          });

          const usageRecord: UsageRecord = {
            model: 'claude-code',
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
            costUsd: totalCostUsd,
            turnSequence: 1,
            toolCallsThisTurn: 0,
            wallClockMs: 0,
            completeness: totalCostUsd === null ? 'partial' : 'complete',
          };
          emitEvent({
            type: 'usage',
            traceId,
            timestamp: new Date(),
            sequence: sequence++,
            payload: usageRecord,
          });

          // turn_finished.reason：
          // - 优先用 CC stopReason 映射（end_turn → stop / interrupted → user_interrupt / …）
          // - 兜底：若调用方主动 interrupt 但 CC 仍 exit 0 且未输出 stopReason，
          //   不能让默认值跌到 'error'，应表达为 user_interrupt
          const mappedReason = stopReasonToEnum(stopReason);
          const finalReason =
            inflightFlag.interruptRequested && mappedReason === 'error'
              ? 'user_interrupt'
              : mappedReason;
          emitEvent({
            type: 'turn_finished',
            traceId,
            timestamp: new Date(),
            sequence: sequence++,
            payload: {
              reason: finalReason,
              turnSequence: 1,
            },
          });
        }
      } finally {
        // turn 自然结束 / 异常 / 被 kill 都释放 session→subproc 绑定，
        // 避免后续 interrupt 误向已退出进程发信号；同时清 inflight flag，让下一轮 sendInput 可入。
        subprocMap.delete(session);
        inflightFlagMap.delete(session);
      }
    },
  };

  return runtime;
}
