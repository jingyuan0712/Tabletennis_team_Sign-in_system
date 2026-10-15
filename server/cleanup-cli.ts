import { openDatabase, migrate } from './db.js';
import { cleanup } from './cleanup.js';
const db = openDatabase(process.env.DATABASE_PATH || './data/team.sqlite');
try { migrate(db); cleanup(db); console.info('Expired rows deleted.'); } finally { db.close(); }
