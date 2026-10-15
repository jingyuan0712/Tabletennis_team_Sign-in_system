import { mkdirSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
// Unique temporary database; never write browser-test people to production/local team DB.
mkdirSync('.test-data', { recursive: true });
const directory = mkdtempSync('.test-data/browser-');
const server = spawn(process.execPath, ['dist-server/server/main.js'], { stdio: 'inherit', env: { ...process.env, DATABASE_PATH: join(directory, 'team.sqlite') } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill());
server.on('exit', code => { process.exitCode = code || 0; });
