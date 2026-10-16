import { nextReset, taipeiDay, validateInput, type Entry } from '../shared/model.js';
import { AdminError, loginAdmin, logoutAdmin, verifyAdmin, type AdminStore } from '../shared/admin-auth.js';

export interface Env {
  DB: D1Database;
  ALLOWED_ORIGIN: string;
  RATE_LIMIT_SECRET: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
}
function adminStore(env: Env): AdminStore {
  return {
    async consume(key, expires) {
      const row = await env.DB.prepare('INSERT INTO rate_limits(key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits').bind(key, expires).first<{ hits: number }>();
      return row?.hits || 999;
    },
    async create(hash, fingerprint, expires) { await env.DB.prepare('INSERT INTO admin_sessions(token_hash,fingerprint,expires_at) VALUES (?,?,?)').bind(hash, fingerprint, expires).run(); },
    async find(hash) { return await env.DB.prepare('SELECT fingerprint,expires_at FROM admin_sessions WHERE token_hash=?').bind(hash).first<{ fingerprint: string; expires_at: number }>() || undefined; },
    async remove(hash) { await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(hash).run(); },
  };
}
const columns = 'id, day, name, status, reason, eta, created_at AS createdAt, updated_at AS updatedAt';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), v => v.toString(16).padStart(2, '0')).join('');
const encoder = new TextEncoder();
async function tokenHash(request: Request) {
  const value = request.headers.get('Authorization');
  if (!value || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) throw new HttpError(403, 'FORBIDDEN', '無法管理這筆登記，請使用原填寫裝置。');
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value.slice(7))));
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'JSON_REQUIRED', '請使用 JSON 傳送資料。');
  if (Number(request.headers.get('Content-Length')) > 4096) throw new HttpError(413, 'TOO_LARGE', '資料超過大小限制。');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON', '請填寫完整資料。');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new HttpError(413, 'TOO_LARGE', '資料超過大小限制。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new HttpError(400, 'INVALID_JSON', '資料格式錯誤，請重試。'); }
}

