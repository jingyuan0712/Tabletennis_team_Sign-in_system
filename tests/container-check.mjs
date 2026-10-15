import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { openDatabase } from './dist-server/server/db.js';
import { taipeiDay } from './dist-server/shared/model.js';
const origin = process.env.PUBLIC_ORIGIN;
const base = 'http://127.0.0.1:3001';
assert.equal(process.getuid(), 10001);
const db = openDatabase('/data/team.sqlite');
assert.equal((statSync('/data/team.sqlite').mode & 0o077), 0);
const response = await fetch(base + '/api/entries', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${randomBytes(32).toString('base64url')}` },
  body: JSON.stringify({ id: randomUUID(), name: '容器測試', status: 'late', reason: '隔離環境驗證', eta: '20:30' }),
});
assert.equal(response.status, 201);
const today = taipeiDay(new Date());
const yesterday = taipeiDay(new Date(Date.now() - 86400000));
db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), yesterday, '舊測試', 'leave', '應被刪除', null, 'f'.repeat(64), new Date().toISOString(), new Date().toISOString());
const list = await (await fetch(base + '/api/today')).json();
assert.equal(list.day, today); assert.equal(list.entries.length, 1);
assert.equal(db.prepare('SELECT count(*) AS count FROM entries WHERE day < ?').get(today).count, 1);
const html = await fetch(base + '/'); assert.equal(html.status, 200);
assert(html.headers.get('content-security-policy').includes("script-src 'self'"));
assert((await html.text()).includes('桌球隊出席登記'));
assert(Number(readFileSync('/data/team.sqlite.scheduler-heartbeat', 'utf8')) > Date.now() - 420000);
db.close();
console.log('Container API, permissions, static assets, heartbeat, expired-read filtering: passed.');
