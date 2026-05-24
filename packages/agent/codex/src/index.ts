export {
  CodexConfigError,
  DEFAULT_BIN,
  DEFAULT_SANDBOX,
  parseCodexConfig,
  SANDBOX_MODES,
  type CodexConfig,
  type CodexSandbox,
} from './config.js';
export {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  CodexCompatibilityProbeError,
  runCompatibilityProbe,
  type CodexCompatibilityProbeOptions,
} from './probe.js';

import type {
  AgentCapabilitySet,
  AgentEvent,
  AgentEventHandler,
  AgentInput,
  AgentRuntime,
  AgentSession,
  SessionConfig,
  SessionKey,
  ToolCallStatus,
  TurnEndReason,
  UsageRecord,
} from '@agent-nexus/protocol';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { execa } from 'execa';
import type { Logger } from '@agent-nexus/daemon';
import type { CodexConfig } from './config.js';
import { buildCodexExecArgs, buildCodexResumeArgs } from './probe.js';

const capabilities: AgentCapabilitySet = {
  supportsThinking: false,
  supportsStreaming: false,
  supportsToolCallEvents: true,
  supportsInterrupt: true,
  supportsStdinInterrupt: false,
};

type ChildProcess = ReturnType<typeof execa> & {
  stdout?: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
};

interface ToolCallState {
  toolName: string;
  resultSequence: number;
  finished: boolean;
}

interface TurnState {
  traceId: string;
  turnSequence: number;
  startedAtMs: number;
  toolCalls: Map<string, ToolCallState>;
  sawThreadStarted: boolean;
  terminalEmitted: boolean;
  resolve: () => void;
  timeout?: NodeJS.Timeout;
}

interface RuntimeState {
  emitter: EventEmitter;
  sessionConfig: SessionConfig;
  proc?: ChildProcess;
  queue: Promise<void>;
  queuedTurns: number;
  nextSequence: number;
  nextTurnSequence: number;
  currentTurn?: TurnState;
  cleanupBarrier?: Promise<void>;
  cleanupBarrierResolve?: () => void;
  cleanupTimers: NodeJS.Timeout[];
  sessionStarted: boolean;
  stopped: boolean;
  errored: boolean;
}

export interface CodexRuntimeOptions {
  config: CodexConfig;
  logger: Logger;
  gracefulInterruptMs?: number;
  sigtermGraceMs?: number;
}

const stateMap = new WeakMap<AgentSession, RuntimeState>();

function makeEvent(
  state: RuntimeState,
  type: AgentEvent['type'],
  traceId: string,
  payload: AgentEvent['payload'],
): AgentEvent {
  return {
    type,
    traceId,
    timestamp: new Date(),
    sequence: state.nextSequence++,
    payload,
  } as AgentEvent;
}

