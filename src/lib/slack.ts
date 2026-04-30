/**
 * Thin Slack webhook helper.
 * Set SLACK_WEBHOOK_URL in .env to enable alerts.
 * If the env var is missing, alerts are silently skipped (no crash).
 */

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

export const BUDGET_THRESHOLDS = [50, 80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];

export type AlertsFired = { '50': boolean; '80': boolean; '100': boolean };

export const DEFAULT_ALERTS_FIRED: AlertsFired = {
  '50': false,
  '80': false,
  '100': false,
};

/** Which thresholds are newly breached given the current spend percentage. */
export function getNewlyBreachedThresholds(
  spentPct: number,
  alertsFired: AlertsFired | Record<string, boolean> | null | undefined,
): BudgetThreshold[] {
  const fired = alertsFired ?? DEFAULT_ALERTS_FIRED;
  return BUDGET_THRESHOLDS.filter(
    (t) => spentPct >= t && !fired[String(t) as keyof typeof fired],
  );
}

/**
 * Build updated alertsFired after marking thresholds as fired.
 * Returns a new object — does not mutate the input.
 */
export function markThresholdsFired(
  current: AlertsFired | Record<string, boolean> | null | undefined,
  thresholds: BudgetThreshold[],
): AlertsFired {
  const base: AlertsFired = {
    '50': (current?.['50'] as boolean) ?? false,
    '80': (current?.['80'] as boolean) ?? false,
    '100': (current?.['100'] as boolean) ?? false,
  };
  for (const t of thresholds) {
    base[String(t) as keyof AlertsFired] = true;
  }
  return base;
}

/**
 * Send a Slack alert for a single threshold.
 * Fire-and-forget: logs errors but never throws.
 */
export async function sendBudgetAlert(params: {
  agentId: string;
  threshold: BudgetThreshold;
  spentToday: number;
  dailyBudget: number;
  spentPct: number;
}): Promise<void> {
  if (!WEBHOOK_URL) return;

  const { agentId, threshold, spentToday, dailyBudget, spentPct } = params;
  const emoji = threshold === 100 ? '🚨' : threshold === 80 ? '⚠️' : '📊';
  const label =
    threshold === 100 ? 'BUDGET EXHAUSTED' : `${threshold}% budget used`;

  const text =
    `${emoji} *[Agent Budget Alert] ${label}*\n` +
    `*Agent:* \`${agentId}\`\n` +
    `*Spent today:* $${spentToday.toFixed(4)} / $${dailyBudget.toFixed(2)} ` +
    `(${spentPct.toFixed(1)}%)\n` +
    `_Further calls will be blocked once 100% is reached._`;

  try {
    const resp = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) {
      console.error(`[slack] webhook returned ${resp.status}`);
    }
  } catch (err) {
    console.error('[slack] failed to send alert:', (err as Error).message);
  }
}

/**
 * Fire all newly breached threshold alerts in sequence.
 * Safe to call with an empty array (no-op).
 */
export async function fireBudgetAlerts(params: {
  agentId: string;
  thresholds: BudgetThreshold[];
  spentToday: number;
  dailyBudget: number;
}): Promise<void> {
  const { agentId, thresholds, spentToday, dailyBudget } = params;
  if (thresholds.length === 0) return;

  const spentPct = dailyBudget > 0
    ? Math.min(100, (spentToday / dailyBudget) * 100)
    : 100;

  for (const threshold of thresholds) {
    await sendBudgetAlert({ agentId, threshold, spentToday, dailyBudget, spentPct });
  }
}
