export {
  parseClaudeCodeConfig,
  type ClaudeCodeConfig,
  ClaudeCodeConfigError,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_BIN,
} from './config.js';

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
  ContentBlock,
  SessionConfig,
  SessionKey,
  ToolResultContent,
  TurnEndReason,
  UsageRecord,
} from '@agent-nexus/protocol';
import { serializeSessionKey } from '@agent-nexus/protocol';
import type { Logger } from '@agent-nexus/daemon';
import {
  costUsdToCompleteness,
  isValidCcUsage,
  normalizeTotalCostUsd,
  type CcUsage,
} from './usage-normalize.js';

export { runCompatibilityProbe, AgentSpawnFailedError } from './probe.js';
export {
  costUsdToCompleteness,
  isValidCcUsage,
  normalizeTotalCostUsd,
} from './usage-normalize.js';

type ChildProcess = ReturnType<typeof execa> & {
  stdout?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
};

interface ToolCallState {
  toolName: string;
  resultSequence: number;
  sawError: boolean;
  finished: boolean;
  errorSummary?: string;
}

interface TurnState {
  traceId: string;
  turnSequence: number;
  textBuf: string;
  toolCalls: Map<string, ToolCallState>;
  terminalEmitted: boolean;
  syntheticTerminalEmitted: boolean;
  interruptRequested: boolean;
  resolve: () => void;
  timeout?: NodeJS.Timeout;
}

interface RuntimeState {
  emitter: EventEmitter;
  config: SessionConfig;
  proc?: ChildProcess;
  stdoutLoop?: Promise<void>;
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

export interface ClaudeCodeRuntimeOptions {
  claudeBin: string;
  allowedTools: string[];
  defaultWorkingDir: string;
  logger: Logger;
  perInputTimeoutMs?: number;
  syntheticTurnFinishedDeliveryMs?: number;
  gracefulInterruptMs?: number;
  sigtermGraceMs?: number;
}

const stateMap = new WeakMap<AgentSession, RuntimeState>();

function buildSafeCause(err: unknown): string {
  if (err === null || typeof err !== 'object') return 'subprocess failure';
  const e = err as {
    name?: unknown;
    code?: unknown;
    exitCode?: unknown;
    signal?: unknown;
    timedOut?: unknown;
    isCanceled?: unknown;
  };
  const name = typeof e.name === 'string' ? e.name : 'Error';
  const isExecaError =
    e.code !== undefined ||
    e.exitCode !== undefined ||
    e.signal !== undefined ||
    e.timedOut !== undefined;
  if (!isExecaError) return name;
  const parts: string[] = [name];
  if (typeof e.code === 'string') parts.push(`code=${e.code}`);
  if (typeof e.exitCode === 'number') parts.push(`exitCode=${e.exitCode}`);
  if (typeof e.signal === 'string') parts.push(`signal=${e.signal}`);
  if (e.timedOut === true) parts.push('timedOut=true');
  if (e.isCanceled === true) parts.push('isCanceled=true');
  return parts.join(' ');
}

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function truncateRaw(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 4096);
  } catch {
    return '[unserializable]';
  }
}

function normalizeToolResultContent(raw: unknown): ToolResultContent {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  if (typeof raw === 'string') return { kind: 'text', text: raw };
  if (Array.isArray(raw)) {
    const blocks = raw.filter(
      (item): item is ContentBlock =>
        !!item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as { type?: unknown }).type === 'string',
    );
    if (blocks.length === raw.length) return { kind: 'blocks', blocks };
    return { kind: 'unknown', raw: truncateRaw(raw) };
  }
  if (isPlainObject(raw)) return { kind: 'object', object: raw };
  return { kind: 'unknown', raw: truncateRaw(raw) };
}

function inputSummary(input: unknown): string {
  const raw = truncateRaw(input);
  return raw.length > 240 ? `${raw.slice(0, 240)}...` : raw;
}

function toolErrorSummary(content: ToolResultContent): string | undefined {
  if (content.kind === 'text') return content.text.slice(0, 240);
  if (content.kind === 'object') return truncateRaw(content.object).slice(0, 240);
  if (content.kind === 'unknown') return content.raw.slice(0, 240);
  return undefined;
}

function validateToolWhitelist(tools: string[]): string | null {
  if (tools.length === 0) return 'toolWhitelist is empty';
  const unsupported = tools.find((tool) => /[()]/.test(tool));
  if (unsupported) return `unsupported tool whitelist pattern: ${unsupported}`;
  return null;
}

