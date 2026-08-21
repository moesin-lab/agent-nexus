import { EventEmitter } from 'node:events';
import type {
  AgentCapabilitySet,
  AgentCommandEnvelope,
  AgentCommandResult,
  AgentEvent,
  AgentEventHandler,
  AgentInput,
  AgentRuntime,
  AgentSession,
  SessionConfig,
  SessionKey,
} from '@agent-nexus/protocol';
import type { CodexAppServerConfig } from './config.js';
import {
  AppServerForeignTurnError,
  type ControllerState,
  type TurnOutcome,
} from './controller.js';

export type { TurnOutcome } from './controller.js';

export interface CodexAppServerSessionEngine {
  start(resumeThreadId?: string): Promise<{ threadId: string; pid?: number }>;
  runTurn(text: string, clientUserMessageId: string): Promise<TurnOutcome>;
  interrupt(): Promise<boolean>;
  stop(): Promise<void>;
  status(): ControllerState;
  onFatal?(handler: (error: Error) => void): () => void;
}

export interface CodexAppServerRuntimeDependencies {
  createEngine(input: {
    key: SessionKey;
    sessionConfig: SessionConfig;
    backendConfig: CodexAppServerConfig;
  }): CodexAppServerSessionEngine;
}

interface ActiveTurn {
  traceId: string;
  turnSequence: number;
  terminal: boolean;
  interruptRequested: boolean;
  interruptCleanupStarted: boolean;
  interruptTimer?: NodeJS.Timeout;
  forcedInterrupt: Promise<ForcedInterruptOutcome>;
  resolveForcedInterrupt: (outcome: ForcedInterruptOutcome) => void;
}

type ForcedInterruptOutcome =
  | { kind: 'forced_interrupt'; ok: true }
  | { kind: 'forced_interrupt'; ok: false; error: unknown };

function isForcedInterruptOutcome(value: unknown): value is ForcedInterruptOutcome {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'forced_interrupt',
  );
}

function isTurnOutcome(value: unknown): value is TurnOutcome {
  if (!value || typeof value !== 'object' || !('status' in value) || !('text' in value)) {
    return false;
  }
  return (
    (value.status === 'completed' ||
      value.status === 'interrupted' ||
      value.status === 'failed') &&
    (typeof value.text === 'string' || value.text === null)
  );
}

interface RuntimeState {
  engine: CodexAppServerSessionEngine;
  emitter: EventEmitter;
  sessionConfig: SessionConfig;
  ready: Promise<void>;
  queue: Promise<void>;
  queuedTurns: number;
  nextSequence: number;
  nextTurnSequence: number;
  active: ActiveTurn | null;
  stopped: boolean;
  errored: boolean;
  sessionStoppedEmitted: boolean;
  safetyWarningEmitted: boolean;
  stopPromise: Promise<void> | null;
}

const CAPABILITIES: AgentCapabilitySet = {
  supportsThinking: false,
  supportsStreaming: false,
  supportsToolCallEvents: false,
  supportsInterrupt: true,
  supportsStdinInterrupt: false,
};

// Keep ordinary multiline text usable while rejecting C0/C1 controls that can
// change terminal or transport behavior without being visible to an operator.
const PROHIBITED_USER_TEXT_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export class CodexAppServerRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerRuntimeError';
  }
}

