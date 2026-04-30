import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agents, organizations } from '../db/schema.js';
import { requireApiKey } from '../middleware/requireApiKey.js';
import { finalizeUsage, reserveBudget } from '../lib/budget.js';
import { emitActivity } from '../lib/events.js';
import {
  computeActualCost,
  estimateCost,
  estimateInputTokens,
} from '../lib/pricing.js';
import { fireBudgetAlerts } from '../lib/slack.js';
import type { AppEnv } from '../types.js';

const OPENAI_API_BASE = 'https://api.openai.com';

// ── Validation ──────────────────────────────────────────────────────────────

const proxyHeaders = z.object({
  'x-agent-id': z.string().min(1),
});

/**
 * Minimal Zod shape for an OpenAI chat completions request.
 * .passthrough() ensures every other OpenAI parameter is forwarded verbatim.
 */
const chatCompletionsBody = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(
        z.object({
          role: z.string(),
          content: z.union([z.string(), z.array(z.unknown())]),
        }),
      )
      .min(1),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .passthrough();

// ── OpenAI usage shape (non-streaming response) ──────────────────────────────

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ── Router ───────────────────────────────────────────────────────────────────

export const proxyRouter = new Hono<AppEnv>();

/**
 * POST /proxy/openai/v1/chat/completions
 *
 * Transparent budget-enforcing proxy for OpenAI chat completions.
 * Drop-in replacement: point your base URL here instead of api.openai.com.
 *
 * Required headers:
 *   Authorization  — Bearer awx_live_<api-key>
 *   x-agent-id     — ID of the agent making the call (must belong to the key's org)
 *
 * The x-org-id header is no longer needed — the org is identified by the API key.
 *
 * Flow:
 *  1. requireApiKey validates the bearer token → sets orgId in context
 *  2. Verify agent exists AND belongs to the authenticated org
 *  3. Estimate input token count → pre-flight budget check
 *  4. If denied → 402, call never reaches OpenAI
 *  5. If approved → forward to OpenAI (streaming or non-streaming)
 *  6. On response → finalize with actual token cost from OpenAI usage object
 */
proxyRouter.post(
  '/openai/v1/chat/completions',
  requireApiKey,
  zValidator('header', proxyHeaders),
  zValidator('json', chatCompletionsBody),
  async (c) => {
    const orgId = c.get('orgId');
    const { 'x-agent-id': agentId } = c.req.valid('header');
    const body = c.req.valid('json');
    const { model, messages, stream: isStreaming = false } = body;

    // ── 1. Verify agent belongs to the authenticated org ───────────────────

    const [agentRow] = await db
      .select({ openaiApiKey: organizations.openaiApiKey })
      .from(agents)
      .innerJoin(organizations, eq(agents.orgId, organizations.id))
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));

    if (!agentRow) {
      return c.json(
        {
          error: 'agent_not_found',
          message: `Agent "${agentId}" not found or does not belong to your organisation.`,
        },
        404,
      );
    }

    // ── 2. Resolve OpenAI API key (per-org key > env fallback) ────────────

    const apiKey = agentRow.openaiApiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return c.json(
        {
          error: 'no_api_key',
          message:
            'No OpenAI API key configured. Set openai_api_key on the organisation ' +
            'or set the OPENAI_API_KEY environment variable.',
        },
        503,
      );
    }

    // ── 3. Estimate cost & pre-flight budget check ─────────────────────────

    const inputTokens = estimateInputTokens(
      messages as Array<{ role: string; content: unknown }>,
    );
    const estimatedCost = estimateCost(model, inputTokens);

    const reservation = await reserveBudget({
      agentId,
      estimatedCost,
      metadata: { model, estimated_input_tokens: inputTokens, proxied: true },
    });

    if (reservation.kind === 'not_found') {
      return c.json({ error: 'agent_not_found', agent_id: agentId }, 404);
    }

    if (reservation.kind === 'denied') {
      void fireBudgetAlerts({
        agentId: reservation.agentId,
        thresholds: reservation.newlyBreachedThresholds,
        spentToday: reservation.spentToday,
        dailyBudget: reservation.dailyBudget,
      });

      emitActivity({
        usage_log_id: reservation.usageLogId,
        agent_id: agentId,
        agent_name: agentId,
        cost: reservation.attemptedCost,
        status: 'denied',
        model,
        timestamp: new Date().toISOString(),
      });

      return c.json(
        {
          error: 'budget_exceeded',
          message: 'Estimated cost would exceed the agent daily budget',
          daily_budget: reservation.dailyBudget,
          spent_today: reservation.spentToday,
          attempted_cost: reservation.attemptedCost,
          usage_log_id: reservation.usageLogId,
        },
        402,
      );
    }

    void fireBudgetAlerts({
      agentId: reservation.agentId,
      thresholds: reservation.newlyBreachedThresholds,
      spentToday: reservation.spentToday,
      dailyBudget: reservation.dailyBudget,
    });

    emitActivity({
      usage_log_id: reservation.usageLogId,
      agent_id: agentId,
      agent_name: agentId,
      cost: estimatedCost,
      status: 'approved',
      model,
      timestamp: new Date().toISOString(),
    });

    const usageLogId = reservation.usageLogId;

    // ── 4. Forward to OpenAI ──────────────────────────────────────────────

    // When streaming, inject stream_options so OpenAI includes usage in final chunk
    const forwardBody = isStreaming
      ? { ...body, stream: true, stream_options: { include_usage: true } }
      : body;

    const openaiResp = await fetch(`${OPENAI_API_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(forwardBody),
    });

    // ── 4a. Non-streaming path ────────────────────────────────────────────

    if (!isStreaming) {
      const data = (await openaiResp.json()) as {
        usage?: OpenAIUsage;
        error?: unknown;
      };

      if (!openaiResp.ok) {
        void finalizeUsage({ logId: usageLogId, actualCost: estimatedCost });
        return c.json(data, openaiResp.status as 400 | 401 | 429 | 500);
      }

      const actualCost = data.usage
        ? computeActualCost(
            model,
            data.usage.prompt_tokens,
            data.usage.completion_tokens,
          )
        : estimatedCost;

      void finalizeUsage({ logId: usageLogId, actualCost });
      return c.json(data);
    }

    // ── 4b. Streaming path ────────────────────────────────────────────────

    if (!openaiResp.ok || !openaiResp.body) {
      const errData = await openaiResp.json().catch(() => ({}));
      void finalizeUsage({ logId: usageLogId, actualCost: estimatedCost });
      return c.json(errData, openaiResp.status as 400 | 401 | 429 | 500);
    }

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    c.header('X-Usage-Log-Id', usageLogId);

    return stream(c, async (s) => {
      const reader = openaiResp.body!.getReader();
      const decoder = new TextDecoder();
      let textBuffer = '';
      let lastUsage: OpenAIUsage | null = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          await s.write(value);

          textBuffer += decoder.decode(value, { stream: true });
          const lines = textBuffer.split('\n');
          textBuffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            try {
              const parsed = JSON.parse(line.slice(6)) as { usage?: OpenAIUsage };
              if (parsed.usage) lastUsage = parsed.usage;
            } catch {
              // Malformed chunk — skip
            }
          }
        }
      } finally {
        reader.releaseLock();

        const actualCost = lastUsage
          ? computeActualCost(
              model,
              lastUsage.prompt_tokens,
              lastUsage.completion_tokens,
            )
          : estimatedCost;

        void finalizeUsage({ logId: usageLogId, actualCost });
      }
    });
  },
);
