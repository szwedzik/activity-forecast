import { describe, expect, it, vi } from 'vitest';

import { createShutdown } from '../../src/shutdown.js';
import { silentLogger } from '../../src/services/logger.js';

function harness() {
  const order: string[] = [];
  const app = { close: vi.fn(async () => void order.push('app')) };
  const server = {
    close: vi.fn((done: () => void) => {
      order.push('server');
      // Real servers finish draining on a later tick, not the same one.
      setTimeout(done, 0);
    }),
  };
  const db = { close: vi.fn(() => void order.push('db')) };
  const exit = vi.fn();

  return {
    order,
    app,
    server,
    db,
    exit,
    shutdown: createShutdown({ app, server, db, logger: silentLogger, exit }),
  };
}

describe('shutting down', () => {
  it('stops the app, drains the server, then closes the database', async () => {
    const h = harness();

    await h.shutdown('SIGINT');

    // The database must outlive the requests still using it.
    expect(h.order).toEqual(['app', 'server', 'db']);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('waits for the server to finish draining before touching the database', async () => {
    const h = harness();
    let drained = false;
    h.server.close.mockImplementation((done: () => void) => {
      setTimeout(() => {
        drained = true;
        done();
      }, 5);
    });
    h.db.close.mockImplementation(() => {
      expect(drained).toBe(true);
    });

    await h.shutdown('SIGTERM');

    expect(h.db.close).toHaveBeenCalledOnce();
  });

  it('ignores a second signal rather than tearing down twice', async () => {
    const h = harness();

    await Promise.all([h.shutdown('SIGINT'), h.shutdown('SIGINT'), h.shutdown('SIGTERM')]);

    expect(h.db.close).toHaveBeenCalledOnce();
    expect(h.server.close).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledOnce();
  });
});
