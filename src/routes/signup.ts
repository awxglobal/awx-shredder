/**
 * Self-serve signup flow.
 *
 * GET  /signup  → serve the signup HTML page
 * POST /signup  → create org + generate API key, set session, return JSON with key
 *
 * The API key is returned ONCE in the POST response and never again.
 * After signup the user has a 7-day session cookie and is redirected to the dashboard.
 */
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { sign } from 'hono/jwt';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/client.js';
import { organizations } from '../db/schema.js';
import { generateApiKey, hashApiKey } from '../lib/apikey.js';
import { sendWelcomeEmail } from '../lib/email.js';
import type { AppEnv } from '../types.js';

export const signupRouter = new Hono<AppEnv>();

const signupBody = z.object({
  email: z.string().email('Please enter a valid email address.'),
  org_name: z.string().min(1).max(80).optional(),
});

// ── GET /signup ───────────────────────────────────────────────────────────────

signupRouter.get('/signup', (c) => c.html(SIGNUP_HTML));

// ── POST /signup ──────────────────────────────────────────────────────────────

signupRouter.post('/signup', zValidator('json', signupBody), async (c) => {
  const { email, org_name } = c.req.valid('json');

  const orgId = `org_${randomBytes(8).toString('hex')}`;
  const orgName = org_name?.trim() || email.split('@')[0];
  const apiKey = generateApiKey();
  const apiKeyHash = hashApiKey(apiKey);

  await db.insert(organizations).values({
    id: orgId,
    name: orgName,
    planTier: 'FREE',
    apiKeyHash,
    email,
  });

  // Set a 7-day session so the user lands straight on the dashboard
  const secret = process.env.SESSION_SECRET;
  if (secret) {
    const now = Math.floor(Date.now() / 1000);
    const token = await sign(
      { org_id: orgId, iat: now, exp: now + 7 * 86400 },
      secret,
      'HS256',
    );
    setCookie(c, 'awx_session', token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 7 * 24 * 3600,
      secure: process.env.NODE_ENV === 'production',
    });
  }

  // Send welcome email (non-blocking — failure does not break signup)
  sendWelcomeEmail({ to: email, orgName, apiKey }).catch(() => {});

  return c.json({
    org_id: orgId,
    org_name: orgName,
    api_key: apiKey,
    message: 'Save this API key — it will NOT be shown again.',
  });
});

// ── Signup HTML ───────────────────────────────────────────────────────────────

const SIGNUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AWX Shredder — Sign up</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    .fade-in { animation: fadeIn 0.35s ease both; }
  </style>
