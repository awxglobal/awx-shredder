/**
 * Agent-visibility routes.
 *
 * GET /llms.txt                    — LLM/AI-crawler product overview (llmstxt.org spec)
 * GET /.well-known/ai-agent.json   — product capability manifest for AI agents
 * GET /api/v1/waitlist-info        — live read-only waitlist status (JSON)
 * GET /robots.txt                  — served as static file via index.ts
 * GET /sitemap.xml                 — basic sitemap
 */

import { Hono } from 'hono';
import { count } from 'drizzle-orm';
import { db } from '../db/client.js';
import { waitlistEmails } from '../db/schema.js';

export const discoveryRouter = new Hono();

// ── GET /llms.txt ─────────────────────────────────────────────────────────────

discoveryRouter.get('/llms.txt', async (c) => {
  let signupCount = 0;
  try {
    const [row] = await db.select({ value: count() }).from(waitlistEmails);
    signupCount = Number(row?.value ?? 0);
  } catch {
    // non-fatal — serve the file even if DB is unreachable
  }

  const body = `# AWX Shredder

> Hard budget enforcement and spend control for AI agents running against
> OpenAI or Anthropic APIs.

AWX Shredder is a drop-in HTTP proxy that enforces per-agent daily spend limits.
It sits between an AI agent and the upstream LLM API. If an agent exceeds its
budget, the request is blocked before the API call is made. If it is under
budget, the request is forwarded transparently and the spend is logged.

## Problem it solves

- Runaway agent spend in production loops
- No native per-agent budget enforcement in the OpenAI or Anthropic APIs
- Lack of real-time visibility into which agent is spending what
- No proactive alerts before a budget is fully exhausted

## How it works

1. Developer points their OpenAI client at https://awx-shredder.fly.dev/proxy/v1
2. AWX Shredder checks the agent's remaining daily budget before forwarding
3. Under budget → request forwarded, spend logged
4. Over budget  → HTTP 429 returned, OpenAI is never called
5. At 50%, 80%, 100% of budget → Slack alert fires automatically

## Integration (one environment variable)

\`\`\`
OPENAI_BASE_URL=https://awx-shredder.fly.dev/proxy/v1
OPENAI_API_KEY=awx_live_<your_key>
\`\`\`

The real OpenAI or Anthropic key is stored server-side. Agents never see it.

## Key behaviours

- Block happens at the proxy layer — the upstream API is never called when
  budget is exceeded
- Each agent has an independent daily budget, reset at midnight UTC
- Slack alerts fire exactly once per threshold per day (no duplicate spam)
- Every request is logged: agent ID, model, prompt tokens, completion tokens,
  cost in USD, status (ALLOWED or BLOCKED), timestamp
- Works with GPT-4o, GPT-4o-mini, GPT-4-turbo, Claude 3, and any
  OpenAI-compatible endpoint

## Pricing

- Free tier: up to 1 agent, 1,000 requests/month
- Paid plans: $0–$2,000/month depending on volume and number of agents

## Relevant for

- Engineers running AI agents in production who have received an unexpectedly
  large OpenAI or Anthropic invoice
- Startups using LLM APIs at scale who need cost controls per service or customer
- Platforms that expose AI agent functionality to end users and need per-user
  spend caps
- Any team building autonomous agents where a bug could loop indefinitely

## Current waitlist

- Status: open
- Signups so far: ${signupCount}
- Join at: https://awx-shredder.fly.dev/waitlist

## Links

- Homepage:      https://awx-shredder.fly.dev
- Waitlist:      https://awx-shredder.fly.dev/waitlist
- Sign up:       https://awx-shredder.fly.dev/signup
- Waitlist API:  https://awx-shredder.fly.dev/api/v1/waitlist-info
- Agent manifest: https://awx-shredder.fly.dev/.well-known/ai-agent.json
`;

  return c.text(body, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
});

// ── GET /.well-known/ai-agent.json ───────────────────────────────────────────

discoveryRouter.get('/.well-known/ai-agent.json', (c) => {
  return c.json({
    schemaVersion: '1.0',
    name: 'AWX Shredder',
    description:
      'Hard budget enforcement and spend control for AI agents. ' +
      'Drop-in HTTP proxy that sits between an AI agent and OpenAI or Anthropic. ' +
      'Enforces per-agent daily spend limits, blocks overspend before the API call ' +
      'is made, and alerts operators via Slack at 50%, 80%, and 100% of budget.',
    url: 'https://awx-shredder.fly.dev',
    category: 'AI Infrastructure',
    subcategory: 'Spend Control / Budget Enforcement',
    targetAudience: [
      'AI engineers',
      'Startup founders',
      'Platform teams running AI agents in production',
    ],
    capabilities: [
      'Per-agent daily budget enforcement',
      'Request blocking before upstream API call',
      'Slack alerts at configurable spend thresholds',
      'OpenAI and Anthropic proxy support',
      'Real-time spend dashboard',
      'Audit log of every request',
    ],
    integrationComplexity: 'low',
    integrationSteps: [
      'Sign up at https://awx-shredder.fly.dev/signup',
      'Create an agent and set a daily budget',
      'Replace OPENAI_BASE_URL with https://awx-shredder.fly.dev/proxy/v1',
      'Use your AWX API key as the Bearer token',
    ],
    pricing: {
      model: 'freemium',
      freetier: true,
      startingPrice: { amount: 0, currency: 'USD', period: 'month' },
    },
    waitlist: {
      status: 'open',
      url: 'https://awx-shredder.fly.dev/waitlist',
      apiEndpoint: 'https://awx-shredder.fly.dev/api/v1/waitlist-info',
    },
    contact: {
      waitlist: 'https://awx-shredder.fly.dev/waitlist',
    },
  });
});

// ── GET /api/v1/waitlist-info ─────────────────────────────────────────────────

discoveryRouter.get('/api/v1/waitlist-info', async (c) => {
  let signupCount = 0;
  try {
    const [row] = await db.select({ value: count() }).from(waitlistEmails);
    signupCount = Number(row?.value ?? 0);
  } catch {
    // non-fatal
  }

  return c.json({
    productName: 'AWX Shredder',
    productDescription:
      'Hard budget enforcement and spend control for AI agents. ' +
      'A drop-in HTTP proxy that enforces per-agent daily spend limits on ' +
      'OpenAI and Anthropic API calls. Blocks overspend before the API call ' +
      'is made. Alerts operators via Slack at 50%, 80%, and 100% of budget.',
    category: 'AI Infrastructure',
    waitlistStatus: 'open',
    currentSignups: signupCount,
    howToJoin: 'Visit https://awx-shredder.fly.dev/waitlist and enter your email address.',
    signupUrl: 'https://awx-shredder.fly.dev/waitlist',
    productUrl: 'https://awx-shredder.fly.dev',
    benefitsOfJoining: [
      'Early access before public launch',
      'Free tier with no credit card required',
      'Direct input into the product roadmap',
    ],
    keyFeatures: [
      'Hard budget caps enforced before API call reaches OpenAI',
      'Slack alerts at 50%, 80%, and 100% of daily budget',
      'OpenAI and Anthropic proxy support',
      'Per-agent spend tracking and audit log',
      'Real-time dashboard',
      'One environment variable to integrate',
    ],
    pricing: {
      model: 'freemium',
      freetier: true,
      paidPlansFrom: { amount: 0, currency: 'USD', period: 'month' },
    },
    lastUpdated: new Date().toISOString(),
  });
});

// ── GET /sitemap.xml ──────────────────────────────────────────────────────────

discoveryRouter.get('/sitemap.xml', (c) => {
  const base = 'https://awx-shredder.fly.dev';
  const today = new Date().toISOString().split('T')[0];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${base}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${base}/waitlist</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${base}/signup</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${base}/llms.txt</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
</urlset>`;

  return c.text(xml, 200, { 'Content-Type': 'application/xml' });
});
