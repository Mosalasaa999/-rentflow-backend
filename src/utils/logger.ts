import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  formatters: { level: (label) => ({ level: label }) },
  redact: ['req.headers.authorization', 'payment_intent_id'],
});
