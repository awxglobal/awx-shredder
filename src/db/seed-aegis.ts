/**
 * Idempotent seed for the Aegis live dashboard demo.
 *
 * Creates:
 *  - org:    org_aegis_demo   (Aegis Demo, PAID)
 *  - agents:
 *      agent_9921       — Production Indexer   $200/day  ACTIVE
 *      agent_research   — Research Agent        $50/day  ACTIVE
 *      agent_batch_proc — Batch Processor      $500/day  ACTIVE
 *
 * Three agents make the multi-agent switcher immediately visible in the demo.
 *
 * API key behaviour:
 *  - If org_aegis_demo already has a key hash stored, the existing key is kept
 *    (its plaintext was shown on first run; we can't regenerate it).
 *  - If no key exists yet, a new awx_live_ key is generated, its hash stored,
 *    and the plaintext printed to stdout ONE TIME.
 *
 * Run: npm run db:seed:aegis
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { agents, organizations } from './schema.js';
import { generateApiKey, hashApiKey } from '../lib/apikey.js';

async function seed() {
  // ── Org ──────────────────────────────────────────────────────────────────

  await db
    .insert(organizations)
    .values({ id: 'org_aegis_demo', name: 'Aegis Demo', planTier: 'PAID' })
    .onConflictDoNothing();

  // ── API key: generate if missing ─────────────────────────────────────────

  const [org] = await db
    .select({ apiKeyHash: organizations.apiKeyHash })
    .from(organizations)
    .where(eq(organizations.id, 'org_aegis_demo'));

  if (!org?.apiKeyHash) {
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);

    await db
      .update(organizations)
      .set({ apiKeyHash })
      .where(eq(organizations.id, 'org_aegis_demo'));

    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                  AWX Shredder — API Key                     ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Org:  org_aegis_demo                                        ║`);
    console.log(`║  Key:  ${apiKey}  ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║  ⚠  Save this key — it will NOT be shown again.             ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log('');
  } else {
    console.log('✓ org_aegis_demo already has an API key — keeping it.');
  }

  // ── Agents ───────────────────────────────────────────────────────────────

  await db
    .insert(agents)
    .values([
      {
        id: 'agent_9921',
        orgId: 'org_aegis_demo',
        name: 'Production Indexer',
        dailyBudget: 200,
        spentToday: 0,
        status: 'ACTIVE',
      },
      {
        id: 'agent_research',
        orgId: 'org_aegis_demo',
        name: 'Research Agent',
        dailyBudget: 50,
        spentToday: 0,
        status: 'ACTIVE',
      },
      {
        id: 'agent_batch_proc',
        orgId: 'org_aegis_demo',
        name: 'Batch Processor',
        dailyBudget: 500,
        spentToday: 0,
        status: 'ACTIVE',
      },
    ])
    .onConflictDoNothing();

  console.log('✓ org_aegis_demo + 3 demo agents ready');
  process.exit(0);
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
