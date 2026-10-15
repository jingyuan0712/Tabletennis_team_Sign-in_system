import { spawnSync } from 'node:child_process';

// Invoked by Actions or locally with env vars. Secrets never become command args,
// command output or files; Wrangler receives the secret only through stdin.
for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'RATE_LIMIT_SECRET']) {
  if (!process.env[name]) throw new Error(`Missing GitHub Actions secret: ${name}`);
}
if (process.env.RATE_LIMIT_SECRET.length < 32 || /[\r\n]/.test(process.env.RATE_LIMIT_SECRET)) throw new Error('RATE_LIMIT_SECRET must have >=32 characters and no newlines.');
function wrangler(args, input) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', 'wrangler.deploy.json'], {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit', input,
  });
  if (result.status !== 0) throw new Error('Cloudflare deployment step failed; check the command status above.');
}
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
wrangler(['deploy']);
wrangler(['secret', 'put', 'RATE_LIMIT_SECRET'], process.env.RATE_LIMIT_SECRET + '\n');

const api = process.env.CLOUDFLARE_API_URL;
let healthy = false;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const response = await fetch(api + '/api/health', { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    if (response.ok && (await response.json()).ok === true) { healthy = true; break; }
  } catch { /* retry propagation; never print response bodies */ }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
if (!healthy) throw new Error('API health check failed. Verify Worker URL, D1 binding and Worker secret.');
console.log('Cloudflare API deployment and health check passed.');
