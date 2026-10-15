import { Cron } from 'croner';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate, openDatabase } from './db.js';
import { cleanup } from './cleanup.js';

process.umask(0o077);
const path = process.env.DATABASE_PATH || './data/team.sqlite';
const db = openDatabase(path);
migrate(db);
const heartbeat = resolve(path + '.scheduler-heartbeat');
function run() {
  try {
    cleanup(db);
    writeFileSync(heartbeat, String(Date.now()), { mode: 0o600 });
    console.info('CLEANUP_OK');
  } catch {
    console.error('CLEANUP_FAILED');
    // Supervisors restart a failed scheduler; startup immediately retries cleanup.
    process.exit(1);
  }
}
run();
const midnight = new Cron('0 0 * * *', { timezone: 'Asia/Taipei', protect: true }, run);
const retry = new Cron('*/5 * * * *', { timezone: 'Asia/Taipei', protect: true }, run);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { midnight.stop(); retry.stop(); db.close(); process.exit(0); });
}
