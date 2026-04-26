import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentRuntime,
  AgentSession,
  NormalizedEvent,
  PlatformAdapter,
  SessionConfig,
} from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';
import type { Logger } from './logger.js';
import type { SessionStore } from './session-store.js';

export interface EngineDeps {
  platform: PlatformAdapter;
  agent: AgentRuntime;
  logger: Logger;
  sessionStore: SessionStore;
  /** 每轮 sessionId 由 Engine 生成；resumeFromCcSessionID 由 store 决定 */
  defaultSessionConfig: Omit<
    SessionConfig,
    'resumeFromCcSessionID' | 'sessionId'
  >;
}

/**
 * Engine：把 platform 入站事件路由到 agent，并把 agent 输出回送 platform。
 *
 * MVP 跳过的横切能力——下一批 PR 逐个补：
 * - 幂等去重（messageId）→ docs/dev/spec/infra/idempotency.md
 * - 限流 / 预算 → docs/dev/spec/infra/cost-and-limits.md
 * - allowlist 鉴权 → docs/dev/spec/security/auth.md
 * - 出口脱敏 → docs/dev/spec/security/redaction.md
 * - sessionStore 持久化 + 状态机 → docs/dev/architecture/session-model.md
 */
export class Engine {
  private readonly platform: PlatformAdapter;
  private readonly agent: AgentRuntime;
  private readonly logger: Logger;
  private readonly sessionStore: SessionStore;
  private readonly defaultSessionConfig: Omit<
    SessionConfig,
    'resumeFromCcSessionID' | 'sessionId'
  >;

  constructor(deps: EngineDeps) {
    this.platform = deps.platform;
    this.agent = deps.agent;
    this.logger = deps.logger;
    this.sessionStore = deps.sessionStore;
    this.defaultSessionConfig = deps.defaultSessionConfig;
  }

  async start(): Promise<void> {
    await this.platform.start(this.dispatch.bind(this));
  }

  async stop(): Promise<void> {
    await this.platform.stop();
    // agent 是 stateless 句柄式实现；无 per-runtime 全局 teardown，
    // 各 session 在 turn_finished 时已 stopSession。
    this.sessionStore.clearAll();
  }

  private async dispatch(event: NormalizedEvent): Promise<void> {
    try {
      const sessionKeyStr = serializeSessionKey(event.sessionKey);
      this.logger.info(
        {
          traceId: event.traceId,
          sessionKey: sessionKeyStr,
          text: event.text,
        },
        'inbound',
      );

      // /new 触发：清 store，并把 /new 后剩余文本作为 prompt（空则只发 ack）
      const rawText = event.text ?? '';
      const trimmed = rawText.trim();
      let prompt: string;
      if (trimmed === '/new' || trimmed.startsWith('/new ')) {
        this.sessionStore.delete(event.sessionKey);
        const remainder = trimmed === '/new' ? '' : trimmed.slice(5).trim();
        if (remainder.length === 0) {
          await this.safeSend(event, '[new session ready]');
          return;
        }
        prompt = remainder;
      } else {
        prompt = rawText;
      }

      const prevCc = this.sessionStore.get(event.sessionKey)?.ccSessionID;
      const config: SessionConfig = {
        ...this.defaultSessionConfig,
        sessionId: randomUUID(),
        resumeFromCcSessionID: prevCc,
      };

      const session = this.agent.startSession(event.sessionKey, config);

      let buf = '';
      let errored = false;

      const handler = async (e: AgentEvent): Promise<void> => {
        try {
          if (e.type === 'session_started') {
            const ccSessionID = e.payload.ccSessionID;
            if (ccSessionID) {
              this.sessionStore.set(event.sessionKey, {
                ccSessionID,
                lastTurnAt: new Date(),
              });
            }
            return;
          }
          if (e.type === 'text_final') {
            // 期望只来一条；多条按到达顺序 concat
            buf += e.payload.text;
            return;
          }
          if (e.type === 'error') {
            errored = true;
            this.logger.error(
              {
                traceId: event.traceId,
                sessionKey: sessionKeyStr,
                errorKind: e.payload.errorKind,
                code: e.payload.code,
                message: e.payload.message,
              },
              'agent_error',
            );
            await this.safeSend(
              event,
              `[CC error: ${e.payload.errorKind}] ${e.payload.message}`,
            );
            return;
          }
          if (e.type === 'turn_finished') {
            if (!errored) {
              const text = buf.length > 0 ? buf : '[empty response]';
              await this.safeSend(event, text);
            }
            this.safeStopSession(session);
            return;
          }
          // usage / session_stopped: MVP 不处理
        } catch (handlerErr) {
          this.logger.error(
            {
              traceId: event.traceId,
              sessionKey: sessionKeyStr,
              err: handlerErr,
            },
            'agent_event_handler_failed',
          );
        }
      };

      this.agent.onEvent(session, handler);

      await this.agent.sendInput(session, {
        type: 'user_message',
        text: prompt,
        traceId: event.traceId,
      });
    } catch (err) {
      this.logger.error(
        {
          traceId: event.traceId,
          sessionKey: serializeSessionKey(event.sessionKey),
          err,
        },
        'dispatch_failed',
      );
    }
  }

  private async safeSend(event: NormalizedEvent, text: string): Promise<void> {
    try {
      await this.platform.send(event.sessionKey, {
        text,
        traceId: event.traceId,
        sessionKey: event.sessionKey,
      });
    } catch (err) {
      this.logger.error(
        {
          traceId: event.traceId,
          sessionKey: serializeSessionKey(event.sessionKey),
          err,
        },
        'platform_send_failed',
      );
    }
  }

  private safeStopSession(session: AgentSession): void {
    try {
      this.agent.stopSession(session);
    } catch (err) {
      this.logger.error({ err }, 'agent_stop_session_failed');
    }
  }
}
