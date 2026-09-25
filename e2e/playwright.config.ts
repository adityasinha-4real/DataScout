import { defineConfig, devices } from '@playwright/test';

const API_PORT = Number(process.env.E2E_API_PORT ?? 4310);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4311);
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

/**
 * Boots the real API and a production build of the frontend, both on private
 * ports against a throwaway in-memory database, so the smoke test exercises
 * the shipped bundle rather than a dev-only code path.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      // Run the entry point directly rather than via `npm start`, so a
      // developer's local .env cannot leak into the e2e run.
      command: 'node --disable-warning=ExperimentalWarning ../backend/src/server.js',
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        PORT: String(API_PORT),
        DATABASE_URL: ':memory:',
        CORS_ORIGIN: WEB_URL,
        // Every spec signs in from 127.0.0.1 against this one server, which
        // already comes close to the default of 10 a minute. The limiter has
        // its own suite (backend/test/rate-limit.test.js); here it would only
        // turn an unrelated new spec into a mysterious 429.
        AUTH_RATE_LIMIT_PER_MIN: '1000',
        JWT_SECRET:
          process.env.JWT_SECRET ?? 'e2e-only-secret-value-at-least-32-characters',
      },
    },
    {
      // Rebuild before previewing: VITE_API_BASE_URL is baked in at build
      // time, so serving a stale dist/ would point the app at the wrong API.
      command:
        `npm --prefix ../frontend run build && ` +
        `npm --prefix ../frontend run preview -- --host 127.0.0.1 ` +
        `--port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { VITE_API_BASE_URL: API_URL },
    },
  ],
});
