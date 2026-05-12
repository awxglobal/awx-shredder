/**
 * Health Score Engine — the cockpit fuel gauge.
 *
 * Calculates a green/amber/red health signal for a project's current
 * or recent session based on five signals:
 *   1. Scope     — files touched vs historical average
 *   2. Focus     — are files in the same module or scattered
 *   3. Repetition — is the same file being edited over and over
 *   4. Duration  — session length vs historical average
 *   5. Trajectory — is the task converging or still expanding
 *
 * All signals are pure math on file_events data. No LLM needed.
 */

import { db } from '../db/client.js';
import { fileEvents, memoryEntries } from '../db/schema.js';
import { eq, and, gte, desc, sql } from 'drizzle-orm';

// ── Types ───────────────────────────────────────────────────────────────────

export type HealthStatus = 'green' | 'amber' | 'red';

export interface SignalResult {
  status: HealthStatus;
  detail: string;
}

export interface HealthScore {
  status: HealthStatus;
  summary: string;
  signals: {
    scope: SignalResult;
    focus: SignalResult;
    repetition: SignalResult;
    duration: SignalResult;
    trajectory: SignalResult;
  };
  meta: {
    filesInSession: number;
    uniqueFiles: number;
    modulesTouched: number;
    maxEditsOnSingleFile: number;
    sessionMinutes: number;
    avgSessionMinutes: number;
    newFilesInLastWindow: number;
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

/**
 * Calculate the health score for a project's most recent activity.
 *
 * @param projectId — the project to analyze
 * @param windowMinutes — how far back to look for "current session" (default 120)
 */
export async function calculateHealthScore(
  projectId: string,
  windowMinutes = 120,
): Promise<HealthScore> {
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

  // Get current session's file events
  const currentEvents = await db
    .select({
      filePath: fileEvents.filePath,
      eventType: fileEvents.eventType,
      timestamp: fileEvents.timestamp,
    })
    .from(fileEvents)
    .where(
      and(
        eq(fileEvents.projectId, projectId),
        gte(fileEvents.timestamp, windowStart),
      ),
    )
    .orderBy(fileEvents.timestamp);

  // Get historical file events for comparison (last 30 days, excluding current window)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const allRecentEvents = await db
    .select({
      filePath: fileEvents.filePath,
      eventType: fileEvents.eventType,
      timestamp: fileEvents.timestamp,
    })
    .from(fileEvents)
    .where(
      and(
        eq(fileEvents.projectId, projectId),
        gte(fileEvents.timestamp, thirtyDaysAgo),
      ),
    )
    .orderBy(fileEvents.timestamp);

  // Calculate historical session averages by grouping events into sessions
  // A "session" is a burst of activity with gaps < 30 minutes between events
  const historicalSessions = groupIntoSessions(
    allRecentEvents.filter((e) => e.timestamp < windowStart),
    30,
  );

  const avgFilesPerSession = historicalSessions.length > 0
    ? historicalSessions.reduce((sum, s) => sum + s.uniqueFiles, 0) / historicalSessions.length
    : 5; // default if no history

  const avgSessionMinutes = historicalSessions.length > 0
    ? historicalSessions.reduce((sum, s) => sum + s.durationMinutes, 0) / historicalSessions.length
    : 20; // default if no history

  // Current session stats
  const uniqueFiles = new Set(currentEvents.map((e) => e.filePath));
  const fileCount = uniqueFiles.size;
  const totalEvents = currentEvents.length;

  // Module analysis — extract top-level directory as "module"
  const modules = new Set(
    currentEvents.map((e) => getModule(e.filePath)),
  );

  // Repetition — count edits per file
  const editCounts = new Map<string, number>();
  for (const e of currentEvents) {
    if (e.eventType === 'modified' || e.eventType === 'created') {
      editCounts.set(e.filePath, (editCounts.get(e.filePath) ?? 0) + 1);
    }
  }
  const maxEdits = editCounts.size > 0 ? Math.max(...editCounts.values()) : 0;
  const filesWithManyEdits = [...editCounts.entries()].filter(([_, count]) => count >= 3);

  // Duration
  const firstEvent = currentEvents[0]?.timestamp;
  const lastEvent = currentEvents[currentEvents.length - 1]?.timestamp;
  const sessionMinutes = firstEvent && lastEvent
    ? Math.round((lastEvent.getTime() - firstEvent.getTime()) / 60000)
    : 0;

  // Trajectory — are new files still being opened in the last quarter of the session?
  const trajectoryWindow = 5; // last 5 minutes
  const trajectoryStart = new Date(Date.now() - trajectoryWindow * 60 * 1000);
  const earlyFiles = new Set(
    currentEvents
      .filter((e) => e.timestamp < trajectoryStart)
      .map((e) => e.filePath),
  );
  const newFilesInLastWindow = currentEvents
    .filter((e) => e.timestamp >= trajectoryStart)
    .filter((e) => !earlyFiles.has(e.filePath))
    .map((e) => e.filePath);
  const newFileCountRecent = new Set(newFilesInLastWindow).size;

  // ── Calculate each signal ──────────────────────────────────────────────

  const scope = calculateScope(fileCount, avgFilesPerSession);
  const focus = calculateFocus(modules.size, fileCount);
  const repetition = calculateRepetition(maxEdits, filesWithManyEdits);
  const duration = calculateDuration(sessionMinutes, avgSessionMinutes);
  const trajectory = calculateTrajectory(newFileCountRecent, fileCount, sessionMinutes);

  // ── Overall status ─────────────────────────────────────────────────────

  const signals = { scope, focus, repetition, duration, trajectory };
  const allStatuses = Object.values(signals).map((s) => s.status);
  const redCount = allStatuses.filter((s) => s === 'red').length;
  const amberCount = allStatuses.filter((s) => s === 'amber').length;

  let status: HealthStatus = 'green';
  if (redCount >= 2 || (redCount >= 1 && amberCount >= 2)) {
    status = 'red';
  } else if (redCount >= 1 || amberCount >= 2) {
    status = 'amber';
  }

  // No events = no session = green
  if (currentEvents.length === 0) {
    status = 'green';
  }

  const summary = buildSummary(status, fileCount, modules.size, sessionMinutes, avgSessionMinutes, maxEdits);

  return {
    status,
    summary,
    signals,
    meta: {
      filesInSession: totalEvents,
      uniqueFiles: fileCount,
      modulesTouched: modules.size,
      maxEditsOnSingleFile: maxEdits,
      sessionMinutes,
      avgSessionMinutes: Math.round(avgSessionMinutes),
      newFilesInLastWindow: newFileCountRecent,
    },
  };
}

// ── Signal calculators ──────────────────────────────────────────────────────

function calculateScope(fileCount: number, avgFiles: number): SignalResult {
  if (fileCount === 0) return { status: 'green', detail: 'No files touched yet' };
  const ratio = fileCount / Math.max(avgFiles, 1);
  if (ratio > 3) {
    return { status: 'red', detail: `${fileCount} files touched (avg: ${Math.round(avgFiles)}) — 3x+ above normal` };
  }
  if (ratio > 1.8) {
    return { status: 'amber', detail: `${fileCount} files touched (avg: ${Math.round(avgFiles)}) — running wide` };
  }
  return { status: 'green', detail: `${fileCount} files touched (avg: ${Math.round(avgFiles)})` };
}

function calculateFocus(moduleCount: number, fileCount: number): SignalResult {
  if (fileCount === 0) return { status: 'green', detail: 'No files touched yet' };
  if (moduleCount === 1) {
    return { status: 'green', detail: 'All files in the same module' };
  }
  if (moduleCount <= 2) {
    return { status: 'green', detail: `Files across ${moduleCount} modules` };
  }
  if (moduleCount <= 4) {
    return { status: 'amber', detail: `Files scattered across ${moduleCount} modules` };
  }
  return { status: 'red', detail: `Files scattered across ${moduleCount} modules — very broad scope` };
}

function calculateRepetition(
  maxEdits: number,
  filesWithManyEdits: [string, number][],
): SignalResult {
  if (maxEdits <= 2) {
    return { status: 'green', detail: 'No file edited more than twice' };
  }
  if (maxEdits <= 4) {
    const file = filesWithManyEdits[0]?.[0] ?? 'unknown';
    return {
      status: 'amber',
      detail: `${shortPath(file)} edited ${maxEdits} times — possible churn`,
    };
  }
  const file = filesWithManyEdits[0]?.[0] ?? 'unknown';
  return {
    status: 'red',
    detail: `${shortPath(file)} edited ${maxEdits} times — likely spiraling`,
  };
}

function calculateDuration(minutes: number, avgMinutes: number): SignalResult {
  if (minutes === 0) return { status: 'green', detail: 'Just started' };
  const ratio = minutes / Math.max(avgMinutes, 1);
  if (ratio > 3) {
    return { status: 'red', detail: `${minutes} min (avg: ${Math.round(avgMinutes)} min) — 3x+ longer than usual` };
  }
  if (ratio > 1.8) {
    return { status: 'amber', detail: `${minutes} min (avg: ${Math.round(avgMinutes)} min) — running long` };
  }
  return { status: 'green', detail: `${minutes} min (avg: ${Math.round(avgMinutes)} min)` };
}

function calculateTrajectory(
  newFilesRecent: number,
  totalFiles: number,
  sessionMinutes: number,
): SignalResult {
  if (sessionMinutes < 3 || totalFiles === 0) {
    return { status: 'green', detail: 'Too early to assess trajectory' };
  }
  if (newFilesRecent === 0) {
    return { status: 'green', detail: 'No new files in last 5 min — converging' };
  }
  if (newFilesRecent <= 2) {
    return { status: 'amber', detail: `${newFilesRecent} new file${newFilesRecent > 1 ? 's' : ''} in last 5 min — still expanding` };
  }
  return { status: 'red', detail: `${newFilesRecent} new files in last 5 min — scope still growing` };
}

// ── Summary builder ─────────────────────────────────────────────────────────

function buildSummary(
  status: HealthStatus,
  fileCount: number,
  moduleCount: number,
  sessionMinutes: number,
  avgMinutes: number,
  maxEdits: number,
): string {
  if (fileCount === 0) {
    return 'No activity detected — waiting for file events';
  }

  if (status === 'green') {
    return `On track — ${fileCount} file${fileCount !== 1 ? 's' : ''}, ${sessionMinutes} min, normal for this project`;
  }

  // Build a specific amber/red message based on worst signals
  const parts: string[] = [];

  if (fileCount > 0 && moduleCount > 3) {
    parts.push(`${fileCount} files across ${moduleCount} modules`);
  } else if (fileCount > 0) {
    parts.push(`${fileCount} files`);
  }

  if (sessionMinutes > avgMinutes * 1.8) {
    parts.push(`${Math.round(sessionMinutes / avgMinutes)}x longer than average`);
  }

  if (maxEdits >= 4) {
    parts.push(`same file edited ${maxEdits} times`);
  }

  if (status === 'red') {
    return `Check in — ${parts.join(', ')}`;
  }

  return `Running hot — ${parts.join(', ')}`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface SessionGroup {
  uniqueFiles: number;
  durationMinutes: number;
}

/**
 * Group file events into "sessions" based on time gaps.
 * A gap of `gapMinutes` or more starts a new session.
 */
function groupIntoSessions(
  events: Array<{ filePath: string; timestamp: Date }>,
  gapMinutes: number,
): SessionGroup[] {
  if (events.length === 0) return [];

  const sessions: SessionGroup[] = [];
  let sessionFiles = new Set<string>();
  let sessionStart = events[0].timestamp;
  let lastTimestamp = events[0].timestamp;

  for (const event of events) {
    const gap = (event.timestamp.getTime() - lastTimestamp.getTime()) / 60000;

    if (gap > gapMinutes) {
      // Close current session
      sessions.push({
        uniqueFiles: sessionFiles.size,
        durationMinutes: Math.round(
          (lastTimestamp.getTime() - sessionStart.getTime()) / 60000,
        ),
      });
      // Start new session
      sessionFiles = new Set();
      sessionStart = event.timestamp;
    }

    sessionFiles.add(event.filePath);
    lastTimestamp = event.timestamp;
  }

  // Close last session
  sessions.push({
    uniqueFiles: sessionFiles.size,
    durationMinutes: Math.round(
      (lastTimestamp.getTime() - sessionStart.getTime()) / 60000,
    ),
  });

  return sessions;
}

/**
 * Extract the "module" from a file path (first directory segment).
 */
function getModule(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : '_root';
}

/**
 * Shorten a file path to just filename for display.
 */
function shortPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts.length > 2
    ? `.../${parts.slice(-2).join('/')}`
    : parts.join('/');
}
