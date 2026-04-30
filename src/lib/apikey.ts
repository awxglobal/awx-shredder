/**
 * API key generation and verification for AWX Shredder.
 *
 * Format: awx_live_<32 lowercase hex chars>
 * Storage: SHA-256 hash of the full key string stored in organizations.api_key_hash.
 *
 * SHA-256 is appropriate here because API keys are 128 bits of randomness —
 * high-entropy inputs don't need the slow hashing of bcrypt.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX = 'awx_live_';

/**
 * Generate a new API key: awx_live_ + 32 random hex chars (128 bits of entropy).
 */
export function generateApiKey(): string {
  const random = randomBytes(16).toString('hex'); // 32 hex chars
  return `${API_KEY_PREFIX}${random}`;
}

/**
 * Hash an API key with SHA-256 for storage.
 * Returns a 64-char lowercase hex string.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Verify a submitted key against a stored hash using a constant-time comparison
 * to prevent timing-based side-channel attacks.
 */
export function verifyApiKey(submittedKey: string, storedHash: string): boolean {
  const h1 = Buffer.from(hashApiKey(submittedKey), 'hex');
  const h2 = Buffer.from(storedHash, 'hex');
  if (h1.length !== h2.length) return false;
  return timingSafeEqual(h1, h2);
}

/** Quick format check — does not hit the DB. */
export function isValidApiKeyFormat(key: string): boolean {
  return (
    key.startsWith(API_KEY_PREFIX) &&
    key.length === API_KEY_PREFIX.length + 32 &&
    /^[0-9a-f]+$/.test(key.slice(API_KEY_PREFIX.length))
  );
}
