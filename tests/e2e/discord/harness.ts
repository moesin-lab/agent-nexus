import { mkdtempSync, rmSync } from 'node:fs';
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

export type ScriptedAgentEvents = (ctx: {
  session: AgentSession;
  input: AgentInput;
}) => AgentEvent[];

export interface DiscordE2EHarnessOptions {
  caseId?: string;
  platformName?: string;
  platformCaps?: Partial<CapabilitySet>;
  sessionKey?: PlatformSessionKey;
  agentEvents: ScriptedAgentEvents;
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
    const messageId = `fake-discord-${this.nextMessageId++}`;
    const ref: MessageRef = {
      platform: sessionKey.platform,
      channelId: sessionKey.channelId,
      messageId,
      messageIds: [messageId],
      sentAt: new Date(),
    };
    const entry: OutboundSendEvent = {
      kind: 'outbound_send',
      sessionKey,
      message,
      ref,
    };
    this.transcript.events.push(entry);
    this.onOutbound(entry);
    return ref;
  }

  async edit(ref: MessageRef, message: OutboundMessage): Promise<void> {
    const entry: OutboundEvent = {
      kind: 'outbound_edit',
      sessionKey: message.sessionKey,
      ref,
      message,
    };
    this.transcript.events.push(entry);
    this.onOutbound(entry);
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
      this.transcript.events.push({
        kind: 'agent_event',
        eventType: event.type,
        sequence: event.sequence,
        traceId: event.traceId,
      });
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
  injectMessage(text: string): Promise<NormalizedEvent>;
  platform: FakeDiscordPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  transcript: Transcript;
  waitForOutbound(
    predicate: (entry: OutboundEvent) => boolean,
    timeoutMs?: number,
  ): Promise<OutboundEvent>;
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
  const agent = new ScriptedAgentRuntime(transcript, options.agentEvents);
  const workingDir = mkdtempSync(
    path.join(tmpdir(), 'agent-nexus-discord-e2e-'),
  );
  const engine = new Engine({
    platform,
    platformName: options.platformName ?? 'discord-main',
    agent,
    logger: createLogger({ level: 'fatal', pretty: false }),
    sessionStore: new SessionStore(),
    defaultSessionConfig: {
      workingDir,
      timeoutMs: 10_000,
    },
  });
  const sessionKey = options.sessionKey ?? DEFAULT_PLATFORM_SESSION_KEY;
  let nextInboundId = 1;

  return {
    agent,
    platform,
    transcript,
    async start(): Promise<void> {
      await engine.start();
    },
    async stop(): Promise<void> {
      await engine.stop();
      rmSync(workingDir, { recursive: true, force: true });
    },
    async injectMessage(text: string): Promise<NormalizedEvent> {
      const id = nextInboundId++;
      const event: NormalizedEvent = {
        eventId: `e2e-event-${id}`,
        platform: 'discord',
        sessionKey,
        messageId: `e2e-message-${id}`,
        traceId: `e2e-trace-${id}`,
        type: 'message',
        text,
        rawPayload: {},
        rawContentType: 'application/json',
        receivedAt: new Date(),
        platformTimestamp: new Date(),
        guildId: 'G-e2e',
        initiator: {
          userId: sessionKey.initiatorUserId,
          displayName: 'e2e-owner',
          isBot: false,
        },
      };
      await platform.inject(event);
      return event;
    },
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
  };
}
