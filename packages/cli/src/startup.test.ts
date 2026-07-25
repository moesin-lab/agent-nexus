import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@agent-nexus/daemon';
import {
  startEnginesWithSignalShutdown,
  type RuntimeEngine,
  type RuntimeSignalSource,
} from './startup.js';

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeSignalSource implements RuntimeSignalSource {
  private readonly listeners = new Map<string, Array<() => void>>();

  on(signal: NodeJS.Signals, listener: () => void): this {
    const listeners = this.listeners.get(signal) ?? [];
    listeners.push(listener);
    this.listeners.set(signal, listeners);
    return this;
  }

  emit(signal: NodeJS.Signals): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

describe('startEnginesWithSignalShutdown', () => {
  it('在 engine start pending 时响应信号、幂等清理并不宣称 started', async () => {
    const pendingStart = deferred();
    const engines: RuntimeEngine[] = [
      { start: vi.fn(() => pendingStart.promise) },
      { start: vi.fn(() => pendingStart.promise) },
    ];
    const signals = new FakeSignalSource();
    const shutdown = vi.fn(async () => {
      pendingStart.reject(new Error('stopped during startup'));
    });
    const exit = vi.fn();

    const starting = startEnginesWithSignalShutdown({
      engines,
      signals,
      shutdown,
      exit,
      logger: makeLogger(),
    });
    await vi.waitFor(() => {
      expect(engines.every((engine) => vi.mocked(engine.start).mock.calls.length === 1))
        .toBe(true);
    });

    signals.emit('SIGTERM');
    signals.emit('SIGINT');

    await expect(starting).resolves.toBe(false);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('正常启动混合平台的所有 engine，并在运行期信号到达后统一清理', async () => {
    const engines: RuntimeEngine[] = [
      { start: vi.fn(async () => {}) },
      { start: vi.fn(async () => {}) },
    ];
    const signals = new FakeSignalSource();
    const shutdown = vi.fn(async () => {});
    const exit = vi.fn();

    await expect(
      startEnginesWithSignalShutdown({
        engines,
        signals,
        shutdown,
        exit,
        logger: makeLogger(),
      }),
    ).resolves.toBe(true);
    expect(engines.every((engine) => vi.mocked(engine.start).mock.calls.length === 1))
      .toBe(true);

    signals.emit('SIGINT');
    await vi.waitFor(() => {
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
