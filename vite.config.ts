import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
  // .env may use NODE_ENV=development for the local Node server. Published
  // frontend builds must still use React's production runtime.
  if (command === 'build') process.env.NODE_ENV = 'production';
  return {
    define: { 'process.env.NODE_ENV': JSON.stringify(command === 'build' ? 'production' : 'development') },
    esbuild: { jsxDev: command !== 'build' },
    base: process.env.VITE_BASE_PATH || '/',
    plugins: [react()],
    server: { host: 'localhost', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3001' } },
  };
});
