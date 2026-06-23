import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AgentEvent,
  AgentCommandEnvelope,
  AgentCommandResult,
  AgentRuntime,
  AgentSession,
  CommandDescriptor,
  CommandPayload,
  EventCommandResponse,
  EventHandlerResult,
  EventModalResponse,
  MessageComponent,
  MessageRef,
  NormalizedEvent,
  PlatformAdapter,
  SessionConfig,
  SessionKey,
  SettingsSnapshotItem,
  ToolResultContent,
  UsageRecord,
} from '@agent-nexus/protocol';
import { serializeSessionKey, withPlatformName } from '@agent-nexus/protocol';
import { checkPlatformAuth } from './auth.js';
import {
  ActiveCommandRegistry,
  type CommandRegistryErrorCode,
} from './command-registry.js';
import {
  dispatchCommandEvent,
  isCommandDispatchFailure,
} from './command-dispatch.js';
import type { CommandDispatchDecision } from './command-dispatch.js';
import type { PlatformAuthConfig, ToolMessageMode } from './config.js';
import type { IdempotencyStore } from './idempotency.js';
import type { Logger } from './logger.js';
import {
  InMemoryMessageQueue,
  QueueFullError,
  QueueItemCancelledError,
  queueKeyFromEvent,
} from './message-queue.js';
import { BasicRedactor, type Redactor } from './redaction.js';
import { RouteError, selectRoute, type RoutingEntry } from './router.js';
import type { SessionStore } from './session-store.js';
import type {
  TrajectorySegment,
  TrajectorySegmentKind,
  TrajectoryStore,
} from './trajectory-store.js';

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

/** config reloader 由组装层注入；语义见 docs/dev/spec/config-routing.md §配置热重载 */
export type DaemonConfigReloadResult =
  | { status: 'reloaded'; message: string }
  | { status: 'failed'; message: string };

export type DaemonConfigReloader = () => Promise<DaemonConfigReloadResult>;

export interface EngineRuntimeUpdate {
  routingTable: readonly RoutingEntry[];
  platformAuth: PlatformAuthConfig;
  toolMessageMode: ToolMessageMode;
  newSessionTextPrefix: boolean;
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
  configReloader?: DaemonConfigReloader;
  idempotencyStore?: IdempotencyStore;
  redactor?: Redactor;
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
  trajectory?: {
    enabled?: boolean;
    store?: TrajectoryStore;
  };
}

const DEFAULT_STREAM_EDIT_THROTTLE_MS = 1500;
const DEFAULT_TYPING_REFRESH_MS = 8000;
const COMMAND_NOT_ALLOWED_TEXT = 'You are not allowed to use this command.';
const COMMAND_NOT_READY_TEXT = 'Slash commands are not ready yet. Try again later.';
const COMMAND_UNAVAILABLE_TEXT = 'This command is not available in this channel.';
const COMMAND_FAILED_TEXT = 'Command failed.';
const SESSION_RESUME_COMPONENT_ID = 'nexus:sessions:resume';
const NEW_THREAD_DEFAULT_TITLE = 'New Nexus session';
const THREAD_AUTO_ARCHIVE_DURATION_MINUTES = 1440;
const WORKING_DIR_ARG = 'path';
const WORKING_DIR_SCOPE_ARG = 'scope';
const SETTINGS_COMPONENT_PREFIX = 'nexus:settings:';
const SETTINGS_REPLY_MODE_COMPONENT_ID = `${SETTINGS_COMPONENT_PREFIX}reply-mode`;
const SETTINGS_RESUME_COMPONENT_ID = `${SETTINGS_COMPONENT_PREFIX}resume`;
const SETTINGS_NEW_THREAD_COMPONENT_ID = `${SETTINGS_COMPONENT_PREFIX}new-thread`;
const SETTINGS_WORKING_DIR_COMPONENT_ID = `${SETTINGS_COMPONENT_PREFIX}working-dir`;
const SETTINGS_WORKING_DIR_MODAL_ID = `${SETTINGS_COMPONENT_PREFIX}working-dir-modal`;
const SETTINGS_WORKING_DIR_PATH_FIELD_ID = 'path';
const SETTINGS_AGENT_COMPONENT_ID = `${SETTINGS_COMPONENT_PREFIX}agent`;
const QUEUE_ACTION_ARG = 'action';
const QUEUE_FULL_TEXT = 'Nexus queue is full. Try again after current tasks finish.';
const QUEUE_COMPONENT_PREFIX = 'nexus:queue:';
const QUEUE_SELECT_COMPONENT_ID = `${QUEUE_COMPONENT_PREFIX}select`;
const QUEUE_INSERT_COMPONENT_ID = `${QUEUE_COMPONENT_PREFIX}insert`;
const QUEUE_INSERT_MODAL_ID = `${QUEUE_COMPONENT_PREFIX}insert-modal`;
const QUEUE_NEXT_COMPONENT_ID = `${QUEUE_COMPONENT_PREFIX}next`;
const QUEUE_EDIT_COMPONENT_PREFIX = `${QUEUE_COMPONENT_PREFIX}edit:`;
const QUEUE_EDIT_MODAL_PREFIX = `${QUEUE_COMPONENT_PREFIX}edit-modal:`;
const QUEUE_MOVE_UP_COMPONENT_PREFIX = `${QUEUE_COMPONENT_PREFIX}up:`;
const QUEUE_MOVE_DOWN_COMPONENT_PREFIX = `${QUEUE_COMPONENT_PREFIX}down:`;
const QUEUE_CANCEL_COMPONENT_PREFIX = `${QUEUE_COMPONENT_PREFIX}cancel:`;
const QUEUE_PROMPT_FIELD_ID = 'prompt';

interface ActiveAgentSession {
  agent: AgentRuntime;
  agentName: string;
  session: AgentSession;
  sessionId: string;
  currentTurn?: {
    eventId: string;
    traceId: string;
    interruptRequested?: boolean;
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

type PreparedWorkingDirUpdate =
  | {
      ok: true;
      workingDir: string;
      scope: 'channel' | 'session';
      apply(): string;
    }
  | { ok: false; message: string };

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

function summarizeToolResultContent(content: ToolResultContent): string {
  switch (content.kind) {
    case 'empty':
      return '(empty result)';
    case 'text':
      return content.text;
    case 'blocks':
      return `${content.blocks.length} content block(s)`;
    case 'object':
      return safeJson(content.object);
    case 'unknown':
      return content.raw;
  }
}

function summarizeUsageRecord(usage: UsageRecord): string {
  const cost =
    usage.costUsd === null ? 'cost unknown' : `cost $${usage.costUsd.toFixed(6)}`;
  return [
    usage.model,
    `input ${usage.inputTokens}`,
    `output ${usage.outputTokens}`,
    cost,
  ].join(', ');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"serialization":"failed"}';
  }
}

function sessionTitleFromPrompt(prompt: string): string | undefined {
  const title = prompt.replace(/\s+/g, ' ').trim();
  if (title.length === 0) return undefined;
  return title.length > 100 ? `${title.slice(0, 97)}...` : title;
}

function commandStringArg(
  args: Record<string, string | number | boolean | null> | undefined,
  name: string,
): string | undefined {
  const value = args?.[name];
  if (typeof value !== 'string') return undefined;
  return value;
}

function validateWorkingDirArg(
  value: string | undefined,
  allowedRoot: string,
):
  | { ok: true; workingDir: string }
  | { ok: false; message: string } {
  const workingDir = value?.trim();
  if (!workingDir) {
    return { ok: false, message: 'Working directory path is required.' };
  }
  if (workingDir.includes('\0')) {
    return { ok: false, message: 'Working directory path is invalid.' };
  }
  if (!isAbsolute(workingDir)) {
    return {
      ok: false,
      message: 'Working directory must be an absolute path.',
    };
  }
  const normalizedWorkingDir = resolve(workingDir);
  const normalizedRoot = resolve(allowedRoot);
  const rel = relative(normalizedRoot, normalizedWorkingDir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return {
      ok: false,
      message: `Working directory must be inside the configured root: ${normalizedRoot}`,
    };
  }
  return { ok: true, workingDir: normalizedWorkingDir };
}

function workingDirScope(value: string | undefined): 'channel' | 'session' {
  return value === 'session' ? 'session' : 'channel';
}

/**
 * Engine：把 platform 入站事件路由到 agent，并把 agent 输出回送 platform。
 *
 * MVP 跳过的横切能力——下一批 PR 逐个补：
 * - 持久化 SQLite 幂等 → docs/dev/spec/infra/idempotency.md
 *   （Engine 支持注入 IdempotencyStore；进程内 eventId LRU 仍作纵深防御）
 * - 日志 sink / transcript 全出口脱敏 → docs/dev/spec/security/redaction.md
 *   （Engine 已对 IM outbound 应用 Redactor）
 * - 限流 / 预算 → docs/dev/spec/infra/cost-and-limits.md
 * - sessionStore 持久化 + 状态机 → docs/dev/architecture/session-model.md
 */
