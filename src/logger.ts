/**
 * The one pino instance. Nothing below this file imports pino: the services declare the
 * slice they need as an interface and take it as an argument (D-021), so they stay
 * testable and this stays the only place a logging library is chosen.
 */
import { pino } from 'pino';

import type { Logger } from './services/logger.js';

export function createLogger(level: string): Logger {
  // JSON lines, which is what a backend wants and what any collector expects. No
  // pretty-printer: it would be a dependency to make development output prettier.
  return pino({ level });
}
