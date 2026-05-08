/**
 * GitHub App utilities — webhook signature verification & event-to-memory mapping.
 *
 * Env vars required:
 *   GITHUB_WEBHOOK_SECRET  — HMAC-SHA256 secret configured in the GitHub App
 *   GITHUB_APP_ID          — GitHub App ID (for future JWT/token management)
 *   GITHUB_APP_PRIVATE_KEY — PEM key (for future JWT/token management)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomBytes } from 'node:crypto';

// ── Signature verification ──────────────────────────────────────────────────

/**
 * Verify the X-Hub-Signature-256 header from a GitHub webhook.
 * Returns true if valid, false otherwise.
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string | null | undefined,
): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[github] GITHUB_WEBHOOK_SECRET not set — rejecting webhook');
    return false;
  }
  if (!signature) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

  // Timing-safe comparison
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false; // length mismatch
  }
}

// ── ID generators ───────────────────────────────────────────────────────────

export function newInstallationId(): string {
  return `ghi_${randomBytes(12).toString('hex')}`;
}

export function newRepoLinkId(): string {
  return `ghrl_${randomBytes(12).toString('hex')}`;
}

// ── Event-to-memory mapping ─────────────────────────────────────────────────

export type MemoryCategory =
  | 'pr_opened' | 'pr_merged' | 'pr_closed'
  | 'issue_opened' | 'issue_closed'
  | 'review_submitted'
  | 'ci_failed' | 'ci_passed';

interface MappedMemory {
  category: MemoryCategory;
  title: string;
  body: string;
  relatedFiles: string[];
  metadata: Record<string, unknown>;
}

interface MappedFileEvent {
  filePath: string;
  eventType: 'created' | 'modified' | 'deleted';
}

export interface WebhookResult {
  memories: MappedMemory[];
  fileEvents: MappedFileEvent[];
}

/**
 * Map a GitHub webhook event to memory entries and file events.
 * Returns null if the event type is not handled.
 */
export function mapWebhookEvent(
  eventType: string,
  payload: Record<string, any>,
): WebhookResult | null {
  switch (eventType) {
    case 'pull_request':
      return mapPullRequest(payload);
    case 'issues':
      return mapIssue(payload);
    case 'pull_request_review':
      return mapPullRequestReview(payload);
    case 'check_run':
      return mapCheckRun(payload);
    case 'push':
      return mapPush(payload);
    default:
      return null;
  }
}

// ── PR events ───────────────────────────────────────────────────────────────

function mapPullRequest(payload: Record<string, any>): WebhookResult | null {
  const action = payload.action;
  const pr = payload.pull_request;
  if (!pr) return null;

  const prNumber = pr.number;
  const title = pr.title ?? '';
  const body = truncate(pr.body ?? '', 500);
  const author = pr.user?.login ?? 'unknown';
  const branch = pr.head?.ref ?? '';
  const baseBranch = pr.base?.ref ?? '';

  if (action === 'opened' || action === 'reopened') {
    return {
      memories: [{
        category: 'pr_opened',
        title: `PR #${prNumber}: ${title}`,
        body: `${author} opened PR #${prNumber} (${branch} → ${baseBranch}).\n\n${body}`,
        relatedFiles: [],
        metadata: { pr_number: prNumber, author, branch, base_branch: baseBranch, url: pr.html_url },
      }],
      fileEvents: [],
    };
  }

  if (action === 'closed' && pr.merged) {
    const mergedBy = pr.merged_by?.login ?? author;
    const changedFiles = pr.changed_files ?? 0;
    const additions = pr.additions ?? 0;
    const deletions = pr.deletions ?? 0;

    return {
      memories: [{
        category: 'pr_merged',
        title: `PR #${prNumber} merged: ${title}`,
        body: `${mergedBy} merged PR #${prNumber} (${branch} → ${baseBranch}). ${changedFiles} files, +${additions} -${deletions}.`,
        relatedFiles: [],
        metadata: {
          pr_number: prNumber,
          author,
          merged_by: mergedBy,
          merge_sha: pr.merge_commit_sha,
          changed_files: changedFiles,
          additions,
          deletions,
          url: pr.html_url,
        },
      }],
      fileEvents: [],
    };
  }

  if (action === 'closed' && !pr.merged) {
    return {
      memories: [{
        category: 'pr_closed',
        title: `PR #${prNumber} closed without merge: ${title}`,
        body: `${author} closed PR #${prNumber} without merging.`,
        relatedFiles: [],
        metadata: { pr_number: prNumber, author, url: pr.html_url },
      }],
      fileEvents: [],
    };
  }

  return null;
}

