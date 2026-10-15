import { readFileSync, writeFileSync } from 'node:fs';

const id = process.env.CLOUDFLARE_DATABASE_ID;
const api = process.env.CLOUDFLARE_API_URL;
const repository = process.env.GITHUB_REPOSITORY || 'jingyuan0712/Tabletennis_team_Sign-in_system';
if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || id.startsWith('00000000-')) {
  throw new Error('Set GitHub repository variable CLOUDFLARE_DATABASE_ID to your D1 database ID.');
}
let url;
try { url = new URL(api); } catch { throw new Error('Set repository variable CLOUDFLARE_API_URL to your Worker HTTPS origin.'); }
if (url.protocol !== 'https:' || url.origin !== api || url.username || url.password || !url.hostname.startsWith('tabletennis-team-api.')) {
  throw new Error('CLOUDFLARE_API_URL must be the exact HTTPS origin of tabletennis-team-api, with no trailing slash.');
}
const config = JSON.parse(readFileSync('wrangler.json', 'utf8'));
config.d1_databases[0].database_id = id;
config.vars.ALLOWED_ORIGIN = `https://${repository.split('/')[0].toLowerCase()}.github.io`;
writeFileSync('wrangler.deploy.json', JSON.stringify(config, null, 2) + '\n');
console.log('Cloudflare deployment configuration ready.');
