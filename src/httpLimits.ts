/**
 * A cap on how much request body we are willing to read (D-028).
 *
 * Yoga buffers and parses a body before any validation of ours sees it, and it caches
 * what it parses, so without a cap a stranger can post megabytes and make the process
 * hold on to them. The check has to happen before the handler, which is why it lives
 * here rather than as a plugin.
 *
 * Declared length is the only thing checked. Counting the stream instead would mean
 * attaching a `data` listener, which puts the request into flowing mode before Yoga has
 * built its own reader, and chunks emitted in between would be lost. A body with no
 * declared length is refused instead, which is what 411 is for: fetch, curl and every
 * GraphQL client set Content-Length on a string body, so this costs a real caller
 * nothing. A request with no body at all, such as the GraphiQL page, has neither header
 * and is unaffected.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Logger } from './services/logger.js';
import { silentLogger } from './services/logger.js';

export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

function refuse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ errors: [{ message, extensions: { code: 'BAD_USER_INPUT' } }] }));
}

export function withBodyLimit(
  inner: RequestListener,
  maxBytes: number,
  logger: Logger = silentLogger,
): RequestListener {
  return (request, response) => {
    const declared = request.headers['content-length'];

    // Node's parser has already rejected anything that is not a plain number, so this
    // only has to decide whether the number is too big.
    if (declared !== undefined) {
      if (Number(declared) > maxBytes) {
        logger.warn({ declared, maxBytes }, 'refused a request body larger than the cap');
        refuse(response, 413, `Request body must be at most ${maxBytes} bytes.`);
        return;
      }
    } else if ((request.headers['transfer-encoding'] ?? '').includes('chunked')) {
      logger.warn({}, 'refused a request body that declared no length');
      refuse(response, 411, 'Request body must declare a Content-Length.');
      return;
    }

    inner(request, response);
  };
}