// ── Issue events ────────────────────────────────────────────────────────────

function mapIssue(payload: Record<string, any>): WebhookResult | null {
  const action = payload.action;
  const issue = payload.issue;
  if (!issue) return null;

  const issueNumber = issue.number;
  const title = issue.title ?? '';
  const body = truncate(issue.body ?? '', 500);
  const author = issue.user?.login ?? 'unknown';
  const labels = (issue.labels ?? []).map((l: any) => l.name).join(', ');

  if (action === 'opened') {
    return {
      memories: [{
        category: 'issue_opened',
        title: `Issue #${issueNumber}: ${title}`,
        body: `${author} opened issue #${issueNumber}.${labels ? ` Labels: ${labels}.` : ''}\n\n${body}`,
        relatedFiles: [],
        metadata: { issue_number: issueNumber, author, labels, url: issue.html_url },
      }],
      fileEvents: [],
    };
  }

  if (action === 'closed') {
    const reason = issue.state_reason ?? 'completed';
    return {
      memories: [{
        category: 'issue_closed',
        title: `Issue #${issueNumber} closed: ${title}`,
        body: `Issue #${issueNumber} closed as ${reason}.`,
        relatedFiles: [],
        metadata: { issue_number: issueNumber, author, reason, url: issue.html_url },
      }],
      fileEvents: [],
    };
  }

  return null;
}

// ── PR review events ────────────────────────────────────────────────────────

function mapPullRequestReview(payload: Record<string, any>): WebhookResult | null {
  if (payload.action !== 'submitted') return null;

  const review = payload.review;
  const pr = payload.pull_request;
  if (!review || !pr) return null;

  const reviewer = review.user?.login ?? 'unknown';
  const state = review.state ?? 'commented'; // approved, changes_requested, commented
  const prNumber = pr.number;
  const prTitle = pr.title ?? '';
  const reviewBody = truncate(review.body ?? '', 300);

  return {
    memories: [{
      category: 'review_submitted',
      title: `Review on PR #${prNumber}: ${state} by ${reviewer}`,
      body: `${reviewer} ${state.replace('_', ' ')} PR #${prNumber} (${prTitle}).${reviewBody ? `\n\n${reviewBody}` : ''}`,
      relatedFiles: [],
      metadata: { pr_number: prNumber, reviewer, state, url: review.html_url },
    }],
    fileEvents: [],
  };
}

// ── CI check events ─────────────────────────────────────────────────────────

function mapCheckRun(payload: Record<string, any>): WebhookResult | null {
  if (payload.action !== 'completed') return null;

  const check = payload.check_run;
  if (!check) return null;

  const name = check.name ?? 'unknown check';
  const conclusion = check.conclusion ?? 'unknown'; // success, failure, neutral, etc.
  const headSha = check.head_sha?.slice(0, 7) ?? '';

  // Only track failures and successes
  if (conclusion !== 'success' && conclusion !== 'failure') return null;

  const category: MemoryCategory = conclusion === 'failure' ? 'ci_failed' : 'ci_passed';

  return {
    memories: [{
      category,
      title: `CI ${conclusion}: ${name}`,
      body: `Check "${name}" ${conclusion} on commit ${headSha}.`,
      relatedFiles: [],
      metadata: { check_name: name, conclusion, head_sha: check.head_sha, url: check.html_url },
    }],
    fileEvents: [],
  };
}

// ── Push events (file events only) ──────────────────────────────────────────

function mapPush(payload: Record<string, any>): WebhookResult | null {
  const commits = payload.commits;
  if (!Array.isArray(commits) || commits.length === 0) return null;

  const fileEvents: MappedFileEvent[] = [];
  const seen = new Set<string>();

  for (const commit of commits) {
    for (const f of commit.added ?? []) {
      if (!seen.has(f)) { seen.add(f); fileEvents.push({ filePath: f, eventType: 'created' }); }
    }
    for (const f of commit.modified ?? []) {
      if (!seen.has(f)) { seen.add(f); fileEvents.push({ filePath: f, eventType: 'modified' }); }
    }
    for (const f of commit.removed ?? []) {
      if (!seen.has(f)) { seen.add(f); fileEvents.push({ filePath: f, eventType: 'deleted' }); }
    }
  }

  return { memories: [], fileEvents };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '…';
}
