/**
 * Stopping cleanly.
 *
 * Its own module so the order can be tested. Left inline in the bootstrap it would be
 * untestable on a platform that does not deliver POSIX signals, and "stop taking
 * requests, let the ones in flight finish, then close the database" is exactly the kind
 * of sequence that is easy to get subtly wrong and never notice.
 */
import type { Logger } from './services/logger.js';

export interface Stoppable {
  close(callback: () => void): unknown;
}

export interface Closeable {
  close(): void;
}

export interface ShutdownOptions {
  /** Whatever the app started; phase 6's refresher is the first of them. */
  readonly app: { close(): Promise<void> };
  readonly server: Stoppable;
  readonly db: Closeable;
  readonly logger: Logger;
  /** Injected so a test does not end its own process. */
  readonly exit?: (code: number) => void;
}

export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const { app, server, db, logger } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let stopping = false;

  return async function shutdown(signal: string): Promise<void> {
    // Someone impatient with Ctrl-C should not start a second teardown over the first.
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');

    // Order matters: stop the app's own work, stop accepting requests and let the ones
    // in flight drain, and only then take the database away from them.
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();

    logger.info({ signal }, 'stopped');
    exit(0);
  };
}
