/**
 * The body cap (D-028). Over a loopback server on an ephemeral port, because the whole
 * point of it is what happens at the socket, before any handler of ours runs. Nothing
 * here leaves the machine.
 */
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestListener } from '../../src/httpLimits.js';
import { withBodyLimit } from '../../src/httpLimits.js';
import type { RecordingLogger } from '../helpers/services.js';
import { recordingLogger } from '../helpers/services.js';

describe('the request body cap', () => {
  const MAX = 100;
  let server: Server;
  let url: string;
  let handler: Mock<RequestListener>;
  let logger: RecordingLogger;

  beforeEach(async () => {
    handler = vi.fn<RequestListener>((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
    logger = recordingLogger();
    server = createServer(withBodyLimit(handler, MAX, logger));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('passes a request the size a real client sends', async () => {
    const response = await fetch(url, { method: 'POST', body: '{"query":"{ __typename }"}' });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('refuses a body larger than the cap, without reading it', async () => {
    const response = await fetch(url, { method: 'POST', body: 'x'.repeat(MAX + 1) });

    expect(response.status).toBe(413);
    // The handler is the expensive part: Yoga buffers, parses and caches before any
    // validation of ours would see the size.
    expect(handler).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      errors: [{ extensions: { code: 'BAD_USER_INPUT' } }],
    });
    // Refusing quietly would leave the one path that answers a caller invisible.
    expect(logger.warnings.map((one) => one.message)).toContain(
      'refused a request body larger than the cap',
    );
  });

  it('refuses a body that declares no length at all', async () => {
    // A chunked request is the way around a Content-Length check, so it is refused
    // rather than counted: counting means consuming, and consuming means Yoga gets
    // nothing.
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"query":"{ __typename }"}'));
        controller.close();
      },
    });
    const response = await fetch(url, {
      method: 'POST',
      body,
      // Node needs this to send a stream body at all.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    expect(response.status).toBe(411);
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves a request with no body alone', async () => {
    // The GraphiQL page is a GET, and it has neither header.
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
});
