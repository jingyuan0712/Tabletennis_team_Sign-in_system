import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cron } from 'croner';
import { createApp } from '../server/app.js';
import { cleanup } from '../server/cleanup.js';
import { migrate, openDatabase } from '../server/db.js';
import { nextReset, taipeiDay, validateInput } from '../shared/model.js';

const origin = 'https://team.example.test';
const token = () => randomBytes(32).toString('base64url');
const valid = { name: ' 測試隊員 ', status: 'leave', reason: ' 今日有事 ', eta: null };

function fixture(initial = '2026-10-15T10:00:00Z') {
  const db = openDatabase(':memory:'); migrate(db);
  let time = new Date(initial);
  const app = createApp(db, { origin, secret: 'test-secret-with-more-than-32-characters', production: false, trustProxy: false, staticDir: './dist', now: () => time });
  const ready = new Promise<string>(resolve => app.listen(0, '127.0.0.1', () => {
    const address = app.address(); assert(address && typeof address !== 'string');
    resolve(`http://127.0.0.1:${address.port}`);
  }));
  return {
    db,
    advance: (value: string) => { time = new Date(value); },
    async request(path: string, method = 'GET', body?: unknown, management?: string, requestOrigin = origin) {
      return fetch(await ready + path, { method, headers: { Origin: requestOrigin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(management ? { Authorization: `Bearer ${management}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    },
    async close() { await new Promise<void>(resolve => { app.close(() => resolve()); app.closeAllConnections(); }); db.close(); },
  };
}

test('front/back shared validator: required trimmed fields, Unicode limits, status and ETA', () => {
  assert.deepEqual(validateInput(valid), { value: { ...valid, name: '測試隊員', reason: '今日有事' } });
  for (const patch of [{ name: '　 \t' }, { reason: '\n　' }, { reason: '字'.repeat(201) }, { name: '名'.repeat(21) }, { status: 'present' }, { name: 'A\nB' }, { reason: 'a\0b' }, { status: 'late', eta: '24:01' }]) assert('error' in validateInput({ ...valid, ...patch }));
  assert('value' in validateInput({ ...valid, name: '🏓'.repeat(20), status: 'late', eta: '19:30' }));
  assert.deepEqual(validateInput({ ...valid, eta: '20:00' }), { value: { ...valid, name: '測試隊員', reason: '今日有事', eta: null } });
});

test('server assigns Taipei day; UTC midnight is not Taipei midnight; cron is Taiwan midnight', () => {
  assert.equal(taipeiDay(new Date('2026-10-15T15:59:59.999Z')), '2026-10-15');
  assert.equal(taipeiDay(new Date('2026-10-15T16:00:00.000Z')), '2026-10-16');
  assert.equal(taipeiDay(new Date('2026-10-15T00:00:00Z')), '2026-10-15');
  assert.equal(nextReset('2026-10-15'), '2026-10-15T16:00:00.000Z');
  const cron = new Cron('0 0 * * *', { timezone: 'Asia/Taipei', paused: true });
  assert.equal(cron.nextRun(new Date('2026-10-15T15:59:59Z'))?.toISOString(), '2026-10-15T16:00:00.000Z');
  cron.stop();
});

test('real HTTP + SQL: leave/late creation, validation, idempotency, public allowlist, duplicate confirmation', async () => {
  const f = fixture();
  try {
    const id = randomUUID(); const secret = token();
    const created = await f.request('/api/entries', 'POST', { ...valid, id, day: '1900-01-01' }, secret);
    assert.equal(created.status, 201);
    const result = await created.json();
    assert.equal(result.entry.name, '測試隊員'); assert.equal(result.entry.day, '2026-10-15');
    assert.equal((await f.request('/api/entries', 'POST', { ...valid, id }, secret)).status, 200);
    const missing = await f.request('/api/entries', 'POST', { ...valid, id: randomUUID(), reason: ' ' }, token());
    assert.equal(missing.status, 422);
    const secondId = randomUUID(); const secondSecret = token();
    const duplicate = { ...valid, id: secondId, status: 'late', eta: '20:15' };
    assert.equal((await f.request('/api/entries', 'POST', duplicate, secondSecret)).status, 409);
    assert.equal((await f.request('/api/entries', 'POST', { ...duplicate, confirmSameName: 'true' }, secondSecret)).status, 409);
    assert.equal((await f.request('/api/entries', 'POST', { ...duplicate, confirmSameName: true }, secondSecret)).status, 201);
    // Two independent fetch clients, with no identity, read the same durable SQL rows.
    const a = await f.request('/api/today'); const b = await f.request('/api/today');
    assert.equal(a.headers.get('cache-control'), 'no-store, max-age=0');
    const data = await a.json(); assert.deepEqual(data, await b.json());
    assert.equal(data.entries.length, 2); assert.equal(data.entries.find((e: any) => e.id === secondId).eta, '20:15');
    assert.deepEqual(Object.keys(data.entries[0]).sort(), ['id', 'day', 'name', 'status', 'reason', 'eta', 'createdAt', 'updatedAt'].sort());
    assert(!JSON.stringify(data).includes(secret)); assert(!JSON.stringify(data).includes('token_hash'));
    assert.notEqual(f.db.prepare('SELECT token_hash FROM entries WHERE id = ?').get(id)?.token_hash, secret);
  } finally { await f.close(); }
});

test('ownership is enforced by backend for update/delete/ID replay; all readers see modifications and withdrawal', async () => {
  const f = fixture();
  try {
    const id = randomUUID(); const secret = token();
    await f.request('/api/entries', 'POST', { ...valid, id }, secret);
    for (const method of ['PUT', 'DELETE', 'POST']) {
      const path = method === 'POST' ? '/api/entries' : `/api/entries/${id}`;
      assert.equal((await f.request(path, method, method === 'DELETE' ? undefined : { ...valid, id }, token())).status, 403);
      assert.equal((await f.request(path, method, method === 'DELETE' ? undefined : { ...valid, id })).status, 403);
    }
    assert.equal((await f.request(`/api/entries/${id}`, 'PUT', { ...valid, status: 'late', eta: '19:45', reason: '行程已變更' }, secret)).status, 200);
    let publicData = await (await f.request('/api/today')).json();
    assert.equal(publicData.entries[0].reason, '行程已變更'); assert.equal(publicData.entries[0].eta, '19:45');
    assert.equal((await f.request(`/api/entries/${id}`, 'DELETE', undefined, secret)).status, 204);
    publicData = await (await f.request('/api/today')).json(); assert.equal(publicData.entries.length, 0);
  } finally { await f.close(); }
});

test('Taipei midnight: hide expired records even if cron failed, reject expired ownership, cleanup actually deletes and is idempotent', async () => {
  const f = fixture('2026-10-15T15:59:59.999Z');
  try {
    const oldId = randomUUID(); const oldToken = token();
    await f.request('/api/entries', 'POST', { ...valid, id: oldId }, oldToken);
    f.advance('2026-10-15T16:00:00.000Z');
    const current = await (await f.request('/api/today')).json();
    assert.equal(current.day, '2026-10-16'); assert.equal(current.entries.length, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM entries').get()?.count, 1);
    assert.equal((await f.request(`/api/entries/${oldId}`, 'PUT', valid, oldToken)).status, 403);
    assert.equal((await f.request('/api/entries', 'POST', { ...valid, id: randomUUID(), day: '2026-10-15' }, token())).status, 201);
    assert.equal(cleanup(f.db, new Date('2026-10-15T16:00:00Z')), 1);
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM entries').get()?.count, 1);
    assert.equal(cleanup(f.db, new Date('2026-10-15T16:01:00Z')), 0);
    // An outage spanning several days is caught up by the next run.
    assert.equal(cleanup(f.db, new Date('2026-10-18T16:00:00Z')), 1);
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM entries').get()?.count, 0);
  } finally { await f.close(); }
});

test('database constraints, concurrent same-name submissions and SQL parameterization', async () => {
  const f = fixture();
  try {
    const responses = await Promise.all([1, 2].map(() => f.request('/api/entries', 'POST', { ...valid, id: randomUUID() }, token())));
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    assert.equal((await f.request('/api/entries', 'POST', { ...valid, id: randomUUID(), name: "Robert');--", reason: '<script>alert(1)</script>' }, token())).status, 201);
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM entries').get()?.count, 2);
    assert.throws(() => f.db.prepare("UPDATE entries SET status = 'present'").run());
  } finally { await f.close(); }
});

test('same-origin JSON and persistent IP rate limits restrict abuse; secrets do not leak through errors', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/api/entries', 'POST', { ...valid, id: randomUUID() }, token(), 'https://evil.test')).status, 403);
    for (let i = 0; i < 30; i++) await f.request('/api/entries', 'POST', { ...valid, reason: '', id: randomUUID() }, token());
    const blocked = await f.request('/api/entries', 'POST', { ...valid, id: randomUUID() }, token());
    assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '600');
    f.advance('2026-10-15T10:10:00Z');
    assert.equal((await f.request('/api/entries', 'POST', { ...valid, id: randomUUID() }, token())).status, 201);
  } finally { await f.close(); }
});

test('file database survives restart; independent server/scheduler connections share data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'team-test-')); const path = join(directory, 'test.sqlite');
  const db = openDatabase(path); migrate(db);
  db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), '2026-10-14', '測試', 'leave', '測試原因', null, 'a'.repeat(64), '2026-10-14T01:00:00Z', '2026-10-14T01:00:00Z');
  db.close();
  const reader = openDatabase(path); const scheduler = openDatabase(path);
  try {
    migrate(reader); migrate(scheduler);
    assert.equal(reader.prepare('SELECT count(*) AS count FROM entries').get()?.count, 1);
    cleanup(scheduler, new Date('2026-10-15T10:00:00Z'));
    assert.equal(reader.prepare('SELECT count(*) AS count FROM entries').get()?.count, 0);
  } finally { reader.close(); scheduler.close(); rmSync(directory, { recursive: true }); }
});
