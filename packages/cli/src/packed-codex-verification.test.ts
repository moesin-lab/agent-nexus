import { describe, expect, it, vi } from 'vitest';
import type {
  CodexAppServerSessionEngine,
  CodexProcessOutputPage,
  CodexProcessStatus,
} from '@agent-nexus/agent-codex-app-server';
import { runPackedCodexTurnVerification } from './packed-codex-verification.js';

const PROCESS_HANDLE = 'packed-process-handle';
const PROCESS_IDENTITY = 'PACKED_CODEX_PROCESS_OK_731';

const status = (state: CodexProcessStatus['state'], cursor: number): CodexProcessStatus => ({
  handle: PROCESS_HANDLE,
  state,
  nextCursor: cursor,
  oldestCursor: 0,
  stdinOpen: state === 'running',
  ...(state === 'exited' ? { exitCode: 137 } : {}),
});

function processPage(cursor: number, text: string): CodexProcessOutputPage {
  const bytes = Buffer.from(text);
  const nextCursor = cursor + bytes.length;
  return {
    status: status('running', nextCursor),
    requestedCursor: cursor,
    oldestCursor: 0,
    nextCursor,
    truncatedBefore: false,
    chunks: [{
      stream: 'stdout',
      startCursor: cursor,
      endCursor: nextCursor,
      dataBase64: bytes.toString('base64'),
    }],
  };
}

function processMethods() {
  const output = [
    `READY ${PROCESS_IDENTITY} 999999\n`,
    `TICK ${PROCESS_IDENTITY}\n`,
    `PONG ${PROCESS_IDENTITY} PING\n`,
  ];
  let cursor = 0;
  return {
    startProcess: vi.fn(async () => status('running', 0)),
    processStatus: vi.fn(() => status('running', cursor)),
    readProcessOutput: vi.fn((input: { handle: string; cursor: number }) => {
      expect(input).toEqual({ handle: PROCESS_HANDLE, cursor });
      const text = output.shift() ?? '';
      const page = processPage(cursor, text);
      cursor = page.nextCursor;
      return page;
    }),
    writeProcessStdin: vi.fn(async () => ({ acceptedBytes: 5, stdinOpen: true })),
    terminateProcess: vi.fn(async () => ({
      alreadyTerminal: false,
      status: status('exited', cursor),
    })),
  };
}

function createEngineWithTurns(
  outcomes: Array<{ status: 'completed' | 'interrupted' | 'failed'; text: string | null }>,
  stop = vi.fn(async () => undefined),
) {
  const processes = processMethods();
  const engine = {
    start: vi.fn(async () => ({ threadId: 'thr_packed', pid: 12 })),
    runTurn: vi.fn(async () => outcomes.shift() ?? {
      status: 'failed' as const,
      text: null,
    }),
    interrupt: vi.fn(async () => false),
    stop,
    ...processes,
  } satisfies CodexAppServerSessionEngine;
  return { engine, processes, stop };
}

describe('runPackedCodexTurnVerification', () => {
  it('runs_the_full_process_path_across_two_turns_and_waits_for_cleanup', async () => {
    const dispose = vi.fn(async () => undefined);
    const created = createEngineWithTurns([
      { status: 'completed', text: 'PACKED_CODEX_TURN_ONE_OK_731' },
      { status: 'completed', text: 'PACKED_CODEX_TURN_TWO_OK_731' },
    ]);
    const createEngine = vi.fn(async () => ({ engine: created.engine, dispose }));

    await expect(runPackedCodexTurnVerification({ createEngine })).resolves.toEqual({
      threadId: 'thr_packed',
    });
    expect(created.engine.runTurn).toHaveBeenCalledTimes(2);
    expect(created.processes.startProcess).toHaveBeenCalledTimes(1);
    expect(created.processes.processStatus).toHaveBeenCalledTimes(3);
    expect(created.processes.readProcessOutput).toHaveBeenCalledTimes(3);
    expect(created.processes.writeProcessStdin).toHaveBeenCalledWith({
      handle: PROCESS_HANDLE,
      dataBase64: Buffer.from('PING\n').toString('base64'),
    });
    expect(created.processes.terminateProcess).toHaveBeenCalledWith(PROCESS_HANDLE);
    expect(created.stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects_a_false_positive_outcome_but_still_cleans_up', async () => {
    const dispose = vi.fn(async () => undefined);
    const created = createEngineWithTurns([
      { status: 'completed', text: 'wrong' },
    ]);
    const createEngine = vi.fn(async () => ({ engine: created.engine, dispose }));

    await expect(runPackedCodexTurnVerification({ createEngine })).rejects.toThrow(
      /packed Codex turn verification failed/,
    );
    expect(created.stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('times_out_an_unsettled_turn_and_still_stops_the_engine', async () => {
    vi.useFakeTimers();
    const interrupt = vi.fn(async () => true);
    const stop = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const processes = processMethods();
    const createEngine = vi.fn(async () => ({
      engine: {
        start: vi.fn(async () => ({ threadId: 'thr_hung' })),
        runTurn: vi.fn(() => new Promise<never>(() => undefined)),
        interrupt,
        stop,
        ...processes,
      } satisfies CodexAppServerSessionEngine,
      dispose,
    }));

    const verification = runPackedCodexTurnVerification({
      createEngine,
      turnTimeoutMs: 25,
    });
    const rejected = expect(verification).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(25);

    await rejected;
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('preserves_the_recovery_root_when_stop_is_not_confirmed', async () => {
    const stop = vi.fn(async () => { throw new Error('cleanup unconfirmed'); });
    const dispose = vi.fn(async () => undefined);
    const created = createEngineWithTurns([
      { status: 'completed', text: 'PACKED_CODEX_TURN_ONE_OK_731' },
      { status: 'completed', text: 'PACKED_CODEX_TURN_TWO_OK_731' },
    ], stop);
    const createEngine = vi.fn(async () => ({ engine: created.engine, dispose }));

    await expect(runPackedCodexTurnVerification({ createEngine })).rejects.toThrow(
      /cleanup unconfirmed/,
    );
    expect(dispose).not.toHaveBeenCalled();
  });
});
