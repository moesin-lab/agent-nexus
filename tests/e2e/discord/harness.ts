import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentCapabilitySet,
  AgentEvent,
  AgentEventHandler,
  AgentInput,
  AgentRuntime,
  AgentSession,
  CapabilitySet,
  EventHandler,
  MessageRef,
  NormalizedEvent,
  OutboundMessage,
  PlatformAdapter,
  PlatformSessionKey,
  SessionConfig,
  SessionKey,
} from '../../../packages/protocol/src/index.js';
import { Engine } from '../../../packages/daemon/src/engine.js';
import type { PlatformAuthConfig } from '../../../packages/daemon/src/config.js';
import { InMemoryIdempotencyStore } from '../../../packages/daemon/src/idempotency.js';
import { createLogger } from '../../../packages/daemon/src/logger.js';
import { SessionStore } from '../../../packages/daemon/src/session-store.js';

const DEFAULT_PLATFORM_CAPS: CapabilitySet = {
  maxTextLength: 2_000,
  supportsEdit: false,
  supportsDelete: false,
  supportsReactions: false,
  supportsEmbeds: false,
  supportsButtons: false,
  supportsThreads: false,
  supportsEphemeral: false,
  supportsAttachments: false,
  maxAttachmentsPerMessage: 0,
  supportsTypingIndicator: false,
};

const DEFAULT_AGENT_CAPS: AgentCapabilitySet = {
  supportsThinking: false,
  supportsStreaming: false,
  supportsToolCallEvents: false,
  supportsInterrupt: false,
  supportsStdinInterrupt: false,
};

const DEFAULT_PLATFORM_SESSION_KEY: PlatformSessionKey = {
  platform: 'discord',
  channelId: 'C-e2e-main',
  initiatorUserId: 'U-e2e-owner',
};

export type TranscriptEvent =
  | {
      kind: 'inbound';
      eventId: string;
      messageId?: string;
      traceId: string;
      sessionKey: PlatformSessionKey;
      text: string;
    }
  | {
      kind: 'agent_event';
      eventType: AgentEvent['type'];
      sequence: number;
      traceId: string;
    }
  | {
      kind: 'outbound_send';
      sessionKey: SessionKey;
      message: OutboundMessage;
      ref: MessageRef;
    }
  | {
      kind: 'outbound_edit';
      sessionKey: SessionKey;
      ref: MessageRef;
      message: OutboundMessage;
    }
  | {
      kind: 'typing';
      action: 'set' | 'clear';
      sessionKey: SessionKey;
    }
  | {
      kind: 'assertion';
      name: string;
      passed: boolean;
      details?: string;
    };

export interface Transcript {
  caseId: string;
  events: TranscriptEvent[];
}

export type OutboundSendEvent = Extract<
  TranscriptEvent,
  { kind: 'outbound_send' }
>;
export type OutboundEvent = Extract<
  TranscriptEvent,
  { kind: 'outbound_send' | 'outbound_edit' }
>;
export type AgentTranscriptEvent = Extract<
  TranscriptEvent,
  { kind: 'agent_event' }
>;

export type ScriptedAgentEvents = (ctx: {
  session: AgentSession;
  input: AgentInput;
}) => AgentEvent[];

export interface DiscordE2EHarnessOptions {
  caseId?: string;
  keepArtifacts?: boolean;
  platformAuth?: PlatformAuthConfig;
  platformName?: string;
  platformCaps?: Partial<CapabilitySet>;
  sessionKey?: PlatformSessionKey;
  agentEvents: ScriptedAgentEvents;
}

export interface DiscordE2EHarnessPaths {
  rootDir: string;
  workingDir: string;
  stateDir: string;
  transcriptDir: string;
}

export interface InjectMessageOptions {
  eventId?: string;
  messageId?: string;
  traceId?: string;
  channelId?: string;
  initiatorUserId?: string;
  displayName?: string;
  guildId?: string;
  initiatorRoleIds?: string[];
}

export function scriptedTextReply(text: string): ScriptedAgentEvents {
  return ({ input }) => [
    {
      type: 'text_final',
      traceId: input.traceId,
      timestamp: new Date(),
      sequence: 1,
      payload: { text },
    },
    {
      type: 'turn_finished',
      traceId: input.traceId,
      timestamp: new Date(),
      sequence: 2,
      payload: { reason: 'stop', turnSequence: 1 },
    },
  ];
}

class FakeDiscordPlatform implements PlatformAdapter {
  private handler?: EventHandler;
  private nextMessageId = 1;
  private readonly caps: CapabilitySet;

  constructor(
    private readonly transcript: Transcript,
    capOverrides: Partial<CapabilitySet>,
    private readonly onOutbound: (entry: OutboundEvent) => void,
  ) {
    this.caps = { ...DEFAULT_PLATFORM_CAPS, ...capOverrides };
  }

