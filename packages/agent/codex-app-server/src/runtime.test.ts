import { describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  AgentInput,
  AgentSession,
  SessionConfig,
  SessionKey,
} from '@agent-nexus/protocol';
import {
  CodexAppServerRuntimeError,
  createCodexAppServerRuntime,
  type CodexAppServerSessionEngine,
  type TurnOutcome,
} from './runtime.js';
import type { CodexAppServerConfig } from './config.js';
import { AppServerForeignTurnError } from './controller.js';

class FakeEngine implements CodexAppServerSessionEngine {
  readonly starts: Array<string | undefined> = [];
  readonly turns: Array<{ text: string; clientUserMessageId: string }> = [];
  interruptCalls = 0;
  interruptError: Error | null = null;
  stopCalls = 0;
  outcomes: TurnOutcome[] = [];
  deferred: { promise: Promise<TurnOutcome>; resolve: (value: TurnOutcome) => void } | null = null;
  startDeferred: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | null = null;
  stopDeferred: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | null = null;
  controllerState: ReturnType<CodexAppServerSessionEngine['status']> = 'Idle';
  readonly fatalHandlers = new Set<(error: Error) => void>();

  async start(resumeThreadId?: string) {
    this.starts.push(resumeThreadId);
    await this.startDeferred?.promise;
    return { threadId: resumeThreadId ?? 'thr_new', pid: 1234 };
  }

  async runTurn(text: string, clientUserMessageId: string): Promise<TurnOutcome> {
    this.turns.push({ text, clientUserMessageId });
    if (this.deferred) return this.deferred.promise;
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error('missing fake outcome');
    return outcome;
  }

  async interrupt(): Promise<boolean> {
    this.interruptCalls += 1;
    if (this.interruptError) throw this.interruptError;
    return true;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopDeferred?.promise;
  }

  status() {
    return this.controllerState;
  }

  onFatal(handler: (error: Error) => void): () => void {
    this.fatalHandlers.add(handler);
    return () => this.fatalHandlers.delete(handler);
  }

  emitFatal(error: Error): void {
    this.controllerState = 'Errored';
    for (const handler of this.fatalHandlers) handler(error);
  }

  defer(): void {
    let resolve!: (value: TurnOutcome) => void;
    const promise = new Promise<TurnOutcome>((value) => {
      resolve = value;
    });
    this.deferred = { promise, resolve };
  }

  deferStop(): void {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.stopDeferred = { promise, resolve, reject };
  }

  deferStart(): void {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.startDeferred = { promise, resolve, reject };
  }
}

const key: SessionKey = {
  platformName: 'lark-main',
  platform: 'lark',
  channelId: 'chat-1',
  initiatorUserId: 'user-1',
};

const sessionConfig: SessionConfig = {
  sessionId: 'session-1',
  workingDir: '/workspace',
  timeoutMs: 30_000,
};

const config: CodexAppServerConfig = {
  bin: 'codex',
  workingDir: '/workspace',
  sandbox: 'read-only',
  addDirs: [],
  maxInputBytes: 262_144,
  requestTimeoutMs: 30_000,
  interruptGraceMs: 5_000,
  terminateGraceMs: 5_000,
  conversationRetentionMs: null,
};

const input = (text: string, traceId: string): AgentInput => ({
  type: 'user_message',
  text,
  traceId,
});

const waitFor = async (predicate: () => boolean): Promise<void> => {
  await vi.waitFor(() => expect(predicate()).toBe(true));
};

function setup(
  resumeFromAgentSessionId?: string,
  backendConfig: CodexAppServerConfig = config,
) {
  const engine = new FakeEngine();
  const runtime = createCodexAppServerRuntime(backendConfig, {
    createEngine: () => engine,
  });
  const session = runtime.startSession(key, {
    ...sessionConfig,
    ...(resumeFromAgentSessionId ? { resumeFromAgentSessionId } : {}),
  });
  const events: AgentEvent[] = [];
  runtime.onEvent(session, (event) => events.push(event));
  return { engine, runtime, session, events };
}

