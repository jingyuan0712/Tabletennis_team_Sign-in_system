import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
const tasks = [
  ['node_modules/tsx/dist/cli.mjs', 'watch', 'server/main.ts'],
  ['node_modules/vite/bin/vite.js'],
  ['node_modules/tsx/dist/cli.mjs', 'server/scheduler.ts'],
];
const children = tasks.map(args => spawn(process.execPath, args, { stdio: 'inherit' }));
let ending = false;
function stop(code = 0) {
  if (ending) return;
  ending = true;
  children.forEach(child => child.kill());
  process.exitCode = code;
}
children.forEach(child => child.on('exit', code => stop(code || 0)));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
