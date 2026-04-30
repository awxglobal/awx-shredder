/**
 * requireAuth middleware
 *
 * Accepts EITHER an API key (Authorization: Bearer awx_live_...) OR a valid
 * awx_session JWT cookie. This makes dashboard API endpoints usable both by
 * programmatic clients (curl / SDK) and by the browser dashboard.
 *
 * Priority:
 *  1. Authorization header with API key
 *  2. awx_session cookie (set by GitHub OAuth or /signup)
 *
 * On success: sets c.get('orgId') and calls next().
 * On failure: returns 401 with a JSON error.
 */
import { eq } from 'drizzle-orm';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { API_KEY_PREFIX, hashApiKey } from '../lib/apikey.js';
import type { AppEnv } from '../types.js';

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  // ── 1. Try API key ────────────────────────────────────────────────────────

  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
    const key = authHeader.slice(7);
    const keyHash = hashApiKey(key);

    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.apiKeyHash, keyHash));

    if (org) {
      c.set('orgId', org.id);
      return next();
    }
    return c.json({ error: 'unauthorized', message: 'Invalid API key.' }, 401);
  }

  // ── 2. Try session cookie ─────────────────────────────────────────────────

  const sessionToken = getCookie(c, 'awx_session');
  if (sessionToken) {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
      return c.json(
        { error: 'server_error', message: 'SESSION_SECRET not configured.' },
        500,
      );
    }

    try {
      const payload = (await verify(sessionToken, secret, 'HS256')) as {
        org_id?: string;
      };
      if (payload?.org_id) {
        c.set('orgId', payload.org_id);
        return next();
      }
    } catch {
      // Expired or tampered token — fall through to 401
    }
  }

  // ── 3. Neither matched ────────────────────────────────────────────────────

  return c.json(
    {
      error: 'unauthorized',
      message:
        'Authentication required. Provide Authorization: Bearer awx_live_<key> or sign in via /auth/github.',
    },
    401,
  );
});
