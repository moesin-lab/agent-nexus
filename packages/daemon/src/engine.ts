import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentCommandEnvelope,
  AgentCommandResult,
  AgentRuntime,
  AgentSession,
  CommandDescriptor,
  CommandPayload,
  EventHandlerResult,
  MessageRef,
  NormalizedEvent,
  PlatformAdapter,
  SessionConfig,
  SessionKey,
} from '@agent-nexus/protocol';
import { serializeSessionKey, withPlatformName } from '@agent-nexus/protocol';
import { checkPlatformAuth } from './auth.js';
import {
  ActiveCommandRegistry,
} from './command-registry.js';
import { dispatchCommandEvent } from './command-dispatch.js';
import type { CommandDispatchDecision } from './command-dispatch.js';
import type { PlatformAuthConfig, ToolMessageMode } from './config.js';
import type { Logger } from './logger.js';
import { RouteError, selectRoute, type RoutingEntry } from './router.js';
import type { SessionStore } from './session-store.js';

export interface EngineAgent {
  agent: AgentRuntime;
  agentName: string;
  agentOwner?: string;
  commandDescriptors?: readonly CommandDescriptor[];
  defaultSessionConfig: Omit<
    SessionConfig,
    'resumeFromAgentSessionId' | 'sessionId'
  >;
}

export interface EngineDeps {
  platform: PlatformAdapter;
  platformName?: string;
  platformType?: 'discord';
  agent?: AgentRuntime;
  agents?: readonly EngineAgent[];
  routingTable?: readonly RoutingEntry[];
  platformAuth?: PlatformAuthConfig;
  commandRegistry?: ActiveCommandRegistry;
  platformCommandHandlerKeys?: readonly string[];
  daemonCommandHandlerKeys?: readonly string[];
  logger: Logger;
  sessionStore: SessionStore;
  /** 每轮 sessionId 由 Engine 生成；resumeFromAgentSessionId 由 store 决定 */
  defaultSessionConfig?: Omit<
    SessionConfig,
    'resumeFromAgentSessionId' | 'sessionId'
  >;
  streaming?: {
    streamEditThrottleMs?: number;
    typingRefreshMs?: number;
  };
  toolMessages?: {
    mode?: ToolMessageMode;
  };
  textPrefixes?: {
    newSession?: boolean;
  };
}

const DEFAULT_STREAM_EDIT_THROTTLE_MS = 1500;
const DEFAULT_TYPING_REFRESH_MS = 8000;
const COMMAND_NOT_ALLOWED_TEXT = 'You are not allowed to use this command.';
const COMMAND_NOT_READY_TEXT = 'Slash commands are not ready yet. Try again later.';
const COMMAND_UNAVAILABLE_TEXT = 'This command is not available in this channel.';
const COMMAND_FAILED_TEXT = 'Command failed.';

interface ActiveAgentSession {
  agent: AgentRuntime;
  agentName: string;
  session: AgentSession;
  currentTurn?: {
    eventId: string;
    pending: Set<Promise<void>>;
    tail: Promise<void>;
    handle(event: AgentEvent): Promise<void>;
  };
}

interface ToolMessageState {
  ref?: MessageRef;
  pendingRef?: Promise<MessageRef | undefined>;
  toolName?: string;
  startText: string;
}

