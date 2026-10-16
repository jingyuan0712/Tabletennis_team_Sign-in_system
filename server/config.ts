import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export function configuration() {
  const production = process.env.NODE_ENV === 'production';
  const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:5173';
  const secret = process.env.RATE_LIMIT_SECRET || (production ? '' : randomBytes(32).toString('hex'));
  if (secret.length < 32) throw new Error('RATE_LIMIT_SECRET must contain at least 32 characters');
  if (new URL(origin).origin !== origin || (production && !origin.startsWith('https://'))) throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin in production');
  return {
    origin, secret, production,
    adminUsername: process.env.ADMIN_USERNAME || 'jingyuan',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    databasePath: process.env.DATABASE_PATH || './data/team.sqlite',
    port: Number(process.env.PORT || 3001),
    host: process.env.HOST || '127.0.0.1',
    trustProxy: process.env.TRUST_PROXY === 'true',
    staticDir: resolve('dist'),
  };
}
