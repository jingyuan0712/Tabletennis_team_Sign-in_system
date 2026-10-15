import { openDatabase, migrate } from './db.js';
const db = openDatabase(process.env.DATABASE_PATH || './data/team.sqlite');
try { migrate(db); console.info('Database schema ready.'); } finally { db.close(); }