function codeBlock(lang: string, text: string): string {
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${lang}\n${text}\n${fence}`;
}

function renderToolStart(toolName: string, inputSummary: string): string {
  const summary = inputSummary.length > 0 ? inputSummary : '(no input)';
  if (toolName === 'Bash') {
    return `Bash:\n${codeBlock('bash', summary)}`;
  }
  return `${toolName}: ${summary}`;
}

/**
 * Engine：把 platform 入站事件路由到 agent，并把 agent 输出回送 platform。
 *
 * MVP 跳过的横切能力——下一批 PR 逐个补：
 * - 持久化幂等 / auth ordering → docs/dev/spec/infra/idempotency.md
 *   （进程内 eventId LRU 已落，详见 seenEventIds 字段）
 * - 限流 / 预算 → docs/dev/spec/infra/cost-and-limits.md
 * - 出口脱敏 → docs/dev/spec/security/redaction.md
 * - sessionStore 持久化 + 状态机 → docs/dev/architecture/session-model.md
 */
export class Engine {
  private readonly platform: PlatformAdapter;
  private readonly platformName: string;
  private readonly platformType: 'discord';
  private readonly platformAuth?: PlatformAuthConfig;
  private readonly commandRegistry?: ActiveCommandRegistry;
  private readonly platformCommandHandlerKeys: readonly string[];
  private readonly daemonCommandHandlerKeys: readonly string[];
  private readonly agents: Map<string, EngineAgent>;
  private readonly routingTable?: readonly RoutingEntry[];
  private readonly logger: Logger;
  private readonly sessionStore: SessionStore;
  private readonly streamEditThrottleMs: number;
  private readonly typingRefreshMs: number;
  private readonly toolMessageMode: ToolMessageMode;
  private readonly newSessionTextPrefixEnabled: boolean;
  private readonly agentSessions = new Map<string, ActiveAgentSession>();
  /**
   * Per-SessionKey 串行队列：同 key 的 dispatch 必须按到达序排队执行，
   * 否则两条并发 inbound 会同时读到陈旧 prevAgentSessionId 各自启新 session、
   * 互相覆盖 sessionStore 里的 agentSessionId（ordering corruption）。
   * 不同 key 之间互不阻塞。
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /**
   * eventId 内存去重：防 adapter 重投同一事件导致 agent 被重复触发（重复消耗 turn 预算）。
   * Map insertion order = LRU；满 cap 后删最旧。
   * 持久化幂等见 docs/dev/spec/infra/idempotency.md（重启窗口足够小时 in-memory 即可，跨进程暂不做）。
   */
  private static readonly DEDUP_CAP = 1024;
  private readonly seenEventIds = new Map<string, true>();

  constructor(deps: EngineDeps) {
    this.platform = deps.platform;
    this.platformName = deps.platformName ?? deps.platform.name();
    this.platformType = deps.platformType ?? 'discord';
    if (deps.routingTable && !deps.platformAuth) {
      throw new Error('Engine with routingTable requires platformAuth');
    }
    this.platformAuth = deps.platformAuth;
    this.commandRegistry = deps.commandRegistry;
    this.platformCommandHandlerKeys = deps.platformCommandHandlerKeys ?? [];
    this.daemonCommandHandlerKeys = deps.daemonCommandHandlerKeys ?? [];
    this.routingTable = deps.routingTable;
    this.agents = new Map();
    if (deps.agents) {
      for (const agent of deps.agents) {
        this.agents.set(agent.agentName, agent);
      }
    } else if (deps.agent && deps.defaultSessionConfig) {
      this.agents.set(deps.agent.name(), {
        agent: deps.agent,
        agentName: deps.agent.name(),
        defaultSessionConfig: deps.defaultSessionConfig,
      });
    } else {
      throw new Error('Engine requires either agents[] or legacy agent/defaultSessionConfig');
    }
    this.logger = deps.logger;
    this.sessionStore = deps.sessionStore;
    this.streamEditThrottleMs =
      deps.streaming?.streamEditThrottleMs ?? DEFAULT_STREAM_EDIT_THROTTLE_MS;
    this.typingRefreshMs =
      deps.streaming?.typingRefreshMs ?? DEFAULT_TYPING_REFRESH_MS;
    this.toolMessageMode = deps.toolMessages?.mode ?? 'append';
    this.newSessionTextPrefixEnabled = deps.textPrefixes?.newSession ?? true;
  }

  async start(): Promise<void> {
    await this.platform.start(this.dispatch.bind(this));
  }

  async stop(): Promise<void> {
    await this.platform.stop();
    for (const [sessionKey, active] of this.agentSessions) {
      try {
        active.agent.stopSession(active.session);
      } catch (err) {
        this.logger.error({ sessionKey, err }, 'agent_stop_session_failed');
      }
    }
    this.agentSessions.clear();
    this.sessionStore.clearAll();
  }

  private dispatch(event: NormalizedEvent): Promise<void | EventHandlerResult> {
    if (event.type === 'command') {
      return this.dispatchCommand(event);
    }
    const route = this.route(event);
    if (!route) return Promise.resolve();
    if (!this.checkAuth(event)) return Promise.resolve();
    return this.dispatchToAgent(event, route);
  }

  private checkAuth(event: NormalizedEvent): boolean {
    if (!this.platformAuth) return true;
    const decision = checkPlatformAuth(this.platformAuth, event);
    if (decision.allowed) return true;
    this.logger.info(
      {
        traceId: event.traceId,
        platformName: this.platformName,
        guildId: event.guildId,
        channelId: event.sessionKey.channelId,
        userId: event.initiator.userId,
        reason: decision.reason,
      },
      'auth_denied',
    );
    return false;
  }

  private dispatchToAgent(
    event: NormalizedEvent,
    route: { bindingName: string; agentName: string },
  ): Promise<void> {
    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const routedEvent = { ...event, sessionKey: routedSessionKey };
    const agentSlot = this.agents.get(route.agentName);
    if (!agentSlot) {
      this.logger.error(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          agentName: route.agentName,
          bindingName: route.bindingName,
        },
        'route_agent_missing',
      );
      return Promise.resolve();
    }
    const keyStr = serializeSessionKey(routedSessionKey);
    const prev = this.inflight.get(keyStr) ?? Promise.resolve();
    // 链式 await：上一条 settle 后再跑当前这条。前一条若 reject 不影响后续——
    // dispatchImpl 内部已 try/catch + 日志化错误，外层只用 catch swallow 防止
    // 链上某条 throw 把整条链 poison 掉。
    const next = prev
      .catch(() => {})
      .then(() => this.dispatchImpl(routedEvent, agentSlot));
    this.inflight.set(keyStr, next);
    // 链尾 cleanup：当前这条就是最末时清掉 map 项，避免长期累积空 promise。
    void next.finally(() => {
      if (this.inflight.get(keyStr) === next) {
        this.inflight.delete(keyStr);
      }
    });
    return next;
  }

  private commandResponse(text: string): EventHandlerResult {
    return { commandResponse: { text, ephemeral: true } };
  }

  private dispatchCommand(event: NormalizedEvent): Promise<void | EventHandlerResult> {
    if (!this.checkAuth(event)) {
      return Promise.resolve(this.commandResponse(COMMAND_NOT_ALLOWED_TEXT));
    }
    if (!this.commandRegistry || !this.routingTable) {
      this.logger.error(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          commandName: event.command?.name,
        },
        'command_handler_missing',
      );
      return Promise.resolve(this.commandResponse(COMMAND_NOT_READY_TEXT));
    }
    if (!this.commandScopeMatchesEngine(event.command?.registrationScope)) {
      this.logger.error(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          platformType: this.platformType,
          scope: event.command?.registrationScope,
          commandName: event.command?.name,
        },
        'command_scope_mismatch',
      );
      return Promise.resolve(this.commandResponse(COMMAND_UNAVAILABLE_TEXT));
    }

    const decision = dispatchCommandEvent({
      event,
      registry: this.commandRegistry,
      platformName: this.platformName,
      platformType: this.platformType,
      routingTable: this.routingTable,
      agentTargets: [...this.agents.values()].map((agent) => ({
        agentName: agent.agentName,
        agentOwner: agent.agentOwner ?? agent.agent.name(),
      })),
      platformHandlerKeys: this.platformCommandHandlerKeys,
      daemonHandlerKeys: this.daemonCommandHandlerKeys,
      logger: this.logger,
    });
    if (!decision) {
      return Promise.resolve(this.commandResponse(COMMAND_UNAVAILABLE_TEXT));
    }
    if (decision.ownerType === 'daemon') {
      return this.handleDaemonCommand(event, decision);
    }
    if (decision.ownerType === 'platform') {
      this.logger.error(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          commandName: decision.commandName,
          canonicalId: decision.canonicalId,
          handlerKey: decision.handlerKey,
          ownerType: decision.ownerType,
        },
        'command_handler_missing',
      );
      return Promise.resolve(this.commandResponse(COMMAND_NOT_READY_TEXT));
    }
    if (decision.dispatchMode === 'immediate') {
      return this.handleAgentCommand(event, decision);
    }
    return this.dispatchQueuedAgentCommand(event, decision);
  }

  private commandScopeMatchesEngine(
    scope: CommandPayload['registrationScope'] | undefined,
  ): boolean {
    return (
      scope?.platformName === this.platformName &&
      scope.platformType === this.platformType
    );
  }

  private async sendCommandAck(
    event: NormalizedEvent,
    sessionKey: SessionKey,
    text: string,
  ): Promise<void> {
    try {
      await this.platform.send(sessionKey, {
        text,
        traceId: event.traceId,
        sessionKey,
      });
    } catch (err) {
      this.logger.error(
        {
          traceId: event.traceId,
          sessionKey: serializeSessionKey(sessionKey),
          err,
        },
        'platform_send_failed',
      );
    }
  }

  private dispatchQueuedAgentCommand(
    event: NormalizedEvent,
    decision: Extract<CommandDispatchDecision, { ownerType: 'agent' }>,
  ): Promise<void | EventHandlerResult> {
    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const keyStr = serializeSessionKey(routedSessionKey);
    const prev = this.inflight.get(keyStr) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.handleAgentCommand(event, decision));
    this.inflight.set(keyStr, next);
    void next.finally(() => {
      if (this.inflight.get(keyStr) === next) {
        this.inflight.delete(keyStr);
      }
    });
    return next;
  }

  private clearTypingBestEffort(
    sessionKey: SessionKey,
    traceId: string,
  ): void {
    Promise.resolve()
      .then(() => this.platform.clearTyping(sessionKey))
      .catch((err) => {
        this.logger.debug(
          {
            traceId,
            sessionKey: serializeSessionKey(sessionKey),
            err,
          },
          'platform_typing_failed',
        );
      });
  }

  private async handleAgentCommand(
    event: NormalizedEvent,
    decision: Extract<CommandDispatchDecision, { ownerType: 'agent' }>,
  ): Promise<void | EventHandlerResult> {
    const command = event.command;
    if (!command) {
      this.logger.error(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          commandName: decision.commandName,
          canonicalId: decision.canonicalId,
        },
        'command_handler_missing',
      );
      return this.commandResponse(COMMAND_NOT_READY_TEXT);
    }
    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const sessionKeyStr = serializeSessionKey(routedSessionKey);
    const agentSlot = this.agents.get(decision.agentName);
    if (!agentSlot) {
      this.logger.error(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          agentName: decision.agentName,
          bindingName: decision.bindingName,
        },
        'route_agent_missing',
      );
      return this.commandResponse(COMMAND_UNAVAILABLE_TEXT);
    }

    const existing = this.agentSessions.get(sessionKeyStr);
    const active =
      existing && existing.agentName === agentSlot.agentName
        ? existing
        : undefined;
    const envelope: AgentCommandEnvelope = {
      canonicalId: decision.canonicalId,
      localName: decision.localName,
      handlerKey: decision.handlerKey,
      args: command.args ?? {},
      rawText: event.text,
      traceId: event.traceId,
      routingSession: {
        sessionKey: routedSessionKey,
        platformName: this.platformName,
        platformType: this.platformType,
        channelId: routedSessionKey.channelId,
        userId: routedSessionKey.initiatorUserId,
      },
    };

    let result: AgentCommandResult;
    try {
      result = await agentSlot.agent.handleCommand(active?.session, envelope);
    } catch (err) {
      this.logger.error(
        {
          traceId: event.traceId,
          sessionKey: sessionKeyStr,
          canonicalId: decision.canonicalId,
          handlerKey: decision.handlerKey,
          err,
        },
        'agent_command_failed',
      );
      return this.commandResponse(COMMAND_FAILED_TEXT);
    }
    this.applyAgentCommandResult(routedSessionKey, sessionKeyStr, result);
    if (result.status === 'rejected' || result.status === 'unsupported') {
      return this.commandResponse(result.message ?? COMMAND_FAILED_TEXT);
    }
    if (result.message) {
      await this.sendCommandAck(event, routedSessionKey, result.message);
    }
  }

  private applyAgentCommandResult(
    sessionKey: SessionKey,
    sessionKeyStr: string,
    result: AgentCommandResult,
  ): void {
    if (!Object.prototype.hasOwnProperty.call(result, 'updatedAgentSessionId')) {
      return;
    }
    if (result.updatedAgentSessionId === null) {
      this.sessionStore.delete(sessionKey);
      const active = this.agentSessions.get(sessionKeyStr);
      if (!active) return;
      try {
        if (!active.agent.isAlive(active.session)) {
          this.agentSessions.delete(sessionKeyStr);
        }
      } catch (err) {
        this.logger.warn(
          { sessionKey: sessionKeyStr, err },
          'agent_is_alive_failed',
        );
        this.agentSessions.delete(sessionKeyStr);
      }
      return;
    }
    if (typeof result.updatedAgentSessionId === 'string') {
      this.sessionStore.set(sessionKey, {
        agentSessionId: result.updatedAgentSessionId,
        lastTurnAt: new Date(),
      });
    }
  }

  private async handleDaemonCommand(
    event: NormalizedEvent,
    decision: Extract<CommandDispatchDecision, { ownerType: 'daemon' }>,
  ): Promise<void | EventHandlerResult> {
    if (decision.handlerKey !== 'kill') {
      this.logger.error(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          commandName: decision.commandName,
          canonicalId: decision.canonicalId,
          handlerKey: decision.handlerKey,
        },
        'command_handler_missing',
      );
      return this.commandResponse(COMMAND_NOT_READY_TEXT);
    }

    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const sessionKeyStr = serializeSessionKey(routedSessionKey);
    const hadActiveSession = this.stopActiveSession(sessionKeyStr, event.traceId);
    const hadStoredSession = this.sessionStore.get(routedSessionKey) !== undefined;
    this.sessionStore.delete(routedSessionKey);
    this.clearTypingBestEffort(routedSessionKey, event.traceId);
    await this.sendCommandAck(
      event,
      routedSessionKey,
      hadActiveSession || hadStoredSession
        ? '[session killed]'
        : '[no active session]',
    );
  }

  private route(event: NormalizedEvent):
    | { bindingName: string; agentName: string }
    | undefined {
    if (!this.routingTable) {
      const onlyAgent = [...this.agents.values()][0];
      if (!onlyAgent) {
        this.logger.error(
          { traceId: event.traceId, platformName: this.platformName },
          'route_agent_missing',
        );
        return undefined;
      }
      return { bindingName: 'legacy', agentName: onlyAgent.agentName };
    }
    try {
      return selectRoute(this.routingTable, {
        platformName: this.platformName,
        platformType: this.platformType,
        event,
      });
    } catch (err) {
      if (err instanceof RouteError) {
        this.logger.warn(
          {
            traceId: event.traceId,
            platformName: err.details.platformName,
            platformType: err.details.platformType,
            channelId: err.details.channelId,
            bindingNames: err.details.bindingNames,
          },
          err.code,
        );
        return undefined;
      }
      throw err;
    }
  }

  private async dispatchImpl(
    event: NormalizedEvent & { sessionKey: SessionKey },
    agentSlot: EngineAgent,
  ): Promise<void> {
    const sessionKeyStr = serializeSessionKey(event.sessionKey);
    if (this.seenEventIds.has(event.eventId)) {
      this.logger.info(
        {
          eventId: event.eventId,
          sessionKey: sessionKeyStr,
          traceId: event.traceId,
        },
        'dispatch_dedup',
      );
      return;
    }
    this.seenEventIds.set(event.eventId, true);
    if (this.seenEventIds.size > Engine.DEDUP_CAP) {
      const oldest = this.seenEventIds.keys().next().value;
      if (oldest !== undefined) this.seenEventIds.delete(oldest);
    }

    try {
      this.logger.info(
        {
          traceId: event.traceId,
          sessionKey: sessionKeyStr,
          length: (event.text ?? '').length,
        },
        'inbound',
      );
      this.logger.debug(
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
      if (
        this.newSessionTextPrefixEnabled &&
        (trimmed === '/new' || trimmed.startsWith('/new '))
      ) {
        this.stopActiveSession(sessionKeyStr, event.traceId);
        this.sessionStore.delete(event.sessionKey);
        const remainder = trimmed === '/new' ? '' : trimmed.slice(5).trim();
        if (remainder.length === 0) {
          try {
            await this.platform.send(event.sessionKey, {
              text: '[new session ready]',
              traceId: event.traceId,
              sessionKey: event.sessionKey,
            });
          } catch (sendErr) {
            this.logger.error(
              { traceId: event.traceId, sessionKey: sessionKeyStr, err: sendErr },
              'platform_send_failed',
            );
          }
          return;
        }
        prompt = remainder;
      } else {
        prompt = rawText;
      }

      const platformCaps = this.platform.capabilities();
      let session: AgentSession | undefined;
      let buf = '';
      let sawDelta = false;
      let errored = false;
      let messageRef: MessageRef | undefined;
      let creatingRef: Promise<MessageRef | undefined> | undefined;
      let currentRenderedText: string | undefined;
      let lastEditAt = 0;
      let pendingEditTimer: ReturnType<typeof setTimeout> | undefined;
      let typingInterval: ReturnType<typeof setInterval> | undefined;
      let typingActive = false;
      let toolStatus: string | undefined;
      const toolCallStartedAt = new Map<string, number>();
      const toolMessages = new Map<string, ToolMessageState>();

      const safeSend = async (text: string): Promise<MessageRef | undefined> => {
        try {
          return await this.platform.send(event.sessionKey, {
            text,
            traceId: event.traceId,
            sessionKey: event.sessionKey,
          });
        } catch (sendErr) {
          this.logger.error(
            {
              traceId: event.traceId,
              sessionKey: sessionKeyStr,
              err: sendErr,
            },
            'platform_send_failed',
          );
          return undefined;
        }
      };

      const safeEdit = async (
        ref: MessageRef,
        text: string,
      ): Promise<void> => {
        try {
          await this.platform.edit(ref, {
            text,
            traceId: event.traceId,
            sessionKey: event.sessionKey,
          });
        } catch (editErr) {
          this.logger.error(
            {
              traceId: event.traceId,
              sessionKey: sessionKeyStr,
              err: editErr,
            },
            'platform_edit_failed',
          );
        }
      };

      const renderVisibleText = (): string => {
        if (toolStatus && buf.length > 0) return `${buf}\n\n${toolStatus}`;
        return buf.length > 0 ? buf : (toolStatus ?? '[working]');
      };

      const ensureMessageRef = (
        text: string,
      ): { promise: Promise<MessageRef | undefined>; createdHere: boolean } => {
        if (messageRef) {
          return { promise: Promise.resolve(messageRef), createdHere: false };
        }
        if (creatingRef) {
          return { promise: creatingRef, createdHere: false };
        }
        creatingRef = safeSend(text)
          .then((ref) => {
            if (ref) messageRef = ref;
            return ref;
          })
          .finally(() => {
            creatingRef = undefined;
          });
        return { promise: creatingRef, createdHere: true };
      };

      const flushEdit = async (text = renderVisibleText()): Promise<void> => {
        if (!platformCaps.supportsEdit) return;
        const { promise, createdHere } = ensureMessageRef(text);
        const ref = await promise;
        if (!ref) return;
        if (!createdHere && currentRenderedText !== text) {
          await safeEdit(ref, text);
        }
        currentRenderedText = text;
        lastEditAt = Date.now();
      };

      const cancelPendingEdit = (): void => {
        if (!pendingEditTimer) return;
        clearTimeout(pendingEditTimer);
        pendingEditTimer = undefined;
      };

      const scheduleEdit = async (): Promise<void> => {
        if (!platformCaps.supportsEdit) return;
        if (!messageRef) {
          if (!creatingRef) await flushEdit();
          return;
        }
        const elapsed = Date.now() - lastEditAt;
        if (elapsed >= this.streamEditThrottleMs) {
          await flushEdit();
          return;
        }
        if (pendingEditTimer) return;
        pendingEditTimer = setTimeout(() => {
          pendingEditTimer = undefined;
          void flushEdit();
        }, this.streamEditThrottleMs - elapsed);
      };

      const clearTyping = (): void => {
        if (!typingActive) return;
        typingActive = false;
        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = undefined;
        }
        Promise.resolve()
          .then(() => this.platform.clearTyping(event.sessionKey))
          .catch((typingErr) => {
            this.logger.debug(
              {
                traceId: event.traceId,
                sessionKey: sessionKeyStr,
                err: typingErr,
              },
              'platform_typing_failed',
            );
          });
      };

      const setTyping = (): void => {
        Promise.resolve()
          .then(() => this.platform.setTyping(event.sessionKey))
          .catch((typingErr) => {
            this.logger.debug(
              {
                traceId: event.traceId,
                sessionKey: sessionKeyStr,
                err: typingErr,
              },
              'platform_typing_failed',
            );
          });
      };

      const startTyping = (): void => {
        if (!platformCaps.supportsTypingIndicator || typingActive) return;
        typingActive = true;
        setTyping();
        typingInterval = setInterval(setTyping, this.typingRefreshMs);
      };

      const finalizeReply = async (): Promise<void> => {
        cancelPendingEdit();
        if (
          this.toolMessageMode === 'append' &&
          toolMessages.size > 0 &&
          buf.length === 0
        ) {
          return;
        }
        const text = buf.length > 0 ? buf : '[empty response]';
        if (platformCaps.supportsEdit) {
          await flushEdit(text);
        } else {
          messageRef = await safeSend(text);
        }
        this.logger.info(
          {
            traceId: event.traceId,
            sessionKey: sessionKeyStr,
            length: text.length,
          },
          'outbound',
        );
        this.logger.debug(
          {
            traceId: event.traceId,
            sessionKey: sessionKeyStr,
            text,
          },
          'outbound',
        );
      };

      const ensureToolVisible = async (status: string): Promise<void> => {
        if (toolStatus) return;
        toolStatus = status;
        if (platformCaps.supportsEdit) {
          await flushEdit();
          return;
        }
        messageRef = await safeSend(toolStatus);
      };

      const upsertToolMessage = async (
        callId: string,
        text: string,
        toolName?: string,
      ): Promise<void> => {
        let state = toolMessages.get(callId);
        if (!state) {
          state = {
            toolName,
            startText: text,
          };
          toolMessages.set(callId, state);
        } else {
          state.toolName = toolName ?? state.toolName;
        }

        if (state.ref && platformCaps.supportsEdit) {
          await safeEdit(state.ref, text);
          state.startText = text;
          return;
        }

        if (state.pendingRef) {
          const ref = await state.pendingRef;
          if (ref && platformCaps.supportsEdit) {
            state.ref = ref;
            await safeEdit(ref, text);
          } else if (!ref || !platformCaps.supportsEdit) {
            state.ref = await safeSend(text);
          }
          state.startText = text;
          return;
        }

        state.startText = text;
        state.pendingRef = safeSend(text)
          .then((ref) => {
            state.ref = ref;
            return ref;
          })
          .finally(() => {
            state.pendingRef = undefined;
          });
        await state.pendingRef;
      };

      const splitAssistantMessageBeforeTool = async (): Promise<void> => {
        cancelPendingEdit();
        if (creatingRef) await creatingRef;
        if (!platformCaps.supportsEdit && buf.length > 0) {
          await safeSend(buf);
        }
        messageRef = undefined;
        creatingRef = undefined;
        currentRenderedText = undefined;
        lastEditAt = 0;
        buf = '';
        sawDelta = false;
        toolStatus = undefined;
      };

      const closeSession = (): void => {
        if (!session) return;
        const current = this.agentSessions.get(sessionKeyStr);
        if (current?.session === session) this.agentSessions.delete(sessionKeyStr);
        try {
          agentSlot.agent.stopSession(session);
        } catch (stopErr) {
          this.logger.error(
            { traceId: event.traceId, sessionKey: sessionKeyStr, err: stopErr },
            'agent_stop_session_failed',
          );
        }
      };

      const handler = async (e: AgentEvent): Promise<void> => {
        try {
          if (e.type === 'session_started') {
            const agentSessionId = e.payload.agentSessionId;
            if (agentSessionId) {
              this.sessionStore.set(event.sessionKey, {
                agentSessionId,
                lastTurnAt: new Date(),
              });
            }
            return;
          }
          if (e.type === 'text_delta') {
            sawDelta = true;
            buf += e.payload.text;
            await scheduleEdit();
            return;
          }
          if (e.type === 'text_final') {
            if (sawDelta) {
              buf = e.payload.text;
            } else {
              // 期望只来一条；多条按到达顺序 concat
              buf += e.payload.text;
            }
            await scheduleEdit();
            return;
          }
          if (e.type === 'tool_call_started') {
            toolCallStartedAt.set(e.payload.callId, Date.now());
            this.logger.info(
              {
                traceId: event.traceId,
                sessionKey: sessionKeyStr,
                callId: e.payload.callId,
                toolName: e.payload.toolName,
              },
              'tool_call_started',
            );
            this.logger.trace(
              {
                traceId: event.traceId,
                sessionKey: sessionKeyStr,
                callId: e.payload.callId,
                toolName: e.payload.toolName,
                inputSummary: e.payload.inputSummary,
              },
              'tool_call_input',
            );
            const startText = renderToolStart(
              e.payload.toolName,
              e.payload.inputSummary,
            );
            if (this.toolMessageMode === 'append') {
              await splitAssistantMessageBeforeTool();
              await upsertToolMessage(
                e.payload.callId,
                startText,
                e.payload.toolName,
              );
            } else {
              await ensureToolVisible(startText);
            }
            return;
          }
          if (e.type === 'tool_call_progress') {
            if (this.toolMessageMode === 'compact') {
              await ensureToolVisible(`[tool: ${e.payload.callId}] running`);
            }
            return;
          }
          if (e.type === 'tool_result') {
            this.logger.trace(
              {
                traceId: event.traceId,
                sessionKey: sessionKeyStr,
                callId: e.payload.callId,
                resultSequence: e.payload.resultSequence,
                isError: e.payload.isError,
                content: e.payload.content,
              },
              'tool_result',
            );
            if (this.toolMessageMode === 'compact') {
              await ensureToolVisible(`[tool: ${e.payload.callId}] result`);
            }
            return;
          }
          if (e.type === 'tool_call_finished') {
            const startedAt = toolCallStartedAt.get(e.payload.callId) ?? Date.now();
            toolCallStartedAt.delete(e.payload.callId);
            this.logger.info(
              {
                traceId: event.traceId,
                sessionKey: sessionKeyStr,
                callId: e.payload.callId,
                toolName: e.payload.toolName,
                status: e.payload.status,
                latencyMs: Math.max(0, Date.now() - startedAt),
              },
              'tool_call_finished',
            );
            if (this.toolMessageMode === 'compact') {
              await ensureToolVisible(
                `[tool: ${e.payload.toolName}] ${e.payload.status}`,
              );
            }
            return;
          }
          if (e.type === 'error') {
            errored = true;
            cancelPendingEdit();
            clearTyping();
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
            try {
              await safeSend(`[agent error: ${e.payload.errorKind}] ${e.payload.message}`);
            } finally {
              closeSession();
            }
            this.logger.info(
              {
                traceId: event.traceId,
                sessionKey: sessionKeyStr,
                errored: true,
              },
              'outbound',
            );
            return;
          }
          if (e.type === 'turn_finished') {
            clearTyping();
            if (
              e.payload.reason === 'user_interrupt' &&
              buf.length === 0 &&
              toolMessages.size === 0
            ) {
              return;
            }
            if (!errored) {
              await finalizeReply();
            }
            return;
          }
          if (e.type === 'session_stopped') {
            clearTyping();
            if (
              session &&
              this.agentSessions.get(sessionKeyStr)?.session === session
            ) {
              this.agentSessions.delete(sessionKeyStr);
            }
            return;
          }
          // usage / thinking: MVP 不处理
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

      const activeSession = this.getOrStartSession(
        event,
        sessionKeyStr,
        agentSlot,
      );
      session = activeSession.session;
      activeSession.currentTurn = {
        eventId: event.eventId,
        pending: new Set(),
        tail: Promise.resolve(),
        handle: handler,
      };
      const turnState = activeSession.currentTurn;

      startTyping();
      let sendInputErr: unknown;
      try {
        await activeSession.agent.sendInput(session, {
          type: 'user_message',
          text: prompt,
          traceId: event.traceId,
        });
      } catch (err) {
        sendInputErr = err;
      } finally {
        while (turnState.pending.size > 0) {
          await Promise.all([...turnState.pending]);
        }
        clearTyping();
        cancelPendingEdit();
        if (activeSession.currentTurn?.eventId === event.eventId) {
          activeSession.currentTurn = undefined;
        }
      }
      if (sendInputErr) throw sendInputErr;
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

  private getOrStartSession(
    event: NormalizedEvent & { sessionKey: SessionKey },
    sessionKeyStr: string,
    agentSlot: EngineAgent,
  ): ActiveAgentSession {
    const active = this.agentSessions.get(sessionKeyStr);
    if (active && active.agentName === agentSlot.agentName) {
      try {
        if (active.agent.isAlive(active.session)) return active;
      } catch (err) {
        this.logger.warn(
          { traceId: event.traceId, sessionKey: sessionKeyStr, err },
          'agent_is_alive_failed',
        );
      }
      try {
        active.agent.stopSession(active.session);
      } catch (err) {
        this.logger.error(
          { traceId: event.traceId, sessionKey: sessionKeyStr, err },
          'agent_stop_session_failed',
        );
      }
      this.agentSessions.delete(sessionKeyStr);
    } else if (active) {
      try {
        active.agent.stopSession(active.session);
      } catch (err) {
        this.logger.error(
          { traceId: event.traceId, sessionKey: sessionKeyStr, err },
          'agent_stop_session_failed',
        );
      }
      this.agentSessions.delete(sessionKeyStr);
    }

    const prevAgentSessionId = this.sessionStore.get(
      event.sessionKey,
    )?.agentSessionId;
    const config: SessionConfig = {
      ...agentSlot.defaultSessionConfig,
      sessionId: randomUUID(),
      resumeFromAgentSessionId: prevAgentSessionId,
    };
    const session = agentSlot.agent.startSession(event.sessionKey, config);
    const activeSession: ActiveAgentSession = {
      agent: agentSlot.agent,
      agentName: agentSlot.agentName,
      session,
    };
    this.agentSessions.set(sessionKeyStr, activeSession);
    agentSlot.agent.onEvent(session, async (agentEvent) => {
      const current = this.agentSessions.get(sessionKeyStr);
      if (current !== activeSession) return;
      const turn = current.currentTurn;
      if (!turn) {
        if (agentEvent.type === 'session_stopped') {
          this.agentSessions.delete(sessionKeyStr);
          return;
        }
        this.logger.debug(
          {
            traceId: agentEvent.traceId,
            sessionKey: sessionKeyStr,
            eventType: agentEvent.type,
          },
          'agent_event_without_turn',
        );
        return;
      }
      turn.tail = turn.tail
        .catch(() => {})
        .then(() => turn.handle(agentEvent));
      const handled = turn.tail
        .catch((err) => {
          this.logger.error(
            {
              traceId: agentEvent.traceId,
              sessionKey: sessionKeyStr,
              err,
            },
            'agent_event_handler_failed',
          );
        });
      const tracked = handled.finally(() => {
        turn.pending.delete(tracked);
      });
      turn.pending.add(tracked);
      await tracked;
    });
    return activeSession;
  }

  private stopActiveSession(sessionKeyStr: string, traceId: string): boolean {
    const active = this.agentSessions.get(sessionKeyStr);
    if (!active) return false;
    this.agentSessions.delete(sessionKeyStr);
    try {
      active.agent.stopSession(active.session);
    } catch (err) {
      this.logger.error(
        { traceId, sessionKey: sessionKeyStr, err },
        'agent_stop_session_failed',
      );
    }
    return true;
  }
}
