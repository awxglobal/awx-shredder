/**
 * requireApiKey middleware
 *
 * Validates the Authorization: Bearer awx_live_... header against
 * the SHA-256 hash stored in organizations.api_key_hash.
 *
 * On success: sets c.get('orgId') and calls next().
 * On failure: returns 401 with a clear JSON error.
 *
 * Use this on the proxy and usage routes (programmatic access only).
 * For dashboard API routes that should also accept browser sessions,
 * use requireAuth from ./requireAuth.ts instead.
 */
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { API_KEY_PREFIX, hashApiKey } from '../lib/apikey.js';
import type { AppEnv } from '../types.js';

export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      {
        error: 'unauthorized',
        message:
          'Missing Authorization header. Include: Authorization: Bearer awx_live_<key>',
      },
      401,
    );
  }

  const key = authHeader.slice(7); // strip "Bearer "

  if (!key.startsWith(API_KEY_PREFIX)) {
    return c.json(
      {
        error: 'unauthorized',
        message: `Invalid API key format. Key must start with "${API_KEY_PREFIX}".`,
      },
      401,
    );
  }

  const keyHash = hashApiKey(key);

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.apiKeyHash, keyHash));

  if (!org) {
    return c.json({ error: 'unauthorized', message: 'Invalid API key.' }, 401);
  }

  c.set('orgId', org.id);
  await next();
});
