import pino, { type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  pretty?: boolean;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? 'info';
  const usePretty = opts.pretty ?? process.stdout.isTTY;
  if (usePretty) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      },
    });
  }
  return pino({ level });
}