</head>
<body class="min-h-screen bg-slate-900 flex items-center justify-center p-4">
  <div class="w-full max-w-md">

    <!-- Logo / brand -->
    <div class="text-center mb-8">
      <div class="inline-flex items-center gap-2 text-white font-bold text-xl">
        <svg class="w-7 h-7 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99
               11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03
               9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/>
        </svg>
        AWX Shredder
      </div>
      <p class="text-slate-400 text-sm mt-1">Budget-enforcing AI proxy</p>
    </div>

    <!-- Sign up card -->
    <div id="signup-card" class="bg-slate-800 rounded-2xl p-8 shadow-2xl fade-in">
      <h1 class="text-white text-2xl font-semibold mb-1">Create your account</h1>
      <p class="text-slate-400 text-sm mb-6">
        Takes 10 seconds. No credit card required.
      </p>

      <!-- GitHub button -->
      <a href="/auth/github"
         class="flex items-center justify-center gap-2 w-full bg-white text-slate-900
                font-medium py-2.5 px-4 rounded-lg hover:bg-slate-100 transition mb-4 text-sm">
        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18
                   6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703
                   -2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466
                   -.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032
                   .892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338
                   -2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688
                   -.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0
                   0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027
                   2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688
                   0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338
                   -.012 2.419-.012 2.745 0 .268.18.58.688.482A10.019 10.019 0 0022
                   12.017C22 6.484 17.522 2 12 2z"/>
        </svg>
        Continue with GitHub
      </a>

      <div class="flex items-center gap-3 my-4">
        <div class="flex-1 h-px bg-slate-700"></div>
        <span class="text-slate-500 text-xs">or sign up with email</span>
        <div class="flex-1 h-px bg-slate-700"></div>
      </div>

      <!-- Email form -->
      <form id="signup-form">
        <div class="space-y-3">
          <div>
            <label class="block text-sm text-slate-300 mb-1" for="email">Work email</label>
            <input id="email" type="email" required placeholder="you@company.com"
              class="w-full bg-slate-700 text-white placeholder-slate-500 border border-slate-600
                     rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2
                     focus:ring-indigo-500 focus:border-transparent">
          </div>
          <div>
            <label class="block text-sm text-slate-300 mb-1" for="org_name">
              Organisation name <span class="text-slate-500">(optional)</span>
            </label>
            <input id="org_name" type="text" placeholder="Acme Corp"
              class="w-full bg-slate-700 text-white placeholder-slate-500 border border-slate-600
                     rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2
                     focus:ring-indigo-500 focus:border-transparent">
          </div>
        </div>

        <div id="error-msg" class="hidden mt-3 text-red-400 text-sm"></div>

        <button type="submit" id="submit-btn"
          class="mt-5 w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium
                 py-2.5 rounded-lg text-sm transition flex items-center justify-center gap-2">
          Create account
        </button>
      </form>

      <p class="text-center text-slate-500 text-xs mt-5">
        Already have an account?
        <a href="/auth/github" class="text-indigo-400 hover:text-indigo-300">Sign in with GitHub</a>
      </p>
    </div>

    <!-- API key reveal card (shown after successful signup) -->
    <div id="key-card" class="hidden bg-slate-800 rounded-2xl p-8 shadow-2xl fade-in">
      <div class="flex items-center gap-2 mb-4">
        <div class="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
          <svg class="w-4 h-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/>
          </svg>
        </div>
        <h2 class="text-white text-xl font-semibold">Account created!</h2>
      </div>

      <div class="bg-amber-900/30 border border-amber-700/50 rounded-lg p-3 mb-4 flex gap-2">
        <svg class="w-4 h-4 text-amber-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71
               c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898
               0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
        </svg>
        <p class="text-amber-300 text-xs">
          <strong>Save this API key now.</strong> It will <em>not</em> be shown again.
        </p>
      </div>

      <label class="block text-slate-400 text-xs mb-1.5">Your API key</label>
      <div class="flex gap-2">
        <code id="api-key-display"
          class="flex-1 bg-slate-900 text-green-400 font-mono text-sm px-3 py-2.5
                 rounded-lg border border-slate-700 overflow-x-auto whitespace-nowrap select-all">
        </code>
        <button id="copy-btn" onclick="copyKey()"
          class="shrink-0 bg-slate-700 hover:bg-slate-600 text-white px-3 py-2 rounded-lg
                 text-xs transition">
          Copy
        </button>
      </div>

      <div class="mt-3 text-slate-500 text-xs">
        Use this key as <code class="text-slate-400">Authorization: Bearer &lt;key&gt;</code>
        on all proxy and API calls.
      </div>

      <a href="/" id="go-dashboard"
        class="mt-5 flex items-center justify-center w-full bg-indigo-600 hover:bg-indigo-500
               text-white font-medium py-2.5 rounded-lg text-sm transition">
        Go to dashboard →
      </a>
    </div>

  </div>

  <script>
    var savedKey = '';

    document.getElementById('signup-form').addEventListener('submit', async function(e) {
      e.preventDefault();
      var btn = document.getElementById('submit-btn');
      var errEl = document.getElementById('error-msg');
      errEl.classList.add('hidden');
      btn.disabled = true;
      btn.textContent = 'Creating…';

      var payload = {
        email: document.getElementById('email').value,
        org_name: document.getElementById('org_name').value.trim() || undefined,
      };

      try {
        var res = await fetch('/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        var data = await res.json();

        if (!res.ok) {
          errEl.textContent = data.error?.issues?.[0]?.message ?? data.message ?? 'Signup failed.';
          errEl.classList.remove('hidden');
          btn.disabled = false;
          btn.textContent = 'Create account';
          return;
        }

        // Show API key reveal card
        savedKey = data.api_key;
        document.getElementById('api-key-display').textContent = data.api_key;
        document.getElementById('signup-card').classList.add('hidden');
        document.getElementById('key-card').classList.remove('hidden');

      } catch (err) {
        errEl.textContent = 'Network error. Please try again.';
        errEl.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'Create account';
      }
    });

    function copyKey() {
      if (!savedKey) return;
      navigator.clipboard.writeText(savedKey).then(function() {
        var btn = document.getElementById('copy-btn');
        btn.textContent = 'Copied!';
        btn.classList.add('text-green-400');
        setTimeout(function() {
          btn.textContent = 'Copy';
          btn.classList.remove('text-green-400');
        }, 2000);
      });
    }
  </script>
</body>
</html>`;
