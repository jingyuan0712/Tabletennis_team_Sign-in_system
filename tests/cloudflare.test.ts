import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openDatabase, migrate } from '../server/db.js';
import worker, { handleRequest, cleanupD1, type Env } from '../cloudflare/worker.js';

// Portable, real SQLite adapter for D1's atomic batch contract. A separate runtime
// integration test exercises the same source with actual workerd/D1 bindings.
function fixture() {
  const db = openDatabase(':memory:'); migrate(db);
  function statement(sql: string, values: any[] = []): any {
    return {
      bind: (...parameters: any[]) => statement(sql, parameters),
      first: async () => db.prepare(sql).get(...values) || null,
      all: async () => execute(sql, values),
      run: async () => execute(sql, values),
      sql, values,
    };
  }
  function execute(sql: string, values: any[]) {
    const result = db.prepare(sql);
    const rows = result.columns().length ? result.all(...values) : [];
    const changes = result.columns().length ? 0 : Number(result.run(...values).changes);
    return { success: true, results: rows, meta: { changes } };
  }
  const env = {
    DB: {
      prepare: statement,
      async batch(statements: any[]) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = statements.map(s => execute(s.sql, s.values));
          db.exec('COMMIT'); return result;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
    },
    ALLOWED_ORIGIN: 'https://jingyuan0712.github.io',
    RATE_LIMIT_SECRET: randomBytes(32).toString('hex'),
    ADMIN_USERNAME: 'test-coach',
    ADMIN_PASSWORD: 'test-only-administrator-password',
  } as unknown as Env;
  let now = new Date('2026-10-15T15:59:59.000Z');
  return {
    db, env,
    advance: (value: string) => { now = new Date(value); },
    request(path = '/api/today', method = 'GET', body?: unknown, token?: string, headers: Record<string, string> = {}) {
      const req = new Request('https://tabletennis-team-api.example.workers.dev' + path, {
        method,
        headers: { Origin: env.ALLOWED_ORIGIN, 'CF-Connecting-IP': '192.0.2.1', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return handleRequest(req as any, env, now);
    },
    close: () => db.close(),
  };
}
const secret = () => randomBytes(32).toString('base64url');
const input = (id = randomUUID(), name = '測試隊員') => ({ id, name, status: 'leave', reason: '今日有事', eta: null });

test('Cloudflare cross-origin preflight permits only configured Pages origin/methods/headers, no cookies', async () => {
  const f = fixture();
  try {
    const preflight = await f.request('/api/entries', 'OPTIONS', undefined, undefined, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), f.env.ALLOWED_ORIGIN);
    assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal(preflight.headers.get('Vary'), 'Origin');
    const blocked = await f.request('/api/entries', 'OPTIONS', undefined, undefined, { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'DELETE' });
    assert.equal(blocked.status, 403); assert.equal(blocked.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal((await f.request('/api/entries', 'POST', input(), secret(), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.request('/api/today', 'OPTIONS', undefined, undefined, { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-Unsupported' })).status, 403);
  } finally { f.close(); }
});

test('D1: leave/late, required reason, server day, public field allowlist and idempotent POST', async () => {
  const f = fixture(); const data = input(); const token = secret();
  try {
    assert.equal((await f.request('/api/entries', 'POST', { ...data, reason: ' ' }, token)).status, 422);
    assert.equal((await f.request('/api/entries', 'POST', { ...data, day: '1900-01-01' }, token)).status, 201);
    assert.equal((await f.request('/api/entries', 'POST', data, token)).status, 200);
    assert.equal((await f.request('/api/entries', 'POST', { ...input(randomUUID(), '另一隊員'), status: 'late', eta: '20:00' }, secret())).status, 201);
    const response = await f.request(); const list = await response.json() as any;
    assert.equal(list.day, '2026-10-15'); assert.equal(list.entries.length, 2);
    assert.equal(response.headers.get('Cache-Control'), 'no-store, max-age=0');
    assert.deepEqual(Object.keys(list.entries[0]).sort(), ['id', 'day', 'name', 'status', 'reason', 'eta', 'createdAt', 'updatedAt'].sort());
    assert(!JSON.stringify(list).includes(token)); assert(!JSON.stringify(list).includes('token_hash'));
    // The production export must not mistake the Workers ExecutionContext for a Date.
    const health = await worker.fetch(new Request('https://example.com/api/health') as any, f.env);
    assert.equal(health.status, 200);
  } finally { f.close(); }
});

test('atomic D1 duplicate confirmation including concurrent writers, idempotency after name collision, and update collision', async () => {
  const f = fixture(); const one = input(); const two = input(); const token = secret(); const token2 = secret();
  try {
    const statuses = await Promise.all([f.request('/api/entries', 'POST', one, token), f.request('/api/entries', 'POST', two, token2)]);
    assert.deepEqual(statuses.map(r => r.status).sort(), [201, 409]);
    f.db.prepare('DELETE FROM entries').run();
    assert.equal((await f.request('/api/entries', 'POST', one, token)).status, 201);
    assert.equal((await f.request('/api/entries', 'POST', { ...two, confirmSameName: 'true' }, token2)).status, 409);
    assert.equal((await f.request('/api/entries', 'POST', { ...two, confirmSameName: true }, token2)).status, 201);
    assert.equal((await f.request('/api/entries', 'POST', one, token)).status, 200);
    assert.equal((await f.request(`/api/entries/${two.id}`, 'PUT', { ...two, reason: '修改原因' }, token2)).status, 409);
    assert.equal((await f.request(`/api/entries/${two.id}`, 'PUT', { ...two, reason: '修改原因', confirmSameName: true }, token2)).status, 200);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n, 2);
  } finally { f.close(); }
});

test('D1 changed POST retry reports conflict and requires an explicit owner update', async () => {
  const f = fixture(); const data = input(); const owner = secret();
  try {
    assert.equal((await f.request('/api/entries', 'POST', data, owner)).status, 201);
    const retry = await f.request('/api/entries', 'POST', { ...data, reason: '重試前改過的原因' }, owner);
    assert.equal(retry.status, 409);
    assert.equal((await retry.json() as any).code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(((await (await f.request()).json()) as any).entries[0].reason, data.reason);
    assert.equal((await f.request(`/api/entries/${data.id}`, 'PUT', { ...data, reason: '重試前改過的原因' }, owner)).status, 200);
    const list = await (await f.request()).json() as any;
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0].reason, '重試前改過的原因');
  } finally { f.close(); }
});

test('D1 authorizes each atomic write; ID/name does not permit modification/deletion; independent readers synchronize', async () => {
  const f = fixture(); const data = input(); const token = secret();
  try {
    await f.request('/api/entries', 'POST', data, token);
    for (const method of ['PUT', 'DELETE', 'POST']) {
      const path = method === 'POST' ? '/api/entries' : `/api/entries/${data.id}`;
      for (const invalid of [undefined, secret()]) assert.equal((await f.request(path, method, method === 'DELETE' ? undefined : data, invalid)).status, 403);
    }
    assert.equal((await f.request(`/api/entries/${data.id}`, 'PUT', { ...data, reason: '行程變更', status: 'late', eta: '19:45' }, token)).status, 200);
    const a = await (await f.request()).json() as any;
    const b = await (await f.request()).json() as any;
    assert.deepEqual(a, b); assert.equal(b.entries[0].reason, '行程變更');
    assert.equal((await f.request(`/api/entries/${data.id}`, 'DELETE', undefined, token)).status, 204);
    assert.equal(((await (await f.request()).json()) as any).entries.length, 0);
  } finally { f.close(); }
});

test('D1 Taipei midnight filters without cron, rejects old edits, deletes all expired data with repeated/delayed jobs', async () => {
  const f = fixture(); const data = input(); const token = secret();
  try {
    await f.request('/api/entries', 'POST', data, token);
    f.advance('2026-10-15T16:00:00.000Z');
    const list = await (await f.request()).json() as any;
    assert.equal(list.day, '2026-10-16'); assert.equal(list.entries.length, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n, 1);
    assert.equal((await f.request(`/api/entries/${data.id}`, 'PUT', data, token)).status, 403);
    assert.equal((await f.request('/api/entries', 'POST', input(), secret())).status, 201);
    await cleanupD1(f.env, new Date('2026-10-15T16:00:00Z'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n, 1);
    await cleanupD1(f.env, new Date('2026-10-15T16:01:00Z'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n, 1);
    await cleanupD1(f.env, new Date('2026-10-18T16:00:00Z'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM entries').get()?.n, 0);
    const config = JSON.parse(readFileSync('wrangler.json', 'utf8'));
    assert(config.triggers.crons.includes('0 16 * * *')); // UTC 16:00 = Taipei 00:00
  } finally { f.close(); }
});

test('Cloudflare: persistent rate limits, no original IP, body/JSON constraints, missing server secret fails closed', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/api/entries', 'POST', { ...input(), reason: 'x'.repeat(5000) }, secret())).status, 413);
    for (let i = 0; i < 29; i++) await f.request('/api/entries', 'POST', { ...input(), reason: '' }, secret());
    assert.equal((await f.request('/api/entries', 'POST', input(), secret())).status, 429);
    const keys = f.db.prepare('SELECT key FROM rate_limits').all(); assert(keys.every(v => !String(v.key).includes('192.0.2.1')));
    f.env.RATE_LIMIT_SECRET = '';
    const failed = await f.request(); assert.equal(failed.status, 503);
    assert(!await failed.text().then(t => t.includes('token_hash')));
  } finally { f.close(); }
});

test('admin: correct login, public/owner token isolation, edit others, original ownership preserved, logout revokes', async () => {
  const f = fixture(); const data = input(); const owner = secret();
  try {
    await f.request('/api/entries', 'POST', data, owner);
    assert.equal((await f.request(`/api/admin/entries/${data.id}`, 'DELETE')).status, 401);
    assert.equal((await f.request(`/api/admin/entries/${data.id}`, 'DELETE', undefined, owner)).status, 401);
    assert.equal((await f.request('/api/admin/session', 'POST', { username: 'test-coach', password: 'wrong' })).status, 401);
    const login = await f.request('/api/admin/session', 'POST', { username: 'test-coach', password: f.env.ADMIN_PASSWORD });
    assert.equal(login.status, 200);
    const session = await login.json() as any;
    assert.equal(session.token.length, 43);
    assert.equal((await f.request('/api/admin/session', 'GET', undefined, session.token)).status, 200);
    assert.equal((await f.request(`/api/admin/entries/${data.id}`, 'PUT', { ...data, reason: ' ' }, session.token)).status, 422);
    assert.equal((await f.request(`/api/admin/entries/${data.id}`, 'PUT', { ...data, reason: '管理員已修正', status: 'late', eta: '21:00' }, session.token)).status, 200);
    const publicData = await (await f.request()).json() as any;
    assert.equal(publicData.entries[0].reason, '管理員已修正');
    assert(!JSON.stringify(publicData).includes(session.token));
    assert(!JSON.stringify(publicData).includes('fingerprint'));
    assert(!JSON.stringify(f.db.prepare('SELECT * FROM admin_sessions').all()).includes(session.token));
    // An admin edit never transfers or invalidates the original submitter's token.
    assert.equal((await f.request(`/api/entries/${data.id}`, 'PUT', { ...data, reason: '原填寫者仍可修改' }, owner)).status, 200);
    assert.equal((await f.request('/api/admin/session', 'DELETE', undefined, session.token)).status, 204);
    assert.equal((await f.request(`/api/admin/entries/${data.id}`, 'DELETE', undefined, session.token)).status, 401);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM admin_sessions').get()?.n, 0);
    const again = await (await f.request('/api/admin/session', 'POST', { username: 'test-coach', password: f.env.ADMIN_PASSWORD })).json() as any;
    assert.equal((await f.request(`/api/admin/entries/${data.id}`, 'DELETE', undefined, again.token)).status, 204);
    assert.equal(((await (await f.request()).json()) as any).entries.length, 0);
  } finally { f.close(); }
});

test('admin: server expiry, password rotation, cross-origin rejection and no access to yesterday records', async () => {
  const f = fixture(); const data = input();
  try {
    await f.request('/api/entries', 'POST', data, secret());
    const login = await (await f.request('/api/admin/session', 'POST', { username: 'test-coach', password: f.env.ADMIN_PASSWORD })).json() as any;
    assert.equal((await f.request('/api/admin/session', 'POST', { username: 'test-coach', password: f.env.ADMIN_PASSWORD }, undefined, { Origin: 'https://evil.example' })).status, 403);
    f.advance('2026-10-15T16:00:00Z');
    assert.equal((await f.request(`/api/admin/entries/${data.id}`, 'DELETE', undefined, login.token)).status, 404);
    f.env.ADMIN_PASSWORD = 'new-test-only-password';
    assert.equal((await f.request('/api/admin/session', 'GET', undefined, login.token)).status, 401);
    f.env.ADMIN_PASSWORD = 'test-only-administrator-password';
    f.advance('2026-10-15T18:00:00Z');
    assert.equal((await f.request('/api/admin/session', 'GET', undefined, login.token)).status, 401);
    await cleanupD1(f.env, new Date('2026-10-15T18:00:00Z'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM admin_sessions').get()?.n, 0);
  } finally { f.close(); }
});

test('admin: isolated login rate limit, no default password, duplicate confirmation and arbitrary methods blocked', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await f.request('/api/admin/session', 'POST', { username: 'wrong', password: 'wrong' })).status, 401);
    const limited = await f.request('/api/admin/session', 'POST', { username: 'test-coach', password: f.env.ADMIN_PASSWORD });
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '900');
    assert.equal((await f.request('/api/entries', 'POST', input(), secret())).status, 201);
    f.advance('2026-10-15T16:15:00Z');
    const admin = await (await f.request('/api/admin/session', 'POST', { username: 'test-coach', password: f.env.ADMIN_PASSWORD })).json() as any;
    const one = input(randomUUID(), '隊員一'); const two = input(randomUUID(), '隊員二');
    await f.request('/api/entries', 'POST', one, secret()); await f.request('/api/entries', 'POST', two, secret());
    assert.equal((await f.request(`/api/admin/entries/${two.id}`, 'PUT', { ...two, name: one.name }, admin.token)).status, 409);
    assert.equal((await f.request(`/api/admin/entries/${two.id}`, 'PUT', { ...two, name: one.name, confirmSameName: true }, admin.token)).status, 200);
    assert.equal((await f.request(`/api/admin/entries/${one.id}`, 'POST', one, admin.token)).status, 405);
    f.env.ADMIN_PASSWORD = '';
    assert.equal((await f.request('/api/admin/session', 'POST', { username: 'test-coach', password: 'anything' })).status, 503);
    assert.equal((await f.request()).status, 200);
  } finally { f.close(); }
});
