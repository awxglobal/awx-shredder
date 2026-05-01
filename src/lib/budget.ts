import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, usageLogs } from '../db/schema.js';
import {
  type AlertsFired,
  type BudgetThreshold,
  DEFAULT_ALERTS_FIRED,
  getNewlyBreachedThresholds,
  markThresholdsFired,
} from './slack.js';

// ---- Types ----

export type ReserveResult =
  | {
      kind: 'approved';
      usageLogId: string;
      dailyBudget: number;
      spentToday: number;
      agentId: string;
      /** Thresholds that just crossed for the first time — caller fires Slack. */
      newlyBreachedThresholds: BudgetThreshold[];
    }
  | {
      kind: 'denied';
      dailyBudget: number;
      spentToday: number;
      attemptedCost: number;
      usageLogId: string;
      agentId: string;
      /**
       * Will contain [100] the first time a denial fires while the agent is
       * already >= 50 % through its budget — i.e. "budget exhausted" signal.
       * Empty on all subsequent denials (dedup via alertsFired).
       */
      newlyBreachedThresholds: BudgetThreshold[];
    }
  | { kind: 'not_found' };

export type FinalizeResult =
  | {
      kind: 'finalized';
      usageLogId: string;
      estimatedCost: number;
      actualCost: number;
      drift: number;
    }
  | { kind: 'not_found' }
  | { kind: 'wrong_status'; status: string };

// ---- Helpers ----

const isDifferentUtcDay = (a: Date, b: Date): boolean =>
  a.getUTCFullYear() !== b.getUTCFullYear() ||
  a.getUTCMonth() !== b.getUTCMonth() ||
  a.getUTCDate() !== b.getUTCDate();

// ---- Core functions ----

/**
 * Reserve budget for an upcoming call.
 * All logic runs inside a single DB transaction with a row-level lock on the agent.
 *
 * Side-effects inside the transaction:
 *  - Day rollover: zeroes spent_today + alerts_fired if last_reset_at is a prior UTC day.
 *  - Approved: increments spent_today, updates alerts_fired for newly breached thresholds,
 *    inserts a usage_log row with status='approved'.
 *  - Denied:  inserts a usage_log row with status='denied' (audit trail).
 *
 * Slack alerts are NOT fired here — the caller receives newlyBreachedThresholds
 * and fires them post-commit so a Slack failure never rolls back the transaction.
 */
export async function reserveBudget(params: {
  agentId: string;
  estimatedCost: number;
  metadata?: Record<string, unknown> | null;
}): Promise<ReserveResult> {
  const { agentId, estimatedCost, metadata = null } = params;
  const now = new Date();

  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('update');

    if (!agent) return { kind: 'not_found' };

    const lastReset =
      agent.lastResetAt instanceof Date
        ? agent.lastResetAt
        : new Date(agent.lastResetAt as unknown as string);

    let spentToday = agent.spentToday;
    let currentAlertsFired: AlertsFired =
      (agent.alertsFired as AlertsFired | null) ?? { ...DEFAULT_ALERTS_FIRED };

    // Day rollover — reset spend, alerts, and status back to ACTIVE
    if (isDifferentUtcDay(lastReset, now)) {
      spentToday = 0;
      currentAlertsFired = { ...DEFAULT_ALERTS_FIRED };
      await tx
        .update(agents)
        .set({
          spentToday: 0,
          lastResetAt: now,
          alertsFired: currentAlertsFired,
          status: 'ACTIVE',
        })
        .where(eq(agents.id, agent.id));
    }

    const projected = spentToday + estimatedCost;

    // Over budget — log denied, return 402 data
    if (projected > agent.dailyBudget) {
      // Fire the 100 % alert on the first denial once the agent is ≥ 50 % spent.
      // This is the "budget exhausted" signal: further calls will keep being blocked,
      // so we only need to alert once, not on every subsequent denial.
      const usedPct =
        agent.dailyBudget > 0 ? (spentToday / agent.dailyBudget) * 100 : 100;
      const fire100 =
        usedPct >= 50 && !currentAlertsFired['100'] as boolean;

      if (fire100) {
        const updated = markThresholdsFired(currentAlertsFired, [100]);
        currentAlertsFired = updated;
        await tx
          .update(agents)
          .set({ alertsFired: updated })
          .where(eq(agents.id, agent.id));
      }

      // Mark agent as BLOCKED so the dashboard reflects reality
      await tx
        .update(agents)
        .set({ status: 'BLOCKED' })
        .where(eq(agents.id, agent.id));

      const [denied] = await tx
        .insert(usageLogs)
        .values({
          agentId: agent.id,
          estimatedCost,
          actualCost: 0,
          status: 'denied',
          metadata,
        })
        .returning({ id: usageLogs.id });

      return {
        kind: 'denied',
        agentId: agent.id,
        dailyBudget: agent.dailyBudget,
        spentToday,
        attemptedCost: estimatedCost,
        usageLogId: denied.id,
        newlyBreachedThresholds: fire100 ? [100 as BudgetThreshold] : [],
      };
    }

    // Approved — increment spent, track alert thresholds, insert log
    const spentPct =
      agent.dailyBudget > 0
        ? Math.min(100, (projected / agent.dailyBudget) * 100)
        : 100;

    const newlyBreached = getNewlyBreachedThresholds(spentPct, currentAlertsFired);
    const updatedAlerts =
      newlyBreached.length > 0
        ? markThresholdsFired(currentAlertsFired, newlyBreached)
        : currentAlertsFired;

    await tx
      .update(agents)
      .set({
        spentToday: projected,
        ...(newlyBreached.length > 0 ? { alertsFired: updatedAlerts } : {}),
      })
      .where(eq(agents.id, agent.id));

    const [approved] = await tx
      .insert(usageLogs)
      .values({
        agentId: agent.id,
        estimatedCost,
        actualCost: 0,
        status: 'approved',
        metadata,
      })
      .returning({ id: usageLogs.id });

    return {
      kind: 'approved',
      usageLogId: approved.id,
      dailyBudget: agent.dailyBudget,
      spentToday: projected,
      agentId: agent.id,
      newlyBreachedThresholds: newlyBreached,
    };
  });
}

/**
 * Settle an approved usage log with the real cost from the upstream response.
 * Adjusts agent.spent_today by (actual_cost − estimated_cost) so the running
 * total reflects truth rather than pre-call estimates.
 */
export async function finalizeUsage(params: {
  logId: string;
  actualCost: number;
}): Promise<FinalizeResult> {
  const { logId, actualCost } = params;

  return db.transaction(async (tx) => {
    const [log] = await tx
      .select()
      .from(usageLogs)
      .where(eq(usageLogs.id, logId))
      .for('update');

    if (!log) return { kind: 'not_found' };
    if (log.status !== 'approved') {
      return { kind: 'wrong_status', status: log.status };
    }

    const drift = actualCost - log.estimatedCost;

    await tx
      .update(usageLogs)
      .set({ actualCost, status: 'completed' })
      .where(eq(usageLogs.id, logId));

    if (drift !== 0) {
      const [agent] = await tx
        .select()
        .from(agents)
        .where(eq(agents.id, log.agentId))
        .for('update');

      if (agent) {
        await tx
          .update(agents)
          .set({ spentToday: agent.spentToday + drift })
          .where(eq(agents.id, log.agentId));
      }
    }

    return {
      kind: 'finalized',
      usageLogId: logId,
      estimatedCost: log.estimatedCost,
      actualCost,
      drift,
    };
  });
}