  name(): string {
    return 'discord-main';
  }

  capabilities(): CapabilitySet {
    return this.caps;
  }

  private splitText(text: string): string[] {
    const maxTextLength = this.caps.maxTextLength;
    if (maxTextLength <= 0 || text.length <= maxTextLength) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxTextLength) {
      chunks.push(text.slice(i, i + maxTextLength));
    }
    return chunks.length > 0 ? chunks : [''];
  }

  private nextRef(sessionKey: SessionKey): MessageRef {
    const messageId = `fake-discord-${this.nextMessageId++}`;
    return {
      platform: sessionKey.platform,
      channelId: sessionKey.channelId,
      messageId,
      messageIds: [messageId],
      sentAt: new Date(),
    };
  }

  async start(handler: EventHandler): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = undefined;
  }

  async inject(event: NormalizedEvent): Promise<void> {
    if (!this.handler) {
      throw new Error('FakeDiscordPlatform must be started before inject');
    }
    this.transcript.events.push({
      kind: 'inbound',
      eventId: event.eventId,
      messageId: event.messageId,
      traceId: event.traceId,
      sessionKey: event.sessionKey,
      text: event.text ?? '',
    });
    await this.handler(event);
  }

  async send(
    sessionKey: SessionKey,
    message: OutboundMessage,
  ): Promise<MessageRef> {
    const refs: MessageRef[] = [];
    for (const chunk of this.splitText(message.text)) {
      const ref = this.nextRef(sessionKey);
      refs.push(ref);
      const entry: OutboundSendEvent = {
        kind: 'outbound_send',
        sessionKey,
        message: { ...message, text: chunk },
        ref,
      };
      this.transcript.events.push(entry);
      this.onOutbound(entry);
    }
    const first = refs[0]!;
    const last = refs[refs.length - 1]!;
    return {
      platform: last.platform,
      channelId: last.channelId,
      messageId: last.messageId,
      messageIds: refs.flatMap((ref) => ref.messageIds),
      sentAt: first.sentAt,
    };
  }

  async edit(ref: MessageRef, message: OutboundMessage): Promise<void> {
    const chunks = this.splitText(message.text);
    const existingIds = ref.messageIds.length > 0 ? ref.messageIds : [ref.messageId];
    const nextIds: string[] = [];
    chunks.forEach((chunk, index) => {
      const messageId = existingIds[index] ?? `fake-discord-${this.nextMessageId++}`;
      nextIds.push(messageId);
      const chunkRef: MessageRef = {
        platform: ref.platform,
        channelId: ref.channelId,
        messageId,
        messageIds: [messageId],
        sentAt: ref.sentAt,
      };
      const entry: OutboundEvent = {
        kind: index < existingIds.length ? 'outbound_edit' : 'outbound_send',
        sessionKey: message.sessionKey,
        ref: chunkRef,
        message: { ...message, text: chunk },
      };
      this.transcript.events.push(entry);
      this.onOutbound(entry);
    });
    ref.messageIds = nextIds;
    ref.messageId = nextIds[nextIds.length - 1] ?? ref.messageId;
  }

  async delete(_ref: MessageRef): Promise<void> {
    throw new Error('FakeDiscordPlatform.delete is not implemented');
  }

  async react(_ref: MessageRef, _emoji: string): Promise<void> {
    throw new Error('FakeDiscordPlatform.react is not implemented');
  }

  async setTyping(sessionKey: SessionKey): Promise<void> {
    this.transcript.events.push({ kind: 'typing', action: 'set', sessionKey });
  }

  async clearTyping(sessionKey: SessionKey): Promise<void> {
    this.transcript.events.push({
      kind: 'typing',
      action: 'clear',
      sessionKey,
    });
  }
}

class ScriptedAgentRuntime implements AgentRuntime {
  readonly inputs: Array<{ session: AgentSession; input: AgentInput }> = [];
  private readonly handlers = new Map<AgentSession, AgentEventHandler>();
  private nextSessionId = 1;

  constructor(
    private readonly transcript: Transcript,
    private readonly onAgentEvent: (entry: AgentTranscriptEvent) => void,
    private readonly events: ScriptedAgentEvents,
  ) {}

  name(): string {
    return 'scripted-agent';
  }

  capabilities(): AgentCapabilitySet {
    return DEFAULT_AGENT_CAPS;
  }

  startSession(key: SessionKey, _config: SessionConfig): AgentSession {
    return {
      key,
      backend: 'scripted',
      state: 'Ready',
      startedAt: new Date(),
      agentSessionId: `scripted-${this.nextSessionId++}`,
    };
  }

