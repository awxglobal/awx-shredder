/**
 * GitHub OAuth routes for AWX Shredder dashboard sessions.
 *
 * GET  /auth/github            → redirect to GitHub
 * GET  /auth/github/callback   → exchange code, create/find org, set session cookie
 * GET  /auth/me                → return current session info (used by frontend JS)
 * POST /auth/logout            → clear session cookie
 *
 * First-time GitHub login: creates an org automatically and redirects to
 *   /?new=1&key=<plaintext-key>  so the dashboard can show the key once.
 *
 * Returning login: finds the existing org, sets session, redirects to /.
 *
 * Required env vars:
 *   GITHUB_CLIENT_ID      — from your GitHub OAuth App
 *   GITHUB_CLIENT_SECRET  — from your GitHub OAuth App
 *   SESSION_SECRET        — random string ≥ 32 chars for signing JWTs
 *   APP_URL               — public base URL (e.g. https://awx-shredder.fly.dev)
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sign, verify } from 'hono/jwt';
import { randomBytes } from 'node:crypto';
import { db } from '../db/client.js';
import { githubAccounts, organizations } from '../db/schema.js';
import { generateApiKey, hashApiKey } from '../lib/apikey.js';
import type { AppEnv } from '../types.js';

export const authRouter = new Hono<AppEnv>();

// ── Helpers ───────────────────────────────────────────────────────────────────

const appUrl = () => (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const isProd = () => process.env.NODE_ENV === 'production';

function setSession(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, 'awx_session', token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 7 * 24 * 3600, // 7 days
    secure: isProd(),
  });
}

async function makeSessionToken(orgId: string, githubLogin?: string): Promise<string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { org_id: orgId, github_login: githubLogin ?? null, iat: now, exp: now + 7 * 86400 },
    secret,
    'HS256',
  );
}

// ── GET /auth/github ──────────────────────────────────────────────────────────

authRouter.get('/github', (c) => {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return c.html(
      `<h2>GitHub OAuth not configured</h2>
       <p>Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> in your environment.</p>`,
      503,
    );
  }

  const state = randomBytes(16).toString('hex');
  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 600, // 10 minutes
    secure: isProd(),
  });

  const redirectUri = `${appUrl()}/auth/github/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read:user user:email',
    state,
  });

  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// ── GET /auth/github/callback ─────────────────────────────────────────────────

authRouter.get('/github/callback', async (c) => {
  const { code, state } = c.req.query();
  const storedState = getCookie(c, 'oauth_state');
  deleteCookie(c, 'oauth_state');

  if (!state || state !== storedState) {
    return c.html('<h2>Invalid OAuth state. Please <a href="/auth/github">try again</a>.</h2>', 400);
  }
  if (!code) {
    return c.html('<h2>No authorization code from GitHub. Please <a href="/auth/github">try again</a>.</h2>', 400);
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.html('<h2>GitHub OAuth not configured on server.</h2>', 503);
  }

  // Exchange code → access token
  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${appUrl()}/auth/github/callback`,
    }),
  });

  const tokenData = (await tokenResp.json()) as { access_token?: string; error?: string };
  if (!tokenData.access_token) {
    return c.html(`<h2>GitHub token exchange failed: ${tokenData.error ?? 'unknown error'}</h2>`, 400);
  }

  // Get GitHub user info
  const userResp = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'User-Agent': 'AWX-Shredder/1.0',
      Accept: 'application/json',
    },
  });

  const user = (await userResp.json()) as {
    id: number;
    login: string;
    name?: string | null;
    email?: string | null;
  };

  const githubId = String(user.id);

  // Find existing account link
  const [existing] = await db
    .select({ orgId: githubAccounts.orgId })
    .from(githubAccounts)
    .where(eq(githubAccounts.githubId, githubId));

  if (existing) {
    // Returning user — set session and go to dashboard
    const token = await makeSessionToken(existing.orgId, user.login);
    setSession(c, token);
    return c.redirect('/app');
  }

  // ── First-time login: create org + API key ───────────────────────────────

  const orgId = `org_${randomBytes(8).toString('hex')}`;
  const orgName = user.name ?? user.login;
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  await db.insert(organizations).values({
    id: orgId,
    name: orgName,
    planTier: 'FREE',
    apiKeyHash,
  });

  await db.insert(githubAccounts).values({
    githubId,
    githubLogin: user.login,
    orgId,
  });

  const token = await makeSessionToken(orgId, user.login);
  setSession(c, token);

  // Redirect to dashboard with key in URL — shown once, then gone
  return c.redirect(`/app?new=1&key=${encodeURIComponent(apiKey)}`);
});

// ── GET /auth/me ──────────────────────────────────────────────────────────────

/**
 * Returns the current session's org info.
 * Used by the frontend JS to decide whether to show the login screen or dashboard.
 *
 * 200 → { org_id, org_name, github_login }
 * 401 → { error: 'not_authenticated' }
 */
authRouter.get('/me', async (c) => {
  const sessionToken = getCookie(c, 'awx_session');
  if (!sessionToken) {
    return c.json({ error: 'not_authenticated' }, 401);
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return c.json({ error: 'server_error', message: 'SESSION_SECRET not configured.' }, 500);
  }

  try {
    const payload = (await verify(sessionToken, secret, 'HS256')) as {
      org_id?: string;
      github_login?: string | null;
    };

    if (!payload?.org_id) {
      return c.json({ error: 'not_authenticated' }, 401);
    }

    const [org] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, payload.org_id));

    if (!org) {
      return c.json({ error: 'not_authenticated' }, 401);
    }

    return c.json({
      org_id: org.id,
      org_name: org.name,
      github_login: payload.github_login ?? null,
    });
  } catch {
    return c.json({ error: 'not_authenticated' }, 401);
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────

authRouter.post('/logout', (c) => {
  deleteCookie(c, 'awx_session', { path: '/' });
  return c.redirect('/');  // back to landing page
});
