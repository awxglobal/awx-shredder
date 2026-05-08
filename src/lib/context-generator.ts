import { and, desc, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { fileEvents, memoryEntries, projects, syncSessions } from '../db/schema.js';

interface ContextOptions {
  maxTokens?: number;
}

interface Section {
  label: string;
  content: string;
  priority: number; // lower = trimmed first
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function generateContextBlock(
  projectId: string,
  opts: ContextOptions = {},
): Promise<{ content: string; tokenEstimate: number }> {
  const maxTokens = opts.maxTokens ?? 2000;
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since2h = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const since14d = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [proj] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!proj) throw new Error(`Project ${projectId} not found`);

  // ── Queries (parallel) ───────────────────────────────────────────────────

  const [recentFileRows, activeFileRows, allMemories, lastSession, recentDiffs, timelineFileRows, timelineMemories] = await Promise.all([
    // Files edited in last 24h — grouped by path, sorted by edit count
    db
      .select({
        filePath: fileEvents.filePath,
        editCount: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'modified')::int`,
        readCount: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'read')::int`,
        lastSeen: sql<Date>`max(${fileEvents.timestamp})`,
        eventTypes: sql<string[]>`array_agg(distinct ${fileEvents.eventType})`,
      })
      .from(fileEvents)
      .where(
        and(
          eq(fileEvents.projectId, projectId),
          gte(fileEvents.timestamp, since24h),
        ),
      )
      .groupBy(fileEvents.filePath)
      .orderBy(
        sql`count(*) filter (where ${fileEvents.eventType} = 'modified') desc`,
      )
      .limit(20),

    // Files touched in last 2h = "currently active"
    db
      .select({ filePath: fileEvents.filePath })
      .from(fileEvents)
      .where(
        and(
          eq(fileEvents.projectId, projectId),
          gte(fileEvents.timestamp, since2h),
        ),
      )
      .groupBy(fileEvents.filePath)
      .orderBy(sql`max(${fileEvents.timestamp}) desc`)
      .limit(10),

    // All live memory entries (not archived, not superseded)
    db
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.projectId, projectId),
          eq(memoryEntries.archived, 'false'),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(100),

    // Last completed session
    db
      .select()
      .from(syncSessions)
      .where(
        and(
          eq(syncSessions.projectId, projectId),
          ne(syncSessions.endedAt, null as unknown as Date),
        ),
      )
      .orderBy(desc(syncSessions.startedAt))
      .limit(1),

    // Most recent diffs (one per file, last 2h, non-null diffs only)
    db
      .select({
        filePath: fileEvents.filePath,
        diff: fileEvents.diff,
        timestamp: fileEvents.timestamp,
      })
      .from(fileEvents)
      .where(
        and(
          eq(fileEvents.projectId, projectId),
          eq(fileEvents.eventType, 'modified'),
          gte(fileEvents.timestamp, since2h),
          isNotNull(fileEvents.diff),
        ),
      )
      .orderBy(desc(fileEvents.timestamp))
      .limit(5),

    // Timeline: file activity grouped by day for last 14 days
    db
      .select({
        filePath: fileEvents.filePath,
        eventType: fileEvents.eventType,
        day: sql<string>`date_trunc('day', ${fileEvents.timestamp})::date::text`,
        editCount: sql<number>`count(*) filter (where ${fileEvents.eventType} = 'modified')::int`,
        eventTypes: sql<string[]>`array_agg(distinct ${fileEvents.eventType})`,
      })
      .from(fileEvents)
      .where(
        and(
          eq(fileEvents.projectId, projectId),
          gte(fileEvents.timestamp, since14d),
        ),
      )
      .groupBy(fileEvents.filePath, fileEvents.eventType, sql`date_trunc('day', ${fileEvents.timestamp})::date::text`)
      .orderBy(sql`date_trunc('day', ${fileEvents.timestamp})::date::text desc`, fileEvents.filePath),

    // Timeline: memories from last 14 days
    db
      .select()
      .from(memoryEntries)
      .where(
        and(
          eq(memoryEntries.projectId, projectId),
          gte(memoryEntries.createdAt, since14d),
          eq(memoryEntries.archived, 'false'),
        ),
      )
      .orderBy(desc(memoryEntries.createdAt))
      .limit(50),
  ]);

  // ── Derive "what they're in the middle of" ──────────────────────────────

  const hottestFile = recentFileRows[0];
  const activeFilePaths = new Set(activeFileRows.map((r) => r.filePath));

  const lastDecision = allMemories.find(
    (m) => m.category === 'decision' || m.category === 'project_rule',
  );
  const lastBug = allMemories.find((m) => m.category === 'bug_fix');

  // ── Build header ────────────────────────────────────────────────────────

  const updatedAt = timeAgo(now);
  let header = `=== PROJECT STATE ===\n`;
  header += `${proj.name}`;
  if (hottestFile) {
    header += ` | active in ${hottestFile.filePath.split('/').slice(-2).join('/')}`;
  }
  header += `\n`;

  if (lastDecision) {
    header += `Last decision: "${lastDecision.title}"\n`;
  }

  // ── Sections ────────────────────────────────────────────────────────────

  const sections: Section[] = [];

  // Active files (highest priority — this is the "where are you" signal)
  if (activeFileRows.length > 0) {
    const lines = activeFileRows
      .map((r) => `  ${r.filePath}`)
      .join('\n');
    sections.push({
      label: 'ACTIVE NOW',
      content: `## ACTIVE NOW (last 2h)\n${lines}`,
      priority: 10,
    });
  }

  // Recent file activity
  if (recentFileRows.length > 0) {
    const lines = recentFileRows
      .map((r) => {
        const types = (r.eventTypes as string[]) ?? [];
        const marker = types.includes('created')
          ? '[+]'
          : types.includes('deleted')
            ? '[x]'
            : '[~]';
        const edits = r.editCount > 0 ? ` ${r.editCount} edit${r.editCount !== 1 ? 's' : ''}` : '';
        const hot = activeFilePaths.has(r.filePath) ? ' ●' : '';
        return `  ${marker} ${r.filePath}${edits}, ${timeAgo(new Date(r.lastSeen))}${hot}`;
      })
      .join('\n');
    sections.push({
      label: 'FILE ACTIVITY',
      content: `## FILE ACTIVITY (last 24h)\n${lines}`,
      priority: 9,
    });
  }

  // Memory by category
  const categories: Array<{
    key: string;
    label: string;
    priority: number;
  }> = [
    { key: 'bug_fix', label: 'BUGS FIXED', priority: 8 },
    { key: 'schema_change', label: 'SCHEMA', priority: 8 },
    { key: 'decision', label: 'DECISIONS', priority: 7 },
    { key: 'project_rule', label: 'RULES IN FORCE', priority: 7 },
    { key: 'constraint', label: 'CONSTRAINTS', priority: 6 },
    { key: 'note', label: 'NOTES', priority: 5 },
    // GitHub App categories
    { key: 'pr_opened', label: 'PR ACTIVITY — OPENED', priority: 7 },
    { key: 'pr_merged', label: 'PR ACTIVITY — MERGED', priority: 8 },
    { key: 'pr_closed', label: 'PR ACTIVITY — CLOSED', priority: 5 },
    { key: 'issue_opened', label: 'ISSUES — OPENED', priority: 6 },
    { key: 'issue_closed', label: 'ISSUES — CLOSED', priority: 6 },
    { key: 'review_submitted', label: 'CODE REVIEWS', priority: 7 },
    { key: 'ci_failed', label: 'CI — FAILED', priority: 8 },
    { key: 'ci_passed', label: 'CI — PASSED', priority: 4 },
  ];

  for (const cat of categories) {
    const entries = allMemories.filter((m) => m.category === cat.key);
    if (entries.length === 0) continue;

    const lines = entries
      .map((e) => {
        const files =
          e.relatedFiles && (e.relatedFiles as string[]).length > 0
            ? ` — ${(e.relatedFiles as string[]).join(', ')}`
            : '';
        return `  - ${e.title}${files}`;
      })
      .join('\n');

    sections.push({
      label: cat.label,
      content: `## ${cat.label}\n${lines}`,
      priority: cat.priority,
    });
  }

  // Recent diffs — one per file, deduped, trimmed per-file
  if (recentDiffs.length > 0) {
    // Dedupe: keep only the latest diff per file path
    const seen = new Set<string>();
    const dedupedDiffs = recentDiffs.filter((r) => {
      if (seen.has(r.filePath)) return false;
      seen.add(r.filePath);
      return true;
    });

    const lines = dedupedDiffs
      .map((r) => {
        const diffText = (r.diff as string)
          .split('\n')
          .slice(0, 30) // max 30 lines per file in context
          .join('\n');
        return `### ${r.filePath}\n\`\`\`diff\n${diffText}\n\`\`\``;
      })
      .join('\n\n');

    sections.push({
      label: 'RECENT CHANGES',
      content: `## RECENT CHANGES\n${lines}`,
      priority: 3, // trimmed first if over budget
    });
  }

  // Project timeline — last 14 days, grouped by day
  if (timelineFileRows.length > 0 || timelineMemories.length > 0) {
    // Group file rows by day
    const byDay = new Map<string, { files: Map<string, { types: Set<string>; edits: number }>; memories: typeof timelineMemories }>();

    for (const row of timelineFileRows) {
      const day = row.day;
      if (!byDay.has(day)) byDay.set(day, { files: new Map(), memories: [] });
      const entry = byDay.get(day)!;
      if (!entry.files.has(row.filePath)) {
        entry.files.set(row.filePath, { types: new Set(), edits: 0 });
      }
      const f = entry.files.get(row.filePath)!;
      for (const t of (row.eventTypes as string[] ?? [])) f.types.add(t);
      f.edits += row.editCount ?? 0;
    }

    for (const mem of timelineMemories) {
      const day = mem.createdAt.toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, { files: new Map(), memories: [] });
      byDay.get(day)!.memories.push(mem);
    }

    const sortedDays = [...byDay.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 10);

    const timelineLines = sortedDays.map((day) => {
      const { files, memories } = byDay.get(day)!;
      const lines: string[] = [`  ${day}:`];

      for (const [fp, info] of files.entries()) {
        const marker = info.types.has('created') ? '[+]' : info.types.has('deleted') ? '[x]' : '[~]';
        const edits = info.edits > 0 ? ` (${info.edits} edit${info.edits !== 1 ? 's' : ''})` : '';
        lines.push(`    ${marker} ${fp}${edits}`);
      }

      for (const mem of memories) {
        const icon = mem.category === 'bug_fix' ? '🐛' : mem.category === 'schema_change' ? '🗄' : mem.category === 'project_rule' ? '📋' : '📝';
        lines.push(`    ${icon} ${mem.title}`);
      }

      return lines.join('\n');
    }).join('\n');

    sections.push({
      label: 'TIMELINE',
      content: `## PROJECT TIMELINE (last 14 days)\n${timelineLines}`,
      priority: 6,
    });
  }

  // Last session summary
  if (lastSession.length > 0) {
    const s = lastSession[0];
    const sum = s.summary as { filesEdited: number; filesRead: number; memoriesCreated: number } | null;
    if (sum) {
      const line = `  ${s.tool} session: ${sum.filesEdited} files edited, ${sum.memoriesCreated} memories added (${timeAgo(new Date(s.startedAt))})`;
      sections.push({
        label: 'LAST SESSION',
        content: `## LAST SESSION\n${line}`,
        priority: 4,
      });
    }
  }

  // ── Token-budget trimming ────────────────────────────────────────────────

  const headerTokens = estimateTokens(header);
  const footerText = `=== END ===`;
  const footerTokens = estimateTokens(footerText);
  let budget = maxTokens - headerTokens - footerTokens - 10;

  // Sort ascending by priority so we trim lowest first
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);
  const kept: Section[] = [];

  // Add from highest priority downward
  for (let i = sorted.length - 1; i >= 0; i--) {
    const s = sorted[i];
    const tokens = estimateTokens(s.content + '\n');
    if (tokens <= budget) {
      kept.push(s);
      budget -= tokens;
    }
    // If a section doesn't fit, skip it (don't truncate mid-section)
  }

  // Restore original order
  const orderedKept = sections.filter((s) => kept.includes(s));

  const body = orderedKept.map((s) => s.content).join('\n\n');
  const content = `${header}\n${body}\n\n${footerText}`;
  const tokenEstimate = estimateTokens(content);

  return { content, tokenEstimate };
}



// Day 6: diff tracking enabled
// andas andas mannen — test line added to verify diff capture
