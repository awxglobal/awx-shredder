import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { finalizeUsage, reserveBudget } from '../lib/budget.js';
import { emitActivity } from '../lib/events.js';
import { fireBudgetAlerts } from '../lib/slack.js';

// ----- Validation schemas -----

const createUsageBody = z.object({
  agent_id: z.string().min(1),
  estimated_cost: z.number().nonnegative(),
  model: z.string().optional(),
  tokens: z.number().int().nonnegative().optional(),
  request_id: z.string().optional(),
});

const finalizeBody = z.object({
  actual_cost: z.number().nonnegative(),
});

const idParam = z.object({
  id: z.string().uuid(),
});

// ----- Router -----

export const usageRouter = new Hono();

/**
 * POST /usage
 * Reserve budget for an upcoming upstream call.
 * - 200 { usage_log_id } if approved.
 * - 402 { budget_exceeded } if the call would breach daily_budget.
 * - Denied attempts are still persisted (status='denied') for audit + dashboard KPI.
 * - Fires Slack alerts when spent_today crosses 50 / 80 / 100% for the first time today.
 */
usageRouter.post('/', zValidator('json', createUsageBody), async (c) => {
  const body = c.req.valid('json');

  const metadata: Record<string, unknown> = {};
  if (body.model !== undefined) metadata.model = body.model;
  if (body.tokens !== undefined) metadata.tokens = body.tokens;
  if (body.request_id !== undefined) metadata.request_id = body.request_id;

  try {
    const outcome = await reserveBudget({
      agentId: body.agent_id,
      estimatedCost: body.estimated_cost,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    });

    if (outcome.kind === 'not_found') {
      return c.json({ error: 'agent_not_found', agent_id: body.agent_id }, 404);
    }

    if (outcome.kind === 'denied') {
      void fireBudgetAlerts({
        agentId: outcome.agentId,
        thresholds: outcome.newlyBreachedThresholds,
        spentToday: outcome.spentToday,
        dailyBudget: outcome.dailyBudget,
      });

      emitActivity({
        usage_log_id: outcome.usageLogId,
        agent_id: outcome.agentId,
        agent_name: outcome.agentId,
        cost: outcome.attemptedCost,
        status: 'denied',
        model: body.model ?? null,
        timestamp: new Date().toISOString(),
      });

      return c.json(
        {
          error: 'budget_exceeded',
          message: 'Estimated cost would exceed daily budget',
          daily_budget: outcome.dailyBudget,
          spent_today: outcome.spentToday,
          attempted_cost: outcome.attemptedCost,
          usage_log_id: outcome.usageLogId,
        },
        402,
      );
    }

    void fireBudgetAlerts({
      agentId: outcome.agentId,
      thresholds: outcome.newlyBreachedThresholds,
      spentToday: outcome.spentToday,
      dailyBudget: outcome.dailyBudget,
    });

    emitActivity({
      usage_log_id: outcome.usageLogId,
      agent_id: outcome.agentId,
      agent_name: outcome.agentId,
      cost: body.estimated_cost,
      status: 'approved',
      model: body.model ?? null,
      timestamp: new Date().toISOString(),
    });

    return c.json({
      usage_log_id: outcome.usageLogId,
      status: 'approved',
      daily_budget: outcome.dailyBudget,
      spent_today: outcome.spentToday,
    });
  } catch (err) {
    return c.json(
      { error: 'internal_error', message: (err as Error).message },
      500,
    );
  }
});

/**
 * POST /usage/:id/finalize
 * Settle an approved usage_log with the upstream's actual_cost.
 * - Updates actual_cost, flips status to 'completed'.
 * - Adjusts agent.spent_today by (actual_cost − estimated_cost).
 */
usageRouter.post(
  '/:id/finalize',
  zValidator('param', idParam),
  zValidator('json', finalizeBody),
  async (c) => {
    const { id } = c.req.valid('param');
    const { actual_cost } = c.req.valid('json');

    try {
      const outcome = await finalizeUsage({ logId: id, actualCost: actual_cost });

      if (outcome.kind === 'not_found') {
        return c.json({ error: 'usage_log_not_found', id }, 404);
      }
      if (outcome.kind === 'wrong_status') {
        return c.json(
          {
            error: 'cannot_finalize',
            message: `Usage log status is "${outcome.status}", expected "approved"`,
          },
          409,
        );
      }

      return c.json({
        usage_log_id: outcome.usageLogId,
        status: 'completed',
        estimated_cost: outcome.estimatedCost,
        actual_cost: outcome.actualCost,
        drift: outcome.drift,
      });
    } catch (err) {
      return c.json(
        { error: 'internal_error', message: (err as Error).message },
        500,
      );
    }
  },
);
