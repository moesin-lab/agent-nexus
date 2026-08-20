import { describe, expect, it, vi } from 'vitest';
import { runPackedCodexTurnVerification } from './packed-codex-verification.js';

describe('runPackedCodexTurnVerification', () => {
  it('runs_one_real-shaped_turn_and_waits_for_engine_cleanup', async () => {
    const stop = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const createEngine = vi.fn(async () => ({
      engine: {
        start: vi.fn(async () => ({ threadId: 'thr_packed', pid: 12 })),
        runTurn: vi.fn(async () => ({
          status: 'completed' as const,
          text: 'PACKED_CODEX_TURN_OK_731',
        })),
        interrupt: vi.fn(async () => false),
        stop,
        isAlive: vi.fn(() => true),
      },
      dispose,
    }));

    await expect(runPackedCodexTurnVerification({ createEngine })).resolves.toEqual({
      threadId: 'thr_packed',
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects_a_false_positive_outcome_but_still_cleans_up', async () => {
    const stop = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const createEngine = vi.fn(async () => ({
      engine: {
        start: vi.fn(async () => ({ threadId: 'thr_bad' })),
        runTurn: vi.fn(async () => ({ status: 'completed' as const, text: 'wrong' })),
        interrupt: vi.fn(async () => false),
        stop,
        isAlive: vi.fn(() => true),
      },
      dispose,
    }));

    await expect(runPackedCodexTurnVerification({ createEngine })).rejects.toThrow(
      /packed Codex turn verification failed/,
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('times_out_an_unsettled_turn_and_still_stops_the_engine', async () => {
    vi.useFakeTimers();
    const interrupt = vi.fn(async () => true);
    const stop = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    const createEngine = vi.fn(async () => ({
      engine: {
        start: vi.fn(async () => ({ threadId: 'thr_hung' })),
        runTurn: vi.fn(() => new Promise<never>(() => undefined)),
        interrupt,
        stop,
        isAlive: vi.fn(() => true),
      },
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
    const createEngine = vi.fn(async () => ({
      engine: {
        start: vi.fn(async () => ({ threadId: 'thr_stop_failed' })),
        runTurn: vi.fn(async () => ({
          status: 'completed' as const,
          text: 'PACKED_CODEX_TURN_OK_731',
        })),
        interrupt: vi.fn(async () => false),
        stop,
        isAlive: vi.fn(() => true),
      },
      dispose,
    }));

    await expect(runPackedCodexTurnVerification({ createEngine })).rejects.toThrow(
      /cleanup unconfirmed/,
    );
    expect(dispose).not.toHaveBeenCalled();
  });
});
