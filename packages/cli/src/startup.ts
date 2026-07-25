import type { Logger } from '@agent-nexus/daemon';

export interface RuntimeEngine {
  start(): Promise<void>;
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

export async function startEnginesWithSignalShutdown(
  options: StartEnginesWithSignalShutdownOptions,
): Promise<boolean> {
  let shutdownPromise: Promise<void> | undefined;

  const requestShutdown = (signal: NodeJS.Signals): void => {
    if (shutdownPromise) return;
    options.logger.info({ signal }, 'shutdown_signal');
    shutdownPromise = (async () => {
      try {
        await options.shutdown();
      } catch (err) {
        options.logger.error({ err }, 'shutdown_error');
      } finally {
        options.exit(0);
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
    if (!shutdownPromise) throw error;
    await shutdownPromise;
    return false;
  }

  if (shutdownPromise) {
    await shutdownPromise;
    return false;
  }
  return true;
}
