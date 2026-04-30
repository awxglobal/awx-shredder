import 'dotenv/config';
import { db } from './client.js';
import { agents, organizations } from './schema.js';

/**
 * Additive, idempotent seed for testing the /usage budget-cap flow with curl.
 * Does NOT wipe existing dashboard demo data.
 *
 * Creates:
 *   org_budget_test (FREE)
 *   ├─ budget_test_low   ($1.00 daily)
 *   ├─ budget_test_mid   ($10.00 daily)
 *   └─ budget_test_high  ($100.00 daily)
 *
 * Re-running is safe: rows with the same primary key are left alone.
 */
async function seed() {
  await db
    .insert(organizations)
    .values({ id: 'org_budget_test', name: 'Budget Test Org', planTier: 'FREE' })
    .onConflictDoNothing();

  await db
    .insert(agents)
    .values([
      {
        id: 'budget_test_low',
        orgId: 'org_budget_test',
        dailyBudget: 1.0,
        spentToday: 0,
        status: 'ACTIVE',
      },
      {
        id: 'budget_test_mid',
        orgId: 'org_budget_test',
        dailyBudget: 10.0,
        spentToday: 0,
        status: 'ACTIVE',
      },
      {
        id: 'budget_test_high',
        orgId: 'org_budget_test',
        dailyBudget: 100.0,
        spentToday: 0,
        status: 'ACTIVE',
      },
    ])
    .onConflictDoNothing();

  console.log('Budget-test seed complete:');
  console.log('  org:    org_budget_test (FREE)');
  console.log('  agents: budget_test_low ($1)  budget_test_mid ($10)  budget_test_high ($100)');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
