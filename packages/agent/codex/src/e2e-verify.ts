import type {
  AgentEvent,
  AgentEventHandler,
  AgentRuntime,
  AgentSession,
} from '@agent-nexus/protocol';
import type { Logger } from '@agent-nexus/daemon';

export type VerifyFailureKind =
  | 'environment_precondition'
  | 'model_behavior'
  | 'contract_failure';

export class VerifyError extends Error {
  constructor(
    readonly kind: VerifyFailureKind,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'VerifyError';
  }
}

export interface TwoTurnResumeResult {
  agentSessionId: string;
}

export function assertVerify(
  condition: unknown,
  kind: VerifyFailureKind,
  message: string,
  details?: unknown,
): asserts condition {
  if (!condition) throw new VerifyError(kind, message, details);
}

export function isCodexAuthPrecondition(message: string): boolean {
  return /401 Unauthorized|Missing bearer|basic authentication|not logged in|not authenticated/i.test(message);
}

export function isCodexBinaryPrecondition(message: string): boolean {
  return /ENOENT|command not found|spawn .* no such file|no such file or directory/i.test(
    message,
  );
}

function text(events: AgentEvent[]): string {
  return events
    .filter(
      (event): event is Extract<
        AgentEvent,
        { type: 'text_delta' | 'text_final' }
      > => event.type === 'text_delta' || event.type === 'text_final',
    )
    .map((event) => event.payload.text)
    .join('\n');
}

export function assertTwoTurnResume(
  firstTurnEvents: AgentEvent[],
  secondTurnEvents: AgentEvent[],
  nonce: string,
): TwoTurnResumeResult {
  const sessionStarted = firstTurnEvents.find(
    (event): event is Extract<AgentEvent, { type: 'session_started' }> =>
      event.type === 'session_started',
  );
  assertVerify(
    sessionStarted?.payload.agentSessionId,
    'contract_failure',
    'two-turn verify did not observe session_started with agentSessionId',
    { firstTurnEvents },
  );
  assertVerify(
    text(firstTurnEvents).includes('CODEX_E2E_TURN1_OK'),
    'model_behavior',
    'first Codex turn did not emit CODEX_E2E_TURN1_OK',
    { firstTurnEvents },
  );
  assertVerify(
    firstTurnEvents.some(
      (event) =>
        event.type === 'usage' && event.payload.completeness === 'partial',
    ),
    'contract_failure',
    'first Codex turn did not emit partial usage',
    { firstTurnEvents },
  );
  assertVerify(
    firstTurnEvents.some(
      (event) =>
        event.type === 'turn_finished' && event.payload.reason === 'stop',
    ),
    'contract_failure',
    'first Codex turn did not finish with reason=stop',
    { firstTurnEvents },
  );
  assertVerify(
    text(secondTurnEvents).includes(nonce),
    'model_behavior',
    'second Codex turn did not recall the nonce from resumed context',
    { nonce, secondTurnEvents },
  );
  assertVerify(
    secondTurnEvents.some(
      (event) =>
        event.type === 'turn_finished' && event.payload.reason === 'stop',
    ),
    'contract_failure',
    'second Codex turn did not finish with reason=stop',
    { secondTurnEvents },
  );
  assertVerify(
    !secondTurnEvents.some((event) => event.type === 'session_started'),
    'contract_failure',
    'resume turn emitted a second session_started event',
    { secondTurnEvents },
  );

  return { agentSessionId: sessionStarted.payload.agentSessionId };
}

export function assertErrorTurn(events: AgentEvent[]): void {
  assertVerify(
    events.some((event) => event.type === 'error'),
    'contract_failure',
    'error verify did not observe an AgentEvent error',
    { events },
  );
  assertVerify(
    events.some(
      (event) =>
        event.type === 'turn_finished' && event.payload.reason === 'error',
    ),
    'contract_failure',
    'error verify did not observe turn_finished reason=error',
    { events },
  );
}

export function assertInterruptTurn(events: AgentEvent[]): void {
  assertVerify(
    events.some(
      (event) =>
        event.type === 'tool_call_started' &&
        event.payload.toolName === 'command_execution',
    ),
    'model_behavior',
    'interrupt verify did not observe a command_execution start',
    { events },
  );
  assertVerify(
    events.some(
      (event) =>
        event.type === 'turn_finished' &&
        event.payload.reason === 'user_interrupt' &&
        (!event.payload.source || event.payload.source === 'runtime-synthesized'),
    ),
    'contract_failure',
    'interrupt verify did not observe user_interrupt terminal event',
    { events },
  );
  assertVerify(
    !events.some(
      (event) =>
        event.type === 'tool_call_finished' && event.payload.status === 'ok',
    ),
    'contract_failure',
    'interrupt verify observed an ok tool completion after interrupt',
    { events },
  );
}

export class RuntimeRecorder {
  readonly events: AgentEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: AgentEvent) => boolean;
    resolve: (event: AgentEvent) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(readonly runtime: AgentRuntime) {}

  sliceFrom(offset: number): AgentEvent[] {
    return this.events.slice(offset);
  }

  waitFor(
    predicate: (event: AgentEvent) => boolean,
    timeoutMs: number,
    label: string,
    kind: VerifyFailureKind = 'contract_failure',
  ): Promise<AgentEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<AgentEvent>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(
            new VerifyError(
              kind,
              `${label} was not observed within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  wrap(): AgentRuntime {
    const base = this.runtime;
    return {
      name: () => base.name(),
      capabilities: () => base.capabilities(),
      startSession: (key, config) => base.startSession(key, config),
      stopSession: (session) => base.stopSession(session),
      isAlive: (session) => base.isAlive(session),
      sendInput: (session, input) => base.sendInput(session, input),
      interrupt: (session) => base.interrupt(session),
      onEvent: (session: AgentSession, handler: AgentEventHandler): void => {
        base.onEvent(session, (event) => {
          this.record(event);
          return handler(event);
        });
      },
    };
  }

  private record(event: AgentEvent): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      this.removeWaiter(waiter);
      waiter.resolve(event);
    }
  }

  private removeWaiter(waiter: (typeof this.waiters)[number]): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx !== -1) this.waiters.splice(idx, 1);
    clearTimeout(waiter.timer);
  }
}

export const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
} as unknown as Logger;
