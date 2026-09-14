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

  it('closes the server and the database even when stopping the app fails', async () => {
    // The failure that hangs a process: a rejected app.close() used to skip everything
    // after it, leaving the port bound and the database open, with the second Ctrl-C
    // already swallowed by the guard (D-026).
    const h = harness();
    h.app.close.mockRejectedValue(new Error('a cycle blew up'));

    await h.shutdown('SIGINT');

    expect(h.server.close).toHaveBeenCalledOnce();
    expect(h.db.close).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('closes the database even when the server refuses to close', async () => {
    const h = harness();
    h.server.close.mockImplementation(() => {
      throw new Error('server already gone');
    });

    await h.shutdown('SIGTERM');

    expect(h.db.close).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('still exits when the database itself will not close', async () => {
    const h = harness();
    h.db.close.mockImplementation(() => {
      throw new Error('locked');
    });

    await h.shutdown('SIGINT');

    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('ignores a second signal rather than tearing down twice', async () => {
    const h = harness();

    await Promise.all([h.shutdown('SIGINT'), h.shutdown('SIGINT'), h.shutdown('SIGTERM')]);

    expect(h.db.close).toHaveBeenCalledOnce();
    expect(h.server.close).toHaveBeenCalledOnce();
    expect(h.exit).toHaveBeenCalledOnce();
  });
});
