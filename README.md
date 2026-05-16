# AWX Shredder

**Hard budget enforcement for AI agents. Blocks the API call before it reaches OpenAI — not after.**

Most AI cost tools tell you what you spent. AWX Shredder stops the spend before it happens.

→ **[Join the waitlist](https://awx-shredder.fly.dev/waitlist)**  
→ **[Sign up for early access](https://awx-shredder.fly.dev/signup)**

---

## The problem

AI agents running in production loops can exhaust a monthly OpenAI budget in minutes. Rate limits don't help — they throttle requests per minute, not spend per agent. OpenAI's own usage limits apply to your whole account, not individual agents. There is no native way to say "this agent gets $5/day and no more."

Common failure modes:
- A bug causes an agent to loop — 10,000 requests before anyone notices
- A prompt injection tricks an agent into expensive repeated calls
- A new model is 10× the cost of what was tested — no one updated the limit
- A single customer's agent spends 50× more than any other — no per-user cap

## How it works

AWX Shredder is a drop-in HTTP proxy. Point your OpenAI client at it instead of `api.openai.com`.

```
Client → AWX Shredder → OpenAI / Anthropic
              │
              ├─ Under budget?  → forward request, log spend
              └─ Over budget?   → return 429, never touch OpenAI
```

**One environment variable to integrate:**

```bash
# Before
OPENAI_BASE_URL=https://api.openai.com/v1

# After
OPENAI_BASE_URL=https://awx-shredder.fly.dev/proxy/v1
OPENAI_API_KEY=awx_live_<your_key_here>
```

Your real OpenAI / Anthropic key stays server-side. Agents never see it.

---

## What gets enforced

| Feature | Detail |
|---|---|
| **Per-agent daily budget** | Each agent has its own spend limit, independent of others |
| **Hard block** | Over-budget requests are rejected before the upstream API call is made |
| **Slack alerts** | Fires at 50%, 80%, and 100% of each agent's daily limit — exactly once per threshold per day |
| **Audit log** | Every request logged: agent, model, tokens, cost, status (ALLOWED / BLOCKED), timestamp |
| **Day rollover** | Budgets reset at midnight UTC automatically |
| **Multi-model** | GPT-4o, GPT-4o-mini, GPT-4-turbo, Claude 3, any OpenAI-compatible endpoint |

---

## Agent-readable resources

This product is built to be discovered by AI agents, not just humans.

| Resource | URL | Description |
|---|---|---|
| `llms.txt` | `/llms.txt` | LLM-optimised product overview ([llmstxt.org](https://llmstxt.org) spec) |
| `ai-agent.json` | `/.well-known/ai-agent.json` | Machine-readable product capability manifest |
| Waitlist API | `/api/v1/waitlist-info` | Live waitlist status and signup count (JSON) |
| `robots.txt` | `/robots.txt` | All AI crawlers explicitly allowed |
| `sitemap.xml` | `/sitemap.xml` | Page index for crawlers |
| Schema.org JSON-LD | In `<head>` of every page | `SoftwareApplication` structured data |

---

## Dashboard

Real-time spend dashboard at `/app` (GitHub OAuth login):

- KPI cards: total spend today, requests, blocked count, active agents
- Per-agent spend bars with budget limits
- Live feed of every proxy request (SSE, no polling)
- Budget editing inline
- One-click agent creation

---

## Pricing

| Plan | Price | Agents | Requests/month |
|---|---|---|---|
| Free | $0 | 1 | 1,000 |
| Starter | $29/mo | 5 | 50,000 |
| Growth | $99/mo | 25 | 500,000 |
| Pro | $299/mo | unlimited | 5,000,000 |

---

## Stack

- **Runtime**: TypeScript, Node.js 22
- **Framework**: [Hono](https://hono.dev) v4
- **ORM**: [Drizzle](https://orm.drizzle.team) + PostgreSQL (Supabase)
- **Auth**: GitHub OAuth 2.0 + JWT session cookies
- **Deployment**: [Fly.io](https://fly.io) (multi-region, auto-scale to zero)

---

## Self-hosting

```bash
git clone https://github.com/your-org/awx-shredder
cd awx-shredder
npm install

# Copy and fill in env vars
cp .env.example .env

# Apply DB migrations
npm run db:migrate

# Start dev server
npm run dev
# → http://localhost:3000
```

**Required env vars:**

```
DATABASE_URL=          # Supabase / any PostgreSQL connection string
SESSION_SECRET=        # Random string ≥ 32 chars
GITHUB_CLIENT_ID=      # GitHub OAuth App client ID
GITHUB_CLIENT_SECRET=  # GitHub OAuth App client secret
APP_URL=               # Public base URL (e.g. https://your-domain.com)
```

---

## Links

- **Homepage**: https://awx-shredder.fly.dev
- **Waitlist**: https://awx-shredder.fly.dev/waitlist
- **Sign up**: https://awx-shredder.fly.dev/signup
- **llms.txt**: https://awx-shredder.fly.dev/llms.txt
- **Waitlist API**: https://awx-shredder.fly.dev/api/v1/waitlist-info
- **Agent manifest**: https://awx-shredder.fly.dev/.well-known/ai-agent.json

<!-- AWX_ARTICLES_START -->
## 📝 Recent Technical Articles

*7 articles published — auto-updated daily*

- **What Anthropic's Claude pricing means for your agent budget** — 
- **How to safely test AI agents without racking up API bills** — 
- **Alerting on LLM cost thresholds: a developer's guide** — 
- **How to build a drop-in OpenAI proxy in TypeScript** — 
- **AutoGen cost management: how to stop agents spending too much** — 

> Articles published to [dev.to](https://dev.to/search?q=awx+shredder), [Hashnode](https://hashnode.com/search?q=awx+shredder), and [awx-shredder.fly.dev/blog](https://awx-shredder.fly.dev/blog)

<!-- AWX_ARTICLES_END -->