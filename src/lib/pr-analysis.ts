/**
 * PR Analysis Engine — the intelligence layer.
 *
 * Analyzes PR changed files against the project brain and produces
 * risk scores, warnings, and context for automatic PR comments.
 *
 * This is what takes Project Brain from "memory" to "intelligence."
 */

import { db } from '../db/client.js';
import { memoryEntries, fileEvents } from '../db/schema.js';
import { eq, and, sql, inArray, gte } from 'drizzle-orm';

// ── Types ───────────────────────────────────────────────────────────────────

export interface FileRisk {
  filename: string;
  riskLevel: 'high' | 'medium' | 'low';
  bugCount: number;
  recentBugs: Array<{ title: string; date: string }>;
  relatedDecisions: Array<{ title: string; date: string }>;
  relatedSchemaChanges: Array<{ title: string; date: string }>;
}

export interface PRAnalysis {
  overallRisk: 'high' | 'medium' | 'low';
  fileRisks: FileRisk[];
  warnings: string[];
  totalBugsInChangedFiles: number;
  totalDecisionsAffected: number;
  hasHighRiskFiles: boolean;
}

// ── Analysis ────────────────────────────────────────────────────────────────

/**
 * Analyze a PR's changed files against the project brain.
 * Returns risk scores, warnings, and relevant context.
 */
export async function analyzePR(
  projectId: string,
  changedFiles: string[],
): Promise<PRAnalysis> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Get all memories related to the changed files from the last 90 days
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const memories = await db
    .select({
      id: memoryEntries.id,
      category: memoryEntries.category,
      title: memoryEntries.title,
      body: memoryEntries.body,
      relatedFiles: memoryEntries.relatedFiles,
      createdAt: memoryEntries.createdAt,
    })
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.projectId, projectId),
        eq(memoryEntries.archived, 'false'),
        gte(memoryEntries.createdAt, ninetyDaysAgo),
      ),
    );

  // Get file event counts for changed files (last 30 days)
  const recentFileEvents = await db
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
    );

  // Analyze each file
  const fileRisks: FileRisk[] = [];

  for (const file of changedFiles) {
    // Find bug fixes that mention this file
    const fileBugs = memories.filter(
      (m) =>
        m.category === 'bug_fix' &&
        (matchesFile(m.relatedFiles as string[] | null, file) ||
          m.title.toLowerCase().includes(fileBaseName(file)) ||
          m.body.toLowerCase().includes(fileBaseName(file))),
    );

    // Recent bugs (last 30 days)
    const recentBugs = fileBugs
      .filter((b) => b.createdAt && b.createdAt >= thirtyDaysAgo)
      .map((b) => ({ title: b.title, date: formatDate(b.createdAt!) }));

    // Decisions related to this file
    const relatedDecisions = memories
      .filter(
        (m) =>
          m.category === 'decision' &&
          (matchesFile(m.relatedFiles as string[] | null, file) ||
            m.title.toLowerCase().includes(fileBaseName(file)) ||
            m.body.toLowerCase().includes(fileBaseName(file))),
      )
      .map((m) => ({ title: m.title, date: formatDate(m.createdAt!) }));

    // Schema changes related to this file
    const relatedSchemaChanges = memories
      .filter(
        (m) =>
          m.category === 'schema_change' &&
          (matchesFile(m.relatedFiles as string[] | null, file) ||
            m.title.toLowerCase().includes(fileBaseName(file)) ||
            m.body.toLowerCase().includes(fileBaseName(file))),
      )
      .map((m) => ({ title: m.title, date: formatDate(m.createdAt!) }));

    // Count how many times this file was modified recently
    const fileModCount = recentFileEvents.filter(
      (e) => e.filePath === file || e.filePath.endsWith(`/${file}`) || file.endsWith(`/${e.filePath}`),
    ).length;

    // Calculate risk level
    const bugCount = recentBugs.length;
    let riskLevel: 'high' | 'medium' | 'low' = 'low';
    if (bugCount >= 3 || (bugCount >= 2 && fileModCount >= 5)) {
      riskLevel = 'high';
    } else if (bugCount >= 1 || fileModCount >= 8) {
      riskLevel = 'medium';
    }

    // Only include files that have SOME brain data
    if (bugCount > 0 || relatedDecisions.length > 0 || relatedSchemaChanges.length > 0) {
      fileRisks.push({
        filename: file,
        riskLevel,
        bugCount,
        recentBugs,
        relatedDecisions,
        relatedSchemaChanges,
      });
    }
  }

  // Sort by risk level (high first)
  const riskOrder = { high: 0, medium: 1, low: 2 };
  fileRisks.sort((a, b) => riskOrder[a.riskLevel] - riskOrder[b.riskLevel]);

  // Generate warnings
  const warnings: string[] = [];
  const highRiskFiles = fileRisks.filter((f) => f.riskLevel === 'high');
  const totalBugs = fileRisks.reduce((sum, f) => sum + f.bugCount, 0);
  const totalDecisions = fileRisks.reduce((sum, f) => sum + f.relatedDecisions.length, 0);

  if (highRiskFiles.length > 0) {
    warnings.push(`${highRiskFiles.length} high-risk file${highRiskFiles.length > 1 ? 's' : ''} detected — these files have had multiple recent bugs`);
  }
  if (totalDecisions > 0) {
    warnings.push(`${totalDecisions} architecture decision${totalDecisions > 1 ? 's' : ''} may be affected by this change`);
  }

  // Overall risk
  let overallRisk: 'high' | 'medium' | 'low' = 'low';
  if (highRiskFiles.length > 0 || totalBugs >= 5) {
    overallRisk = 'high';
  } else if (fileRisks.some((f) => f.riskLevel === 'medium') || totalBugs >= 2) {
    overallRisk = 'medium';
  }

  return {
    overallRisk,
    fileRisks,
    warnings,
    totalBugsInChangedFiles: totalBugs,
    totalDecisionsAffected: totalDecisions,
    hasHighRiskFiles: highRiskFiles.length > 0,
  };
}