  stopSession(session: AgentSession): void {
    this.handlers.delete(session);
    session.state = 'Stopped';
  }

  isAlive(session: AgentSession): boolean {
    return session.state !== 'Stopped';
  }

  async sendInput(session: AgentSession, input: AgentInput): Promise<void> {
    this.inputs.push({ session, input });
    const handler = this.handlers.get(session);
    if (!handler) return;
    for (const event of this.events({ session, input })) {
      const entry: AgentTranscriptEvent = {
        kind: 'agent_event',
        eventType: event.type,
        sequence: event.sequence,
        traceId: event.traceId,
      };
      this.transcript.events.push(entry);
      this.onAgentEvent(entry);
      await handler(event);
    }
  }

  onEvent(session: AgentSession, handler: AgentEventHandler): void {
    this.handlers.set(session, handler);
  }

  interrupt(_session: AgentSession): void {}
}

export function createDiscordE2EHarness(options: DiscordE2EHarnessOptions): {
  agent: ScriptedAgentRuntime;
  injectMessage(
    text: string,
    overrides?: InjectMessageOptions,
  ): Promise<NormalizedEvent>;
  paths: DiscordE2EHarnessPaths;
  platform: FakeDiscordPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  transcript: Transcript;
  waitForAgentEvent(
    predicate: (entry: AgentTranscriptEvent) => boolean,
    timeoutMs?: number,
  ): Promise<AgentTranscriptEvent>;
  waitForOutbound(
    predicate: (entry: OutboundEvent) => boolean,
    timeoutMs?: number,
  ): Promise<OutboundEvent>;
  waitForNoAgentCall(windowMs?: number, expectedTotal?: number): Promise<void>;
  waitForTurnFinished(
    traceId: string,
    timeoutMs?: number,
  ): Promise<AgentTranscriptEvent>;
} {
  const transcript: Transcript = {
    caseId: options.caseId ?? 'harness-qualification',
    events: [],
  };
  type OutboundWaiter = {
    predicate: (entry: OutboundEvent) => boolean;
    resolve: (entry: OutboundEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const outboundWaiters = new Set<OutboundWaiter>();
  const consumedOutbounds = new WeakSet<OutboundEvent>();
  const settleOutboundWaiters = (entry: OutboundEvent): void => {
    let matched = false;
    for (const waiter of [...outboundWaiters]) {
      if (!waiter.predicate(entry)) continue;
      clearTimeout(waiter.timer);
      outboundWaiters.delete(waiter);
      matched = true;
      transcript.events.push({
        kind: 'assertion',
        name: 'waitForOutbound',
        passed: true,
      });
      waiter.resolve(entry);
    }
    if (matched) consumedOutbounds.add(entry);
  };
  const platform = new FakeDiscordPlatform(
    transcript,
    options.platformCaps ?? {},
    settleOutboundWaiters,
  );
  type AgentWaiter = {
    predicate: (entry: AgentTranscriptEvent) => boolean;
    resolve: (entry: AgentTranscriptEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  const agentWaiters = new Set<AgentWaiter>();
  const consumedAgentEvents = new WeakSet<AgentTranscriptEvent>();
  const settleAgentWaiters = (entry: AgentTranscriptEvent): void => {
    let matched = false;
    for (const waiter of [...agentWaiters]) {
      if (!waiter.predicate(entry)) continue;
      clearTimeout(waiter.timer);
      agentWaiters.delete(waiter);
      matched = true;
      transcript.events.push({
        kind: 'assertion',
        name: 'waitForAgentEvent',
        passed: true,
      });
      waiter.resolve(entry);
    }
    if (matched) consumedAgentEvents.add(entry);
  };
  const agent = new ScriptedAgentRuntime(
    transcript,
    settleAgentWaiters,
    options.agentEvents,
  );
  const rootDir = mkdtempSync(
    path.join(tmpdir(), 'agent-nexus-discord-e2e-'),
  );
  const paths: DiscordE2EHarnessPaths = {
    rootDir,
    workingDir: path.join(rootDir, 'workdir'),
    stateDir: path.join(rootDir, 'state'),
    transcriptDir: path.join(rootDir, 'transcripts'),
  };
  mkdirSync(paths.workingDir, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.transcriptDir, { recursive: true });
  const engine = new Engine({
    platform,
    platformName: options.platformName ?? 'discord-main',
    platformAuth: options.platformAuth,
    idempotencyStore: new InMemoryIdempotencyStore(),
    agent,
    logger: createLogger({ level: 'fatal', pretty: false }),
    sessionStore: new SessionStore(),
    defaultSessionConfig: {
      workingDir: paths.workingDir,
      timeoutMs: 10_000,
    },
  });
  const sessionKey = options.sessionKey ?? DEFAULT_PLATFORM_SESSION_KEY;
  let nextInboundId = 1;

  const waitForAgentEvent = async (
    predicate: (entry: AgentTranscriptEvent) => boolean,
    timeoutMs = 1_000,
  ): Promise<AgentTranscriptEvent> => {
    const existing = transcript.events.find(
      (event): event is AgentTranscriptEvent =>
        event.kind === 'agent_event' &&
        !consumedAgentEvents.has(event) &&
        predicate(event),
    );
    if (existing) {
      consumedAgentEvents.add(existing);
      transcript.events.push({
        kind: 'assertion',
        name: 'waitForAgentEvent',
        passed: true,
      });
      return existing;
    }

    return await new Promise<AgentTranscriptEvent>((resolve, reject) => {
      const waiter: AgentWaiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          agentWaiters.delete(waiter);
          transcript.events.push({
            kind: 'assertion',
            name: 'waitForAgentEvent',
            passed: false,
            details: `no agent event matched within ${timeoutMs}ms`,
          });
          reject(new Error(`no agent event matched within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      agentWaiters.add(waiter);
    });
  };

  return {
    agent,
    paths,
    platform,
    transcript,
    async start(): Promise<void> {
      await engine.start();
    },
    async stop(): Promise<void> {
      await engine.stop();
      if (!options.keepArtifacts) {
        rmSync(paths.rootDir, { recursive: true, force: true });
      }
    },
    async injectMessage(
      text: string,
      overrides: InjectMessageOptions = {},
    ): Promise<NormalizedEvent> {
      const id = nextInboundId++;
      const eventSessionKey: PlatformSessionKey = {
        platform: sessionKey.platform,
        channelId: overrides.channelId ?? sessionKey.channelId,
        initiatorUserId:
          overrides.initiatorUserId ?? sessionKey.initiatorUserId,
      };
      const event: NormalizedEvent = {
        eventId: overrides.eventId ?? `e2e-event-${id}`,
        platform: 'discord',
        sessionKey: eventSessionKey,
        messageId: overrides.messageId ?? `e2e-message-${id}`,
        traceId: overrides.traceId ?? `e2e-trace-${id}`,
        type: 'message',
        text,
        rawPayload: {},
        rawContentType: 'application/json',
        receivedAt: new Date(),
        platformTimestamp: new Date(),
        guildId: overrides.guildId ?? 'G-e2e',
        initiatorRoleIds: overrides.initiatorRoleIds,
        initiator: {
          userId: eventSessionKey.initiatorUserId,
          displayName: overrides.displayName ?? 'e2e-owner',
          isBot: false,
        },
      };
      await platform.inject(event);
      return event;
    },
    waitForAgentEvent,
    async waitForOutbound(
      predicate: (entry: OutboundEvent) => boolean,
      timeoutMs = 1_000,
    ): Promise<OutboundEvent> {
      const existing = transcript.events.find(
        (event): event is OutboundEvent =>
          (event.kind === 'outbound_send' || event.kind === 'outbound_edit') &&
          !consumedOutbounds.has(event) &&
          predicate(event),
      );
      if (existing) {
        consumedOutbounds.add(existing);
        transcript.events.push({
          kind: 'assertion',
          name: 'waitForOutbound',
          passed: true,
        });
        return existing;
      }

      return await new Promise<OutboundEvent>((resolve, reject) => {
        const waiter: OutboundWaiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            outboundWaiters.delete(waiter);
            transcript.events.push({
              kind: 'assertion',
              name: 'waitForOutbound',
              passed: false,
              details: `no outbound matched within ${timeoutMs}ms`,
            });
            reject(new Error(`no outbound matched within ${timeoutMs}ms`));
          }, timeoutMs),
        };
        outboundWaiters.add(waiter);
      });
    },
    async waitForNoAgentCall(
      windowMs = 50,
      expectedTotal = 0,
    ): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, windowMs));
      const passed = agent.inputs.length === expectedTotal;
      transcript.events.push({
        kind: 'assertion',
        name: 'waitForNoAgentCall',
        passed,
        details: passed
          ? undefined
          : `expected ${expectedTotal} agent inputs, got ${agent.inputs.length}`,
      });
      if (!passed) {
        throw new Error(
          `expected ${expectedTotal} agent inputs, got ${agent.inputs.length}`,
        );
      }
    },
    async waitForTurnFinished(
      traceId: string,
      timeoutMs = 1_000,
    ): Promise<AgentTranscriptEvent> {
      return await waitForAgentEvent(
        (entry) =>
          entry.eventType === 'turn_finished' && entry.traceId === traceId,
        timeoutMs,
      );
    },
  };
}
