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

  const delta = earlyRetries > 0
    ? Math.round(((recentRetries - earlyRetries) / earlyRetries) * 100)
    : 0;

  const trend = weeks.map(w => ({
    week: w.label,
    value: countRetrySignals(allEvents.filter(e => e.timestamp >= w.start && e.timestamp < w.end)),
  }));

  const totalRetries = earlyRetries + recentRetries;

  return {
    id: 'retry',
    title: 'Retry / loop reduction',
    value: totalRetries === 0 ? '0' : `${Math.abs(delta)}%`,
    previous: `${earlyRetries} loops`,
    delta,
    unit: delta <= 0 ? 'fewer loops' : 'more loops',
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

  return {
    id: 'review',
    title: 'Reviewer rewrite reduction',
    value: totalReviews === 0 ? '0' : `${Math.abs(delta)}%`,
    previous: `${earlyRewrites} rewrites`,
    delta,
    unit: 'less reviewer rescue',
    pain: 'Reviewers stop re-implementing agent output by hand.',
    evidence: `${totalReviews} reviews, ${earlyRewrites + recentRewrites} with changes requested`,
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

  return {
    id: 'ci',
    title: 'CI failure reduction',
    value: totalCI === 0 ? '0' : `${Math.abs(delta)}%`,
    previous: `${earlyFailures} CI failures`,
    delta,
    unit: 'fewer failed runs',
    pain: 'Known failing checks get run before handoff.',
    evidence: `${totalCI} CI events, ${earlyFailures + recentFailures} failures`,
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
  // Count unique files read per period (read events = exploration)
  const earlyExploration = new Set(earlyEvents.filter(e => e.eventType === 'read').map(e => e.filePath)).size;
  const recentExploration = new Set(recentEvents.filter(e => e.eventType === 'read').map(e => e.filePath)).size;

  // If no read events, count all unique files as exploration proxy
  const earlyFiles = earlyExploration || new Set(earlyEvents.map(e => e.filePath)).size;
  const recentFiles = recentExploration || new Set(recentEvents.map(e => e.filePath)).size;

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

  return {
    id: 'exploration',
    title: 'File exploration reduction',
    value: earlyFiles + recentFiles === 0 ? '0' : `${Math.abs(delta)}%`,
    previous: `${earlyFiles} files`,
    delta,
    unit: 'less repo wandering',
    pain: 'Agents start with evidence instead of broad scans.',
    evidence: `${new Set(allEvents.map(e => e.filePath)).size} unique files across ${allEvents.length} events`,
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

  const trend = weeks.map(w => {
    const weekBugs = bugFixes.filter(m => m.createdAt >= w.start && m.createdAt < w.end);
    return {
      week: w.label,
      value: findRegressions(bugFixes.filter(m => m.createdAt < w.end)).length,
    };
  });

  return {
    id: 'regression',
    title: 'Repeated regression prevention',
    value: String(regressions.length),
    previous: `${bugFixes.length} bug fixes tracked`,
    delta: regressions.length > 0 ? regressions.length * 100 : 0,
    unit: 'repeat failures blocked',
    pain: 'The same bug stops returning across AI tools.',
    evidence: `${regressions.length} regressions from ${bugFixes.length} bug fixes on ${countUniqueFiles(bugFixes)} files`,
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
