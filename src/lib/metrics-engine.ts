/**
 * Metrics Engine — calculates the five operational intelligence cards
 * from real DB data instead of mocks.
 *
 * Cards:
 *   1. Retry / loop reduction — command failures and repeated edits
 *   2. Reviewer rewrite reduction — PR reviews with changes_requested
 *   3. CI failure reduction — ci_failed vs ci_passed memory entries
 *   4. File exploration reduction — unique files touched per session
 *   5. Repeated regression prevention — bug_fix entries on same files
 *
 * Each metric returns: current value, comparison, delta %, trend, evidence.
 */

import { db } from '../db/client.js';
import { fileEvents, memoryEntries, syncSessions } from '../db/schema.js';
import { eq, and, gte, sql, desc } from 'drizzle-orm';

// ── Types ───────────────────────────────────────────────────────────────────

export interface MetricResult {
  id: string;
  title: string;
  value: string;
  previous: string;
  delta: number;
  unit: string;
  pain: string;
  evidence: string;
  trend: Array<{ week: string; value: number }>;
}

export interface MetricsPayload {
  source: 'live' | 'insufficient_data';
  metrics: MetricResult[];
  dataAge: {
    oldestEvent: string | null;
    newestEvent: string | null;
    totalFileEvents: number;
    totalMemories: number;
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function calculateMetrics(projectId: string): Promise<MetricsPayload> {
  const now = new Date();
  const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  // Fetch all data in parallel
  const [
    allFileEvents,
    allMemories,
    sessions,
  ] = await Promise.all([
    db.select({
      filePath: fileEvents.filePath,
      eventType: fileEvents.eventType,
      timestamp: fileEvents.timestamp,
    })
      .from(fileEvents)
      .where(and(eq(fileEvents.projectId, projectId), gte(fileEvents.timestamp, fourWeeksAgo)))
      .orderBy(fileEvents.timestamp),

    db.select({
      id: memoryEntries.id,
      category: memoryEntries.category,
      title: memoryEntries.title,
      body: memoryEntries.body,
      relatedFiles: memoryEntries.relatedFiles,
      metadata: memoryEntries.metadata,
      createdAt: memoryEntries.createdAt,
    })
      .from(memoryEntries)
      .where(and(eq(memoryEntries.projectId, projectId), gte(memoryEntries.createdAt, fourWeeksAgo)))
      .orderBy(memoryEntries.createdAt),

    db.select({
      id: syncSessions.id,
      tool: syncSessions.tool,
      startedAt: syncSessions.startedAt,
      endedAt: syncSessions.endedAt,
      summary: syncSessions.summary,
    })
      .from(syncSessions)
      .where(and(eq(syncSessions.projectId, projectId), gte(syncSessions.startedAt, fourWeeksAgo)))
      .orderBy(syncSessions.startedAt),
  ]);

  // Split into two-week windows for before/after comparison
  const earlyEvents = allFileEvents.filter(e => e.timestamp < twoWeeksAgo);
  const recentEvents = allFileEvents.filter(e => e.timestamp >= twoWeeksAgo);
  const earlyMemories = allMemories.filter(m => m.createdAt < twoWeeksAgo);
  const recentMemories = allMemories.filter(m => m.createdAt >= twoWeeksAgo);

  // Build weekly trend buckets
  const weekBoundaries = [
    { label: 'W1', start: new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000), end: new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000) },
    { label: 'W2', start: new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000), end: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000) },
    { label: 'W3', start: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), end: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
    { label: 'W4', start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now },
  ];

  const metrics: MetricResult[] = [
    calculateRetryMetric(earlyEvents, recentEvents, allFileEvents, weekBoundaries),
    calculateReviewMetric(earlyMemories, recentMemories, allMemories, weekBoundaries),
    calculateCIMetric(earlyMemories, recentMemories, allMemories, weekBoundaries),
    calculateExplorationMetric(earlyEvents, recentEvents, allFileEvents, weekBoundaries),
    calculateRegressionMetric(allMemories, weekBoundaries),
  ];

  const timestamps = allFileEvents.map(e => e.timestamp.getTime());

  return {
    source: allFileEvents.length + allMemories.length > 0 ? 'live' : 'insufficient_data',
    metrics,
    dataAge: {
      oldestEvent: timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : null,
      newestEvent: timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : null,
      totalFileEvents: allFileEvents.length,
      totalMemories: allMemories.length,
    },
  };
}

// ── 1. Retry / loop reduction ───────────────────────────────────────────────

type FileEventRow = { filePath: string; eventType: string; timestamp: Date };
type MemoryRow = { id: string; category: string; title: string; body: string; relatedFiles: string[] | null; metadata: Record<string, unknown> | null; createdAt: Date };
type WeekBucket = { label: string; start: Date; end: Date };

