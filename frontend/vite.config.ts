import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Dev and preview serve /api from the page's own origin by proxying it to the
 * API, the same shape as the /api rewrite in vercel.mjs. The browser never
 * makes a cross-origin call locally either, so dev and e2e exercise the
 * cookie and routing exactly as production does. API_PROXY_TARGET is the
 * dev/e2e counterpart of Vercel's API_ORIGIN.
 */
const apiProxy = (target: string) => ({
  '/api': {
    target,
    // Keep the browser's Host so the API sees the request as the page sent it.
    changeOrigin: false,
  },
});

export default defineConfig(({ mode }) => {
  // An empty prefix makes loadEnv include plain process environment variables.
  const env = loadEnv(mode, '.', '');
  const proxy = apiProxy(env.API_PROXY_TARGET || 'http://localhost:4000');
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy },
    preview: { port: 4173, strictPort: true, proxy },
    build: { outDir: 'dist', sourcemap: false },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}', 'vercel.test.mjs'],
      setupFiles: ['src/test/setup.ts'],
      restoreMocks: true,
    },
  };
});
