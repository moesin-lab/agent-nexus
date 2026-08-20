import type { Logger } from '@agent-nexus/daemon';

export interface RuntimeEngine {
  start(): Promise<void>;
}

export interface RuntimeStoppableEngine {
  stop(): Promise<void>;
}

export interface RuntimeSignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

interface StartEnginesWithSignalShutdownOptions {
  engines: readonly RuntimeEngine[];
  signals: RuntimeSignalSource;
  shutdown(): Promise<void>;
  exit(code: number): void;
  logger: Logger;
}

export async function stopRuntimeEngines(
  engines: readonly RuntimeStoppableEngine[],
): Promise<void> {
  const results = await Promise.allSettled(
    engines.map((engine) => Promise.resolve().then(() => engine.stop())),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'one or more engine shutdowns were not confirmed');
  }
}

export async function startEnginesWithSignalShutdown(
  options: StartEnginesWithSignalShutdownOptions,
): Promise<boolean> {
  let shutdownPromise: Promise<void> | undefined;

  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (shutdownPromise) return;
    options.logger.info({ signal }, 'shutdown_signal');
    shutdownPromise = (async () => {
      let exitCode = 0;
      try {
        await options.shutdown();
      } catch (err) {
        exitCode = 1;
        options.logger.error({ err }, 'shutdown_error');
      } finally {
        options.exit(exitCode);
      }
    })();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    options.signals.on(signal, () => {
      requestShutdown(signal);
    });
  }

  try {
    await Promise.all(options.engines.map((engine) => engine.start()));
  } catch (error) {
    if (shutdownPromise) {
      await shutdownPromise;
      return false;
    }
    shutdownPromise = Promise.resolve().then(() => options.shutdown());
    try {
      await shutdownPromise;
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'engine startup and rollback cleanup both failed',
      );
    }
    throw error;
  }

  if (shutdownPromise) {
    await shutdownPromise;
    return false;
  }
  return true;
}
