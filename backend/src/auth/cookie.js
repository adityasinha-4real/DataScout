/**
 * The session cookie. Written by hand rather than with a cookie library: it is
 * one name, a fixed set of attributes and a header split, not worth a
 * dependency (C6).
 *
 * - HttpOnly: page scripts cannot read it, so an XSS cannot lift the token.
 * - SameSite=Lax: not sent on cross-site POST/PUT/DELETE, which is what stands
 *   in for a CSRF token (PLAN.md §8). It also means the SPA and the API must
 *   share a registrable domain, or the browser never attaches it.
 * - Secure only in production, so plain-http dev and e2e runs still work.
 */

export const SESSION_COOKIE = 'datascout_session';

function serialize(value, maxAgeSeconds, secure) {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function setSessionCookie(res, token, config) {
  res.append(
    'Set-Cookie',
    serialize(token, config.jwtExpiresIn, config.isProduction),
  );
}

/** Same attributes as when set, or some browsers keep the original. */
export function clearSessionCookie(res, config) {
  res.append('Set-Cookie', serialize('', 0, config.isProduction));
}

/** The session token from a Cookie header, or null. */
export function readSessionCookie(header) {
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = pair.slice(eq + 1).trim();
      return value === '' ? null : value;
    }
  }
  return null;
}