describe('createCodexAppServerRuntime', () => {
  it('should_emit_a_platform_visible_safety_warning_before_the_first_dangerous_turn', async () => {
    const { engine, runtime, session, events } = setup(undefined, {
      ...config,
      sandbox: 'danger-full-access',
    });
    engine.outcomes.push(
      { status: 'completed', text: 'FIRST' },
      { status: 'completed', text: 'SECOND' },
    );
    await waitFor(() => session.state === 'Idle');

    await runtime.sendInput(session, input('first', 'trace-danger-1'));
    await runtime.sendInput(session, input('second', 'trace-danger-2'));

    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'status',
      'text_final',
      'turn_finished',
      'text_final',
      'turn_finished',
    ]);
    expect(events[1]).toMatchObject({
      type: 'status',
      traceId: 'trace-danger-1',
      payload: { message: expect.stringMatching(/danger-full-access|远程.*本机/) },
    });
  });

  it('should_timeout_active_turn_once_and_ignore_late_backend_terminal', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    await waitFor(() => session.state === 'Idle');
    vi.useFakeTimers();
    try {
      const work = runtime.sendInput(session, input('slow', 'trace-timeout'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(engine.turns).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(sessionConfig.timeoutMs);
      await vi.advanceTimersByTimeAsync(config.interruptGraceMs);
      await work;

      expect(engine.interruptCalls).toBe(1);
      expect(events.filter((event) => event.type === 'turn_finished')).toEqual([
        expect.objectContaining({
          traceId: 'trace-timeout',
          payload: expect.objectContaining({
            reason: 'wallclock_timeout',
            source: 'runtime-synthesized',
          }),
        }),
      ]);
      expect(events.filter((event) => event.type === 'error')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ code: 'codex_app_server_timeout_cleanup_failed' }),
        }),
      ]);
      expect(engine.stopCalls).toBe(1);
      expect(session.state).toBe('Stopped');
      expect(events.at(-1)).toMatchObject({
        type: 'session_stopped',
        payload: { reason: 'wallclock_timeout' },
      });

      engine.deferred!.resolve({ status: 'completed', text: 'late' });
      await vi.runAllTicks();
      expect(events.some((event) => event.type === 'text_final')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should_keep_the_session_idle_when_timeout_interrupt_is_confirmed_within_grace', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    await waitFor(() => session.state === 'Idle');
    vi.useFakeTimers();
    try {
      const work = runtime.sendInput(session, input('slow', 'trace-clean-timeout'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(sessionConfig.timeoutMs);
      engine.deferred!.resolve({ status: 'interrupted', text: null });
      await work;

      expect(engine.stopCalls).toBe(0);
      expect(session.state).toBe('Idle');
      expect(events.filter((event) => event.type === 'turn_finished')).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ reason: 'wallclock_timeout' }) }),
      ]);
      expect(events.some((event) => event.type === 'session_stopped')).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should_reject_timeout_cleanup_when_forced_stop_fails_without_reporting_stopped', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    engine.deferStop();
    await waitFor(() => session.state === 'Idle');
    vi.useFakeTimers();
    try {
      const work = runtime.sendInput(session, input('slow', 'trace-timeout-stop-fails'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(sessionConfig.timeoutMs);
      await vi.advanceTimersByTimeAsync(config.interruptGraceMs);
      const stopError = new Error('forced stop failed');
      engine.stopDeferred!.reject(stopError);

      await expect(work).rejects.toBe(stopError);
      expect(events.some((event) => event.type === 'session_stopped')).toBe(false);
      expect(runtime.isAlive(session)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
  it('should_emit_session_started_after_engine_initializes_or_resumes', async () => {
    const { engine, runtime, session, events } = setup('thr_resume');
    await waitFor(() => events.length === 1);

    expect(engine.starts).toEqual(['thr_resume']);
    expect(events[0]).toMatchObject({
      type: 'session_started',
      sequence: 0,
      payload: { agentSessionId: 'thr_resume', pid: 1234, workingDir: '/workspace' },
    });
    expect(session.agentSessionId).toBe('thr_resume');
    expect(session.state).toBe('Idle');
    expect(runtime.isAlive(session)).toBe(true);
  });

  it('should_run_two_turns_serially_with_exact_terminal_order', async () => {
    const { engine, runtime, session, events } = setup();
    engine.outcomes.push(
      { status: 'completed', text: 'FIRST' },
      { status: 'completed', text: 'SECOND' },
    );
    await waitFor(() => session.state === 'Idle');

    await runtime.sendInput(session, input('first', 'trace-1'));
    await runtime.sendInput(session, input('second', 'trace-2'));

    expect(engine.turns.map((turn) => turn.text)).toEqual(['first', 'second']);
    expect(events.map((event) => event.type)).toEqual([
      'session_started',
      'text_final',
      'turn_finished',
      'text_final',
      'turn_finished',
    ]);
    expect(events.at(-1)).toMatchObject({
      traceId: 'trace-2',
      payload: { reason: 'stop', turnSequence: 2 },
    });
  });

  it('should_interrupt_busy_turn_and_emit_one_user_interrupt_terminal', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    await waitFor(() => session.state === 'Idle');
    const work = runtime.sendInput(session, input('long', 'trace-long'));
    await waitFor(() => engine.turns.length === 1);

    runtime.interrupt(session);
    await waitFor(() => engine.interruptCalls === 1);
    engine.deferred!.resolve({ status: 'interrupted', text: null });
    await work;

    expect(events.filter((event) => event.type === 'turn_finished')).toEqual([
      expect.objectContaining({
        traceId: 'trace-long',
        payload: expect.objectContaining({ reason: 'user_interrupt' }),
      }),
    ]);
    expect(session.state).toBe('Idle');
  });

  it('should_force_stop_once_when_interrupt_rpc_succeeds_but_terminal_never_arrives', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    await waitFor(() => session.state === 'Idle');
    vi.useFakeTimers();
    const work = runtime.sendInput(session, input('stuck', 'trace-interrupt-stuck'));
    try {
      await Promise.resolve();
      await Promise.resolve();
      runtime.interrupt(session);
      runtime.interrupt(session);

      await vi.advanceTimersByTimeAsync(config.interruptGraceMs);

      expect(engine.interruptCalls).toBe(1);
      expect(engine.stopCalls).toBe(1);
      await work;
      expect(events.filter((event) => event.type === 'turn_finished')).toEqual([
        expect.objectContaining({
          traceId: 'trace-interrupt-stuck',
          payload: expect.objectContaining({ reason: 'user_interrupt' }),
        }),
      ]);
      expect(events.at(-1)).toMatchObject({
        type: 'session_stopped',
        payload: { reason: 'error' },
      });
      expect(session.state).toBe('Stopped');
      expect(runtime.isAlive(session)).toBe(false);
    } finally {
      engine.deferred!.resolve({ status: 'interrupted', text: null });
      await work.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('should_force_stop_after_interrupt_rpc_rejects_instead_of_waiting_for_wallclock', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    engine.interruptError = new Error('interrupt rpc failed');
    await waitFor(() => session.state === 'Idle');
    vi.useFakeTimers();
    const work = runtime.sendInput(session, input('stuck', 'trace-interrupt-reject'));
    try {
      await Promise.resolve();
      await Promise.resolve();
      runtime.interrupt(session);

      await vi.advanceTimersByTimeAsync(config.interruptGraceMs);

      expect(engine.interruptCalls).toBe(1);
      expect(engine.stopCalls).toBe(1);
      await work;
      expect(events.filter((event) => event.type === 'turn_finished')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'session_stopped')).toEqual([
        expect.objectContaining({ payload: { reason: 'error' } }),
      ]);
      expect(session.state).toBe('Stopped');
    } finally {
      engine.deferred!.resolve({ status: 'interrupted', text: null });
      await work.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('should_keep_interrupt_cleanup_failed_when_process_exit_is_not_confirmed', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    engine.deferStop();
    await waitFor(() => session.state === 'Idle');
    vi.useFakeTimers();
    const work = runtime.sendInput(session, input('stuck', 'trace-interrupt-stop-failed'));
    const stopError = new Error('process group exit not confirmed');
    try {
      await Promise.resolve();
      await Promise.resolve();
      runtime.interrupt(session);
      await vi.advanceTimersByTimeAsync(config.interruptGraceMs);
      expect(engine.stopCalls).toBe(1);

      engine.stopDeferred!.reject(stopError);

      await expect(work).rejects.toBe(stopError);
      await expect(runtime.stopSession(session)).rejects.toBe(stopError);
      expect(events.filter((event) => event.type === 'turn_finished')).toEqual([
        expect.objectContaining({
          traceId: 'trace-interrupt-stop-failed',
          payload: expect.objectContaining({ reason: 'user_interrupt' }),
        }),
      ]);
      expect(events.filter((event) => event.type === 'session_stopped')).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        payload: { code: 'codex_app_server_interrupt_stop_failed' },
      });
    } finally {
      engine.deferred!.resolve({ status: 'interrupted', text: null });
      await work.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('should_wait_for_interrupt_cleanup_when_stop_settles_the_backend_turn_first', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    await waitFor(() => session.state === 'Idle');
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
    engine.stop = vi.fn(async () => {
      engine.stopCalls += 1;
      engine.deferred!.resolve({ status: 'interrupted', text: null });
      await cleanup;
    });
    vi.useFakeTimers();
    const work = runtime.sendInput(session, input('stuck', 'trace-stop-settles-turn'));
    let workSettled = false;
    void work.then(
      () => { workSettled = true; },
      () => { workSettled = true; },
    );
    const stopError = new Error('host cleanup rejected after controller stopped');
    try {
      await Promise.resolve();
      await Promise.resolve();
      runtime.interrupt(session);
      await vi.advanceTimersByTimeAsync(config.interruptGraceMs);
      await Promise.resolve();
      await Promise.resolve();

      expect(engine.stopCalls).toBe(1);
      expect(workSettled).toBe(false);

      rejectCleanup(stopError);
      await expect(work).rejects.toBe(stopError);
      expect(events.filter((event) => event.type === 'session_stopped')).toEqual([]);
    } finally {
      rejectCleanup(stopError);
      await work.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('should_map_failed_turn_to_error_then_terminal', async () => {
    const { engine, runtime, session, events } = setup();
    engine.outcomes.push({ status: 'failed', text: null });
    await waitFor(() => session.state === 'Idle');

    await runtime.sendInput(session, input('fail', 'trace-fail'));

    expect(events.slice(-2).map((event) => event.type)).toEqual(['error', 'turn_finished']);
    expect(events.at(-1)).toMatchObject({ payload: { reason: 'error' } });
  });

  it('should_stop_the_runtime_only_after_fatal_controller_cleanup_is_confirmed', async () => {
    const { engine, runtime, session, events } = setup();
    engine.deferStop();
    await waitFor(() => session.state === 'Idle');
    engine.controllerState = 'Errored';
    engine.runTurn = vi.fn(async () => {
      throw new Error('host protocol failed');
    });

    await runtime.sendInput(session, input('fail', 'trace-host-fatal'));

    expect(session.state).toBe('Errored');
    expect(runtime.isAlive(session)).toBe(false);
    await waitFor(() => engine.stopCalls === 1);
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);

    const stopping = runtime.stopSession(session);
    engine.stopDeferred!.resolve();
    await stopping;
    expect(events.filter((event) => event.type === 'session_stopped')).toEqual([
      expect.objectContaining({ payload: { reason: 'error' } }),
    ]);
  });

  it('should_keep_idle_fatal_cleanup_failed_without_reporting_stopped', async () => {
    const { engine, runtime, session, events } = setup();
    engine.deferStop();
    await waitFor(() => session.state === 'Idle');
    engine.controllerState = 'Errored';

    expect(runtime.isAlive(session)).toBe(false);
    expect(session.state).toBe('Errored');
    await waitFor(() => engine.stopCalls === 1);
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);

    const stopError = new Error('idle fatal cleanup failed');
    engine.stopDeferred!.reject(stopError);
    await expect(runtime.stopSession(session)).rejects.toBe(stopError);
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);
  });

  it('should_begin_idle_fatal_cleanup_without_waiting_for_an_isAlive_poll', async () => {
    const { engine, runtime, session, events } = setup();
    engine.deferStop();
    await waitFor(() => session.state === 'Idle');

    engine.emitFatal(new Error('app-server exited while idle'));
    await Promise.resolve();
    await Promise.resolve();

    expect(session.state).toBe('Errored');
    expect(engine.stopCalls).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        payload: expect.objectContaining({ code: 'codex_app_server_host_fatal' }),
      }),
    );
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);

    engine.stopDeferred!.resolve();
    await runtime.stopSession(session);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'session_stopped', payload: { reason: 'error' } }),
    );
  });

  it('should_cleanup_an_idle_foreign_turn_without_emitting_a_platform_error', async () => {
    const { engine, runtime, session, events } = setup();
    engine.deferStop();
    await waitFor(() => session.state === 'Idle');

    engine.emitFatal(new AppServerForeignTurnError('unsupported foreign turn/started'));
    await waitFor(() => engine.stopCalls === 1);

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.filter((event) => event.type === 'text_final')).toEqual([]);
    engine.stopDeferred!.resolve();
    await runtime.stopSession(session);
    expect(events.map((event) => event.type)).toEqual(['session_started', 'session_stopped']);
  });

  it('should_cleanup_a_busy_foreign_turn_without_binding_events_to_the_platform_trace', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    engine.deferStop();
    await waitFor(() => session.state === 'Idle');
    const work = runtime.sendInput(session, input('owned', 'trace-owned'));
    await waitFor(() => engine.turns.length === 1);

    engine.emitFatal(new AppServerForeignTurnError('unsupported foreign turn/started'));
    await waitFor(() => engine.stopCalls === 1);
    expect(events.map((event) => event.type)).toEqual(['session_started']);

    engine.deferred!.resolve({ status: 'failed', text: null });
    await work;
    engine.stopDeferred!.resolve();
    await runtime.stopSession(session);
    expect(events.map((event) => event.type)).toEqual(['session_started', 'session_stopped']);
    expect(events.at(-1)?.traceId).toBe('system');
  });

  it('should_not_relabel_a_foreign_turn_during_startup_as_a_start_error', async () => {
    const { engine, runtime, session, events } = setup();
    engine.deferStart();
    engine.deferStop();
    await Promise.resolve();

    engine.emitFatal(new AppServerForeignTurnError('foreign turn during viewer startup'));
    await waitFor(() => engine.stopCalls === 1);
    engine.startDeferred!.reject(new AppServerForeignTurnError('foreign turn during startup'));
    engine.stopDeferred!.resolve();
    await runtime.stopSession(session);

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(['session_stopped']);
  });

  it('should_cleanup_a_start_failure_and_preserve_a_rejected_stop_barrier', async () => {
    const { engine, runtime, session, events } = setup();
    engine.deferStart();
    engine.deferStop();
    const startError = new Error('initialize failed');
    engine.startDeferred!.reject(startError);

    await waitFor(() => events.some((event) => event.type === 'error'));
    await waitFor(() => engine.stopCalls === 1);
    expect(session.state).toBe('Errored');
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);

    const stopError = new Error('start rollback cleanup failed');
    engine.stopDeferred!.reject(stopError);
    await expect(runtime.stopSession(session)).rejects.toBe(stopError);
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);
  });

  it('should_reject_a_cloned_or_foreign_session_handle', async () => {
    const { runtime, session } = setup();
    await waitFor(() => session.state === 'Idle');
    const clone: AgentSession = { ...session };

    await expect(runtime.sendInput(clone, input('x', 'trace'))).rejects.toBeInstanceOf(
      CodexAppServerRuntimeError,
    );
    expect(() => runtime.interrupt(clone)).toThrow(CodexAppServerRuntimeError);
  });

  it('should_report_structured_session_status_without_exposing_the_thread_id', async () => {
    const { engine, runtime, session } = setup();
    await waitFor(() => session.state === 'Idle');
    engine.controllerState = 'Busy';

    await expect(
      runtime.handleCommand(session, {
        canonicalId: 'agent:codex-app-server:status',
        handlerKey: 'status',
        localName: 'status',
        args: {},
        traceId: 'trace-status',
        routingSession: {
          sessionKey: key,
          platformName: 'lark-main',
          platformType: 'lark',
          channelId: 'chat-1',
          userId: 'user-1',
        },
      }),
    ).resolves.toEqual({ status: 'handled', message: '[codex-app-server: Busy]' });
  });

  it('should_await_one_shared_engine_stop_before_emitting_session_stopped', async () => {
    const { engine, runtime, session, events } = setup();
    engine.defer();
    engine.deferStop();
    await waitFor(() => session.state === 'Idle');
    void runtime.sendInput(session, input('long', 'trace-stop'));
    await waitFor(() => engine.turns.length === 1);

    const stopping = runtime.stopSession(session);
    const duplicate = runtime.stopSession(session);
    await waitFor(() => engine.stopCalls === 1);
    expect(duplicate).toBe(stopping);
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);

    engine.stopDeferred!.resolve();
    await stopping;

    expect(events.filter((event) => event.type === 'turn_finished')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'session_stopped',
      payload: { reason: 'user_stop' },
    });
    expect(runtime.isAlive(session)).toBe(false);
  });

  it('should_reject_stop_without_reporting_session_cleanup_success', async () => {
    const { engine, runtime, session, events } = setup();
    engine.deferStop();
    await waitFor(() => session.state === 'Idle');

    const stopping = runtime.stopSession(session);
    const stopError = new Error('viewer cleanup not confirmed');
    engine.stopDeferred!.reject(stopError);

    await expect(stopping).rejects.toBe(stopError);
    expect(events.some((event) => event.type === 'session_stopped')).toBe(false);
    expect(runtime.isAlive(session)).toBe(false);
  });

  it('should_not_report_a_start_failure_after_stop_wins_the_startup_race', async () => {
    const { engine, runtime, session, events } = setup();
    engine.deferStart();

    const stopping = runtime.stopSession(session);
    engine.startDeferred!.reject(new Error('engine stopped during startup'));
    await stopping;
    await waitFor(() => engine.starts.length === 1);

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.filter((event) => event.type === 'session_stopped')).toEqual([
      expect.objectContaining({ payload: { reason: 'user_stop' } }),
    ]);
    expect(session.state).toBe('Stopped');
  });
});
