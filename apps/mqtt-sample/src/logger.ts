import { EventEmitter } from 'node:events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogContext = Record<string, unknown>;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/**
 * Minimal structured logger. One JSON object per line, errors followed by
 * the stack trace exactly as Node renders it. Emits an event per level so
 * callers (tests, scripts) can observe what was logged.
 */
export class Logger extends EventEmitter {
  public level: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';
  public readonly service = 'telemetry-hub';

  debug(msg: string, ctx: LogContext = {}): void {
    this.write('debug', msg, ctx);
  }

  info(msg: string, ctx: LogContext = {}): void {
    this.write('info', msg, ctx);
  }

  warn(msg: string, ctx: LogContext = {}, err?: unknown): void {
    this.write('warn', msg, ctx, err);
  }

  error(msg: string, ctx: LogContext = {}, err?: unknown): void {
    this.write('error', msg, ctx, err);
  }

  private write(level: Exclude<LogLevel, 'silent'>, msg: string, ctx: LogContext, err?: unknown): void {
    // 'log' rather than the level name: an EventEmitter 'error' event with no
    // listener would throw.
    this.emit('log', level, msg, ctx, err);
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      service: this.service,
      msg,
      ...ctx,
    });
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(line + '\n');
    if (err !== undefined) {
      const rendered = err instanceof Error ? err.stack ?? err.message : String(err);
      out.write(rendered + '\n');
    }
  }
}

export const logger = new Logger();
