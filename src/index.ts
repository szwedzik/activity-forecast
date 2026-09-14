import { pino } from 'pino';

// Placeholder. The server, config and wiring arrive in phase 5 (docs/PHASES.md);
// until then this exists so `npm run build` and `npm start` have an entry point.
const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' });

logger.info('activity-forecast: not implemented yet, the GraphQL server arrives in phase 5');
