import 'dotenv/config';
import { createReadStream, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import { db } from './db/client.js';
import { agents, organizations, usageLogs } from './db/schema.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { proxyRouter } from './routes/proxy.js';
import { signupRouter } from './routes/signup.js';
import { usageRouter } from './routes/usage.js';
import { waitlistRouter } from './routes/waitlist.js';
import { discoveryRouter } from './routes/discovery.js';
import { blogRouter } from './routes/blog.js';
import { syncRouter } from './routes/sync.js';
import { githubWebhookRouter } from './routes/github-webhooks.js';
import { getSnapshot, snapshotForWire } from './views/dashboard.js';
import type { AppEnv } from './types.js';

// Serve static HTML files
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const landingHtml   = readFileSync(join(__dirname, 'public/landing.html'),  'utf-8');
const dashboardHtml = readFileSync(join(__dirname, 'public/index.html'),   'utf-8');
const waitlistHtml  = readFileSync(join(__dirname, 'public/waitlist.html'), 'utf-8');
const robotsTxt     = readFileSync(join(__dirname, 'public/robots.txt'),    'utf-8');

const app = new Hono<AppEnv>();

app.use('*', logger());

// â”€â”€ Public routes (no auth required) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Agent-discovery routes (llms.txt, ai-agent.json, waitlist API, sitemap)
app.route('/', discoveryRouter);

// robots.txt
app.get('/robots.txt', (c) => c.text(robotsTxt, 200, { 'Content-Type': 'text/plain' }));

// Landing page (public)
app.get('/', (c) => c.html(landingHtml));

// Demo video â€” served with correct MIME type and range support
app.get('/demo.mp4', (c) => {
  const videoPath = join(__dirname, 'public/demo.mp4');
  try {
    const stat = statSync(videoPath);
    const range = c.req.header('range');
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      const stream = createReadStream(videoPath, { start, end });
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': 'video/mp4',
        },
      });
    }
    const stream = createReadStream(videoPath);
    return new Response(stream as unknown as ReadableStream, {
      headers: {
        'Content-Length': String(stat.size),
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return c.text('Video not found', 404);
  }
});

// Dashboard app (auth-gated via client-side JS)
app.get('/app', (c) => c.html(dashboardHtml));

// GitHub OAuth + session management
app.route('/auth', authRouter);

// Waitlist page (GET) + email capture API (POST /waitlist/join)
app.get('/waitlist', (c) => c.html(waitlistHtml));
app.route('/waitlist', waitlistRouter);

// Self-serve signup
app.route('/', signupRouter);

// GitHub App webhooks + installation callback (no auth — GitHub sends these)
app.route('/', githubWebhookRouter);

// Blog â€” public read + internal write for marketing agent
app.route('/', blogRouter);

// Legacy snapshot SSE stream (unauthenticated â€” used by the old ticker demo)
app.get('/events', (c) =>
  streamSSE(c, async (stream) => {
    let id = 0;
    while (!stream.aborted) {
      try {
        const snap = await getSnapshot();
        await stream.writeSSE({
          id: String(id++),
          event: 'snapshot',
          data: JSON.stringify(snapshotForWire(snap)),
        });
      } catch (err) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ message: (err as Error).message }),
        });
      }
      await stream.sleep(3000);
    }
  }),
);

app.get('/status', (c) => c.json({ ok: true, service: 'awx-shredder' }));

app.get('/health', async (c) => {
  try {
    await db.select().from(organizations).limit(1);
    return c.json({ status: 'healthy', db: 'connected' });
  } catch (err) {
    return c.json({ status: 'unhealthy', error: (err as Error).message }, 500);
  }
});

// â”€â”€ Debug read-only routes (consider removing before public launch) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

app.get('/organizations', async (c) => {
  const rows = await db.select({ id: organizations.id, name: organizations.name }).from(organizations);
  return c.json(rows);
});

app.get('/agents', async (c) => {
  const rows = await db
    .select({ id: agents.id, orgId: agents.orgId, name: agents.name, status: agents.status })
    .from(agents);
  return c.json(rows);
});

app.get('/usage-logs', async (c) => {
  const rows = await db
    .select({ id: usageLogs.id, agentId: usageLogs.agentId, status: usageLogs.status })
    .from(usageLogs)
    .limit(50);
  return c.json(rows);
});

// â”€â”€ Authenticated routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Dashboard API: all endpoints require API key or session cookie
app.route('/', dashboardRouter);

// Usage enforcement: requires API key
app.route('/usage', usageRouter);

// OpenAI proxy: requires API key
app.route('/proxy', proxyRouter);
app.route('/sync', syncRouter);

// â”€â”€ Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`\n  âœ¦ AWX Shredder running on http://localhost:${info.port}`);
  console.log(`  âœ¦ Dashboard:  http://localhost:${info.port}/`);
  console.log(`  âœ¦ Sign up:    http://localhost:${info.port}/signup`);
  console.log(`  âœ¦ GitHub auth: http://localhost:${info.port}/auth/github\n`);

  // Demo ticker â€” disabled for live demos so only real proxy calls appear.
  // Re-enable by uncommenting (generates synthetic spend every 1.5 s on test agents).
  // startTicker(1500);
});