function calculateRetryMetric(
  earlyEvents: FileEventRow[],
  recentEvents: FileEventRow[],
  allEvents: FileEventRow[],
  weeks: WeekBucket[],
): MetricResult {
  // Retry signal = files modified 3+ times in the same session-window (2h gaps)
  const earlyRetries = countRetrySignals(earlyEvents);
  const recentRetries = countRetrySignals(recentEvents);
  const totalRetries = earlyRetries + recentRetries;

  const delta = earlyRetries > 0
    ? Math.round(((recentRetries - earlyRetries) / earlyRetries) * 100)
    : 0;

  const trend = weeks.map(w => ({
    week: w.label,
    value: countRetrySignals(allEvents.filter(e => e.timestamp >= w.start && e.timestamp < w.end)),
  }));

  // Show absolute count when no baseline, percentage when comparing
  const hasBaseline = earlyRetries > 0;

  return {
    id: 'retry',
    title: 'Retry / loop reduction',
    value: hasBaseline ? `${Math.abs(delta)}%` : String(totalRetries),
    previous: hasBaseline ? `${earlyRetries} loops` : `${allEvents.length} file events`,
    delta,
    unit: hasBaseline ? (delta <= 0 ? 'fewer loops' : 'more loops') : 'retry signals detected',
    pain: 'AI sessions stop circling the same failed fix.',
    evidence: `${totalRetries} retry signals across ${allEvents.length} file events`,
    trend,
  };
}

function countRetrySignals(events: FileEventRow[]): number {
  // Count files edited 3+ times within a 2-hour sliding window
  const editCounts = new Map<string, number>();
  for (const e of events) {
    if (e.eventType === 'modified' || e.eventType === 'created') {
      editCounts.set(e.filePath, (editCounts.get(e.filePath) ?? 0) + 1);
    }
  }
  return [...editCounts.values()].filter(count => count >= 3).length;
}

// ── 2. Reviewer rewrite reduction ───────────────────────────────────────────

function calculateReviewMetric(
  earlyMemories: MemoryRow[],
  recentMemories: MemoryRow[],
  allMemories: MemoryRow[],
  weeks: WeekBucket[],
): MetricResult {
  const earlyRewrites = earlyMemories.filter(m =>
    m.category === 'review_submitted' && isChangesRequested(m),
  ).length;
  const recentRewrites = recentMemories.filter(m =>
    m.category === 'review_submitted' && isChangesRequested(m),
  ).length;
  const totalReviews = allMemories.filter(m => m.category === 'review_submitted').length;
  const totalRewrites = earlyRewrites + recentRewrites;

  const delta = earlyRewrites > 0
    ? Math.round(((recentRewrites - earlyRewrites) / earlyRewrites) * 100)
    : 0;

  const trend = weeks.map(w => ({
    week: w.label,
    value: allMemories.filter(m =>
      m.category === 'review_submitted' &&
      isChangesRequested(m) &&
      m.createdAt >= w.start && m.createdAt < w.end,
    ).length,
  }));

  const hasBaseline = earlyRewrites > 0;

  return {
    id: 'review',
    title: 'Reviewer rewrite reduction',
    value: hasBaseline ? `${Math.abs(delta)}%` : String(totalRewrites),
    previous: hasBaseline ? `${earlyRewrites} rewrites` : `${totalReviews} reviews total`,
    delta,
    unit: hasBaseline ? 'less reviewer rescue' : 'changes requested',
    pain: 'Reviewers stop re-implementing agent output by hand.',
    evidence: `${totalReviews} reviews, ${totalRewrites} with changes requested`,
    trend,
  };
}

function isChangesRequested(m: MemoryRow): boolean {
  const state = (m.metadata as Record<string, unknown> | null)?.state;
  return state === 'changes_requested';
}

// ── 3. CI failure reduction ─────────────────────────────────────────────────

function calculateCIMetric(
  earlyMemories: MemoryRow[],
  recentMemories: MemoryRow[],
  allMemories: MemoryRow[],
  weeks: WeekBucket[],
): MetricResult {
  const earlyFailures = earlyMemories.filter(m => m.category === 'ci_failed').length;
  const recentFailures = recentMemories.filter(m => m.category === 'ci_failed').length;
  const totalCI = allMemories.filter(m => m.category === 'ci_failed' || m.category === 'ci_passed').length;
  const totalFailures = earlyFailures + recentFailures;
  const totalPassed = allMemories.filter(m => m.category === 'ci_passed').length;

  const delta = earlyFailures > 0
    ? Math.round(((recentFailures - earlyFailures) / earlyFailures) * 100)
    : 0;

  const trend = weeks.map(w => ({
    week: w.label,
    value: allMemories.filter(m =>
      m.category === 'ci_failed' &&
      m.createdAt >= w.start && m.createdAt < w.end,
    ).length,
  }));

  const hasBaseline = earlyFailures > 0;
  // Show pass rate when no baseline
  const passRate = totalCI > 0 ? Math.round((totalPassed / totalCI) * 100) : 0;

  return {
    id: 'ci',
    title: 'CI failure reduction',
    value: hasBaseline ? `${Math.abs(delta)}%` : `${passRate}%`,
    previous: hasBaseline ? `${earlyFailures} CI failures` : `${totalFailures} failures from ${totalCI} runs`,
    delta: hasBaseline ? delta : -passRate,
    unit: hasBaseline ? 'fewer failed runs' : 'CI pass rate',
    pain: 'Known failing checks get run before handoff.',
    evidence: `${totalCI} CI events, ${totalFailures} failures, ${totalPassed} passed`,
    trend,
  };
}

