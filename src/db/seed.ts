import 'dotenv/config';
import { db } from './client.js';
import { agents, organizations, usageLogs } from './schema.js';

const ORG_ID = 'org_aegis_demo';

const NAMES = [
  'Data-Scraper-Alpha',
  'Data-Scraper-Beta',
  'Data-Scraper-Gamma',
  'Report-Gen-01',
  'Report-Gen-02',
  'Report-Gen-03',
  'Email-Triage-01',
  'Email-Triage-02',
  'Analytics-Worker-01',
  'Analytics-Worker-02',
  'Analytics-Worker-03',
  'Doc-Indexer-01',
  'Doc-Indexer-02',
  'Search-Bot-North',
  'Search-Bot-South',
  'Translator-EN',
  'Translator-ES',
  'Translator-JP',
  'Code-Reviewer-01',
  'Code-Reviewer-02',
  'Webhook-Relay-North',
  'Webhook-Relay-South',
  'Crawler-Edge-01',
  'Crawler-Edge-02',
  'Payment-Bot-Alpha',
  'Payment-Bot-Beta',
  'Sentiment-Analyzer-01',
  'Refund-Processor-01',
];

const THROTTLED = new Set(['Report-Gen-02', 'Crawler-Edge-02', 'Webhook-Relay-South']);
const BLOCKED = new Set(['Payment-Bot-Beta']);

const BUDGETS = [100, 150, 200, 250, 300, 400, 500];

const RECENT_FEED = [
  { agent: 'Data-Scraper-Alpha', status: 'OK', cost: 0.08, secondsAgo: 12 },
  { agent: 'Report-Gen-01', status: 'REQ', cost: 0, secondsAgo: 25 },
  { agent: 'Payment-Bot-Beta', status: 'BLOCKED', cost: 0, secondsAgo: 47 },
  { agent: 'Analytics-Worker-02', status: 'OK', cost: 0.14, secondsAgo: 68 },
  { agent: 'Search-Bot-North', status: 'REQ', cost: 0, secondsAgo: 95 },
  { agent: 'Doc-Indexer-01', status: 'OK', cost: 0.21, secondsAgo: 130 },
  { agent: 'Email-Triage-02', status: 'OK', cost: 0.05, secondsAgo: 165 },
  { agent: 'Code-Reviewer-01', status: 'OK', cost: 0.33, secondsAgo: 210 },
];

async function seed() {
  console.log('Wiping existing rows...');
  await db.delete(usageLogs);
  await db.delete(agents);
  await db.delete(organizations);

  console.log('Inserting organization...');
  await db.insert(organizations).values({
    id: ORG_ID,
    name: 'AEGIS Demo Co.',
    planTier: 'PAID',
  });

  console.log(`Inserting ${NAMES.length} agents...`);
  const agentRows = NAMES.map((name, idx) => {
    const status = BLOCKED.has(name)
      ? 'BLOCKED'
      : THROTTLED.has(name)
        ? 'THROTTLED'
        : 'ACTIVE';
    const budget = BUDGETS[idx % BUDGETS.length];
    let spent: number;
    if (status === 'BLOCKED') spent = 0;
    else if (status === 'THROTTLED') spent = budget * (0.92 + Math.random() * 0.08);
    else spent = budget * (0.4 + Math.random() * 0.5);
    return {
      id: name,
      orgId: ORG_ID,
      dailyBudget: budget,
      spentToday: Math.round(spent * 100) / 100,
      status,
    };
  });
  await db.insert(agents).values(agentRows);

  const now = Date.now();
  const logs: (typeof usageLogs.$inferInsert)[] = [];

  for (const r of RECENT_FEED) {
    logs.push({
      agentId: r.agent,
      estimatedCost: r.cost,
      actualCost: r.cost,
      status: r.status,
      timestamp: new Date(now - r.secondsAgo * 1000),
    });
  }

  for (let i = 0; i < 142; i++) {
    const minutesAgo = 5 + Math.random() * (24 * 60 - 5);
    logs.push({
      agentId: 'Payment-Bot-Beta',
      estimatedCost: 0,
      actualCost: 0,
      status: 'BLOCKED',
      timestamp: new Date(now - minutesAgo * 60 * 1000),
    });
  }

  for (let i = 0; i < 80; i++) {
    const minutesAgo = 5 + Math.random() * (24 * 60 - 5);
    const cost = Math.round(Math.random() * 60) / 100;
    logs.push({
      agentId: NAMES[Math.floor(Math.random() * NAMES.length)],
      estimatedCost: cost,
      actualCost: cost,
      status: Math.random() < 0.85 ? 'OK' : 'REQ',
      timestamp: new Date(now - minutesAgo * 60 * 1000),
    });
  }

  console.log(`Inserting ${logs.length} usage logs...`);
  for (let i = 0; i < logs.length; i += 100) {
    await db.insert(usageLogs).values(logs.slice(i, i + 100));
  }

  console.log(`Seed complete: 1 org, ${agentRows.length} agents, ${logs.length} usage logs.`);
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
