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
  /** 单次 spawn 超时（ms），默认 60_000 */
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

export function createClaudeCodeRuntime(
  opts: ClaudeCodeRuntimeOptions,
): AgentRuntime {
  const { claudeBin, allowedTools, defaultWorkingDir, logger } = opts;
  const perInputTimeoutMs = opts.perInputTimeoutMs ?? 60_000;

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
        ccSessionID: config.resumeFromCcSessionID,
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

      const emitEvent = (evt: AgentEvent): void => {
        emitter.emit('event', evt);
      };

      // per-session config 优先；runtime 级 default 仅作 config 缺失兜底（spec 要求 --cwd / --allowed-tools 必须显式）
      const sessionConfig = configMap.get(session);
      const cwd = sessionConfig?.workingDir ?? defaultWorkingDir;
      const tools = sessionConfig?.toolWhitelist ?? allowedTools;
      const args: string[] = [
        '--print',
        input.text ?? '',
        '--output-format',
        'stream-json',
        '--verbose',
        '--cwd',
        cwd,
        '--allowed-tools',
        tools.join(','),
      ];
      if (session.ccSessionID) {
        args.push('--resume', session.ccSessionID);
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
          timeout: perInputTimeoutMs,
          buffer: false,
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
              // ccSessionID 写回 session：protocol 把它标了可选 string，直接赋值即可
              session.ccSessionID = sid;
            }
            emitEvent({
              type: 'session_started',
              traceId,
              timestamp: new Date(),
              sequence: sequence++,
              payload: {
                ccSessionID: typeof sid === 'string' ? sid : undefined,
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
            totalCostUsd = typeof cost === 'number' ? cost : null;
            continue;
          }

          // 其他事件类型（user/tool_result 等）MVP 忽略
        }

        await subproc;
      } catch (err) {
        // spawn 失败 / 子进程非零退出 / 行扫错误
        const message = err instanceof Error ? err.message : String(err);
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

      emitEvent({
        type: 'turn_finished',
        traceId,
        timestamp: new Date(),
        sequence: sequence++,
        payload: {
          reason: stopReasonToEnum(stopReason),
          turnSequence: 1,
        },
      });
    },
  };

  return runtime;
}
