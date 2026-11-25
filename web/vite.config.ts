import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = process.env.MARION_API ?? 'http://127.0.0.1:8787';

/** The commit this build was made from, so the app can tell when its source folder has moved on. */
function buildCommit() {
  try { return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'dev'; }
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: { __MARION_BUILD__: JSON.stringify(command === 'build' ? buildCommit() : 'dev') },
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../server/src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false, ws: true },
    },
  },
  // noVNC uses top-level await, so target ES2022+.
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
}));
