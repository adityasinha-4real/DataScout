import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Passwords are stored as scrypt digests, never in plaintext or reversibly.
 * Format: scrypt$N$r$p$<salt hex>$<derived key hex>, so the cost parameters
 * travel with the hash and can be raised later without breaking old rows.
 */

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(plaintext) {
  const salt = randomBytes(16);
  const derived = scryptSync(plaintext, salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

export function verifyPassword(plaintext, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltHex, keyHex] = parts;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const derived = scryptSync(plaintext, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