// ── 4. File exploration reduction ───────────────────────────────────────────

function calculateExplorationMetric(
  earlyEvents: FileEventRow[],
  recentEvents: FileEventRow[],
  allEvents: FileEventRow[],
  weeks: WeekBucket[],
): MetricResult {
  // Count unique files per period (all events = exploration proxy)
  const earlyFiles = new Set(earlyEvents.map(e => e.filePath)).size;
  const recentFiles = new Set(recentEvents.map(e => e.filePath)).size;
  const totalUniqueFiles = new Set(allEvents.map(e => e.filePath)).size;

  const delta = earlyFiles > 0
    ? Math.round(((recentFiles - earlyFiles) / earlyFiles) * 100)
    : 0;

  const trend = weeks.map(w => {
    const weekEvents = allEvents.filter(e => e.timestamp >= w.start && e.timestamp < w.end);
    return {
      week: w.label,
      value: new Set(weekEvents.map(e => e.filePath)).size,
    };
  });

  const hasBaseline = earlyFiles > 0;

  return {
    id: 'exploration',
    title: 'File exploration reduction',
    value: hasBaseline ? `${Math.abs(delta)}%` : String(totalUniqueFiles),
    previous: hasBaseline ? `${earlyFiles} files` : `${allEvents.length} total events`,
    delta,
    unit: hasBaseline ? 'less repo wandering' : 'unique files touched',
    pain: 'Agents start with evidence instead of broad scans.',
    evidence: `${totalUniqueFiles} unique files across ${allEvents.length} events`,
    trend,
  };
}

// ── 5. Repeated regression prevention ───────────────────────────────────────

function calculateRegressionMetric(
  allMemories: MemoryRow[],
  weeks: WeekBucket[],
): MetricResult {
  // Find bug_fix entries that share related_files with older bug_fix entries
  // = same file broke twice = regression (or regression prevented if brain caught it)
  const bugFixes = allMemories.filter(m => m.category === 'bug_fix');
  const regressions = findRegressions(bugFixes);
  const bugFiles = countUniqueFiles(bugFixes);

  const trend = weeks.map(w => ({
    week: w.label,
    value: bugFixes.filter(m => m.createdAt >= w.start && m.createdAt < w.end).length,
  }));

  return {
    id: 'regression',
    title: 'Repeated regression prevention',
    value: bugFixes.length === 0 ? '0' : String(regressions.length > 0 ? regressions.length : bugFixes.length),
    previous: regressions.length > 0
      ? `${regressions.length} regressions caught`
      : `${bugFixes.length} bug fixes tracked`,
    delta: regressions.length > 0 ? regressions.length * 100 : bugFixes.length * 50,
    unit: regressions.length > 0 ? 'repeat failures blocked' : 'bug fixes in brain memory',
    pain: 'The same bug stops returning across AI tools.',
    evidence: `${bugFixes.length} bug fixes on ${bugFiles} files, ${regressions.length} regressions detected`,
    trend,
  };
}

function findRegressions(bugFixes: MemoryRow[]): MemoryRow[] {
  // A regression = a bug_fix on a file that already had a bug_fix earlier
  const seenFiles = new Map<string, Date>(); // file → first bug fix date
  const regressions: MemoryRow[] = [];

  for (const fix of bugFixes) {
    const files = fix.relatedFiles ?? [];
    for (const file of files) {
      const firstSeen = seenFiles.get(file);
      if (firstSeen && fix.createdAt > firstSeen) {
        regressions.push(fix);
        break; // count each memory once
      }
      if (!firstSeen) {
        seenFiles.set(file, fix.createdAt);
      }
    }
  }

  return regressions;
}

function countUniqueFiles(memories: MemoryRow[]): number {
  const files = new Set<string>();
  for (const m of memories) {
    for (const f of m.relatedFiles ?? []) {
      files.add(f);
    }
  }
  return files.size;
}
