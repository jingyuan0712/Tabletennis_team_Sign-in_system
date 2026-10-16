import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

// Actual workerd + D1 emulation. No Cloudflare account, token, or production DB.
mkdirSync('.test-data', { recursive: true });
const directory = mkdtempSync('.test-data/cloudflare-runtime-');
const state = resolve(directory, 'state');
const secretFile = resolve(directory, 'vars');
const testAdminPassword = 'runtime-admin-test-only';
writeFileSync(secretFile, 'RATE_LIMIT_SECRET=' + randomBytes(32).toString('hex') + '\nADMIN_PASSWORD=' + testAdminPassword + '\n');
const browserMode = process.argv.includes('--browser');
const siteRoot = resolve(directory, 'site');
const basePath = '/Tabletennis_team_Sign-in_system/';
let site;
let origin = 'https://jingyuan0712.github.io';
if (browserMode) {
  site = createHttpServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!path.startsWith(basePath)) { res.writeHead(404); res.end(); return; }
    const relative = path.slice(basePath.length) || 'index.html';
    const file = resolve(siteRoot, relative);
    if (!file.startsWith(siteRoot + sep) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  site.unref();
  origin = `http://127.0.0.1:${site.address().port}`;
}
const settings = JSON.parse(readFileSync('wrangler.json', 'utf8'));
settings.main = resolve(settings.main);
settings.d1_databases[0].migrations_dir = resolve('migrations');
settings.vars.ALLOWED_ORIGIN = origin;
const config = resolve(directory, 'wrangler.json');
writeFileSync(config, JSON.stringify(settings));
const cli = resolve('node_modules/wrangler/bin/wrangler.js');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
function command(args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--config', config], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Local Wrangler command failed:\n' + result.stderr + result.stdout);
}
command(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state]);
// Ask OS for a free loopback port. No fixed port or reuse of another project.
const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); });
});
const server = spawn(process.execPath, [cli, 'dev', '--local', '--test-scheduled', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', state, '--env-file', secretFile, '--config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', chunk => { logs += chunk.toString(); });
server.stderr.on('data', chunk => { logs += chunk.toString(); });
const base = `http://127.0.0.1:${port}`;
const token = randomBytes(32).toString('base64url');
const id = randomUUID();
const value = { id, name: '雲端測試', status: 'late', reason: '隔離測試環境', eta: '20:15' };
const headers = { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const request = (path, method = 'GET', body, customHeaders = headers) => fetch(base + path, { method, headers: customHeaders, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12_000) });
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (server.exitCode !== null) throw new Error('Wrangler dev exited:\n' + logs);
    try { if ((await request('/api/health')).ok) { ready = true; break; } } catch { /* wait for workerd */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(ready, 'Local Cloudflare runtime did not become ready:\n' + logs);
  const preflight = await request('/api/entries', 'OPTIONS', undefined, { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal((await request('/api/entries', 'POST', value)).status, 201);
  assert.equal((await request('/api/entries', 'POST', value)).status, 200);
  const list = await (await request('/api/today')).json();
  assert.equal(list.entries.length, 1); assert(!JSON.stringify(list).includes(token));
  assert.equal((await request(`/api/entries/${id}`, 'DELETE', undefined, { Origin: origin, Authorization: 'Bearer ' + randomBytes(32).toString('base64url') })).status, 403);
  assert.equal((await request(`/api/entries/${id}`, 'PUT', { ...value, reason: '行程變更' })).status, 200);
  // Insert a genuinely expired row in the isolated D1, and dispatch scheduled handler.
  const oldId = randomUUID();
  command(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--command', `INSERT INTO entries VALUES ('${oldId}','2000-01-01','過期測試','leave','待刪除',NULL,'${'a'.repeat(64)}','2000-01-01T00:00:00Z','2000-01-01T00:00:00Z')`]);
  assert.equal((await (await request('/api/today')).json()).entries.length, 1);
  assert.equal((await fetch(base + '/cdn-cgi/local/scheduled?cron=0+16+*+*+*')).status, 200);
  assert.equal((await fetch(base + '/cdn-cgi/local/scheduled?cron=0+16+*+*+*')).status, 200);
  // A CHECK failure causes CLI failure if scheduled cleanup did not really remove it.
  command(['d1', 'execute', 'DB', '--local', '--persist-to', state, '--command', "CREATE TABLE cleanup_assert(n INTEGER CHECK(n=0)); INSERT INTO cleanup_assert SELECT count(*) FROM entries WHERE day='2000-01-01'; DROP TABLE cleanup_assert;"]);
  assert.equal((await request(`/api/entries/${id}`, 'DELETE')).status, 204);
  assert.equal((await (await request('/api/today')).json()).entries.length, 0);
  const moderated = { ...value, id: randomUUID(), name: '待管理測試' };
  assert.equal((await request('/api/entries', 'POST', moderated)).status, 201);
  assert.equal((await request(`/api/admin/entries/${moderated.id}`, 'DELETE')).status, 401);
  const login = await request('/api/admin/session', 'POST', { username: 'jingyuan', password: testAdminPassword });
  assert.equal(login.status, 200);
  const session = await login.json();
  const managerHeaders = { ...headers, Authorization: `Bearer ${session.token}` };
  assert.equal((await request(`/api/admin/entries/${moderated.id}`, 'PUT', { ...moderated, reason: '管理員修正' }, managerHeaders)).status, 200);
  assert.equal((await (await request('/api/today')).json()).entries[0].reason, '管理員修正');
  assert.equal((await request(`/api/admin/entries/${moderated.id}`, 'DELETE', undefined, managerHeaders)).status, 204);
  assert.equal((await request('/api/admin/session', 'DELETE', undefined, managerHeaders)).status, 204);
  assert.equal((await request('/api/admin/session', 'GET', undefined, managerHeaders)).status, 401);
  console.log('Actual workerd/D1: CORS, create/retry, private credentials, ownership, edit/delete and scheduled physical deletion passed.');
  console.log('Actual workerd/D1: administrator login, moderation, logout and revoked-session rejection passed.');
  if (browserMode) {
    // This isolated test builds HTTP loopback URLs directly; production Pages
    // build-pages.mjs independently enforces HTTPS for the published API origin.
    const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', siteRoot], {
      env: { ...env, VITE_API_BASE_URL: base, VITE_BASE_PATH: basePath }, encoding: 'utf8',
    });
    assert.equal(build.status, 0, build.stderr);
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    const contextA = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'America/Los_Angeles' });
    const contextB = await browser.newContext({ timezoneId: 'Pacific/Auckland' });
    try {
      const a = await contextA.newPage(); const b = await contextB.newPage();
      const errors = [];
      a.on('pageerror', error => errors.push(error.message));
      b.on('pageerror', error => errors.push(error.message));
      const { expect } = await import('@playwright/test');
      await Promise.all([a.goto(origin + basePath), b.goto(origin + basePath)]);
      await expect(a.getByText('今天還沒有人登記請假或遲到。')).toBeVisible();
      await a.getByLabel('姓名', { exact: false }).fill('跨站測試');
      await a.getByRole('button', { name: '遲到 會晚一點抵達' }).click();
      await a.getByLabel('原因', { exact: false }).fill('Pages 子路徑連接 D1');
      await a.getByRole('button', { name: '送出今日登記' }).click();
      await expect(a.getByRole('article')).toHaveCount(1);
      await expect(b.getByRole('article')).toHaveCount(1, { timeout: 15_000 });
      await expect(b.getByRole('button', { name: '修改', exact: true })).toHaveCount(0);
      assert(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await a.getByRole('button', { name: '修改', exact: true }).click();
      await a.getByLabel('原因', { exact: false }).fill('跨來源修改已同步');
      await a.getByRole('button', { name: '儲存修改' }).click();
      await expect(b.getByRole('article')).toContainText('跨來源修改已同步', { timeout: 15_000 });
      await a.getByRole('button', { name: '撤回', exact: true }).click();
      await a.getByRole('button', { name: '確認撤回' }).click();
      await expect(b.getByRole('article')).toHaveCount(0, { timeout: 15_000 });
      // A second registration belongs only to context A. Context B logs in as
      // administrator and moderates it over the actual cross-origin API.
      await a.getByLabel('姓名', { exact: false }).fill('管理員流程測試');
      await a.getByRole('button', { name: '請假 今天無法出席' }).click();
      await a.getByLabel('原因', { exact: false }).fill('測試管理員修正');
      await a.getByRole('button', { name: '送出今日登記' }).click();
      await expect(b.getByRole('article')).toHaveCount(1, { timeout: 15_000 });
      await b.getByRole('button', { name: '管理員登入', exact: true }).click();
      await b.getByLabel('管理員帳號').fill('jingyuan');
      await b.getByLabel('管理員密碼').fill(testAdminPassword);
      await b.getByRole('button', { name: '登入管理員', exact: true }).click();
      await expect(b.getByRole('button', { name: '登出管理員' })).toBeVisible();
      await b.reload();
      await expect(b.getByRole('button', { name: '登出管理員' })).toBeVisible();
      await b.getByRole('button', { name: '修改', exact: true }).click();
      await b.getByLabel('原因', { exact: false }).fill('跨來源管理員已修正');
      await b.getByRole('button', { name: '儲存修改' }).click();
      await expect(a.getByRole('article')).toContainText('跨來源管理員已修正', { timeout: 15_000 });
      await b.getByRole('button', { name: '刪除', exact: true }).click();
      await b.getByRole('button', { name: '確認刪除', exact: true }).click();
      await expect(a.getByRole('article')).toHaveCount(0, { timeout: 15_000 });
      await b.getByRole('button', { name: '登出管理員' }).click();
      await expect(b.getByRole('button', { name: '管理員登入', exact: true })).toBeVisible();
      assert.deepEqual(errors, []);
      console.log('Pages subpath + real cross-origin workerd/D1: two browsers, create, edit, withdraw and automatic sync passed.');
      console.log('Pages administrator footer login, session restoration, moderation sync and logout passed.');
    } finally { await contextA.close(); await contextB.close(); await browser.close(); }
  }
} finally {
  // Test process owns this exact child, its fresh local state contains no real people.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else { server.once('exit', resolve); setTimeout(resolve, 5000).unref(); } });
  if (site) await new Promise(resolve => { site.close(resolve); site.closeAllConnections(); });
}
