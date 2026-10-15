import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Isolated project/volumes. Never run smoke tests against the deployment project.
const project = 'team-smoke-' + randomBytes(5).toString('hex');
const env = { ...process.env, DOMAIN: 'verification.example.test', PUBLIC_ORIGIN: 'https://verification.example.test', RATE_LIMIT_SECRET: randomBytes(32).toString('hex') };
function docker(args) {
  const result = spawnSync('docker', args, { env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Docker verification command failed');
}
const compose = (...args) => docker(['compose', '-p', project, '-f', 'compose.yaml', '-f', 'tests/compose.smoke.yaml', ...args]);
try {
  docker(['build', '-t', 'table-tennis-today:verification', '.']);
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'app', 'scheduler');
  compose('exec', '-T', 'app', 'node', '--input-type=module', '-e', readFileSync('tests/container-check.mjs', 'utf8'));
  compose('exec', '-T', 'scheduler', 'node', 'dist-server/server/cleanup-cli.js');
  compose('exec', '-T', 'scheduler', 'node', 'dist-server/server/cleanup-cli.js');
  compose('restart', 'app');
  compose('up', '-d', '--no-build', '--wait', 'app', 'scheduler');
  compose('exec', '-T', 'app', 'node', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {openDatabase} from './dist-server/server/db.js';
    import {taipeiDay} from './dist-server/shared/model.js';
    const db=openDatabase('/data/team.sqlite');
    assert.equal(db.prepare('SELECT count(*) AS count FROM entries WHERE day < ?').get(taipeiDay(new Date())).count,0);
    assert.equal((await (await fetch('http://127.0.0.1:3001/api/today')).json()).entries.length,1);
    db.close(); console.log('Actual deletion, repeated cleanup, restart persistence: passed.');
  `);
  compose('run', '--rm', '--no-deps', 'proxy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile');
} finally {
  compose('down', '--volumes', '--remove-orphans');
}
