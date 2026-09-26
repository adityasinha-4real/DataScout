/**
 * Vercel project configuration, evaluated at build time. Programmatic rather
 * than vercel.json because the API's address comes from the environment, and
 * a static file cannot read it. Only one of the two may exist.
 *
 * Every /api request is rewritten to the API, so the browser only ever talks
 * to the frontend's own origin: no CORS, and the session cookie is
 * first-party whatever domain the API runs on.
 *
 * Plain objects with vercel.json's property names; the optional
 * @vercel/config package would only add types and helpers.
 */

/** @param {Record<string, string | undefined>} env */
export function buildConfig(env) {
  const raw = (env.API_ORIGIN ?? '').trim();
  if (raw === '') {
    throw new Error(
      'API_ORIGIN is not set. Set it in the Vercel project to the API origin, e.g. https://api.example.com.',
    );
  }

  let origin;
  try {
    origin = new URL(raw);
  } catch {
    throw new Error(`API_ORIGIN "${raw}" is not a URL.`);
  }
  // The rewrite forwards the session cookie, so the hop must be encrypted.
  if (origin.protocol !== 'https:') {
    throw new Error(`API_ORIGIN must use https, got "${raw}".`);
  }
  if (origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error(`API_ORIGIN must be an origin with no path, got "${raw}".`);
  }

  return {
    rewrites: [
      // Order matters: /api must be claimed before the SPA fallback.
      { source: '/api/:path*', destination: `${origin.origin}/api/:path*` },
      // Client-side routes such as /datasets/<id> load the app, not a 404.
      // Real files in dist/ are served before any rewrite applies.
      { source: '/(.*)', destination: '/index.html' },
    ],
  };
}

export const config = buildConfig(process.env);
