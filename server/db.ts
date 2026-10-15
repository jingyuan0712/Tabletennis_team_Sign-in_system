import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Entry } from '../shared/model.js';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;');
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY NOT NULL) STRICT;');
  const files = readdirSync(resolve('migrations')).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  for (const file of files) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(file)) {
        db.exec(readFileSync(resolve('migrations', file), 'utf8'));
        db.prepare('INSERT INTO schema_migrations(name) VALUES (?)').run(file);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}

// Explicit allowlist: never SELECT * for public API data.
export const PUBLIC_COLUMNS = 'id, day, name, status, reason, eta, created_at AS createdAt, updated_at AS updatedAt';
export function todayEntries(db: DatabaseSync, day: string): Entry[] {
  return db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM entries WHERE day = ? ORDER BY created_at DESC, id DESC`).all(day) as unknown as Entry[];
}
