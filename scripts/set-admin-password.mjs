import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { parseEnv } from 'node:util';

// Password enters via hidden terminal input/stdin, never command arguments/logs.
process.stdout.write('Administrator password (input hidden): ');
let password = '';
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  password = await new Promise(resolve => {
    const keys = (_text, key) => {
      if (key.ctrl && key.name === 'c') process.exit(130);
      if (key.name === 'return') { process.stdin.removeListener('keypress', keys); process.stdin.setRawMode(false); process.stdin.pause(); resolve(password); }
      else if (key.name === 'backspace') password = Array.from(password).slice(0, -1).join('');
      else if (_text && !key.ctrl && !key.meta) password += _text;
    };
    process.stdin.on('keypress', keys);
  });
} else {
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  password = await new Promise(resolve => { lines.once('line', value => { lines.close(); resolve(value); }); });
}
if (password.length < 8 || password.length > 256 || /[\r\n\0]/.test(password)) throw new Error('Password must contain 8-256 characters without newlines.');
let env = existsSync('.env') ? readFileSync('.env', 'utf8') : readFileSync('.env.example', 'utf8');
function set(name, value) {
  // dotenv is not JSON: JSON backslash/quote escaping can change the password.
  // Prefer literal single quotes, also preventing Compose $ interpolation.
  const quoted = !value.includes("'") ? "'" + value + "'"
    : !/["\\$]/.test(value) ? '"' + value + '"' : undefined;
  if (quoted === undefined || parseEnv(name + '=' + quoted)[name] !== value) {
    throw new Error('Cannot safely represent this password in both Node and Compose .env formats. Use a password without single quotes, or set ADMIN_PASSWORD directly in the server environment. No file was changed.');
  }
  const line = name + '=' + quoted;
  const pattern = new RegExp('^' + name + '=.*$', 'm');
  env = pattern.test(env) ? env.replace(pattern, () => line) : env.trimEnd() + '\n' + line + '\n';
}
set('ADMIN_USERNAME', 'jingyuan');
set('ADMIN_PASSWORD', password);
writeFileSync('.env', env, { mode: 0o600 });
console.log('\nLocal administrator configured in ignored .env. Password was not printed.');
