import { createApp } from './app.js';
import { configuration } from './config.js';
import { migrate, openDatabase } from './db.js';
import { cleanup } from './cleanup.js';

process.umask(0o077);
const config = configuration();
const db = openDatabase(config.databasePath);
migrate(db);
cleanup(db);
const server = createApp(db, config);
server.listen(config.port, config.host, () => console.info(`Server ready on port ${config.port}.`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(() => { db.close(); process.exit(0); }); server.closeIdleConnections(); });
}
