import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JSON Web Tokens. Only the subset the API issues and accepts
 * is implemented, and the algorithm is fixed rather than read from the
 * header, which closes the "alg: none" substitution class of bugs outright.
 */

const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** `nowMs` exists so tests can move time; callers normally omit it. */
export function signToken(payload, secret, expiresInSeconds, nowMs = Date.now()) {
  const issuedAt = Math.floor(nowMs / 1000);
  const body = base64url(
    JSON.stringify({ ...payload, iat: issuedAt, exp: issuedAt + expiresInSeconds }),
  );
  const data = `${HEADER}.${body}`;
  return `${data}.${sign(data, secret)}`;
}

/** @returns {object|null} the payload, or null if the token is unusable. */
export function verifyToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expected = Buffer.from(sign(`${header}.${body}`, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp <= Math.floor(nowMs / 1000)) return null;
  return payload;
}
