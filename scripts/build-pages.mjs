import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const value = process.env.VITE_API_BASE_URL;
let url;
try { url = new URL(value); } catch { throw new Error('VITE_API_BASE_URL must be set to your HTTPS Cloudflare API origin.'); }
if (url.protocol !== 'https:' || value !== url.origin) throw new Error('VITE_API_BASE_URL must be an HTTPS origin without a trailing slash or path.');
const base = process.env.VITE_BASE_PATH;
if (!base || !base.startsWith('/') || !base.endsWith('/') || base.includes('..') || !/^\/[A-Za-z0-9_/-]*$/.test(base)) throw new Error('VITE_BASE_PATH must be /repository-name/.');
const result = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
