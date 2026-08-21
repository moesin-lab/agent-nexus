import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@agent-nexus/daemon';
import {
  startEnginesWithSignalShutdown,
  stopRuntimeEngines,
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

  it('部分 engine 启动失败时先清理所有已启动或启动中的 engine', async () => {
    const startError = new Error('second engine failed to start');
    const engines: RuntimeEngine[] = [
      { start: vi.fn(async () => {}) },
      { start: vi.fn(async () => { throw startError; }) },
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
    ).rejects.toBe(startError);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('关机清理失败时记录失败并使用非零退出码', async () => {
    const engines: RuntimeEngine[] = [{ start: vi.fn(async () => {}) }];
    const signals = new FakeSignalSource();
    const cleanupError = new Error('session cleanup not confirmed');
    const shutdown = vi.fn(async () => {
      throw cleanupError;
    });
    const exit = vi.fn();
    const logger = makeLogger();

    await expect(
      startEnginesWithSignalShutdown({ engines, signals, shutdown, exit, logger }),
    ).resolves.toBe(true);
    signals.emit('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith({ err: cleanupError }, 'shutdown_error');
  });
});

describe('stopRuntimeEngines', () => {
  it('等待所有 engine 清理完成后再传播失败', async () => {
    const cleanupError = new Error('first engine cleanup failed');
    const secondStop = deferred();
    let settled = false;
    const stopping = stopRuntimeEngines([
      { stop: vi.fn(() => { throw cleanupError; }) },
      { stop: vi.fn(() => secondStop.promise) },
    ]).finally(() => {
      settled = true;
    });
    const rejected = expect(stopping).rejects.toBe(cleanupError);
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    secondStop.resolve();
    await rejected;
  });
});
