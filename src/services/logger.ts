/**
 * The slice of a logger the services use, shaped like pino's so phase 5 can pass a pino
 * instance straight in. Declared here rather than imported so a service can be tested
 * without a logging library, and so a background failure has somewhere to go that is not
 * the console (AGENTS.md).
 */

export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** The default. A service should not log anything unless someone asked for logs. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