export class Engine {
  private readonly platform: PlatformAdapter;
  private readonly platformName: string;
  private readonly platformType: 'discord';
  // applyRuntimeUpdate 热替换的四个字段；其余 deps 启动后不可变
  private platformAuth?: PlatformAuthConfig;
  private routingTable?: readonly RoutingEntry[];
  private toolMessageMode: ToolMessageMode;
  private newSessionTextPrefixEnabled: boolean;
  private readonly commandRegistry?: ActiveCommandRegistry;
  private readonly platformCommandHandlerKeys: readonly string[];
  private readonly daemonCommandHandlerKeys: readonly string[];
  private readonly configReloader?: DaemonConfigReloader;
  private readonly idempotencyStore?: IdempotencyStore;
  private readonly redactor: Redactor;
  private readonly agents: Map<string, EngineAgent>;
  private readonly logger: Logger;
  private readonly sessionStore: SessionStore;
  private readonly trajectoryEnabled: boolean;
  private readonly trajectoryStore?: TrajectoryStore;
  private readonly streamEditThrottleMs: number;
  private readonly typingRefreshMs: number;
  private readonly agentSessions = new Map<string, ActiveAgentSession>();
  private readonly agentOverridesByChannel = new Map<string, string>();
  /**
   * Daemon 级 per-SessionKey barrier：同 key 的 message / queued command
   * 按到达序执行，不同 key 之间互不阻塞。
   */
  private readonly messageQueue = new InMemoryMessageQueue();

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
    this.configReloader = deps.configReloader;
    this.idempotencyStore = deps.idempotencyStore;
    this.redactor = deps.redactor ?? new BasicRedactor();
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
    this.trajectoryEnabled = deps.trajectory?.enabled ?? true;
    this.trajectoryStore = deps.trajectory?.store;
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

  /** 热替换运行期可安全更新的配置字段；语义见 docs/dev/spec/config-routing.md §配置热重载 */
  applyRuntimeUpdate(update: EngineRuntimeUpdate): void {
    this.routingTable = update.routingTable;
    this.platformAuth = update.platformAuth;
    this.toolMessageMode = update.toolMessageMode;
    this.newSessionTextPrefixEnabled = update.newSessionTextPrefix;
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
    this.messageQueue.clearAll();
    this.sessionStore.clearAll();
    this.idempotencyStore?.clearAll();
  }

  private dispatch(event: NormalizedEvent): Promise<void | EventHandlerResult> {
    if (event.type === 'command') {
      return this.dispatchCommand(event);
    }
    if (event.type === 'interaction') {
      return this.dispatchInteraction(event);
    }
    const route = this.route(event);
    if (!route) return Promise.resolve();
    if (!this.checkAuth(event)) return Promise.resolve();
    return this.dispatchToAgent(event, route);
  }

