import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { nextReset, sameInput, taipeiDay, validateInput, type Entry } from '../shared/model.js';
import { PUBLIC_COLUMNS, todayEntries } from './db.js';
import { AdminError, loginAdmin, logoutAdmin, verifyAdmin, type AdminStore } from '../shared/admin-auth.js';

export type AppOptions = {
  origin: string; secret: string; production: boolean; trustProxy: boolean;
  staticDir: string; now?: () => Date;
  adminUsername?: string; adminPassword?: string;
};
class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function credential(req: IncomingMessage): string {
  const value = req.headers.authorization;
  if (!value || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) throw new HttpError(403, 'FORBIDDEN', '無法管理這筆登記，請使用原填寫裝置。');
  return hash(value.slice(7));
}
function authorized(stored: string, supplied: string) {
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(supplied, 'hex'));
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'JSON_REQUIRED', '請使用 JSON 傳送資料。');
  if (Number(req.headers['content-length']) > 4096) throw new HttpError(413, 'TOO_LARGE', '資料超過大小限制。');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new HttpError(413, 'TOO_LARGE', '資料超過大小限制。');
    chunks.push(chunk);
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new HttpError(400, 'INVALID_JSON', '資料格式錯誤，請重試。'); }
}

function json(res: ServerResponse, status: number, data?: unknown) {
  res.statusCode = status;
  if (data === undefined) { res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

export function createApp(db: DatabaseSync, options: AppOptions) {
  const adminConfig = { username: options.adminUsername || 'jingyuan', password: options.adminPassword || '', secret: options.secret };
  const adminStore: AdminStore = {
    async consume(key, expires) { return (db.prepare('INSERT INTO rate_limits(key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits').get(key, expires) as { hits: number }).hits; },
    async create(hash, fingerprint, expires) { db.prepare('INSERT INTO admin_sessions(token_hash,fingerprint,expires_at) VALUES (?,?,?)').run(hash, fingerprint, expires); },
    async find(hash) { return db.prepare('SELECT fingerprint,expires_at FROM admin_sessions WHERE token_hash=?').get(hash) as { fingerprint: string; expires_at: number } | undefined; },
    async remove(hash) { db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(hash); },
  };
  const peer = (req: IncomingMessage) => options.trustProxy && typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : req.socket.remoteAddress || 'unknown';
  function limited(req: IncomingMessage, now: Date, write: boolean) {
    // Only trust a proxy which overwrites X-Real-IP; never trust X-Forwarded-For.
    const peer = options.trustProxy && typeof req.headers['x-real-ip'] === 'string'
      ? req.headers['x-real-ip'] : req.socket.remoteAddress || 'unknown';
    const seconds = write ? 600 : 60;
    const slot = Math.floor(now.getTime() / (seconds * 1000));
    const key = createHmac('sha256', options.secret).update(`${taipeiDay(now)}:${peer}:${write}:${slot}`).digest('hex');
    const row = db.prepare(`INSERT INTO rate_limits(key, hits, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits`).get(key, (slot + 1) * seconds * 1000) as { hits: number };
    if (row.hits > (write ? 30 : 600)) throw new HttpError(429, 'RATE_LIMIT', '操作太頻繁，請稍候再試。');
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Snapshot upon server receipt; no date supplied by the browser is trusted.
    const receivedAt = options.now?.() || new Date();
    const day = taipeiDay(receivedAt);
    const timestamp = receivedAt.toISOString();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (options.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url || '/', options.origin);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD', '不支援此操作。');
        const relative = decodeURIComponent(url.pathname);
        const root = resolve(options.staticDir);
        const file = resolve(root, '.' + relative);
        if (!file.startsWith(root + sep) && file !== root) throw new HttpError(404, 'NOT_FOUND', '找不到頁面。');
        const target = existsSync(file) && statSync(file).isFile() ? file : resolve(root, 'index.html');
        if (!existsSync(target)) throw new HttpError(503, 'NOT_BUILT', '前端尚未建置，開發時請開啟 http://localhost:5173。');
        const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
        res.setHeader('Content-Type', mime[extname(target)] || 'application/octet-stream');
        res.setHeader('Cache-Control', target.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
        if (req.method === 'HEAD') res.end(); else createReadStream(target).pipe(res);
        return;
      }
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      if (url.pathname === '/api/health' && req.method === 'GET') {
        db.prepare('SELECT 1').get();
        json(res, 200, { ok: true }); return;
      }
      const write = req.method !== 'GET';
      if (write && req.headers.origin !== options.origin) throw new HttpError(403, 'ORIGIN', '請從網站頁面操作。');
      limited(req, receivedAt, write);
      if (url.pathname.startsWith('/api/admin/')) {
        if (url.pathname === '/api/admin/session') {
          if (req.method === 'POST') { json(res, 200, await loginAdmin(adminConfig, adminStore, peer(req), await readJson(req), receivedAt)); return; }
          if (req.method === 'GET') { json(res, 200, await verifyAdmin(adminConfig, adminStore, req.headers.authorization, receivedAt)); return; }
          if (req.method === 'DELETE') { await logoutAdmin(adminStore, req.headers.authorization); json(res, 204); return; }
          throw new HttpError(405, 'METHOD', '不支援此操作。');
        }
        await verifyAdmin(adminConfig, adminStore, req.headers.authorization, receivedAt);
        const target = /^\/api\/admin\/entries\/([^/]+)$/.exec(url.pathname);
        if (!target || !idPattern.test(target[1])) throw new HttpError(404, 'NOT_FOUND', '找不到此登記。');
        const id = target[1];
        if (req.method === 'DELETE') {
          const deleted = db.prepare('DELETE FROM entries WHERE id=? AND day=?').run(id, day);
          if (!deleted.changes) throw new HttpError(404, 'NOT_FOUND', '登記已刪除或到期。');
          json(res, 204); return;
        }
        if (req.method !== 'PUT') throw new HttpError(405, 'METHOD', '不支援此操作。');
        const data = await readJson(req);
        const parsed = validateInput(data);
        if ('error' in parsed) throw new HttpError(422, 'VALIDATION', parsed.error);
        db.exec('BEGIN IMMEDIATE');
        let entry;
        try {
          if (!db.prepare('SELECT id FROM entries WHERE id=? AND day=?').get(id, day)) throw new HttpError(404, 'NOT_FOUND', '登記已刪除或到期。');
          const value = parsed.value;
          if (data.confirmSameName !== true && db.prepare('SELECT id FROM entries WHERE day=? AND name=? AND id<>? LIMIT 1').get(day, value.name, id)) throw new HttpError(409, 'DUPLICATE_NAME', '今天已有完全相同姓名，請確認後儲存修改。');
          db.prepare('UPDATE entries SET name=?,status=?,reason=?,eta=?,updated_at=? WHERE id=? AND day=?').run(value.name, value.status, value.reason, value.eta, timestamp, id, day);
          entry = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM entries WHERE id=? AND day=?`).get(id, day);
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        json(res, 200, { entry, day, serverNow: timestamp, nextResetAt: nextReset(day) }); return;
      }
      if (url.pathname === '/api/today' && req.method === 'GET') {
        json(res, 200, { day, serverNow: timestamp, nextResetAt: nextReset(day), entries: todayEntries(db, day) }); return;
      }
      const match = /^\/api\/entries\/([^/]+)$/.exec(url.pathname);
      if (url.pathname !== '/api/entries' && !match) throw new HttpError(404, 'NOT_FOUND', '找不到此操作。');
      if (!(req.method === 'POST' && !match) && !(match && (req.method === 'PUT' || req.method === 'DELETE'))) throw new HttpError(405, 'METHOD', '不支援此操作。');
      const tokenHash = credential(req);
      const data = req.method === 'DELETE' ? {} : await readJson(req);
      const id = match ? match[1] : data.id;
      if (typeof id !== 'string' || !idPattern.test(id)) throw new HttpError(400, 'INVALID_ID', '登記識別碼格式錯誤。');
      const parsed = req.method === 'DELETE' ? undefined : validateInput(data);
      if (parsed && 'error' in parsed) throw new HttpError(422, 'VALIDATION', parsed.error);
      // Atomic ownership, duplicate check, and mutation, including simultaneous names.
      db.exec('BEGIN IMMEDIATE');
      let result: unknown;
      let responseCode = req.method === 'POST' ? 201 : 200;
      try {
        const existing = db.prepare('SELECT token_hash, day FROM entries WHERE id = ?').get(id) as { token_hash: string; day: string } | undefined;
        if (existing && (!authorized(existing.token_hash, tokenHash) || existing.day !== day)) throw new HttpError(403, 'FORBIDDEN', '無法管理這筆登記，請使用原填寫裝置；舊登記已到期。');
        if (req.method === 'POST' && existing) {
          // A lost response/repeated POST returns the same row; never creates another.
          const entry = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM entries WHERE id = ? AND day = ?`).get(id, day) as Entry | undefined;
          if (entry && parsed && 'value' in parsed && !sameInput(entry, parsed.value)) {
            throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '先前的登記已送達。已保留目前輸入，請按「儲存修改」更新同一筆登記。');
          }
          result = entry;
          responseCode = 200;
        } else if (req.method === 'DELETE') {
          if (!existing) throw new HttpError(404, 'NOT_FOUND', '登記已撤回或到期。');
          db.prepare('DELETE FROM entries WHERE id = ? AND token_hash = ? AND day = ?').run(id, tokenHash, day);
          responseCode = 204;
        } else {
          if (req.method === 'PUT' && !existing) throw new HttpError(404, 'NOT_FOUND', '登記已撤回或到期。');
          const value = parsed && 'value' in parsed ? parsed.value : undefined;
          if (!value) throw new HttpError(422, 'VALIDATION', '請填寫完整資料。');
          const duplicate = db.prepare('SELECT id FROM entries WHERE day = ? AND name = ? AND id <> ? LIMIT 1').get(day, value.name, id);
          if (duplicate && data.confirmSameName !== true) throw new HttpError(409, 'DUPLICATE_NAME', '今天已有完全相同姓名。若是同名隊員，請確認後再送出；原登記不會被覆蓋。');
          if (req.method === 'POST') {
            db.prepare('INSERT INTO entries(id, day, name, status, reason, eta, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(id, day, value.name, value.status, value.reason, value.eta, tokenHash, timestamp, timestamp);
          } else {
            db.prepare('UPDATE entries SET name = ?, status = ?, reason = ?, eta = ?, updated_at = ? WHERE id = ? AND token_hash = ? AND day = ?')
              .run(value.name, value.status, value.reason, value.eta, timestamp, id, tokenHash, day);
          }
          result = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM entries WHERE id = ? AND day = ?`).get(id, day);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      json(res, responseCode, result ? { entry: result, day, serverNow: timestamp, nextResetAt: nextReset(day) } : undefined);
    } catch (error) {
      if (error instanceof HttpError || error instanceof AdminError) {
        if (error.status === 429) res.setHeader('Retry-After', error instanceof AdminError ? '900' : '600');
        json(res, error.status, { code: error.code, message: error.message });
      } else {
        // No request bodies, identifiers, names, reasons, credentials or raw errors.
        console.error('REQUEST_FAILED');
        json(res, 503, { code: 'UNAVAILABLE', message: '服務暫時無法使用，輸入內容已保留，請稍後重試。' });
      }
    }
  }
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 40;
  return server;
}