// ── Format PR Comment ───────────────────────────────────────────────────────

/**
 * Format the analysis into a GitHub PR comment body (markdown).
 */
export function formatPRComment(analysis: PRAnalysis, prTitle: string): string {
  const riskEmoji = { high: '🔴', medium: '🟡', low: '🟢' };
  const riskLabel = { high: 'High Risk', medium: 'Medium Risk', low: 'Low Risk' };

  let comment = `## 🧠 Project Brain Analysis\n\n`;
  comment += `**Overall Risk: ${riskEmoji[analysis.overallRisk]} ${riskLabel[analysis.overallRisk]}**\n\n`;

  // Warnings
  if (analysis.warnings.length > 0) {
    for (const w of analysis.warnings) {
      comment += `> ⚠️ ${w}\n`;
    }
    comment += '\n';
  }

  // File risks
  if (analysis.fileRisks.length > 0) {
    comment += `### File Analysis\n\n`;

    for (const file of analysis.fileRisks) {
      comment += `#### ${riskEmoji[file.riskLevel]} \`${file.filename}\`\n`;

      if (file.bugCount > 0) {
        comment += `- **${file.bugCount} bug${file.bugCount > 1 ? 's' : ''} fixed** in the last 30 days:\n`;
        for (const bug of file.recentBugs.slice(0, 3)) {
          comment += `  - ${bug.title} *(${bug.date})*\n`;
        }
        if (file.recentBugs.length > 3) {
          comment += `  - *...and ${file.recentBugs.length - 3} more*\n`;
        }
      }

      if (file.relatedDecisions.length > 0) {
        comment += `- **Related decisions:**\n`;
        for (const d of file.relatedDecisions.slice(0, 3)) {
          comment += `  - ${d.title} *(${d.date})*\n`;
        }
      }

      if (file.relatedSchemaChanges.length > 0) {
        comment += `- **Schema changes:**\n`;
        for (const s of file.relatedSchemaChanges.slice(0, 3)) {
          comment += `  - ${s.title} *(${s.date})*\n`;
        }
      }

      comment += '\n';
    }
  } else {
    comment += `No risk signals found for the changed files. The brain has no bug history, decisions, or schema changes related to these files.\n\n`;
  }

  // Summary stats
  comment += `---\n`;
  comment += `*${analysis.totalBugsInChangedFiles} recent bugs · ${analysis.totalDecisionsAffected} related decisions · ${analysis.fileRisks.length} files analyzed*\n\n`;
  comment += `*Powered by [Project Brain](https://awx-shredder.fly.dev) — intelligence for AI-powered development*`;

  return comment;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function matchesFile(relatedFiles: string[] | null, target: string): boolean {
  if (!relatedFiles || relatedFiles.length === 0) return false;
  const targetBase = fileBaseName(target);
  return relatedFiles.some(
    (f) => f === target || f.endsWith(`/${target}`) || target.endsWith(`/${f}`) || fileBaseName(f) === targetBase,
  );
}

function fileBaseName(path: string): string {
  return path.split('/').pop()?.toLowerCase() ?? path.toLowerCase();
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