  private checkAuth(event: NormalizedEvent): boolean {
    if (!this.platformAuth) return true;
    const thread = this.sessionStore.findThreadByChannelId({
      platformName: this.platformName,
      platform: event.sessionKey.platform,
      channelId: event.sessionKey.channelId,
    });
    if (thread) {
      if (thread.ownerUserId !== event.initiator.userId) {
        this.logger.info(
          {
            traceId: event.traceId,
            platformName: this.platformName,
            guildId: event.guildId,
            channelId: event.sessionKey.channelId,
            userId: event.initiator.userId,
            ownerUserId: thread.ownerUserId,
            reason: 'thread_owner_mismatch',
          },
          'auth_denied',
        );
        return false;
      }
      const inheritedEvent: NormalizedEvent = {
        ...event,
        sessionKey: {
          ...event.sessionKey,
          channelId: thread.parentChannelId,
        },
      };
      const decision = checkPlatformAuth(this.platformAuth, inheritedEvent);
      if (decision.allowed) return true;
      this.logger.info(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          guildId: event.guildId,
          channelId: event.sessionKey.channelId,
          parentChannelId: thread.parentChannelId,
          userId: event.initiator.userId,
          reason: decision.reason,
        },
        'auth_denied',
      );
      return false;
    }
    if (event.threadParentChannelId) {
      const inheritedEvent: NormalizedEvent = {
        ...event,
        sessionKey: {
          ...event.sessionKey,
          channelId: event.threadParentChannelId,
        },
      };
      const decision = checkPlatformAuth(this.platformAuth, inheritedEvent);
      if (decision.allowed) return true;
      this.logger.info(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          guildId: event.guildId,
          channelId: event.sessionKey.channelId,
          parentChannelId: event.threadParentChannelId,
          userId: event.initiator.userId,
          reason: decision.reason,
        },
        'auth_denied',
      );
      return false;
    }
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
    const idempotencyMessageId = event.messageId;
    if (this.idempotencyStore && idempotencyMessageId) {
      const decision = this.idempotencyStore.checkAndSet(
        routedSessionKey,
        idempotencyMessageId,
      );
      if (decision.kind === 'hit') {
        this.logger.info(
          {
            traceId: event.traceId,
            sessionKey: serializeSessionKey(routedSessionKey),
            messageId: idempotencyMessageId,
            status: decision.status,
          },
          'idempotency_hit',
        );
        return Promise.resolve();
      }
      this.logger.info(
        {
          traceId: event.traceId,
          sessionKey: serializeSessionKey(routedSessionKey),
          messageId: idempotencyMessageId,
        },
        'idempotency_insert',
      );
    }
    const keyStr = queueKeyFromEvent(event, this.platformName);
    const queuedMessage = { text: event.text };
    let queued: Promise<void>;
    try {
      queued = this.messageQueue.enqueue({
        key: keyStr,
        kind: 'message',
        traceId: event.traceId,
        label: this.queueLabelForEvent(event),
        ...(idempotencyMessageId ? { eventId: idempotencyMessageId } : {}),
        ...(event.text ? { editableText: event.text } : {}),
        onEdit: (text) => {
          queuedMessage.text = text;
        },
        onCancel: () => {
          if (this.idempotencyStore && idempotencyMessageId) {
            this.idempotencyStore.markCancelled(
              routedSessionKey,
              idempotencyMessageId,
            );
          }
        },
        run: async () => {
          try {
            await this.dispatchImpl(
              this.withQueuedText(routedEvent, queuedMessage.text),
              agentSlot,
            );
            if (this.idempotencyStore && idempotencyMessageId) {
              this.idempotencyStore.markProcessed(
                routedSessionKey,
                idempotencyMessageId,
              );
            }
          } catch (err) {
            if (this.idempotencyStore && idempotencyMessageId) {
              this.idempotencyStore.markFailed(
                routedSessionKey,
                idempotencyMessageId,
              );
            }
            throw err;
          }
        },
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        if (this.idempotencyStore && idempotencyMessageId) {
          this.idempotencyStore.forget(routedSessionKey, idempotencyMessageId);
        }
        this.logger.warn(
          {
            traceId: event.traceId,
            sessionKey: keyStr,
            maxPendingPerKey: err.maxPendingPerKey,
          },
          'message_queue_full',
        );
        return this.sendQueueFullNotice(routedSessionKey, event.traceId);
      }
      throw err;
    }
    return queued.catch((err: unknown) => {
      if (err instanceof QueueItemCancelledError) {
        this.logger.info(
          {
            traceId: event.traceId,
            sessionKey: keyStr,
            messageId: idempotencyMessageId,
          },
          'message_queue_cancelled',
        );
        return;
      }
      throw err;
    });
  }

  private commandResponse(text: string, traceId: string): EventHandlerResult {
    return this.commandResponseResult({ text, ephemeral: true }, traceId);
  }

  private commandResponseResult(
    response: EventCommandResponse,
    traceId: string,
  ): EventHandlerResult {
    return {
      commandResponse: this.redactCommandResponse(response, traceId),
    };
  }

  private modalResponse(response: EventModalResponse, traceId: string): EventHandlerResult {
    return {
      modalResponse: this.redactModalResponse(response, traceId),
    };
  }

  private withQueuedText(
    event: NormalizedEvent & { sessionKey: SessionKey },
    text: string | undefined,
  ): NormalizedEvent & { sessionKey: SessionKey } {
    if (event.type !== 'message' || text === undefined) return event;
    return { ...event, text };
  }

  private interactionComponentId(event: NormalizedEvent): string {
    return event.interaction?.componentId ?? '';
  }

  private modalValue(event: NormalizedEvent, componentId: string): string | undefined {
    const prefix = `${componentId}=`;
    const value = event.interaction?.values.find((candidate) =>
      candidate.startsWith(prefix),
    );
    return value?.slice(prefix.length);
  }

  private redactCommandResponse(
    response: EventCommandResponse,
    traceId: string,
  ): EventCommandResponse {
    return {
      ...response,
      text: this.redactForOutbound(response.text, traceId),
      ...(response.components
        ? {
            components: response.components.map((component) =>
              this.redactMessageComponent(component, traceId),
            ),
          }
        : {}),
    };
  }

  private redactModalResponse(
    response: EventModalResponse,
    traceId: string,
  ): EventModalResponse {
    return {
      ...response,
      title: this.redactForOutbound(response.title, traceId),
      inputs: response.inputs.map((input) => ({
        ...input,
        label: this.redactForOutbound(input.label, traceId),
        ...(input.placeholder !== undefined
          ? { placeholder: this.redactForOutbound(input.placeholder, traceId) }
          : {}),
        ...(input.value !== undefined
          ? { value: this.redactForOutbound(input.value, traceId) }
          : {}),
      })),
    };
  }

  private redactMessageComponent(
    component: MessageComponent,
    traceId: string,
  ): MessageComponent {
    if (component.type === 'button') {
      return {
        ...component,
        label: this.redactForOutbound(component.label, traceId),
      };
    }
    return {
      ...component,
      ...(component.placeholder
        ? { placeholder: this.redactForOutbound(component.placeholder, traceId) }
        : {}),
      options: component.options.map((option) => ({
        ...option,
        label: this.redactForOutbound(option.label, traceId),
        ...(option.description
          ? { description: this.redactForOutbound(option.description, traceId) }
          : {}),
      })),
    };
  }

  private queueLabelForEvent(event: NormalizedEvent): string {
    return this.queueLabelForText(event.text, event.messageId ?? event.eventId);
  }

  private queueLabelForText(
    value: string | undefined,
    fallback: string,
  ): string {
    const text = value?.replace(/\s+/g, ' ').trim();
    if (text && text.length > 0) {
      return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    }
    return fallback;
  }

  private async sendQueueFullNotice(
    sessionKey: SessionKey,
    traceId: string,
  ): Promise<void> {
    try {
      await this.platform.send(sessionKey, {
        text: QUEUE_FULL_TEXT,
        traceId,
        sessionKey,
      });
    } catch (err) {
      this.logger.error(
        {
          traceId,
          sessionKey: serializeSessionKey(sessionKey),
          err,
        },
        'platform_send_failed',
      );
    }
  }

  private commandFailureResponse(
    code: CommandRegistryErrorCode,
    traceId: string,
  ): EventHandlerResult {
    if (code === 'command_active_map_missing') {
      return this.commandResponse(COMMAND_NOT_READY_TEXT, traceId);
    }
    if (code === 'command_handler_missing') {
      return this.commandResponse(COMMAND_NOT_READY_TEXT, traceId);
    }
    if (code === 'command_descriptor_invalid') {
      return this.commandResponse(COMMAND_NOT_READY_TEXT, traceId);
    }
    return this.commandResponse(COMMAND_UNAVAILABLE_TEXT, traceId);
  }

  private dispatchCommand(event: NormalizedEvent): Promise<void | EventHandlerResult> {
    if (!this.checkAuth(event)) {
      return Promise.resolve(
        this.commandResponse(COMMAND_NOT_ALLOWED_TEXT, event.traceId),
      );
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
      return Promise.resolve(
        this.commandResponse(COMMAND_NOT_READY_TEXT, event.traceId),
      );
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
      return Promise.resolve(
        this.commandResponse(COMMAND_UNAVAILABLE_TEXT, event.traceId),
      );
    }

    const decision = dispatchCommandEvent({
      event: this.routeEventForBinding(event),
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
    if (isCommandDispatchFailure(decision)) {
      return Promise.resolve(
        this.commandFailureResponse(decision.code, event.traceId),
      );
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
      return Promise.resolve(
        this.commandResponse(COMMAND_NOT_READY_TEXT, event.traceId),
      );
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
      const outboundText = this.redactForOutbound(text, event.traceId);
      await this.platform.send(sessionKey, {
        text: outboundText,
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
    const keyStr = queueKeyFromEvent(event, this.platformName);
    try {
      return this.messageQueue.enqueue({
        key: keyStr,
        kind: 'agent-command',
        traceId: event.traceId,
        label: `/${decision.localName}`,
        run: () => this.handleAgentCommand(event, decision),
      }).catch((err: unknown) => {
        if (err instanceof QueueItemCancelledError) {
          return this.commandResponse('[command cancelled]', event.traceId);
        }
        throw err;
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        return Promise.resolve(this.commandResponse(QUEUE_FULL_TEXT, event.traceId));
      }
      throw err;
    }
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
      return this.commandResponse(COMMAND_NOT_READY_TEXT, event.traceId);
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
      return this.commandResponse(COMMAND_UNAVAILABLE_TEXT, event.traceId);
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
      return this.commandResponse(COMMAND_FAILED_TEXT, event.traceId);
    }
    this.applyAgentCommandResult(routedSessionKey, sessionKeyStr, result);
    if (result.status === 'rejected' || result.status === 'unsupported') {
      return this.commandResponse(
        result.message ?? COMMAND_FAILED_TEXT,
        event.traceId,
      );
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
    if (decision.handlerKey === 'reload-config' && this.configReloader) {
      return this.handleReloadConfigCommand(event, decision);
    }
    if (decision.handlerKey === 'sessions') {
      return this.handleSessionsCommand(event);
    }
    if (decision.handlerKey === 'new-thread') {
      return this.handleNewThreadCommand(event);
    }
    if (decision.handlerKey === 'queue') {
      return this.handleQueueCommand(event);
    }
    if (decision.handlerKey === 'working-dir') {
      return this.handleWorkingDirCommand(event);
    }
    if (decision.handlerKey === 'settings') {
      return this.handleSettingsCommand(event);
    }
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
      return this.commandResponse(COMMAND_NOT_READY_TEXT, event.traceId);
    }

    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const sessionKeyStr = serializeSessionKey(routedSessionKey);
    const hadActiveSession = this.stopActiveSession(sessionKeyStr, event.traceId);
    const cancelled = this.messageQueue.clearPending(sessionKeyStr).cancelled;
    if (cancelled > 0) {
      this.logger.info(
        { traceId: event.traceId, sessionKey: sessionKeyStr, cancelled },
        'message_queue_cleared',
      );
    }
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

  private async handleReloadConfigCommand(
    event: NormalizedEvent,
    decision: Extract<CommandDispatchDecision, { ownerType: 'daemon' }>,
  ): Promise<EventHandlerResult> {
    if (!this.configReloader) {
      return this.commandResponse(COMMAND_NOT_READY_TEXT, event.traceId);
    }
    let result: DaemonConfigReloadResult;
    try {
      result = await this.configReloader();
    } catch (err) {
      this.logger.error(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          commandName: decision.commandName,
          canonicalId: decision.canonicalId,
          err,
        },
        'config_reload_failed',
      );
      return this.commandResponse(COMMAND_FAILED_TEXT, event.traceId);
    }
    this.logger.info(
      {
        traceId: event.traceId,
        platformName: this.platformName,
        commandName: decision.commandName,
        status: result.status,
      },
      'config_reload_result',
    );
    return this.commandResponse(result.message, event.traceId);
  }

  private handleSessionsCommand(event: NormalizedEvent): EventHandlerResult {
    const sessions = this.sessionStore.listForUser({
      platformName: this.platformName,
      platform: event.sessionKey.platform,
      initiatorUserId: event.initiator.userId,
      limit: 25,
    });
    if (sessions.length === 0) {
      return this.commandResponse('[no resumable sessions]', event.traceId);
    }
    return this.commandResponseResult(
      {
        text: 'Select a session to resume.',
        ephemeral: true,
        components: [
          {
            type: 'select',
            componentId: SESSION_RESUME_COMPONENT_ID,
            placeholder: 'Resume session',
            minValues: 1,
            maxValues: 1,
            options: sessions.map((session) => ({
              label: (session.title ?? session.key.channelId).slice(0, 100),
              value: session.sessionId,
              description: `${session.key.channelId} · ${session.agentSessionId}`.slice(0, 100),
            })),
          },
        ],
      },
      event.traceId,
    );
  }

  private async handleNewThreadCommand(
    event: NormalizedEvent,
  ): Promise<EventHandlerResult> {
    if (
      !this.platform.capabilities().supportsThreadCreation ||
      !this.platform.createThread
    ) {
      return this.commandResponse('This platform cannot create threads.', event.traceId);
    }
    const requestedTitle = sessionTitleFromPrompt(
      commandStringArg(event.command?.args, 'title') ?? '',
    );
    const title = requestedTitle ?? NEW_THREAD_DEFAULT_TITLE;
    const outboundTitle = this.redactForOutbound(title, event.traceId);
    let result: Awaited<ReturnType<NonNullable<PlatformAdapter['createThread']>>>;
    try {
      result = await this.platform.createThread({
        parentChannelId: event.sessionKey.channelId,
        initiatorUserId: event.initiator.userId,
        title: outboundTitle,
        visibility: 'private',
        autoArchiveDurationMinutes: THREAD_AUTO_ARCHIVE_DURATION_MINUTES,
        initialMessage: `[new Nexus session: ${outboundTitle}]`,
        traceId: event.traceId,
      });
    } catch (err) {
      this.logger.error(
        {
          traceId: event.traceId,
          platformName: this.platformName,
          channelId: event.sessionKey.channelId,
          userId: event.initiator.userId,
          err,
        },
        'thread_create_failed',
      );
      return this.commandResponse(
        'Could not create a thread. Check bot permissions and try again.',
        event.traceId,
      );
    }
    const threadSessionKey = withPlatformName(
      {
        platform: event.sessionKey.platform,
        channelId: result.threadId,
        initiatorUserId: event.initiator.userId,
      },
      this.platformName,
    );
    this.sessionStore.set(threadSessionKey, {
      lastTurnAt: new Date(),
      title,
    });
    this.sessionStore.registerThread(threadSessionKey, {
      parentChannelId: result.parentChannelId,
      ownerUserId: event.initiator.userId,
      autoArchiveDurationMinutes: THREAD_AUTO_ARCHIVE_DURATION_MINUTES,
      renameOnFirstPrompt: requestedTitle === undefined,
    });
    const suffix = result.url ? ` ${result.url}` : ` ${result.threadId}`;
    return this.commandResponse(`[thread created]${suffix}`, event.traceId);
  }

  private handleQueueCommand(event: NormalizedEvent): EventHandlerResult {
    const action = commandStringArg(event.command?.args, QUEUE_ACTION_ARG) ?? 'status';
    if (action !== 'status' && action !== 'clear' && action !== 'next') {
      return this.commandResponse(COMMAND_UNAVAILABLE_TEXT, event.traceId);
    }
    const key = queueKeyFromEvent(event, this.platformName);
    if (action === 'clear') {
      const { cancelled } = this.messageQueue.clearPending(key);
      return this.queueCommandResponse(event, `Cancelled: \`${cancelled}\``);
    }
    if (action === 'next') {
      return this.handleQueueNextCommand(event);
    }
    return this.queueCommandResponse(event);
  }

  private handleQueueNextCommand(event: NormalizedEvent): EventHandlerResult {
    const key = queueKeyFromEvent(event, this.platformName);
    const snapshot = this.messageQueue.snapshot(key);
    if (!snapshot.running) {
      return this.queueCommandResponse(event, 'No running item.');
    }
    if (snapshot.pendingCount === 0) {
      return this.queueCommandResponse(event, 'No pending item to run next.');
    }
    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const sessionKeyStr = serializeSessionKey(routedSessionKey);
    const active = this.agentSessions.get(sessionKeyStr);
    if (!active) {
      return this.queueCommandResponse(event, 'Current queue item cannot be interrupted.');
    }
    if (active.currentTurn?.traceId !== snapshot.running.traceId) {
      return this.queueCommandResponse(event, 'Current queue item already advanced.');
    }
    if (active.currentTurn.interruptRequested) {
      return this.queueCommandResponse(event, 'Run next already requested.');
    }
    active.currentTurn.interruptRequested = true;
    try {
      active.agent.interrupt(active.session);
    } catch (err) {
      active.currentTurn.interruptRequested = false;
      this.logger.error(
        { traceId: event.traceId, sessionKey: sessionKeyStr, err },
        'agent_interrupt_failed',
      );
      return this.queueCommandResponse(event, COMMAND_FAILED_TEXT);
    }
    return this.queueCommandResponse(
      event,
      'Interrupted current turn; next queued item will run.',
    );
  }

  private queueCommandResponse(
    event: NormalizedEvent,
    prefix?: string,
    selectedItemId?: string,
  ): EventHandlerResult {
    const key = queueKeyFromEvent(event, this.platformName);
    const snapshot = this.messageQueue.snapshot(key);
    return this.commandResponseResult(
      {
        text: this.renderQueueStatus(key, prefix, selectedItemId),
        ephemeral: true,
        components: this.queueComponents(snapshot, selectedItemId),
      },
      event.traceId,
    );
  }

  private renderQueueStatus(
    key: string,
    prefix?: string,
    selectedItemId?: string,
  ): string {
    const snapshot = this.messageQueue.snapshot(key);
    const running = snapshot.running
      ? `${snapshot.running.kind} · ${snapshot.running.label}`
      : 'none';
    const selected = snapshot.pending.find((item) => item.id === selectedItemId);
    const pendingLines = snapshot.pending.slice(0, 5).map(
      (item, index) => `${index + 1}. ${item.kind} · ${item.label}`,
    );
    const lines = ['**Nexus queue**'];
    if (prefix) {
      lines.push('', prefix);
    }
    lines.push(
      '',
      `Key: \`${key}\``,
      `Running: \`${running}\``,
      `Pending: \`${snapshot.pendingCount} / ${snapshot.maxPendingPerKey}\``,
      `Recent: completed \`${snapshot.recentCounts.completed}\`, failed \`${snapshot.recentCounts.failed}\`, cancelled \`${snapshot.recentCounts.cancelled}\``,
    );
    if (selected) {
      lines.push('', `Selected: \`${selected.kind} · ${selected.label}\``);
    }
    if (pendingLines.length > 0) {
      lines.push('', '**Pending**', ...pendingLines);
    }
    return lines.join('\n');
  }

  private queueComponents(
    snapshot: ReturnType<InMemoryMessageQueue['snapshot']>,
    selectedItemId?: string,
  ): NonNullable<EventHandlerResult['commandResponse']>['components'] {
    const components: NonNullable<EventHandlerResult['commandResponse']>['components'] = [];
    if (snapshot.pending.length > 0) {
      components.push({
        type: 'select',
        componentId: QUEUE_SELECT_COMPONENT_ID,
        placeholder: 'Select queued item',
        minValues: 1,
        maxValues: 1,
        options: snapshot.pending.slice(0, 25).map((item, index) => ({
          label: `${index + 1}. ${item.label}`.slice(0, 100),
          value: item.id,
          description: item.kind.slice(0, 100),
          default: item.id === selectedItemId,
        })),
      });
    }
    const selected = snapshot.pending.find((item) => item.id === selectedItemId);
    if (!selected) {
      if (snapshot.running && snapshot.pendingCount > 0) {
        components.push({
          type: 'button',
          componentId: QUEUE_NEXT_COMPONENT_ID,
          label: 'Run next',
          style: 'primary',
        });
      }
      components.push({
        type: 'button',
        componentId: QUEUE_INSERT_COMPONENT_ID,
        label: 'Insert next',
        style:
          snapshot.running && snapshot.pendingCount > 0
            ? 'secondary'
            : 'primary',
      });
    }
    if (selected) {
      components.push(
        {
          type: 'button',
          componentId: `${QUEUE_MOVE_UP_COMPONENT_PREFIX}${selected.id}`,
          label: 'Up',
          style: 'secondary',
        },
        {
          type: 'button',
          componentId: `${QUEUE_MOVE_DOWN_COMPONENT_PREFIX}${selected.id}`,
          label: 'Down',
          style: 'secondary',
        },
        {
          type: 'button',
          componentId: `${QUEUE_EDIT_COMPONENT_PREFIX}${selected.id}`,
          label: 'Edit',
          style: 'secondary',
          disabled: selected.kind !== 'message',
        },
        {
          type: 'button',
          componentId: `${QUEUE_CANCEL_COMPONENT_PREFIX}${selected.id}`,
          label: 'Cancel',
          style: 'danger',
        },
      );
    }
    return components;
  }

  private async handleWorkingDirCommand(
    event: NormalizedEvent,
  ): Promise<EventHandlerResult> {
    const prepared = this.prepareWorkingDirUpdate(
      event,
      commandStringArg(event.command?.args, WORKING_DIR_ARG),
      commandStringArg(event.command?.args, WORKING_DIR_SCOPE_ARG),
    );
    if (!prepared.ok) {
      return this.commandResponse(prepared.message, event.traceId);
    }
    return this.enqueueWorkingDirUpdate(event, prepared);
  }

  private prepareWorkingDirUpdate(
    event: NormalizedEvent,
    path: string | undefined,
    scopeArg: string | undefined,
  ): PreparedWorkingDirUpdate {
    const route = this.route(event);
    if (!route) {
      return { ok: false, message: COMMAND_UNAVAILABLE_TEXT };
    }
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
      return { ok: false, message: COMMAND_UNAVAILABLE_TEXT };
    }
    const parsed = validateWorkingDirArg(path, agentSlot.defaultSessionConfig.workingDir);
    if (!parsed.ok) {
      return { ok: false, message: parsed.message };
    }
    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const scope = workingDirScope(scopeArg);
    return {
      ok: true,
      workingDir: parsed.workingDir,
      scope,
      apply: () => {
        if (scope === 'session') {
          this.sessionStore.setNextWorkingDir(
            routedSessionKey,
            parsed.workingDir,
            new Date(),
          );
          return `[next session workingDir: ${parsed.workingDir}]`;
        }
        this.sessionStore.setChannelWorkingDir(
          {
            platformName: this.platformName,
            platform: event.sessionKey.platform,
            channelId: event.sessionKey.channelId,
          },
          parsed.workingDir,
        );
        return `[channel workingDir: ${parsed.workingDir}]`;
      },
    };
  }

  private async enqueueWorkingDirUpdate(
    event: NormalizedEvent,
    update: Extract<PreparedWorkingDirUpdate, { ok: true }>,
  ): Promise<EventHandlerResult> {
    const key = queueKeyFromEvent(event, this.platformName);
    const wasIdle = this.messageQueue.isIdle(key);
    let queued: Promise<string>;
    try {
      queued = this.messageQueue.enqueue({
        key,
        kind: 'daemon-state-command',
        traceId: event.traceId,
        label: `working-dir:${update.scope}`,
        run: async () => update.apply(),
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        return this.commandResponse(QUEUE_FULL_TEXT, event.traceId);
      }
      throw err;
    }

    if (wasIdle) {
      try {
        return this.commandResponse(await queued, event.traceId);
      } catch (err) {
        if (err instanceof QueueItemCancelledError) {
          return this.commandResponse('[workingDir update cancelled]', event.traceId);
        }
        throw err;
      }
    }

    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    void queued
      .then((text) => this.sendCommandAck(event, routedSessionKey, text))
      .catch((err: unknown) => {
        if (err instanceof QueueItemCancelledError) {
          this.logger.info(
            { traceId: event.traceId, sessionKey: key },
            'message_queue_cancelled',
          );
          return;
        }
        this.logger.error(
          { traceId: event.traceId, sessionKey: key, err },
          'working_dir_update_failed',
        );
      });
    return this.commandResponse(
      `[workingDir update queued: ${update.workingDir}]`,
      event.traceId,
    );
  }

  private async handleSettingsCommand(
    event: NormalizedEvent,
    prefix?: string,
  ): Promise<EventHandlerResult> {
    return this.commandResponseResult(
      await this.buildSettingsResponse(event, prefix),
      event.traceId,
    );
  }

  private async buildSettingsResponse(
    event: NormalizedEvent,
    prefix?: string,
  ): Promise<NonNullable<EventHandlerResult['commandResponse']>> {
    const platformItems = await this.platform.settingsSnapshot?.({
      userId: event.initiator.userId,
      channelId: event.sessionKey.channelId,
      ...(event.threadParentChannelId
        ? { threadParentChannelId: event.threadParentChannelId }
        : {}),
    });
    const items = [
      ...(platformItems?.items ?? []),
      ...this.daemonSettingsSnapshotItems(event),
    ];
    const sessions = this.sessionStore.listForUser({
      platformName: this.platformName,
      platform: event.sessionKey.platform,
      initiatorUserId: event.initiator.userId,
      limit: 25,
    });
    const text = this.renderSettingsText(items, sessions.length, prefix);
    return {
      text,
      ephemeral: true,
      components: this.settingsComponents(items, sessions),
    };
  }

  private renderSettingsText(
    items: readonly SettingsSnapshotItem[],
    sessionCount: number,
    prefix?: string,
  ): string {
    const replyMode = items.find((item) => item.key === 'discord.replyMode');
    const agent = items.find((item) => item.key === 'daemon.agent');
    const workingDir = items.find((item) => item.key === 'daemon.workingDir');
    const lines = ['**Nexus settings**'];
    if (prefix) {
      lines.push('', `Result: ${prefix}`);
    }
    lines.push(
      '',
      '**Current state**',
      `Reply mode: ${this.renderSettingsValue(replyMode)}`,
      `Agent: ${this.renderSettingsValue(agent)}`,
      `WorkingDir: ${this.renderSettingsValue(workingDir)}`,
      `Resumable sessions: \`${sessionCount}\``,
      '',
      '**Notes**',
      'Controls below apply to this channel/thread. Values marked `in-memory` reset when the daemon restarts.',
    );
    return lines.join('\n');
  }

  private renderSettingsValue(item: SettingsSnapshotItem | undefined): string {
    if (!item) return '`unavailable`';
    return `\`${item.value}\` · ${item.source} · ${item.durability}`;
  }

  private daemonSettingsSnapshotItems(
    event: NormalizedEvent,
  ): SettingsSnapshotItem[] {
    const route = this.route(event);
    const routedChannelId = this.routeEventForBinding(event).sessionKey.channelId;
    const agentOverride = this.agentOverridesByChannel.get(
      this.channelOverrideKey(event.sessionKey.platform, routedChannelId),
    );
    const bindingItem: SettingsSnapshotItem = {
      key: 'daemon.agent',
      label: 'Agent',
      owner: 'daemon',
      value: agentOverride ?? route?.agentName ?? '[unavailable]',
      source: agentOverride ? 'channel override' : 'binding route',
      durability: agentOverride ? 'in-memory' : 'derived',
      canChange: this.agents.size > 1,
    };
    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const nextWorkingDir = this.sessionStore.get(routedSessionKey)
      ?.nextSession?.workingDir;
    if (nextWorkingDir) {
      return [
        bindingItem,
        {
          key: 'daemon.workingDir',
          label: 'WorkingDir',
          owner: 'daemon',
          value: nextWorkingDir,
          source: 'next session override',
          durability: 'in-memory',
          canChange: false,
        },
      ];
    }
    const currentChannelWorkingDir = this.sessionStore.getChannelWorkingDir({
      platformName: this.platformName,
      platform: event.sessionKey.platform,
      channelId: event.sessionKey.channelId,
    });
    if (currentChannelWorkingDir) {
      return [
        bindingItem,
        {
          key: 'daemon.workingDir',
          label: 'WorkingDir',
          owner: 'daemon',
          value: currentChannelWorkingDir,
          source: 'channel default',
          durability: 'in-memory',
          canChange: false,
        },
      ];
    }
    const thread = this.sessionStore.findThreadByChannelId({
      platformName: this.platformName,
      platform: event.sessionKey.platform,
      channelId: event.sessionKey.channelId,
    });
    const parentChannelId = thread?.parentChannelId ?? event.threadParentChannelId;
    if (parentChannelId) {
      const parentWorkingDir = this.sessionStore.getChannelWorkingDir({
        platformName: this.platformName,
        platform: event.sessionKey.platform,
        channelId: parentChannelId,
      });
      if (parentWorkingDir) {
        return [
          bindingItem,
          {
            key: 'daemon.workingDir',
            label: 'WorkingDir',
            owner: 'daemon',
            value: parentWorkingDir,
            source: 'parent channel default',
            durability: 'in-memory',
            canChange: false,
          },
        ];
      }
    }
    const agentSlot = route ? this.agents.get(route.agentName) : undefined;
    return [
      bindingItem,
      {
        key: 'daemon.workingDir',
        label: 'WorkingDir',
        owner: 'daemon',
        value: agentSlot?.defaultSessionConfig.workingDir ?? '[unavailable]',
        source: 'agent default',
        durability: 'derived',
        canChange: false,
      },
    ];
  }

  private settingsComponents(
    items: readonly SettingsSnapshotItem[],
    sessions: ReturnType<SessionStore['listForUser']>,
  ): NonNullable<EventHandlerResult['commandResponse']>['components'] {
    const components: NonNullable<EventHandlerResult['commandResponse']>['components'] = [];
    const replyMode = items.find((item) => item.key === 'discord.replyMode');
    if (replyMode?.canChange) {
      components.push({
        type: 'select',
        componentId: SETTINGS_REPLY_MODE_COMPONENT_ID,
        placeholder: 'Change reply mode',
        minValues: 1,
        maxValues: 1,
        options: [
          {
            label: 'mention',
            value: 'mention',
            description: 'Only replies when mentioned or slash commands are used',
            default: replyMode.value === 'mention',
          },
          {
            label: 'all',
            value: 'all',
            description: 'Replies to all allowed messages in the channel',
            default: replyMode.value === 'all',
          },
        ],
      });
    }
    const agentItem = items.find((item) => item.key === 'daemon.agent');
    if (agentItem?.canChange) {
      components.push({
        type: 'select',
        componentId: SETTINGS_AGENT_COMPONENT_ID,
        placeholder: 'Switch agent binding',
        minValues: 1,
        maxValues: 1,
        options: [...this.agents.values()].map((agent) => ({
          label: agent.agentName.slice(0, 100),
          value: agent.agentName,
          description: (agent.agentOwner ?? agent.agent.name()).slice(0, 100),
          default: agent.agentName === agentItem.value,
        })),
      });
    }
    if (sessions.length > 0) {
      components.push({
        type: 'select',
        componentId: SETTINGS_RESUME_COMPONENT_ID,
        placeholder: 'Resume a session',
        minValues: 1,
        maxValues: 1,
        options: sessions.map((session) => ({
          label: (session.title ?? session.key.channelId).slice(0, 100),
          value: session.sessionId,
          description: `${session.key.channelId} · ${session.agentSessionId}`.slice(0, 100),
        })),
      });
    }
    components.push({
      type: 'button',
      componentId: SETTINGS_WORKING_DIR_COMPONENT_ID,
      label: 'Set workingDir',
      style: 'secondary',
    });
    if (
      this.platform.capabilities().supportsThreadCreation &&
      this.platform.createThread
    ) {
      components.push({
        type: 'button',
        componentId: SETTINGS_NEW_THREAD_COMPONENT_ID,
        label: 'Create thread',
        style: 'primary',
      });
    }
    return components;
  }

  private async dispatchInteraction(event: NormalizedEvent): Promise<EventHandlerResult | void> {
    if (!this.checkAuth(event)) {
      return this.commandResponse(COMMAND_NOT_ALLOWED_TEXT, event.traceId);
    }
    const componentId = this.interactionComponentId(event);
    if (componentId === SESSION_RESUME_COMPONENT_ID) {
      return this.handleSessionResumeInteraction(event);
    }
    if (componentId.startsWith(QUEUE_COMPONENT_PREFIX)) {
      return this.handleQueueInteraction(event);
    }
    if (componentId.startsWith(SETTINGS_COMPONENT_PREFIX)) {
      return this.handleSettingsInteraction(event);
    }
    this.logger.error(
      {
        traceId: event.traceId,
        platformName: this.platformName,
        componentId,
      },
      'interaction_handler_missing',
    );
    return this.commandResponse(COMMAND_NOT_READY_TEXT, event.traceId);
  }

  private async handleQueueInteraction(
    event: NormalizedEvent,
  ): Promise<EventHandlerResult> {
    const componentId = this.interactionComponentId(event);
    const key = queueKeyFromEvent(event, this.platformName);
    if (componentId === QUEUE_SELECT_COMPONENT_ID) {
      const selectedId = event.interaction?.values[0];
      return this.queueCommandResponse(event, undefined, selectedId);
    }
    if (componentId === QUEUE_INSERT_COMPONENT_ID) {
      return this.modalResponse(
        {
          modalId: QUEUE_INSERT_MODAL_ID,
          title: 'Insert queued prompt',
          inputs: [
            {
              componentId: QUEUE_PROMPT_FIELD_ID,
              label: 'Prompt',
              kind: 'long_text',
              required: true,
              placeholder: 'Ask Nexus to do this next',
            },
          ],
        },
        event.traceId,
      );
    }
    if (componentId === QUEUE_NEXT_COMPONENT_ID) {
      return this.handleQueueNextCommand(event);
    }
    if (componentId === QUEUE_INSERT_MODAL_ID) {
      const prompt = this.modalValue(event, QUEUE_PROMPT_FIELD_ID)?.trim();
      if (!prompt) {
        return this.commandResponse('Prompt is required.', event.traceId);
      }
      return this.enqueueInsertedPrompt(event, prompt);
    }
    if (componentId.startsWith(QUEUE_EDIT_COMPONENT_PREFIX)) {
      const itemId = componentId.slice(QUEUE_EDIT_COMPONENT_PREFIX.length);
      const item = this.messageQueue
        .snapshot(key)
        .pending.find((candidate) => candidate.id === itemId);
      if (!item || item.kind !== 'message') {
        return this.queueCommandResponse(event, COMMAND_UNAVAILABLE_TEXT);
      }
      return this.modalResponse(
        {
          modalId: `${QUEUE_EDIT_MODAL_PREFIX}${itemId}`,
          title: 'Edit queued prompt',
          inputs: [
            {
              componentId: QUEUE_PROMPT_FIELD_ID,
              label: 'Prompt',
              kind: 'long_text',
              required: true,
              value: item.editableText ?? item.label,
            },
          ],
        },
        event.traceId,
      );
    }
    if (componentId.startsWith(QUEUE_EDIT_MODAL_PREFIX)) {
      const itemId = componentId.slice(QUEUE_EDIT_MODAL_PREFIX.length);
      const prompt = this.modalValue(event, QUEUE_PROMPT_FIELD_ID)?.trim();
      if (!prompt) {
        return this.commandResponse('Prompt is required.', event.traceId);
      }
      const existing = this.messageQueue
        .snapshot(key)
        .pending.find((candidate) => candidate.id === itemId && candidate.kind === 'message');
      const existingPrompt = existing?.editableText ?? existing?.label;
      // Modal values are redacted for outbound display. With deterministic redaction,
      // unchanged submissions keep the queued raw prompt; partial edits use submitted text.
      const effectivePrompt =
        existingPrompt && prompt === this.redactForOutbound(existingPrompt, event.traceId).trim()
          ? existingPrompt
          : prompt;
      const result = this.messageQueue.editPending(
        key,
        itemId,
        effectivePrompt,
        this.queueLabelForText(effectivePrompt, itemId),
      );
      if (result.status !== 'updated') {
        return this.queueCommandResponse(event, COMMAND_UNAVAILABLE_TEXT);
      }
      return this.queueCommandResponse(
        event,
        `Updated: \`${result.item.label}\``,
        itemId,
      );
    }
    if (componentId.startsWith(QUEUE_MOVE_UP_COMPONENT_PREFIX)) {
      const itemId = componentId.slice(QUEUE_MOVE_UP_COMPONENT_PREFIX.length);
      const result = this.messageQueue.movePending(key, itemId, 'up');
      return this.queueCommandResponse(
        event,
        result.status === 'not_found' ? COMMAND_UNAVAILABLE_TEXT : 'Moved up',
        itemId,
      );
    }
    if (componentId.startsWith(QUEUE_MOVE_DOWN_COMPONENT_PREFIX)) {
      const itemId = componentId.slice(QUEUE_MOVE_DOWN_COMPONENT_PREFIX.length);
      const result = this.messageQueue.movePending(key, itemId, 'down');
      return this.queueCommandResponse(
        event,
        result.status === 'not_found' ? COMMAND_UNAVAILABLE_TEXT : 'Moved down',
        itemId,
      );
    }
    if (componentId.startsWith(QUEUE_CANCEL_COMPONENT_PREFIX)) {
      const itemId = componentId.slice(QUEUE_CANCEL_COMPONENT_PREFIX.length);
      const result = this.messageQueue.cancelPendingItem(key, itemId);
      return this.queueCommandResponse(
        event,
        result.status === 'cancelled'
          ? `Cancelled: \`${result.item.label}\``
          : COMMAND_UNAVAILABLE_TEXT,
      );
    }
    return this.commandResponse(COMMAND_NOT_READY_TEXT, event.traceId);
  }

  private enqueueInsertedPrompt(
    event: NormalizedEvent,
    prompt: string,
  ): EventHandlerResult {
    const route = this.route(event);
    if (!route) {
      return this.queueCommandResponse(event, COMMAND_UNAVAILABLE_TEXT);
    }
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
      return this.queueCommandResponse(event, COMMAND_UNAVAILABLE_TEXT);
    }
    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const insertedEvent: NormalizedEvent & { sessionKey: SessionKey } = {
      eventId: `${event.eventId}:queue-insert:${randomUUID()}`,
      platform: event.platform,
      sessionKey: routedSessionKey,
      traceId: event.traceId,
      type: 'message',
      text: prompt,
      messageId: undefined,
      rawPayload: event.rawPayload,
      rawContentType: 'daemon:queue-insert',
      receivedAt: new Date(),
      ...(event.platformTimestamp ? { platformTimestamp: event.platformTimestamp } : {}),
      ...(event.guildId ? { guildId: event.guildId } : {}),
      ...(event.initiatorRoleIds ? { initiatorRoleIds: event.initiatorRoleIds } : {}),
      ...(event.threadParentChannelId
        ? { threadParentChannelId: event.threadParentChannelId }
        : {}),
      initiator: event.initiator,
    };
    const key = queueKeyFromEvent(event, this.platformName);
    const queuedMessage = { text: prompt };
    let handle: { id: string; done: Promise<void> };
    try {
      handle = this.messageQueue.enqueueWithHandle({
        key,
        kind: 'message',
        traceId: event.traceId,
        label: this.queueLabelForText(prompt, event.eventId),
        editableText: prompt,
        position: 'front',
        onEdit: (text) => {
          queuedMessage.text = text;
        },
        run: () =>
          this.dispatchImpl(
            { ...insertedEvent, text: queuedMessage.text },
            agentSlot,
          ),
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        return this.queueCommandResponse(event, QUEUE_FULL_TEXT);
      }
      throw err;
    }
    void handle.done.catch((err: unknown) => {
      if (err instanceof QueueItemCancelledError) {
        this.logger.info(
          { traceId: event.traceId, sessionKey: key },
          'message_queue_cancelled',
        );
        return;
      }
      this.logger.error(
        { traceId: event.traceId, sessionKey: key, err },
        'inserted_queue_prompt_failed',
      );
    });
    return this.queueCommandResponse(
      event,
      `Inserted next: \`${this.queueLabelForText(prompt, event.eventId)}\``,
      handle.id,
    );
  }

  private handleSessionResumeInteraction(event: NormalizedEvent): EventHandlerResult {
    const sessionId = event.interaction?.values[0];
    if (!sessionId) {
      return this.commandResponse(COMMAND_UNAVAILABLE_TEXT, event.traceId);
    }
    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    const sessionKeyStr = serializeSessionKey(routedSessionKey);
    this.stopActiveSession(sessionKeyStr, event.traceId);
    const rebound = this.sessionStore.bindExistingToKey(
      routedSessionKey,
      sessionId,
      new Date(),
    );
    if (!rebound) {
      return this.commandResponse(COMMAND_UNAVAILABLE_TEXT, event.traceId);
    }
    return this.commandResponse(
      `[session resumed: ${rebound.agentSessionId}]`,
      event.traceId,
    );
  }

  private async handleSettingsInteraction(
    event: NormalizedEvent,
  ): Promise<EventHandlerResult> {
    const componentId = this.interactionComponentId(event);
    if (componentId === SETTINGS_REPLY_MODE_COMPONENT_ID) {
      const value = event.interaction?.values[0];
      if (value !== 'mention' && value !== 'all') {
        return this.commandResponse(COMMAND_UNAVAILABLE_TEXT, event.traceId);
      }
      const result = await this.platform.applySettingsAction?.({
        action: 'discord.replyMode',
        value,
        userId: event.initiator.userId,
        channelId: event.sessionKey.channelId,
        ...(event.threadParentChannelId
          ? { threadParentChannelId: event.threadParentChannelId }
          : {}),
      });
      const message =
        result?.message ??
        (result?.status === 'unsupported'
          ? COMMAND_UNAVAILABLE_TEXT
          : `[reply mode requested: ${value}]`);
      return this.handleSettingsCommand(event, message);
    }
    if (componentId === SETTINGS_RESUME_COMPONENT_ID) {
      const result = this.handleSessionResumeInteraction(event);
      return this.handleSettingsCommand(
        event,
        result.commandResponse?.text ?? COMMAND_UNAVAILABLE_TEXT,
      );
    }
    if (componentId === SETTINGS_NEW_THREAD_COMPONENT_ID) {
      const result = await this.handleNewThreadCommand(event);
      return this.handleSettingsCommand(
        event,
        result.commandResponse?.text ?? COMMAND_UNAVAILABLE_TEXT,
      );
    }
    if (componentId === SETTINGS_WORKING_DIR_COMPONENT_ID) {
      return this.modalResponse(
        {
          modalId: SETTINGS_WORKING_DIR_MODAL_ID,
          title: 'Set working directory',
          inputs: [
            {
              componentId: SETTINGS_WORKING_DIR_PATH_FIELD_ID,
              label: 'Absolute path',
              kind: 'short_text',
              required: true,
              placeholder: '/workspace/project',
            },
          ],
        },
        event.traceId,
      );
    }
    if (componentId === SETTINGS_WORKING_DIR_MODAL_ID) {
      const result = await this.applySettingsWorkingDir(event);
      return this.handleSettingsCommand(
        event,
        result.commandResponse?.text ?? COMMAND_UNAVAILABLE_TEXT,
      );
    }
    if (componentId === SETTINGS_AGENT_COMPONENT_ID) {
      const result = this.applySettingsAgent(event);
      return this.handleSettingsCommand(
        event,
        result.commandResponse?.text ?? COMMAND_UNAVAILABLE_TEXT,
      );
    }
    return this.commandResponse(COMMAND_NOT_READY_TEXT, event.traceId);
  }

  private async applySettingsWorkingDir(
    event: NormalizedEvent,
  ): Promise<EventHandlerResult> {
    const prepared = this.prepareWorkingDirUpdate(
      event,
      this.modalValue(event, SETTINGS_WORKING_DIR_PATH_FIELD_ID),
      undefined,
    );
    if (!prepared.ok) return this.commandResponse(prepared.message, event.traceId);
    return this.enqueueWorkingDirUpdate(event, prepared);
  }

  private applySettingsAgent(event: NormalizedEvent): EventHandlerResult {
    const agentName = event.interaction?.values[0];
    if (!agentName || !this.agents.has(agentName)) {
      return this.commandResponse(COMMAND_UNAVAILABLE_TEXT, event.traceId);
    }
    const routedChannelId = this.routeEventForBinding(event).sessionKey.channelId;
    this.agentOverridesByChannel.set(
      this.channelOverrideKey(event.sessionKey.platform, routedChannelId),
      agentName,
    );
    const routedSessionKey = withPlatformName(
      event.sessionKey,
      this.platformName,
    );
    this.stopActiveSession(serializeSessionKey(routedSessionKey), event.traceId);
    this.sessionStore.delete(routedSessionKey);
    return this.commandResponse(`[agent binding: ${agentName}]`, event.traceId);
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
      const routingEvent = this.routeEventForBinding(event);
      const overrideAgent = this.agentOverridesByChannel.get(
        this.channelOverrideKey(
          routingEvent.sessionKey.platform,
          routingEvent.sessionKey.channelId,
        ),
      );
      if (overrideAgent && this.agents.has(overrideAgent)) {
        return { bindingName: 'settings-override', agentName: overrideAgent };
      }
      return selectRoute(this.routingTable, {
        platformName: this.platformName,
        platformType: this.platformType,
        event: routingEvent,
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

  private channelOverrideKey(platform: string, channelId: string): string {
    return `${this.platformName}:${platform}:${channelId}`;
  }

  private routeEventForBinding(event: NormalizedEvent): NormalizedEvent {
    const thread = this.sessionStore.findThreadByChannelId({
      platformName: this.platformName,
      platform: event.sessionKey.platform,
      channelId: event.sessionKey.channelId,
    });
    const parentChannelId = thread?.parentChannelId ?? event.threadParentChannelId;
    if (!parentChannelId) return event;
    return {
      ...event,
      sessionKey: {
        ...event.sessionKey,
        channelId: parentChannelId,
      },
    };
  }

  private renameThreadBestEffort(
    event: NormalizedEvent & { sessionKey: SessionKey },
    title: string | undefined,
  ): void {
    if (!title || !this.platform.updateThread) return;
    const thread = this.sessionStore.findThreadByChannelId({
      platformName: this.platformName,
      platform: event.sessionKey.platform,
      channelId: event.sessionKey.channelId,
    });
    if (!thread) return;
    if (!thread.renameOnFirstPrompt) return;
    Promise.resolve()
      .then(() =>
        this.platform.updateThread?.({
          threadId: event.sessionKey.channelId,
          title: this.redactForOutbound(title, event.traceId),
          traceId: event.traceId,
        }),
      )
      .catch((err) => {
        this.logger.warn(
          {
            traceId: event.traceId,
            platformName: this.platformName,
            channelId: event.sessionKey.channelId,
            err,
          },
          'thread_update_failed',
        );
      });
    this.sessionStore.registerThread(event.sessionKey, {
      ...thread,
      renameOnFirstPrompt: false,
    });
  }

  private resolveWorkingDirForSession(
    event: NormalizedEvent & { sessionKey: SessionKey },
    defaultWorkingDir: string,
  ): string {
    const nextWorkingDir = this.sessionStore.consumeNextWorkingDir(
      event.sessionKey,
    );
    if (nextWorkingDir) return nextWorkingDir;
    const currentChannelWorkingDir = this.sessionStore.getChannelWorkingDir({
      platformName: this.platformName,
      platform: event.sessionKey.platform,
      channelId: event.sessionKey.channelId,
    });
    if (currentChannelWorkingDir) return currentChannelWorkingDir;
    const thread = this.sessionStore.findThreadByChannelId({
      platformName: this.platformName,
      platform: event.sessionKey.platform,
      channelId: event.sessionKey.channelId,
    });
    const parentChannelId = thread?.parentChannelId ?? event.threadParentChannelId;
    if (parentChannelId) {
      const parentChannelWorkingDir = this.sessionStore.getChannelWorkingDir({
        platformName: this.platformName,
        platform: event.sessionKey.platform,
        channelId: parentChannelId,
      });
      if (parentChannelWorkingDir) return parentChannelWorkingDir;
    }
    return defaultWorkingDir;
  }

  private redactForOutbound(text: string, traceId: string): string {
    try {
      return this.redactor.redact(text);
    } catch (err) {
      this.logger.error({ traceId, err }, 'redaction_failed');
      return '[redacted output unavailable]';
    }
  }

  private appendNexusTrajectorySegment(
    active: ActiveAgentSession,
    input: {
      kind: TrajectorySegmentKind;
      traceId?: string;
      turnSequence?: number;
      ts: string;
      summary: string;
      usageEventId?: string;
      metadata: Record<string, unknown>;
    },
  ): void {
    if (!this.trajectoryEnabled || !this.trajectoryStore) return;
    const segment: TrajectorySegment = {
      segmentId: randomUUID(),
      sessionId: active.sessionId,
      source: 'nexus-agent-event',
      kind: input.kind,
      sequence: this.sessionStore.nextTrajectorySequence(active.sessionId),
      ts: input.ts,
      summary: input.summary,
      confidence: 'high',
      redactionState: 'redacted',
      metadataJson: safeJson(input.metadata),
    };
    if (input.traceId) segment.traceId = input.traceId;
    if (input.turnSequence !== undefined) {
      segment.turnSequence = input.turnSequence;
    }
    if (input.usageEventId) segment.usageEventId = input.usageEventId;

    try {
      this.trajectoryStore.appendTrajectorySegment(segment);
    } catch (err) {
      this.logger.warn(
        {
          traceId: input.traceId,
          sessionId: active.sessionId,
          kind: input.kind,
          err,
        },
        'trajectory_segment_append_failed',
      );
    }
  }

  private appendInboundTrajectorySegment(
    active: ActiveAgentSession,
    event: NormalizedEvent & { sessionKey: SessionKey },
    prompt: string,
    sessionKeyStr: string,
    agentName: string,
  ): void {
    this.appendNexusTrajectorySegment(active, {
      kind: 'user-message',
      traceId: event.traceId,
      ts: event.receivedAt.toISOString(),
      summary: prompt,
      metadata: {
        eventId: event.eventId,
        messageId: event.messageId,
        platform: event.platform,
        rawContentType: event.rawContentType,
        sessionKey: sessionKeyStr,
        agentName,
      },
    });
  }

  private appendAgentEventTrajectorySegment(
    active: ActiveAgentSession,
    event: AgentEvent,
    sessionKeyStr: string,
  ): void {
    const baseMetadata = {
      eventType: event.type,
      agentEventSequence: event.sequence,
      sessionKey: sessionKeyStr,
    };
    switch (event.type) {
      case 'session_started':
        this.appendNexusTrajectorySegment(active, {
          kind: 'state-change',
          traceId: event.traceId,
          ts: event.timestamp.toISOString(),
          summary: event.payload.agentSessionId
            ? `session started: ${event.payload.agentSessionId}`
            : 'session started',
          metadata: {
            ...baseMetadata,
            agentSessionId: event.payload.agentSessionId,
            workingDir: event.payload.workingDir,
          },
        });
        return;
      case 'thinking':
        this.appendNexusTrajectorySegment(active, {
          kind: 'reasoning',
          traceId: event.traceId,
          ts: event.timestamp.toISOString(),
          summary: event.payload.text,
          metadata: baseMetadata,
        });
        return;
      case 'text_delta':
        return;
      case 'text_final':
        this.appendNexusTrajectorySegment(active, {
          kind: 'agent-message',
          traceId: event.traceId,
          ts: event.timestamp.toISOString(),
          summary: event.payload.text,
          metadata: baseMetadata,
        });
        return;
      case 'tool_call_started':
        this.appendNexusTrajectorySegment(active, {
          kind: 'tool-call',
          traceId: event.traceId,
          ts: event.timestamp.toISOString(),
          summary: `${event.payload.toolName}: ${event.payload.inputSummary}`,
          metadata: {
            ...baseMetadata,
            callId: event.payload.callId,
            toolName: event.payload.toolName,
          },
        });
        return;
      case 'tool_call_progress':
        this.appendNexusTrajectorySegment(active, {
          kind: 'state-change',
          traceId: event.traceId,
          ts: event.timestamp.toISOString(),
          summary: `[tool: ${event.payload.callId}] ${event.payload.note}`,
          metadata: {
            ...baseMetadata,
            callId: event.payload.callId,
          },
        });
        return;
      case 'tool_result':
        this.appendNexusTrajectorySegment(active, {
          kind: 'tool-result',
          traceId: event.traceId,
          ts: event.timestamp.toISOString(),
          summary: summarizeToolResultContent(event.payload.content),
          metadata: {
            ...baseMetadata,
            callId: event.payload.callId,
            resultSequence: event.payload.resultSequence,
            isError: event.payload.isError,
            contentKind: event.payload.content.kind,
          },
        });
        return;
      case 'tool_call_finished':
        this.appendNexusTrajectorySegment(active, {
          kind: 'state-change',
          traceId: event.traceId,
          ts: event.timestamp.toISOString(),
          summary: `${event.payload.toolName}: ${event.payload.status}`,
          metadata: {
            ...baseMetadata,
            callId: event.payload.callId,
            toolName: event.payload.toolName,
            status: event.payload.status,
            errorSummary: event.payload.errorSummary,
          },
        });
        return;
      case 'usage':
        this.appendNexusTrajectorySegment(active, {
          kind: 'usage',
          traceId: event.traceId,
          turnSequence: event.payload.turnSequence,
          ts: event.timestamp.toISOString(),
          summary: summarizeUsageRecord(event.payload),
          usageEventId: `${active.sessionId}:usage:${event.sequence}`,
          metadata: {
            ...baseMetadata,
            usage: event.payload,
          },
        });
        return;
      case 'turn_finished':
        this.appendNexusTrajectorySegment(active, {
          kind: 'state-change',
          traceId: event.traceId,
          turnSequence: event.payload.turnSequence,
          ts: event.timestamp.toISOString(),
          summary: `turn finished: ${event.payload.reason}`,
          metadata: {
            ...baseMetadata,
            reason: event.payload.reason,
            source: event.payload.source,
          },
        });
        return;
      case 'error':
        this.appendNexusTrajectorySegment(active, {
          kind: 'state-change',
          traceId: event.traceId,
          ts: event.timestamp.toISOString(),
          summary: `[agent error: ${event.payload.errorKind}] ${event.payload.message}`,
          metadata: {
            ...baseMetadata,
            errorKind: event.payload.errorKind,
            code: event.payload.code,
          },
        });
        return;
      case 'session_stopped':
        this.appendNexusTrajectorySegment(active, {
          kind: 'state-change',
          traceId: event.traceId,
          ts: event.timestamp.toISOString(),
          summary: `session stopped: ${event.payload.reason}`,
          metadata: {
            ...baseMetadata,
            reason: event.payload.reason,
          },
        });
        return;
    }
  }

  private appendAgentEventTrajectoryBestEffort(
    active: ActiveAgentSession,
    event: AgentEvent,
    sessionKeyStr: string,
  ): void {
    try {
      this.appendAgentEventTrajectorySegment(active, event, sessionKeyStr);
    } catch (err) {
      this.logger.warn(
        {
          traceId: event.traceId,
          sessionId: active.sessionId,
          eventType: event.type,
          err,
        },
        'trajectory_event_mapping_failed',
      );
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
            const outboundText = this.redactForOutbound(
              '[new session ready]',
              event.traceId,
            );
            await this.platform.send(event.sessionKey, {
              text: outboundText,
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
      // turn 级 snapshot：reload 切换 toolMessages 只影响后续 turn，
      // 避免同一 turn 内前后段按不同模式混合渲染
      const toolMessageMode = this.toolMessageMode;
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
      let activeSessionForTrajectory: ActiveAgentSession | undefined;

      const safeSend = async (text: string): Promise<MessageRef | undefined> => {
        try {
          const outboundText = this.redactForOutbound(text, event.traceId);
          return await this.platform.send(event.sessionKey, {
            text: outboundText,
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
          const outboundText = this.redactForOutbound(text, event.traceId);
          await this.platform.edit(ref, {
            text: outboundText,
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
          toolMessageMode === 'append' &&
          toolMessages.size > 0 &&
          buf.length === 0
        ) {
          return;
        }
        const text = buf.length > 0 ? buf : '[empty response]';
        const outboundText = this.redactForOutbound(text, event.traceId);
        if (platformCaps.supportsEdit) {
          await flushEdit(text);
        } else {
          messageRef = await safeSend(text);
        }
        this.logger.info(
          {
            traceId: event.traceId,
            sessionKey: sessionKeyStr,
            length: outboundText.length,
          },
          'outbound',
        );
        this.logger.debug(
          {
            traceId: event.traceId,
            sessionKey: sessionKeyStr,
            text: outboundText,
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
          if (activeSessionForTrajectory) {
            this.appendAgentEventTrajectoryBestEffort(
              activeSessionForTrajectory,
              e,
              sessionKeyStr,
            );
          }
          if (e.type === 'session_started') {
            const agentSessionId = e.payload.agentSessionId;
            if (agentSessionId) {
              const promptTitle = sessionTitleFromPrompt(prompt);
              const thread = this.sessionStore.findThreadByChannelId({
                platformName: this.platformName,
                platform: event.sessionKey.platform,
                channelId: event.sessionKey.channelId,
              });
              const title =
                thread && !thread.renameOnFirstPrompt ? undefined : promptTitle;
              this.sessionStore.set(event.sessionKey, {
                agentSessionId,
                lastTurnAt: new Date(),
                title,
              });
              this.renameThreadBestEffort(event, title);
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
            if (toolMessageMode === 'append') {
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
            if (toolMessageMode === 'compact') {
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
            if (toolMessageMode === 'compact') {
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
            if (toolMessageMode === 'compact') {
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
      activeSessionForTrajectory = activeSession;
      session = activeSession.session;
      activeSession.currentTurn = {
        eventId: event.eventId,
        traceId: event.traceId,
        pending: new Set(),
        tail: Promise.resolve(),
        handle: handler,
      };
      const turnState = activeSession.currentTurn;
      this.appendInboundTrajectorySegment(
        activeSession,
        event,
        prompt,
        sessionKeyStr,
        agentSlot.agentName,
      );

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
    const workingDir = this.resolveWorkingDirForSession(
      event,
      agentSlot.defaultSessionConfig.workingDir,
    );
    const config: SessionConfig = {
      ...agentSlot.defaultSessionConfig,
      workingDir,
      sessionId: this.sessionStore.ensureSessionId(event.sessionKey),
      resumeFromAgentSessionId: prevAgentSessionId,
    };
    const session = agentSlot.agent.startSession(event.sessionKey, config);
    const activeSession: ActiveAgentSession = {
      agent: agentSlot.agent,
      agentName: agentSlot.agentName,
      session,
      sessionId: config.sessionId,
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
