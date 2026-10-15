import type { DatabaseSync } from 'node:sqlite';
import { taipeiDay } from '../shared/model.js';

export function cleanup(db: DatabaseSync, now = new Date()): number {
  // A delayed job uses execution time, not its original scheduled date.
  db.exec('BEGIN IMMEDIATE');
  let deleted = 0;
  try {
    deleted = Number(db.prepare('DELETE FROM entries WHERE day < ?').run(taipeiDay(now)).changes);
    db.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').run(now.getTime());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // Remove deleted page contents from the active WAL where readers permit it.
  // Not a guarantee about host snapshots, disks, or backups.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return deleted;
}