function writeJsonLine(proc: ChildProcess, value: unknown): void {
  if (!proc.stdin) throw new Error('subprocess stdin is null');
  proc.stdin.write(`${JSON.stringify(value)}\n`);
}

function usageRecordFromResult(
  usage: CcUsage,
  totalCostUsd: number | null,
  turn: TurnState,
): UsageRecord {
  return {
    model: 'claude-code',
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd: totalCostUsd,
    turnSequence: turn.turnSequence,
    toolCallsThisTurn: turn.toolCalls.size,
    wallClockMs: 0,
    completeness: costUsdToCompleteness(totalCostUsd),
  };
}

function mapStopReason(raw: unknown): TurnEndReason {
  if (raw === 'end_turn') return 'stop';
  if (raw === 'max_tokens') return 'max_tokens';
  if (raw === 'interrupted' || raw === 'aborted_streaming') return 'user_interrupt';
  return 'error';
}

function finishToolCalls(
  state: RuntimeState,
  turn: TurnState,
  statusOverride?: 'cancelled' | 'error',
): void {
  for (const [callId, tool] of turn.toolCalls) {
    if (tool.finished) continue;
    tool.finished = true;
    const status = statusOverride ?? (tool.sawError ? 'error' : 'ok');
    emitEvent(state, 'tool_call_finished', turn.traceId, {
      callId,
      toolName: tool.toolName,
      status,
      ...(tool.errorSummary ? { errorSummary: tool.errorSummary } : {}),
    });
  }
}

function clearTurnTimer(turn: TurnState): void {
  if (turn.timeout) clearTimeout(turn.timeout);
  turn.timeout = undefined;
}

function clearCleanupTimers(state: RuntimeState): void {
  for (const timer of state.cleanupTimers) clearTimeout(timer);
  state.cleanupTimers = [];
}

function finishTurn(
  state: RuntimeState,
  reason: TurnEndReason,
  source?: 'runtime-synthesized',
): void {
  const turn = state.currentTurn;
  if (!turn || turn.terminalEmitted) return;
  turn.terminalEmitted = true;
  turn.syntheticTerminalEmitted = source === 'runtime-synthesized';
  clearTurnTimer(turn);

  if (source === 'runtime-synthesized') {
    finishToolCalls(state, turn, reason === 'user_interrupt' ? 'cancelled' : 'error');
  } else {
    if (turn.textBuf.length > 0) {
      emitEvent(state, 'text_final', turn.traceId, { text: turn.textBuf });
    }
    finishToolCalls(
      state,
      turn,
      reason === 'user_interrupt' ? 'cancelled' : undefined,
    );
  }

  emitEvent(state, 'turn_finished', turn.traceId, {
    reason,
    turnSequence: turn.turnSequence,
    ...(source ? { source } : {}),
  });
  turn.resolve();
}

function cleanupAfterRealResult(state: RuntimeState): void {
  const turn = state.currentTurn;
  if (!turn) return;
  clearTurnTimer(turn);
  clearCleanupTimers(state);
  state.currentTurn = undefined;
  state.cleanupBarrierResolve?.();
  state.cleanupBarrier = undefined;
  state.cleanupBarrierResolve = undefined;
}

function unsafePermissionMode(value: unknown): boolean {
  return value === 'bypassPermissions' || value === 'acceptEdits';
}

