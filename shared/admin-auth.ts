export interface AdminConfig { username: string; password: string; secret: string }
export interface AdminStore {
  consume(key: string, expiresAt: number): Promise<number>;
  create(hash: string, fingerprint: string, expiresAt: number): Promise<void>;
  find(hash: string): Promise<{ fingerprint: string; expires_at: number } | undefined>;
  remove(hash: string): Promise<void>;
}
export type AdminSession = { username: string; expiresAt: string; serverNow: string };
export class AdminError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const SESSION_MS = 2 * 60 * 60 * 1000;
const encode = (value: string) => new TextEncoder().encode(value);
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => new Uint8Array(value.match(/../g)!.map(byte => parseInt(byte, 16)));
const unauthorized = () => new AdminError(401, 'ADMIN_UNAUTHORIZED', '管理員登入已到期或無效，請重新登入。');
function ready(config: AdminConfig) {
  if (!config.username || config.password.length < 8 || config.password.length > 256) throw new AdminError(503, 'ADMIN_NOT_CONFIGURED', '管理員登入尚未設定，請先設定伺服器 Secret。');
}
async function key(config: AdminConfig) {
  return crypto.subtle.importKey('raw', encode(config.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const message = (username: string, password: string) => encode(JSON.stringify(['admin-credentials-v1', username, password]));
async function fingerprint(config: AdminConfig) {
  return hex(await crypto.subtle.sign('HMAC', await key(config), message(config.username, config.password)));
}
async function hashToken(authorization: string | null | undefined) {
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw unauthorized();
  return hex(await crypto.subtle.digest('SHA-256', encode(authorization.slice(7))));
}
function describe(config: AdminConfig, expiresAt: number, now: Date): AdminSession {
  return { username: config.username, expiresAt: new Date(expiresAt).toISOString(), serverNow: now.toISOString() };
}
export async function loginAdmin(config: AdminConfig, store: AdminStore, peer: string, input: Record<string, unknown>, now: Date) {
  ready(config);
  const slot = Math.floor(now.getTime() / 900_000);
  // Separate from ordinary team-member limits; per-IP and global login budgets.
  for (const [scope, maximum] of [[peer, 5], ['all-admin-attempts', 60]] as const) {
    const digest = hex(await crypto.subtle.sign('HMAC', await key(config), encode(`admin-login:${scope}:${slot}`)));
    if (await store.consume(digest, (slot + 1) * 900_000) > maximum) throw new AdminError(429, 'ADMIN_RATE_LIMIT', '登入嘗試太頻繁，請稍後再試。');
  }
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (username.length > 64 || password.length > 256) throw new AdminError(401, 'ADMIN_CREDENTIALS', '帳號或密碼不正確。');
  const expected = await fingerprint(config);
  // Native Web Crypto verification avoids timing-sensitive string comparisons.
  if (!await crypto.subtle.verify('HMAC', await key(config), unhex(expected), message(username, password))) throw new AdminError(401, 'ADMIN_CREDENTIALS', '帳號或密碼不正確。');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const hash = await hashToken(`Bearer ${token}`);
  const expires = now.getTime() + SESSION_MS;
  await store.create(hash, expected, expires);
  return { ...describe(config, expires, now), token };
}
export async function verifyAdmin(config: AdminConfig, store: AdminStore, authorization: string | null | undefined, now: Date): Promise<AdminSession> {
  ready(config);
  const hash = await hashToken(authorization);
  const session = await store.find(hash);
  if (!session || session.expires_at <= now.getTime()) throw unauthorized();
  // Changing either credential or the server secret invalidates existing sessions.
  if (!await crypto.subtle.verify('HMAC', await key(config), unhex(session.fingerprint), message(config.username, config.password))) throw unauthorized();
  return describe(config, session.expires_at, now);
}
export async function logoutAdmin(store: AdminStore, authorization: string | null | undefined) {
  await store.remove(await hashToken(authorization));
}