export function createCodexAppServerRuntime(
  backendConfig: CodexAppServerConfig,
  dependencies: CodexAppServerRuntimeDependencies,
): AgentRuntime {
  const states = new WeakMap<AgentSession, RuntimeState>();

  const getState = (session: AgentSession): RuntimeState => {
    const state = states.get(session);
    if (!state || session.backend !== 'codex-app-server') {
      throw new CodexAppServerRuntimeError('foreign or cloned AgentSession handle');
    }
    return state;
  };

  const emit = <T extends AgentEvent['type']>(
    state: RuntimeState,
    type: T,
    traceId: string,
    payload: Extract<AgentEvent, { type: T }>['payload'],
  ): void => {
    const event = {
      type,
      traceId,
      timestamp: new Date(),
      sequence: state.nextSequence++,
      payload,
    } as Extract<AgentEvent, { type: T }>;
    state.emitter.emit('event', event);
  };

  const finishTurn = (
    state: RuntimeState,
    reason: Extract<AgentEvent, { type: 'turn_finished' }>['payload']['reason'],
    source?: 'runtime-synthesized',
  ): void => {
    const active = state.active;
    if (!active || active.terminal) return;
    active.terminal = true;
    if (active.interruptTimer) {
      clearTimeout(active.interruptTimer);
      active.interruptTimer = undefined;
    }
    emit(state, 'turn_finished', active.traceId, {
      reason,
      turnSequence: active.turnSequence,
      ...(source ? { source } : {}),
    });
  };

  const emitSessionStopped = (
    state: RuntimeState,
    traceId: string,
    reason: Extract<AgentEvent, { type: 'session_stopped' }>['payload']['reason'],
  ): void => {
    if (state.sessionStoppedEmitted) return;
    state.sessionStoppedEmitted = true;
    emit(state, 'session_stopped', traceId, { reason });
  };

  const beginFatalCleanup = (
    session: AgentSession,
    state: RuntimeState,
    traceId: string,
  ): Promise<void> => {
    state.errored = true;
    session.state = 'Errored';
    if (!state.stopPromise) {
      state.stopPromise = Promise.resolve().then(() => state.engine.stop());
    }
    const cleanup = state.stopPromise;
    void cleanup.then(
      () => emitSessionStopped(state, traceId, 'error'),
      () => undefined,
    );
    return cleanup;
  };

  const forceInterruptedTurnCleanup = (
    session: AgentSession,
    state: RuntimeState,
    active: ActiveTurn,
  ): void => {
    if (state.active !== active || active.terminal || state.stopped) return;
    active.interruptCleanupStarted = true;
    finishTurn(state, 'user_interrupt', 'runtime-synthesized');
    state.stopped = true;
    session.state = 'Stopped';
    if (!state.stopPromise) {
      state.stopPromise = Promise.resolve().then(() => state.engine.stop());
    }
    void state.stopPromise.then(
      () => {
        emitSessionStopped(state, active.traceId, 'error');
        active.resolveForcedInterrupt({ kind: 'forced_interrupt', ok: true });
      },
      (error) => {
        emit(state, 'error', active.traceId, {
          errorKind: 'agent',
          code: 'codex_app_server_interrupt_stop_failed',
          message: error instanceof Error ? error.message : String(error),
        });
        active.resolveForcedInterrupt({
          kind: 'forced_interrupt',
          ok: false,
          error,
        });
      },
    );
  };

  const runInput = async (
    session: AgentSession,
    state: RuntimeState,
    input: AgentInput,
  ): Promise<void> => {
    await state.ready;
    if (state.stopped || state.errored || session.state === 'Stopped') {
      throw new CodexAppServerRuntimeError('session is stopped or errored');
    }
    if (input.type !== 'user_message' || typeof input.text !== 'string' || input.text.length === 0) {
      throw new CodexAppServerRuntimeError('codex-app-server 仅接受非空 user_message');
    }
    if (
      PROHIBITED_USER_TEXT_CONTROL.test(input.text) ||
      Buffer.byteLength(input.text) > backendConfig.maxInputBytes
    ) {
      throw new CodexAppServerRuntimeError('user_message 包含禁止控制字符或超过 maxInputBytes');
    }
    if (backendConfig.sandbox === 'danger-full-access' && !state.safetyWarningEmitted) {
      state.safetyWarningEmitted = true;
      emit(state, 'status', input.traceId, {
        message:
          '⚠️ 安全警告：当前 Codex session 使用 danger-full-access，远程操作者等价于可在本机执行命令并访问本机文件。',
      });
    }

    let resolveForcedInterrupt!: (outcome: ForcedInterruptOutcome) => void;
    const forcedInterrupt = new Promise<ForcedInterruptOutcome>((resolve) => {
      resolveForcedInterrupt = resolve;
    });
    const active: ActiveTurn = {
      traceId: input.traceId,
      turnSequence: state.nextTurnSequence++,
      terminal: false,
      interruptRequested: false,
      interruptCleanupStarted: false,
      forcedInterrupt,
      resolveForcedInterrupt,
    };
    state.active = active;
    session.state = 'Busy';
    let timeout: NodeJS.Timeout | undefined;
    let timeoutStopError: unknown;
    let interruptStopFailed = false;
    try {
      const backendTurn = state.engine.runTurn(input.text, input.traceId);
      const timedOut = Symbol('wallclock-timeout');
      const deadline = new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), state.sessionConfig.timeoutMs);
      });
      const outcome = await Promise.race([
        backendTurn,
        deadline,
        active.forcedInterrupt,
      ]);
      const forcedOutcome = isForcedInterruptOutcome(outcome)
        ? outcome
        : active.interruptCleanupStarted
          ? await active.forcedInterrupt
          : null;
      if (forcedOutcome) {
        if (!forcedOutcome.ok) {
          interruptStopFailed = true;
          throw forcedOutcome.error;
        }
        return;
      }
      if (state.active !== active || active.terminal) return;
      if (outcome === timedOut) {
        active.terminal = true;
        emit(state, 'turn_finished', input.traceId, {
          reason: 'wallclock_timeout',
          turnSequence: active.turnSequence,
          source: 'runtime-synthesized',
        });
        await state.engine.interrupt().catch(() => false);
        let cleanupTimer: NodeJS.Timeout | undefined;
        const cleanupConfirmed = await Promise.race([
          backendTurn.then(() => true, () => true),
          new Promise<false>((resolve) => {
            cleanupTimer = setTimeout(() => resolve(false), backendConfig.interruptGraceMs);
          }),
        ]).finally(() => {
          if (cleanupTimer) clearTimeout(cleanupTimer);
        });
        if (!cleanupConfirmed) {
          state.stopped = true;
          session.state = 'Stopped';
          if (!state.stopPromise) state.stopPromise = state.engine.stop();
          try {
            await state.stopPromise;
          } catch (error) {
            timeoutStopError = error;
            emit(state, 'error', input.traceId, {
              errorKind: 'agent',
              code: 'codex_app_server_timeout_stop_failed',
              message: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          emit(state, 'error', input.traceId, {
            errorKind: 'agent',
            code: 'codex_app_server_timeout_cleanup_failed',
            message: `Codex app-server did not confirm timeout cleanup within ${backendConfig.interruptGraceMs}ms`,
          });
          emitSessionStopped(state, input.traceId, 'wallclock_timeout');
        }
        return;
      }
      if (!isTurnOutcome(outcome)) {
        throw new CodexAppServerRuntimeError('invalid Codex turn outcome');
      }
      if (outcome.status === 'completed') {
        if (!outcome.text) {
          emit(state, 'error', input.traceId, {
            errorKind: 'agent',
            code: 'codex_app_server_missing_final',
            message: 'completed turn missing final agent message',
          });
          finishTurn(state, 'error');
        } else {
          emit(state, 'text_final', input.traceId, { text: outcome.text });
          finishTurn(state, 'stop');
        }
      } else if (outcome.status === 'interrupted') {
        finishTurn(state, 'user_interrupt');
      } else {
        emit(state, 'error', input.traceId, {
          errorKind: 'agent',
          code: 'codex_app_server_turn_failed',
          message: 'Codex app-server turn failed',
        });
        finishTurn(state, 'error');
      }
    } catch (error) {
      if (error === timeoutStopError || interruptStopFailed) throw error;
      if (state.active === active && !active.terminal && !state.stopped) {
        emit(state, 'error', input.traceId, {
          errorKind: 'agent',
          code: 'codex_app_server_turn_error',
          message: error instanceof Error ? error.message : String(error),
        });
        finishTurn(state, 'error');
        if (state.engine.status() === 'Errored' || state.engine.status() === 'Stopped') {
          void beginFatalCleanup(session, state, input.traceId);
        }
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (active.interruptTimer) clearTimeout(active.interruptTimer);
      if (state.active === active) state.active = null;
      if (!state.stopped && !state.errored) session.state = 'Idle';
    }
  };

  const runtime: AgentRuntime = {
    name: () => 'codex-app-server',
    capabilities: () => ({ ...CAPABILITIES }),

    startSession(key, sessionConfig) {
      const session: AgentSession = {
        key,
        backend: 'codex-app-server',
        state: 'Spawning',
        startedAt: new Date(),
        ...(sessionConfig.resumeFromAgentSessionId
          ? { agentSessionId: sessionConfig.resumeFromAgentSessionId }
          : {}),
      };
      const engine = dependencies.createEngine({ key, sessionConfig, backendConfig });
      let releaseReady!: () => void;
      const state: RuntimeState = {
        engine,
        emitter: new EventEmitter(),
        sessionConfig,
        ready: new Promise<void>((resolve) => {
          releaseReady = resolve;
        }),
        queue: Promise.resolve(),
        queuedTurns: 0,
        nextSequence: 0,
        nextTurnSequence: 1,
        active: null,
        stopped: false,
        errored: false,
        sessionStoppedEmitted: false,
        safetyWarningEmitted: false,
        stopPromise: null,
      };
      states.set(session, state);
      engine.onFatal?.((error) => {
        if (state.stopped || state.errored) return;
        const foreignTurn = error instanceof AppServerForeignTurnError;
        const traceId = foreignTurn ? 'system' : state.active?.traceId ?? 'system';
        if (!foreignTurn) {
          emit(state, 'error', traceId, {
            errorKind: 'agent',
            code: 'codex_app_server_host_fatal',
            message: error.message,
          });
          finishTurn(state, 'error', 'runtime-synthesized');
        } else if (state.active) {
          // Close the owned latch without attributing a viewer-originated turn to its trace.
          state.active.terminal = true;
        }
        void beginFatalCleanup(session, state, traceId);
      });

      void Promise.resolve().then(async () => {
        try {
          const started = await engine.start(sessionConfig.resumeFromAgentSessionId);
          if (state.stopped || state.errored) return;
          session.agentSessionId = started.threadId;
          if (started.pid !== undefined) session.pid = started.pid;
          session.state = 'Idle';
          emit(state, 'session_started', 'system', {
            agentSessionId: started.threadId,
            ...(started.pid === undefined ? {} : { pid: started.pid }),
            workingDir: sessionConfig.workingDir,
            capabilities: { ...CAPABILITIES },
          });
        } catch (error) {
          if (state.stopped || state.errored) return;
          emit(state, 'error', 'system', {
            errorKind: 'agent',
            code: 'codex_app_server_start_failed',
            message: error instanceof Error ? error.message : String(error),
          });
          void beginFatalCleanup(session, state, 'system');
        } finally {
          releaseReady();
        }
      });
      return session;
    },

    stopSession(session) {
      const state = getState(session);
      if (state.stopPromise) return state.stopPromise;
      state.stopped = true;
      session.state = 'Stopped';
      const traceId = state.active?.traceId ?? 'system';
      if (state.active && !state.active.terminal) {
        finishTurn(state, 'user_interrupt', 'runtime-synthesized');
      }
      state.stopPromise = state.engine.stop().then(() => {
        emitSessionStopped(state, traceId, 'user_stop');
      });
      return state.stopPromise;
    },

    isAlive(session) {
      const state = states.get(session);
      if (!state || state.stopped || state.errored || session.state === 'Stopped') return false;
      const engineStatus = state.engine.status();
      if (engineStatus === 'Errored' || engineStatus === 'Stopped') {
        void beginFatalCleanup(session, state, state.active?.traceId ?? 'system');
        return false;
      }
      return true;
    },

    async sendInput(session, input) {
      const state = getState(session);
      if (state.queuedTurns >= 1) {
        throw new CodexAppServerRuntimeError('sendInput queue is full');
      }
      state.queuedTurns += 1;
      const work = state.queue.then(async () => {
        state.queuedTurns -= 1;
        await runInput(session, state, input);
      });
      state.queue = work.catch(() => undefined);
      await work;
    },

    async handleCommand(session, command: AgentCommandEnvelope): Promise<AgentCommandResult> {
      if (command.handlerKey === 'new') {
        if (session) await runtime.stopSession(session);
        return { status: 'handled', message: '[new session ready]', updatedAgentSessionId: null };
      }
      if (command.handlerKey === 'stop') {
        if (!session) return { status: 'rejected', message: '[no active output]' };
        const state = getState(session);
        if (!state.active) return { status: 'rejected', message: '[no active output]' };
        runtime.interrupt(session);
        return { status: 'handled', message: '[stop requested]' };
      }
      if (command.handlerKey === 'status') {
        if (!session) return { status: 'handled', message: '[codex-app-server: no active session]' };
        const state = getState(session);
        return {
          status: 'handled',
          message: `[codex-app-server: ${state.engine.status()}]`,
        };
      }
      return { status: 'unsupported', message: '[unsupported command]' };
    },

    onEvent(session, handler: AgentEventHandler) {
      getState(session).emitter.on('event', handler);
    },

    interrupt(session) {
      const state = getState(session);
      const active = state.active;
      if (!active || active.terminal || active.interruptRequested || state.stopped) return;
      active.interruptRequested = true;
      active.interruptTimer = setTimeout(
        () => forceInterruptedTurnCleanup(session, state, active),
        backendConfig.interruptGraceMs,
      );
      void Promise.resolve()
        .then(() => state.engine.interrupt())
        .catch(() => undefined);
    },
  };

  return runtime;
}
