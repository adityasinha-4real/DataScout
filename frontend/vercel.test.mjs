import { beforeAll, describe, expect, it, vi } from 'vitest';

// vercel.mjs builds its config from process.env the moment it is imported,
// exactly as it does on Vercel, so the variable must exist first.
let buildConfig;
let config;
beforeAll(async () => {
  vi.stubEnv('API_ORIGIN', 'https://api.example.com');
  ({ buildConfig, config } = await import('./vercel.mjs'));
});

describe('vercel.mjs', () => {
  it('rewrites /api to API_ORIGIN before the SPA fallback', () => {
    expect(config.rewrites).toEqual([
      { source: '/api/:path*', destination: 'https://api.example.com/api/:path*' },
      { source: '/(.*)', destination: '/index.html' },
    ]);
  });

  it('reads the origin from the environment, normalising a trailing slash', () => {
    const { rewrites } = buildConfig({ API_ORIGIN: ' https://datascout-api.fly.dev/ ' });
    expect(rewrites[0].destination).toBe('https://datascout-api.fly.dev/api/:path*');
  });

  it('fails the build rather than deploying a frontend with no API', () => {
    expect(() => buildConfig({})).toThrow(/API_ORIGIN is not set/);
    expect(() => buildConfig({ API_ORIGIN: '   ' })).toThrow(/API_ORIGIN is not set/);
  });

  it('refuses an origin that is not https, not a URL, or carries a path', () => {
    expect(() => buildConfig({ API_ORIGIN: 'http://api.example.com' })).toThrow(/https/);
    expect(() => buildConfig({ API_ORIGIN: 'api.example.com' })).toThrow(/not a URL/);
    expect(() => buildConfig({ API_ORIGIN: 'https://api.example.com/v1' })).toThrow(
      /no path/,
    );
    expect(() => buildConfig({ API_ORIGIN: 'https://api.example.com/?x=1' })).toThrow(
      /no path/,
    );
  });
});