function emitEvent(
  state: RuntimeState,
  type: AgentEvent['type'],
  traceId: string,
  payload: AgentEvent['payload'],
): void {
  state.emitter.emit('event', makeEvent(state, type, traceId, payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function truncate(value: string, max = 240): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clearTurnTimer(turn: TurnState): void {
  if (turn.timeout) clearTimeout(turn.timeout);
  turn.timeout = undefined;
}

function clearCleanupTimers(state: RuntimeState): void {
  for (const timer of state.cleanupTimers) clearTimeout(timer);
  state.cleanupTimers = [];
}

function finishOpenToolCalls(
  state: RuntimeState,
  turn: TurnState,
  statusOverride?: ToolCallStatus,
): void {
  for (const [callId, tool] of turn.toolCalls) {
    if (tool.finished) continue;
    tool.finished = true;
    emitEvent(state, 'tool_call_finished', turn.traceId, {
      callId,
      toolName: tool.toolName,
      status: statusOverride ?? 'error',
    });
  }
}

function finishTurn(
  state: RuntimeState,
  reason: TurnEndReason,
  source?: 'runtime-synthesized',
): void {
  const turn = state.currentTurn;
  if (!turn || turn.terminalEmitted) return;
  turn.terminalEmitted = true;
  clearTurnTimer(turn);
  finishOpenToolCalls(
    state,
    turn,
    reason === 'user_interrupt' ? 'cancelled' : 'error',
  );
  emitEvent(state, 'turn_finished', turn.traceId, {
    reason,
    turnSequence: turn.turnSequence,
    ...(source ? { source } : {}),
  });
  turn.resolve();
}

function cleanupAfterTurn(session: AgentSession, state: RuntimeState): void {
  const turn = state.currentTurn;
  if (turn) clearTurnTimer(turn);
  clearCleanupTimers(state);
  state.currentTurn = undefined;
  state.proc = undefined;
  state.cleanupBarrierResolve?.();
  state.cleanupBarrier = undefined;
  state.cleanupBarrierResolve = undefined;
  session.pid = undefined;
  if (!state.stopped && !state.errored) session.state = 'Idle';
}

function usageRecordFromCodex(
  runtimeConfig: CodexConfig,
  turn: TurnState,
  usage: unknown,
): UsageRecord {
  const raw = isRecord(usage) ? usage : {};
  return {
    model: runtimeConfig.model ?? 'unknown',
    inputTokens: numeric(raw['input_tokens']),
    outputTokens: numeric(raw['output_tokens']),
    cacheReadTokens: numeric(raw['cached_input_tokens']),
    cacheWriteTokens: 0,
    costUsd: null,
    turnSequence: turn.turnSequence,
    toolCallsThisTurn: turn.toolCalls.size,
    wallClockMs: Date.now() - turn.startedAtMs,
    completeness: 'partial',
  };
}

export function createCodexRuntime(opts: CodexRuntimeOptions): AgentRuntime {
  const { config: runtimeConfig, logger } = opts;
  const gracefulInterruptMs = opts.gracefulInterruptMs ?? 5_000;
  const sigtermGraceMs = opts.sigtermGraceMs ?? 5_000;

  function getState(session: AgentSession): RuntimeState {
    const state = stateMap.get(session);
    if (!state) throw new Error('unknown session');
    return state;
  }

  function emitErrorTurn(
    state: RuntimeState,
    traceId: string,
    code: string,
    message: string,
  ): void {
    emitEvent(state, 'error', traceId, { errorKind: 'agent', code, message });
    emitEvent(state, 'turn_finished', traceId, {
      reason: 'error',
      turnSequence: state.nextTurnSequence++,
    });
  }

  function stopWithError(
    session: AgentSession,
    state: RuntimeState,
    traceId: string,
    code: string,
    message: string,
  ): void {
    state.errored = true;
    session.state = 'Errored';
    state.proc?.kill('SIGTERM');
    emitEvent(state, 'error', traceId, { errorKind: 'agent', code, message });
    if (state.currentTurn && !state.currentTurn.terminalEmitted) {
      finishTurn(state, 'error');
    }
    emitEvent(state, 'session_stopped', traceId, { reason: 'error' });
    cleanupAfterTurn(session, state);
  }

  function beginCleanupTimers(
    session: AgentSession,
    state: RuntimeState,
    proc: ChildProcess,
  ): void {
    if (!state.cleanupBarrier) {
      state.cleanupBarrier = new Promise<void>((resolve) => {
        state.cleanupBarrierResolve = resolve;
      });
    }
    clearCleanupTimers(state);
    state.cleanupTimers.push(
      setTimeout(() => {
        proc.kill('SIGTERM');
      }, gracefulInterruptMs),
      setTimeout(() => {
        proc.kill('SIGKILL');
        cleanupAfterTurn(session, state);
      }, gracefulInterruptMs + sigtermGraceMs),
    );
  }

  function handleThreadStarted(
    session: AgentSession,
    state: RuntimeState,
    threadId: unknown,
  ): void {
    const turn = state.currentTurn;
    const traceId = turn?.traceId ?? 'system';
    if (typeof threadId !== 'string' || threadId.length === 0) {
      stopWithError(
        session,
        state,
        traceId,
        'codex_thread_missing',
        'Codex thread.started event did not include thread_id',
      );
      return;
    }
    const expected = session.agentSessionId;
    if (expected && expected !== threadId) {
      stopWithError(
        session,
        state,
        traceId,
        'codex_thread_mismatch',
        'Codex resumed thread_id did not match the expected session id',
      );
      return;
    }
    session.agentSessionId = threadId;
    if (turn) turn.sawThreadStarted = true;
    if (state.sessionStarted) return;
    state.sessionStarted = true;
    emitEvent(state, 'session_started', traceId, {
      agentSessionId: threadId,
      pid: session.pid,
      workingDir: runtimeConfig.workingDir,
      capabilities,
    });
  }

  function handleCommandStarted(state: RuntimeState, item: Record<string, unknown>): void {
    const turn = state.currentTurn;
    if (!turn || turn.terminalEmitted) return;
    const id = safeString(item['id']);
    if (!id) return;
    turn.toolCalls.set(id, {
      toolName: 'command_execution',
      resultSequence: 0,
      finished: false,
    });
    emitEvent(state, 'tool_call_started', turn.traceId, {
      callId: id,
      toolName: 'command_execution',
      inputSummary: truncate(safeString(item['command']) ?? ''),
    });
  }

  function handleCommandCompleted(
    state: RuntimeState,
    item: Record<string, unknown>,
  ): void {
    const turn = state.currentTurn;
    if (!turn || turn.terminalEmitted) return;
    const id = safeString(item['id']);
    if (!id) return;
    let tool = turn.toolCalls.get(id);
    if (!tool) {
      tool = {
        toolName: 'command_execution',
        resultSequence: 0,
        finished: false,
      };
      turn.toolCalls.set(id, tool);
    }
    const status =
      item['status'] === 'completed' && item['exit_code'] === 0 ? 'ok' : 'error';
    const output = typeof item['aggregated_output'] === 'string'
      ? item['aggregated_output']
      : '';
    emitEvent(state, 'tool_result', turn.traceId, {
      callId: id,
      resultSequence: tool.resultSequence++,
      content: { kind: 'text', text: output },
      isError: status === 'error',
    });
    tool.finished = true;
    emitEvent(state, 'tool_call_finished', turn.traceId, {
      callId: id,
      toolName: tool.toolName,
      status,
      ...(status === 'error'
        ? {
            errorSummary: `exit_code=${String(item['exit_code'])} status=${String(item['status'])}`,
          }
        : {}),
    });
  }

  function handleItem(
    state: RuntimeState,
    item: unknown,
  ): void {
    const turn = state.currentTurn;
    if (!turn || turn.terminalEmitted || !isRecord(item)) return;
    const itemType = item['type'];
    if (itemType === 'agent_message') {
      const text = item['text'];
      if (typeof text === 'string') {
        emitEvent(state, 'text_final', turn.traceId, { text });
      }
    } else if (itemType === 'command_execution') {
      handleCommandCompleted(state, item);
    } else {
      logger.debug(
        {
          itemId: typeof item['id'] === 'string' ? item['id'] : undefined,
          itemType,
        },
        'codex_unknown_item',
      );
    }
  }

  function handleCodexEvent(
    session: AgentSession,
    state: RuntimeState,
    event: Record<string, unknown>,
  ): void {
    const turn = state.currentTurn;
    const type = event['type'];
    if (type === 'thread.started') {
      handleThreadStarted(session, state, event['thread_id']);
    } else if (type === 'turn.started') {
      return;
    } else if (type === 'item.started') {
      const item = event['item'];
      if (turn && !turn.terminalEmitted && isRecord(item)) {
        if (item['type'] === 'command_execution') {
          handleCommandStarted(state, item);
        } else {
          logger.debug(
            {
              itemId: typeof item['id'] === 'string' ? item['id'] : undefined,
              itemType: item['type'],
            },
            'codex_unknown_item',
          );
        }
      }
    } else if (type === 'item.completed') {
      handleItem(state, event['item']);
    } else if (type === 'turn.completed') {
      if (!turn || turn.terminalEmitted) return;
      if (!turn.sawThreadStarted) {
        stopWithError(
          session,
          state,
          turn.traceId,
          'codex_thread_missing',
          'Codex turn completed before thread.started bound the session id',
        );
        return;
      }
      emitEvent(
        state,
        'usage',
        turn.traceId,
        usageRecordFromCodex(runtimeConfig, turn, event['usage']),
      );
      finishTurn(state, 'stop');
      cleanupAfterTurn(session, state);
    } else if (type === 'error') {
      if (!turn || turn.terminalEmitted) return;
      emitEvent(state, 'error', turn.traceId, {
        errorKind: 'agent',
        code: 'codex_error',
        message: safeString(event['message']) ?? 'Codex CLI emitted an error',
      });
    } else if (type === 'turn.failed') {
      if (!turn || turn.terminalEmitted) return;
      const err = isRecord(event['error']) ? event['error'] : {};
      emitEvent(state, 'error', turn.traceId, {
        errorKind: 'agent',
        code: 'codex_turn_failed',
        message: safeString(err['message']) ?? 'Codex CLI turn failed',
      });
      finishTurn(state, 'error');
      cleanupAfterTurn(session, state);
    } else {
      logger.debug({ eventType: type }, 'codex_unknown_event');
    }
  }

  async function readStdoutLoop(
    session: AgentSession,
    state: RuntimeState,
    proc: ChildProcess,
  ): Promise<void> {
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        logger.debug({ line: truncate(line) }, 'codex_non_json_line');
        continue;
      }
      if (!isRecord(parsed)) continue;
      handleCodexEvent(session, state, parsed);
    }
  }

  async function runTurn(
    session: AgentSession,
    state: RuntimeState,
    input: AgentInput,
  ): Promise<void> {
    if (state.cleanupBarrier) await state.cleanupBarrier;
    if (state.stopped || state.errored) {
      emitErrorTurn(
        state,
        input.traceId,
        'session_stopped',
        'sendInput called after session cleanup failed',
      );
      return;
    }
    const traceId = input.traceId;
    const prompt = input.text ?? '';
    const threadId = session.agentSessionId ?? state.sessionConfig.resumeFromAgentSessionId;
    const args = threadId
      ? buildCodexResumeArgs(runtimeConfig, threadId, prompt)
      : buildCodexExecArgs(runtimeConfig, prompt);

    await new Promise<void>((resolve) => {
      const turn: TurnState = {
        traceId,
        turnSequence: state.nextTurnSequence++,
        startedAtMs: Date.now(),
        toolCalls: new Map(),
        sawThreadStarted: false,
        terminalEmitted: false,
        resolve,
      };
      state.currentTurn = turn;
      session.state = 'Busy';

      let proc: ChildProcess;
      try {
        proc = execa(runtimeConfig.bin, args, {
          buffer: false,
          stdin: 'ignore',
        }) as ChildProcess;
      } catch (err) {
        emitEvent(state, 'error', traceId, {
          errorKind: 'agent',
          code: 'codex_spawn_failed',
          message: err instanceof Error ? err.message : String(err),
        });
        finishTurn(state, 'error');
        cleanupAfterTurn(session, state);
        return;
      }

      if (!proc.stdout) {
        emitEvent(state, 'error', traceId, {
          errorKind: 'agent',
          code: 'codex_stdout_missing',
          message: 'Codex subprocess stdout is missing',
        });
        proc.kill('SIGTERM');
        finishTurn(state, 'error');
        cleanupAfterTurn(session, state);
        return;
      }

      state.proc = proc;
      session.pid = proc.pid;
      turn.timeout = setTimeout(() => {
        proc.kill('SIGINT');
        finishTurn(state, 'wallclock_timeout', 'runtime-synthesized');
        emitEvent(state, 'error', traceId, {
          errorKind: 'agent',
          code: 'codex_wallclock_timeout',
          message: 'Codex turn exceeded wallclock timeout',
        });
        beginCleanupTimers(session, state, proc);
      }, state.sessionConfig.timeoutMs);

      readStdoutLoop(session, state, proc).catch((err: unknown) => {
        if (!state.stopped && !state.errored && !turn.terminalEmitted) {
          stopWithError(
            session,
            state,
            traceId,
            'codex_stdout_error',
            err instanceof Error ? err.message : String(err),
          );
        }
      });

      void Promise.resolve(proc).then(
        () => {
          if (!state.stopped && !state.errored && state.currentTurn === turn) {
            if (!turn.terminalEmitted) {
              emitEvent(state, 'error', traceId, {
                errorKind: 'agent',
                code: 'codex_process_exited_without_terminal',
                message: 'Codex process exited without a terminal JSONL event',
              });
              finishTurn(state, 'error');
            }
            cleanupAfterTurn(session, state);
          }
        },
        (err: unknown) => {
          if (!state.stopped && !state.errored && state.currentTurn === turn) {
            if (!turn.terminalEmitted) {
              emitEvent(state, 'error', traceId, {
                errorKind: 'agent',
                code: 'codex_subproc_error',
                message: err instanceof Error ? err.message : String(err),
              });
              finishTurn(state, 'error');
              emitEvent(state, 'session_stopped', traceId, { reason: 'error' });
            }
            cleanupAfterTurn(session, state);
          }
        },
      );
    });
  }

  return {
    name(): string {
      return 'codex';
    },

    capabilities(): AgentCapabilitySet {
      return capabilities;
    },

    startSession(key: SessionKey, sessionConfig: SessionConfig): AgentSession {
      const session: AgentSession = {
        key,
        backend: 'codex',
        state: 'Idle',
        startedAt: new Date(),
        agentSessionId: sessionConfig.resumeFromAgentSessionId,
      };
      stateMap.set(session, {
        emitter: new EventEmitter(),
        sessionConfig,
        queue: Promise.resolve(),
        queuedTurns: 0,
        nextSequence: 0,
        nextTurnSequence: 1,
        cleanupTimers: [],
        sessionStarted: false,
        stopped: false,
        errored: false,
      });
      return session;
    },

    stopSession(session: AgentSession): void {
      const state = getState(session);
      state.stopped = true;
      session.state = 'Stopped';
      state.proc?.kill('SIGTERM');
      clearCleanupTimers(state);
      if (state.currentTurn && !state.currentTurn.terminalEmitted) {
        finishTurn(state, 'error');
      }
      emitEvent(state, 'session_stopped', state.currentTurn?.traceId ?? 'system', {
        reason: 'user_stop',
      });
      cleanupAfterTurn(session, state);
    },

    isAlive(session: AgentSession): boolean {
      const state = stateMap.get(session);
      return session.state !== 'Stopped' && state?.errored !== true;
    },

    async sendInput(session: AgentSession, input: AgentInput): Promise<void> {
      const state = getState(session);
      if (session.state === 'Stopped' || state.errored) {
        emitErrorTurn(
          state,
          input.traceId,
          'session_stopped',
          'sendInput called on stopped session',
        );
        return;
      }
      if (state.currentTurn && state.queuedTurns >= 1) {
        emitErrorTurn(
          state,
          input.traceId,
          'concurrent_send_input',
          'sendInput queue is full',
        );
        return;
      }
      state.queuedTurns++;
      const work = state.queue.then(async () => {
        state.queuedTurns--;
        await runTurn(session, state, input);
      });
      state.queue = work.catch(() => {});
      await work;
    },

    onEvent(session: AgentSession, handler: AgentEventHandler): void {
      const state = getState(session);
      state.emitter.on('event', (event: AgentEvent) => {
        try {
          const ret = handler(event);
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
      const state = getState(session);
      const turn = state.currentTurn;
      const proc = state.proc;
      if (!proc || !turn || turn.terminalEmitted) {
        logger.debug({ sessionKey: session.key }, 'codex_interrupt_no_inflight');
        return;
      }
      const signaled = proc.kill('SIGINT');
      if (!signaled) return;
      finishTurn(state, 'user_interrupt', 'runtime-synthesized');
      beginCleanupTimers(session, state, proc);
    },
  };
}
