/**
 * Health Score API — cockpit fuel gauge endpoint.
 *
 * GET /sync/health/:projectId
 *   Returns green/amber/red status + five signal breakdown.
 *   Used by the dashboard and the MCP resource for in-chat alerts.
 *
 * GET /sync/health/:projectId/terrain/:filePath
 *   Returns risk data for a specific file being touched.
 *   Used by the MCP resource for terrain warnings.
 */

import { Hono } from 'hono';
import { calculateHealthScore } from '../lib/health-score.js';
import { analyzePR } from '../lib/pr-analysis.js';
import type { AppEnv } from '../types.js';

export const healthRouter = new Hono<AppEnv>();

// ── Health score ────────────────────────────────────────────────────────────

healthRouter.get('/health/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const windowStr = c.req.query('window');
  const windowMinutes = windowStr ? parseInt(windowStr, 10) : 120;

  try {
    const score = await calculateHealthScore(projectId, windowMinutes);
    return c.json(score);
  } catch (err) {
    console.error('[health] Score calculation failed:', (err as Error).message);
    return c.json({ error: 'health_score_failed', message: (err as Error).message }, 500);
  }
});

// ── Terrain warning ─────────────────────────────────────────────────────────

healthRouter.get('/health/:projectId/terrain', async (c) => {
  const projectId = c.req.param('projectId');
  const filePath = c.req.query('file');

  if (!filePath) {
    return c.json({ error: 'missing_file_param' }, 400);
  }

  try {
    // Reuse the PR analysis engine — it already scores file risk
    const analysis = await analyzePR(projectId, [filePath]);

    const fileRisk = analysis.fileRisks[0];
    if (!fileRisk) {
      return c.json({
        file: filePath,
        risk: 'none',
        message: 'No brain signals for this file',
        bugs: [],
        decisions: [],
        schemaChanges: [],
      });
    }

    return c.json({
      file: filePath,
      risk: fileRisk.riskLevel,
      message: buildTerrainMessage(fileRisk),
      bugs: fileRisk.recentBugs,
      decisions: fileRisk.relatedDecisions,
      schemaChanges: fileRisk.relatedSchemaChanges,
    });
  } catch (err) {
    console.error('[health] Terrain check failed:', (err as Error).message);
    return c.json({ error: 'terrain_check_failed', message: (err as Error).message }, 500);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildTerrainMessage(fileRisk: {
  filename: string;
  riskLevel: string;
  bugCount: number;
  relatedDecisions: Array<{ title: string }>;
  relatedSchemaChanges: Array<{ title: string }>;
}): string {
  const parts: string[] = [];

  if (fileRisk.bugCount > 0) {
    parts.push(`${fileRisk.bugCount} bug${fileRisk.bugCount > 1 ? 's' : ''} in the last 30 days`);
  }
  if (fileRisk.relatedDecisions.length > 0) {
    parts.push(`${fileRisk.relatedDecisions.length} active decision${fileRisk.relatedDecisions.length > 1 ? 's' : ''}`);
  }
  if (fileRisk.relatedSchemaChanges.length > 0) {
    parts.push(`${fileRisk.relatedSchemaChanges.length} recent schema change${fileRisk.relatedSchemaChanges.length > 1 ? 's' : ''}`);
  }

  if (parts.length === 0) return 'No brain signals for this file';

  const riskLabel = fileRisk.riskLevel === 'high' ? 'High-risk file' : fileRisk.riskLevel === 'medium' ? 'Caution' : 'Low risk';
  return `${riskLabel} — ${parts.join(', ')}`;
}
