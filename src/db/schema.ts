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

/**
 * Blog posts published by the marketing agent.
 * Served at /blog and /blog/:slug on the AWX site.
 */
export const blogPosts = pgTable('blog_posts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  summary: text('summary').notNull(),
  tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  devtoUrl: text('devto_url'),
  hashnodeUrl: text('hashnode_url'),
});

export type BlogPost = typeof blogPosts.$inferSelect;
export type NewBlogPost = typeof blogPosts.$inferInsert;

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type UsageLog = typeof usageLogs.$inferSelect;
export type NewUsageLog = typeof usageLogs.$inferInsert;
export type GithubAccount = typeof githubAccounts.$inferSelect;
export type NewGithubAccount = typeof githubAccounts.$inferInsert;

// -- AWX Sync Tables ----------------------------------------------------------

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const syncSessions = pgTable('sync_sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  summary: jsonb('summary').$type<{ filesEdited: number; filesRead: number; memoriesCreated: number }>(),
});

export const fileEvents = pgTable('file_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => syncSessions.id, { onDelete: 'set null' }),
  filePath: text('file_path').notNull(),
  eventType: text('event_type', { enum: ['created', 'modified', 'deleted', 'read'] }).notNull(),
  diff: text('diff'),
  fileSize: doublePrecision('file_size'),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),
});

export const memoryEntries = pgTable('memory_entries', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => syncSessions.id, { onDelete: 'set null' }),
  category: text('category', {
    enum: [
      'bug_fix', 'schema_change', 'project_rule', 'decision', 'constraint', 'note',
      'pr_opened', 'pr_merged', 'pr_closed',
      'issue_opened', 'issue_closed',
      'review_submitted',
      'ci_failed', 'ci_passed',
    ],
  }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  relatedFiles: jsonb('related_files').$type<string[]>().default([]),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  supersededBy: uuid('superseded_by'),
  archived: text('archived', { enum: ['true', 'false'] }).notNull().default('false'),
});

export const contextSnapshots = pgTable('context_snapshots', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  tokenEstimate: doublePrecision('token_estimate').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

// -- GitHub App Tables ---------------------------------------------------------

/**
 * Tracks GitHub App installations linked to an org.
 * Created when a user installs the GitHub App and completes the callback.
 */
export const githubInstallations = pgTable('github_installations', {
  id: text('id').primaryKey(), // ghi_ + hex
  orgId: text('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  installationId: text('installation_id').notNull(), // GitHub's numeric ID (stored as text)
  accountLogin: text('account_login').notNull(), // GitHub org/user login
  accountType: text('account_type', { enum: ['Organization', 'User'] }).notNull(),
  repos: jsonb('repos').$type<string[] | null>(), // selected repos, null = all
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Links a GitHub repo to a project brain.
 * One repo can be linked to one project. Created during installation callback
 * (auto-match by name) or manually via dashboard.
 */
export const githubRepoLinks = pgTable('github_repo_links', {
  id: text('id').primaryKey(),
  installationId: text('installation_id')
    .notNull()
    .references(() => githubInstallations.id, { onDelete: 'cascade' }),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  repoFullName: text('repo_full_name').notNull(), // e.g. "user/repo"
  repoId: text('repo_id').notNull(), // GitHub's numeric repo ID (stored as text)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
export type GithubRepoLink = typeof githubRepoLinks.$inferSelect;
export type NewGithubRepoLink = typeof githubRepoLinks.$inferInsert;

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type SyncSession = typeof syncSessions.$inferSelect;
export type NewSyncSession = typeof syncSessions.$inferInsert;
export type FileEvent = typeof fileEvents.$inferSelect;
export type NewFileEvent = typeof fileEvents.$inferInsert;
export type MemoryEntry = typeof memoryEntries.$inferSelect;
export type NewMemoryEntry = typeof memoryEntries.$inferInsert;
export type ContextSnapshot = typeof contextSnapshots.$inferSelect;
export type NewContextSnapshot = typeof contextSnapshots.$inferInsert;