export function createClaudeCodeRuntime(
  opts: ClaudeCodeRuntimeOptions,
): AgentRuntime {
  const { claudeBin, allowedTools, defaultWorkingDir, logger } = opts;
  const defaultTimeoutMs = opts.perInputTimeoutMs ?? 300_000;
  const syntheticDeliveryMs = opts.syntheticTurnFinishedDeliveryMs ?? 250;
  const gracefulInterruptMs = opts.gracefulInterruptMs ?? 5_000;
  const sigtermGraceMs = opts.sigtermGraceMs ?? 5_000;

  const capabilities: AgentCapabilitySet = {
    supportsThinking: false,
    supportsStreaming: true,
    supportsToolCallEvents: true,
    supportsInterrupt: true,
    supportsStdinInterrupt: false,
  };

  function getState(session: AgentSession): RuntimeState {
    const state = stateMap.get(session);
    if (!state) throw new Error('unknown session');
    return state;
  }

  function emitErrorTurn(
    state: RuntimeState,
    traceId: string,
    errorKind: string,
    message: string,
  ): void {
    emitEvent(state, 'error', traceId, { errorKind, message });
    emitEvent(state, 'turn_finished', traceId, {
      reason: 'error',
      turnSequence: state.nextTurnSequence++,
    });
  }

  function stopWithError(
    session: AgentSession,
    state: RuntimeState,
    traceId: string,
    errorKind: string,
    message: string,
  ): void {
    state.errored = true;
    session.state = 'Errored';
    state.proc?.kill('SIGTERM');
    const turn = state.currentTurn;
    if (turn && !turn.terminalEmitted) {
      emitEvent(state, 'error', traceId, { errorKind, message });
      finishTurn(state, 'error');
      cleanupAfterRealResult(state);
    } else {
      emitEvent(state, 'error', traceId, { errorKind, message });
      cleanupAfterRealResult(state);
    }
    emitEvent(state, 'session_stopped', traceId, { reason: 'error' });
  }

  function beginCleanupBarrier(
    session: AgentSession,
    state: RuntimeState,
    proc: ChildProcess,
    traceId: string,
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
        if (!state.errored && !state.stopped) {
          state.errored = true;
          session.state = 'Errored';
          emitEvent(state, 'error', traceId, {
            errorKind: 'interrupt_cleanup_failed',
            message: 'Claude Code did not acknowledge interrupted turn cleanup',
          });
          emitEvent(state, 'session_stopped', traceId, { reason: 'error' });
        }
        cleanupAfterRealResult(state);
      }, gracefulInterruptMs + sigtermGraceMs),
    );
  }

  async function ensureProc(session: AgentSession, state: RuntimeState): Promise<void> {
    if (state.proc) return;
    const config = state.config;
    const cwd = config.workingDir ?? defaultWorkingDir;
    const tools = config.toolWhitelist ?? allowedTools;
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--permission-prompt-tool',
      'stdio',
      '--replay-user-messages',
      '--verbose',
      '--allowed-tools',
      tools.join(','),
    ];
    const resumeId = session.agentSessionId ?? config.resumeFromAgentSessionId;
    if (resumeId) args.push('--resume', resumeId);

    const proc = execa(claudeBin, args, {
      buffer: false,
      cwd,
    }) as ChildProcess;
    if (!proc.stdout) throw new Error('subprocess stdout is null');
    if (!proc.stdin) throw new Error('subprocess stdin is null');
    state.proc = proc;
    session.pid = proc.pid;

    state.stdoutLoop = readStdoutLoop(session, state, proc).catch((err: unknown) => {
      if (!state.stopped && !state.errored) {
        stopWithError(
          session,
          state,
          state.currentTurn?.traceId ?? 'system',
          'agent_stdout_error',
          err instanceof Error ? err.message : String(err),
        );
      }
    });

    void Promise.resolve(proc).catch((err: unknown) => {
      if (!state.stopped && !state.errored) {
        const traceId = state.currentTurn?.traceId ?? 'system';
        logger.warn(
          {
            sessionKey: serializeSessionKey(session.key),
            traceId,
            errorKind: 'agent',
            code: 'spawn_failed',
            cause: buildSafeCause(err),
          },
          'claudecode_subproc_error',
        );
        stopWithError(
          session,
          state,
          traceId,
          'spawn_failed',
          err instanceof Error ? err.message : String(err),
        );
      }
    });
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
        logger.debug({ line }, 'cc_non_json_line');
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      handleStdoutMessage(session, state, proc, parsed as Record<string, unknown>);
    }
  }

  function handleSystemInit(
    session: AgentSession,
    state: RuntimeState,
    e: Record<string, unknown>,
  ): void {
    const traceId = state.currentTurn?.traceId ?? 'system';
    if (unsafePermissionMode(e['permissionMode'])) {
      stopWithError(
        session,
        state,
        traceId,
        'permission_mode_unsafe',
        `unsafe Claude Code permissionMode: ${String(e['permissionMode'])}`,
      );
      return;
    }
    const sid = e['session_id'];
    if (typeof sid === 'string') session.agentSessionId = sid;
    if (state.sessionStarted) return;
    state.sessionStarted = true;
    emitEvent(state, 'session_started', traceId, {
      agentSessionId: typeof sid === 'string' ? sid : undefined,
      pid: session.pid,
      workingDir: typeof e['cwd'] === 'string' ? e['cwd'] : state.config.workingDir,
      capabilities,
    });
  }

  function handleAssistant(state: RuntimeState, e: Record<string, unknown>): void {
    const turn = state.currentTurn;
    if (!turn || turn.terminalEmitted) return;
    const message = e['message'] as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) return;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      const item = part as Record<string, unknown>;
      if (item['type'] === 'text' || item['type'] === 'text_delta') {
        const text = item['text'];
        if (typeof text === 'string') {
          turn.textBuf += text;
          emitEvent(state, 'text_delta', turn.traceId, { text });
        }
      } else if (item['type'] === 'tool_use') {
        const id = item['id'];
        const name = item['name'];
        if (typeof id !== 'string' || typeof name !== 'string') continue;
        turn.toolCalls.set(id, {
          toolName: name,
          resultSequence: 0,
          sawError: false,
          finished: false,
        });
        emitEvent(state, 'tool_call_started', turn.traceId, {
          callId: id,
          toolName: name,
          inputSummary: inputSummary(item['input']),
        });
      }
    }
  }

  function handleToolResult(state: RuntimeState, e: Record<string, unknown>): void {
    const turn = state.currentTurn;
    if (!turn || turn.terminalEmitted) return;
    const message = e['message'] as { content?: unknown } | undefined;
    if (!Array.isArray(message?.content)) return;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      const item = part as Record<string, unknown>;
      if (item['type'] !== 'tool_result') continue;
      const callId = item['tool_use_id'];
      if (typeof callId !== 'string') continue;
      let tool = turn.toolCalls.get(callId);
      if (!tool) {
        tool = {
          toolName: 'unknown',
          resultSequence: 0,
          sawError: false,
          finished: false,
        };
        turn.toolCalls.set(callId, tool);
      }
      const content = normalizeToolResultContent(item['content']);
      const isError = item['is_error'] === true;
      if (isError) {
        tool.sawError = true;
        tool.errorSummary = toolErrorSummary(content);
      }
      emitEvent(state, 'tool_result', turn.traceId, {
        callId,
        resultSequence: tool.resultSequence++,
        content,
        isError,
      });
    }
  }

  function handleControlRequest(
    session: AgentSession,
    state: RuntimeState,
    proc: ChildProcess,
    e: Record<string, unknown>,
  ): void {
    const request = e['request'] as Record<string, unknown> | undefined;
    if (request?.['subtype'] !== 'can_use_tool') return;
    const requestId = e['request_id'];
    if (typeof requestId !== 'string') return;
    const toolName = request['tool_name'];
    const tools = state.config.toolWhitelist ?? allowedTools;
    const allowed =
      typeof toolName === 'string' && tools.includes(toolName);
    const response = allowed
      ? {
          behavior: 'allow',
          updatedInput: request['input'],
        }
      : {
          behavior: 'deny',
          message: `Tool ${String(toolName)} is not in toolWhitelist`,
        };
    try {
      writeJsonLine(proc, {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response,
        },
      });
    } catch (err) {
      stopWithError(
        session,
        state,
        state.currentTurn?.traceId ?? 'system',
        'permission_control_write_failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function emitUsageIfValid(
    state: RuntimeState,
    turn: TurnState,
    e: Record<string, unknown>,
  ): void {
    if (!isValidCcUsage(e['usage'])) return;
    emitEvent(
      state,
      'usage',
      turn.traceId,
      usageRecordFromResult(
        e['usage'],
        normalizeTotalCostUsd(e['total_cost_usd']),
        turn,
      ),
    );
  }

  function handleResult(state: RuntimeState, e: Record<string, unknown>): void {
    const turn = state.currentTurn;
    if (!turn) return;
    if (turn.syntheticTerminalEmitted) {
      emitUsageIfValid(state, turn, e);
      cleanupAfterRealResult(state);
      return;
    }
    const mappedReason = mapStopReason(e['stop_reason'] ?? e['terminal_reason']);
    const reason =
      turn.interruptRequested && mappedReason === 'error'
        ? 'user_interrupt'
        : mappedReason;
    finishToolCalls(
      state,
      turn,
      reason === 'user_interrupt' ? 'cancelled' : undefined,
    );
    emitUsageIfValid(state, turn, e);
    finishTurn(state, reason);
    cleanupAfterRealResult(state);
  }

  function handleStdoutMessage(
    session: AgentSession,
    state: RuntimeState,
    proc: ChildProcess,
    e: Record<string, unknown>,
  ): void {
    if (e['type'] === 'system' && e['subtype'] === 'init') {
      handleSystemInit(session, state, e);
    } else if (e['type'] === 'assistant') {
      handleAssistant(state, e);
    } else if (e['type'] === 'user') {
      if (e['isReplay'] === true) return;
      handleToolResult(state, e);
    } else if (e['type'] === 'control_request') {
      handleControlRequest(session, state, proc, e);
    } else if (e['type'] === 'result') {
      handleResult(state, e);
    } else if (e['type'] === 'stream_event') {
      const event = e['event'] as Record<string, unknown> | undefined;
      const delta = event?.['delta'] as Record<string, unknown> | undefined;
      const turn = state.currentTurn;
      if (
        turn &&
        !turn.terminalEmitted &&
        event?.['type'] === 'content_block_delta' &&
        delta?.['type'] === 'text_delta' &&
        typeof delta['text'] === 'string'
      ) {
        turn.textBuf += delta['text'];
        emitEvent(state, 'text_delta', turn.traceId, { text: delta['text'] });
      }
    }
  }

  async function runTurn(
    session: AgentSession,
    state: RuntimeState,
    input: AgentInput,
  ): Promise<void> {
    const tools = state.config.toolWhitelist ?? allowedTools;
    const invalidTools = validateToolWhitelist(tools);
    if (invalidTools) {
      emitErrorTurn(state, input.traceId, 'tool_whitelist_invalid', invalidTools);
      return;
    }
    if (state.cleanupBarrier) await state.cleanupBarrier;
    if (state.errored || state.stopped) {
      emitErrorTurn(
        state,
        input.traceId,
        'session_stopped',
        'sendInput called after session cleanup failed',
      );
      return;
    }
    await ensureProc(session, state);
    const proc = state.proc;
    if (!proc) throw new Error('subprocess not spawned');

    await new Promise<void>((resolve) => {
      const turn: TurnState = {
        traceId: input.traceId,
        turnSequence: state.nextTurnSequence++,
        textBuf: '',
        toolCalls: new Map(),
        terminalEmitted: false,
        syntheticTerminalEmitted: false,
        interruptRequested: false,
        resolve,
        timeout: undefined,
      };
      state.currentTurn = turn;
      turn.timeout = setTimeout(() => {
        proc.kill('SIGINT');
        finishTurn(state, 'wallclock_timeout', 'runtime-synthesized');
        beginCleanupBarrier(session, state, proc, input.traceId);
        if (!state.errored && !state.stopped) {
          state.errored = true;
          session.state = 'Errored';
          emitEvent(state, 'error', input.traceId, {
            errorKind: 'wallclock_timeout',
            message: 'Claude Code turn exceeded wallclock timeout',
          });
          emitEvent(state, 'session_stopped', input.traceId, { reason: 'error' });
        }
      }, state.config.timeoutMs ?? defaultTimeoutMs);
      try {
        writeJsonLine(proc, {
          type: 'user',
          message: { role: 'user', content: input.text ?? '' },
        });
      } catch (err) {
        stopWithError(
          session,
          state,
          input.traceId,
          'stdin_write_failed',
          err instanceof Error ? err.message : String(err),
        );
        resolve();
      }
    });
  }

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
        agentSessionId: config.resumeFromAgentSessionId,
      };
      stateMap.set(session, {
        emitter: new EventEmitter(),
        config,
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

    isAlive(session: AgentSession): boolean {
      const state = stateMap.get(session);
      return session.state !== 'Stopped' && state?.errored !== true;
    },

    onEvent(session: AgentSession, handler: AgentEventHandler): void {
      const state = getState(session);
      state.emitter.on('event', (e: AgentEvent) => {
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
      const state = getState(session);
      const turn = state.currentTurn;
      if (!state.proc || !turn || turn.terminalEmitted) {
        logger.debug({ sessionKey: session.key }, 'claudecode_interrupt_no_inflight');
        return;
      }
      const signaled = state.proc.kill('SIGINT');
      if (!signaled) return;
      turn.interruptRequested = true;
      setTimeout(() => {
        if (!state.currentTurn || state.currentTurn !== turn || turn.terminalEmitted) {
          return;
        }
        finishTurn(state, 'user_interrupt', 'runtime-synthesized');
        beginCleanupBarrier(session, state, state.proc!, turn.traceId);
      }, syntheticDeliveryMs);
    },

    stopSession(session: AgentSession): void {
      const state = getState(session);
      state.stopped = true;
      session.state = 'Stopped';
      state.proc?.kill('SIGTERM');
      clearCleanupTimers(state);
      if (state.currentTurn && !state.currentTurn.terminalEmitted) {
        finishTurn(state, 'error');
        cleanupAfterRealResult(state);
      }
      emitEvent(state, 'session_stopped', state.currentTurn?.traceId ?? 'system', {
        reason: 'user_stop',
      });
    },

    async sendInput(session: AgentSession, input: AgentInput): Promise<void> {
      const state = getState(session);
      if (session.state === 'Stopped' || state.errored) {
        emitErrorTurn(state, input.traceId, 'session_stopped', 'sendInput called on stopped session');
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
  };

  return runtime;
}
