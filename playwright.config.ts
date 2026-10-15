import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:3187', trace: 'off', screenshot: 'off', video: 'off' },
  reporter: 'list',
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:3187/api/health',
    reuseExistingServer: false,
    env: { NODE_ENV: 'development', PORT: '3187', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://127.0.0.1:3187', DATABASE_PATH: './.test-data/e2e.sqlite', TRUST_PROXY: 'false' },
  },
});