async function rateLimit(request: Request, env: Env, now: Date, write: boolean) {
  // CF-Connecting-IP is set by Cloudflare, never trust X-Forwarded-For from clients.
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const seconds = write ? 600 : 60;
  const slot = Math.floor(now.getTime() / (seconds * 1000));
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.RATE_LIMIT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${taipeiDay(now)}:${ip}:${write}:${slot}`)));
  const row = await env.DB.prepare(`INSERT INTO rate_limits(key, hits, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`)
    .bind(digest, (slot + 1) * seconds * 1000).first<{ hits: number }>();
  if (!row || row.hits > (write ? 30 : 600)) throw new HttpError(429, 'RATE_LIMIT', '操作太頻繁，請稍候再試。');
}

async function mutate(request: Request, env: Env, day: string, timestamp: string, idFromPath?: string): Promise<{ status: number; entry?: Entry }> {
  const hash = await tokenHash(request);
  const data = request.method === 'DELETE' ? {} : await readJson(request);
  const id = idFromPath || data.id;
  if (typeof id !== 'string' || !idPattern.test(id)) throw new HttpError(400, 'INVALID_ID', '登記識別碼格式錯誤。');
  const parsed = request.method === 'DELETE' ? undefined : validateInput(data);
  if (parsed && 'error' in parsed) throw new HttpError(422, 'VALIDATION', parsed.error);

  // D1 batch is an atomic transaction. Every write has its own ownership/day and
  // duplicate-name predicates; no read-then-write authorization race across isolates.
  // Never return the existence/ownership probe to the caller.
  const existing = env.DB.prepare(`SELECT day, (token_hash = ?) AS owned FROM entries WHERE id = ?`).bind(hash, id);
  if (request.method === 'DELETE') {
    const [before, deleted] = await env.DB.batch([
      existing,
      env.DB.prepare('DELETE FROM entries WHERE id = ? AND token_hash = ? AND day = ?').bind(id, hash, day),
    ]);
    checkOwnership(before.results[0] as Probe | undefined, day, true);
    if (!deleted.meta.changes) throw new HttpError(404, 'NOT_FOUND', '登記已撤回或到期。');
    return { status: 204 };
  }
  const value = parsed && 'value' in parsed ? parsed.value : undefined;
  if (!value) throw new HttpError(422, 'VALIDATION', '請填寫完整資料。');
  const confirmed = data.confirmSameName === true ? 1 : 0;
  const duplicate = env.DB.prepare('SELECT id FROM entries WHERE day = ? AND name = ? AND id <> ? LIMIT 1').bind(day, value.name, id);
  const nameAllowed = '(? = 1 OR NOT EXISTS (SELECT 1 FROM entries WHERE day = ? AND name = ? AND id <> ?))';
  const write = request.method === 'POST'
    ? env.DB.prepare(`INSERT INTO entries(id, day, name, status, reason, eta, token_hash, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${nameAllowed} ON CONFLICT DO NOTHING`)
      .bind(id, day, value.name, value.status, value.reason, value.eta, hash, timestamp, timestamp, confirmed, day, value.name, id)
    : env.DB.prepare(`UPDATE entries SET name = ?, status = ?, reason = ?, eta = ?, updated_at = ?
        WHERE id = ? AND token_hash = ? AND day = ? AND ${nameAllowed}`)
      .bind(value.name, value.status, value.reason, value.eta, timestamp, id, hash, day, confirmed, day, value.name, id);
  const [before, duplicates, changed, after] = await env.DB.batch([
    existing, duplicate, write,
    env.DB.prepare(`SELECT ${columns} FROM entries WHERE id = ? AND token_hash = ? AND day = ?`).bind(id, hash, day),
  ]);
  const probe = before.results[0] as Probe | undefined;
  checkOwnership(probe, day, request.method === 'PUT');
  // An identical POST retry succeeds even if another same-name row was added later.
  if (request.method === 'POST' && probe && after.results[0]) return { status: 200, entry: after.results[0] as unknown as Entry };
  if (duplicates.results.length && !confirmed) throw new HttpError(409, 'DUPLICATE_NAME', '今天已有完全相同姓名。若是同名隊員，請確認後再送出；原登記不會被覆蓋。');
  if (!changed.meta.changes || !after.results[0]) throw new HttpError(409, 'CONFLICT', '送出識別碼已使用，請重新開啟頁面後再試。');
  return { status: request.method === 'POST' ? 201 : 200, entry: after.results[0] as unknown as Entry };
}
type Probe = { day: string; owned: number };
function checkOwnership(probe: Probe | undefined, day: string, required: boolean) {
  if (probe && (!probe.owned || probe.day !== day)) throw new HttpError(403, 'FORBIDDEN', '無法管理這筆登記，請使用原填寫裝置；舊登記已到期。');
  if (required && !probe) throw new HttpError(404, 'NOT_FOUND', '登記已撤回或到期。');
}

export async function handleRequest(request: Request, env: Env, now = new Date()): Promise<Response> {
  const origin = request.headers.get('Origin');
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0',
    'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
  });
  if (origin && origin === env.ALLOWED_ORIGIN) headers.set('Access-Control-Allow-Origin', origin);
  const respond = (status: number, data?: unknown) => new Response(data === undefined ? null : JSON.stringify(data), { status, headers });
  try {
    if (!env.ALLOWED_ORIGIN || !env.RATE_LIMIT_SECRET || env.RATE_LIMIT_SECRET.length < 32) throw new HttpError(503, 'CONFIGURATION', '服務尚未完成設定，請稍後再試。');
    if (origin && origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'ORIGIN', '請從網站頁面操作。');
    if (request.method === 'OPTIONS') {
      if (origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'ORIGIN', '不允許此來源。');
      const method = request.headers.get('Access-Control-Request-Method');
      const requested = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
      if (!method || !['GET', 'POST', 'PUT', 'DELETE'].includes(method) || requested.some(v => !['authorization', 'content-type'].includes(v))) throw new HttpError(403, 'ORIGIN', '不允許此操作。');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      headers.set('Access-Control-Max-Age', '600');
      return respond(204);
    }
    const path = new URL(request.url).pathname;
    if (path === '/api/health' && request.method === 'GET') {
      await env.DB.prepare('SELECT 1').first();
      return respond(200, { ok: true });
    }
    const day = taipeiDay(now);
    const timestamp = now.toISOString();
    const write = request.method !== 'GET';
    if (write && origin !== env.ALLOWED_ORIGIN) throw new HttpError(403, 'ORIGIN', '請從網站頁面操作。');
    await rateLimit(request, env, now, write);
    if (path.startsWith('/api/admin/')) {
      const config = { username: env.ADMIN_USERNAME || 'jingyuan', password: env.ADMIN_PASSWORD || '', secret: env.RATE_LIMIT_SECRET };
      const store = adminStore(env);
      if (path === '/api/admin/session') {
        if (request.method === 'POST') return respond(200, await loginAdmin(config, store, request.headers.get('CF-Connecting-IP') || 'local', await readJson(request), now));
        if (request.method === 'GET') return respond(200, await verifyAdmin(config, store, request.headers.get('Authorization'), now));
        if (request.method === 'DELETE') { await logoutAdmin(store, request.headers.get('Authorization')); return respond(204); }
        throw new HttpError(405, 'METHOD', '不支援此操作。');
      }
      await verifyAdmin(config, store, request.headers.get('Authorization'), now);
      const target = /^\/api\/admin\/entries\/([^/]+)$/.exec(path);
      if (!target || !idPattern.test(target[1])) throw new HttpError(404, 'NOT_FOUND', '找不到此登記。');
      const id = target[1];
      if (request.method === 'DELETE') {
        const result = await env.DB.prepare('DELETE FROM entries WHERE id=? AND day=?').bind(id, day).run();
        if (!result.meta.changes) throw new HttpError(404, 'NOT_FOUND', '登記已刪除或到期。');
        return respond(204);
      }
      if (request.method !== 'PUT') throw new HttpError(405, 'METHOD', '不支援此操作。');
      const data = await readJson(request);
      const parsed = validateInput(data);
      if ('error' in parsed) throw new HttpError(422, 'VALIDATION', parsed.error);
      const value = parsed.value;
      const [before, duplicate, changed, after] = await env.DB.batch([
        env.DB.prepare('SELECT id FROM entries WHERE id=? AND day=?').bind(id, day),
        env.DB.prepare('SELECT id FROM entries WHERE day=? AND name=? AND id<>? LIMIT 1').bind(day, value.name, id),
        env.DB.prepare(`UPDATE entries SET name=?,status=?,reason=?,eta=?,updated_at=? WHERE id=? AND day=? AND
          (?=1 OR NOT EXISTS (SELECT 1 FROM entries WHERE day=? AND name=? AND id<>?))`)
          .bind(value.name, value.status, value.reason, value.eta, timestamp, id, day, data.confirmSameName === true ? 1 : 0, day, value.name, id),
        env.DB.prepare(`SELECT ${columns} FROM entries WHERE id=? AND day=?`).bind(id, day),
      ]);
      if (!before.results.length) throw new HttpError(404, 'NOT_FOUND', '登記已刪除或到期。');
      if (duplicate.results.length && data.confirmSameName !== true) throw new HttpError(409, 'DUPLICATE_NAME', '今天已有完全相同姓名，請確認後儲存修改。');
      if (!changed.meta.changes) throw new HttpError(409, 'CONFLICT', '資料已變更，請重新讀取後再試。');
      return respond(200, { entry: after.results[0], day, serverNow: timestamp, nextResetAt: nextReset(day) });
    }
    if (path === '/api/today' && request.method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT ${columns} FROM entries WHERE day = ? ORDER BY created_at DESC, id DESC`).bind(day).all<Entry>();
      return respond(200, { day, serverNow: timestamp, nextResetAt: nextReset(day), entries: results });
    }
    const match = /^\/api\/entries\/([^/]+)$/.exec(path);
    if (path !== '/api/entries' && !match) throw new HttpError(404, 'NOT_FOUND', '找不到此操作。');
    if (!(path === '/api/entries' && request.method === 'POST') && !(match && ['PUT', 'DELETE'].includes(request.method))) throw new HttpError(405, 'METHOD', '不支援此操作。');
    const result = await mutate(request, env, day, timestamp, match?.[1]);
    return respond(result.status, result.entry ? { entry: result.entry, day, serverNow: timestamp, nextResetAt: nextReset(day) } : undefined);
  } catch (error) {
    if (error instanceof HttpError || error instanceof AdminError) {
      if (error.status === 429) headers.set('Retry-After', error instanceof AdminError ? '900' : '600');
      return respond(error.status, { code: error.code, message: error.message });
    }
    // Do not log raw D1 errors, SQL parameters, request headers or payloads.
    return respond(503, { code: 'UNAVAILABLE', message: '服務暫時無法使用，輸入內容已保留，請稍後重試。' });
  }
}

export async function cleanupD1(env: Pick<Env, 'DB'>, now = new Date()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM entries WHERE day < ?').bind(taipeiDay(now)),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now.getTime()),
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(now.getTime()),
  ]);
}

export default {
  fetch(request: Request, env: Env) { return handleRequest(request, env); },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Use actual execution date, so a delayed invocation catches up all expired days.
    // Throw a sanitized error so Cloudflare records failure without any payload.
    try { await cleanupD1(env); } catch { throw new Error('CLEANUP_FAILED'); }
  },
} satisfies ExportedHandler<Env>;
