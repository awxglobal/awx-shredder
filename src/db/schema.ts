import { sql } from 'drizzle-orm';
import {
  doublePrecision,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  planTier: text('plan_tier', { enum: ['FREE', 'PAID'] }).notNull(),
  /** Contact email — used for budget alert emails. */
  email: text('email'),
  /** Per-org OpenAI API key. Falls back to OPENAI_API_KEY env var if null. */
  openaiApiKey: text('openai_api_key'),
  /** SHA-256 hash of the org's awx_live_ API key. Null until a key is generated. */
  apiKeyHash: text('api_key_hash'),
});

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  /** Human-readable display name. Falls back to id in the UI when null. */
  name: text('name'),
  dailyBudget: doublePrecision('daily_budget').notNull(),
  spentToday: doublePrecision('spent_today').notNull().default(0),
  status: text('status').notNull(),
  lastResetAt: timestamp('last_reset_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /**
   * Tracks which budget-threshold Slack alerts have already fired today.
   * Reset to defaults on day rollover alongside spent_today.
   * Shape: { "50": bool, "80": bool, "100": bool }
   */
  alertsFired: jsonb('alerts_fired')
    .$type<{ '50': boolean; '80': boolean; '100': boolean }>()
    .notNull()
    .default({ '50': false, '80': false, '100': false }),
});

export const usageLogs = pgTable('usage_logs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  estimatedCost: doublePrecision('estimated_cost').notNull(),
  actualCost: doublePrecision('actual_cost').notNull(),
  status: text('status').notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
});

/**
 * Links a GitHub user ID to an AWX org.
 * Created on first GitHub OAuth login. One GitHub account = one org (for now).
 */
export const githubAccounts = pgTable('github_accounts', {
  githubId: text('github_id').primaryKey(),
  githubLogin: text('github_login').notNull(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const waitlistEmails = pgTable('waitlist_emails', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: text('email').notNull().unique(),
  source: text('source').notNull().default('landing'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type UsageLog = typeof usageLogs.$inferSelect;
export type NewUsageLog = typeof usageLogs.$inferInsert;
export type GithubAccount = typeof githubAccounts.$inferSelect;
export type NewGithubAccount = typeof githubAccounts.$inferInsert;
