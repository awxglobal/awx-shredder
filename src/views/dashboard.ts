import { desc, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agents, usageLogs } from '../db/schema.js';

export interface FleetEntry {
  id: string;
  status: string;
}

export interface TelemetryEntry {
  timestamp: string;
  status: string;
  agentId: string;
  actualCost: number;
}

export interface DashboardSnapshot {
  spendToday: number;
  dailyBudget: number;
  spendPct: number;
  activeAgents: number;
  blockedRequests: number;
  fleet: FleetEntry[];
  telemetry: TelemetryEntry[];
}

const fmtCurrency = (n: number) =>
  '$' +
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtSignedCost = (n: number) => {
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (n >= 0 ? '-$' : '+$') + abs;
};

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fleetStyle = (status: string) => {
  const s = status.toUpperCase();
  if (s === 'ACTIVE')
    return {
      dot: 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.6)]',
      label: 'text-on-surface-variant',
    };
  if (s === 'THROTTLED')
    return {
      dot: 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)] animate-pulse',
      label: 'text-amber-400/80',
    };
  if (s === 'BLOCKED')
    return {
      dot: 'bg-error shadow-[0_0_8px_rgba(255,180,171,0.6)]',
      label: 'text-error',
    };
  return {
    dot: 'bg-outline',
    label: 'text-on-surface-variant',
  };
};

const telemetryStyle = (status: string) => {
  const s = status.toUpperCase();
  if (s === 'OK' || s === 'COMPLETED')
    return { tag: 'OK', tagClass: 'text-secondary' };
  if (s === 'BLOCKED' || s === 'WARN' || s === 'POLICY_VIOLATION')
    return { tag: 'WARN', tagClass: 'text-error' };
  if (s === 'REQ' || s === 'STARTED' || s === 'RUNNING')
    return { tag: 'REQ', tagClass: 'text-primary' };
  return { tag: s, tagClass: 'text-outline' };
};

export function renderFleet(fleet: FleetEntry[]): string {
  if (fleet.length === 0) {
    return `<li class="font-body-sm text-on-surface-variant italic px-2 py-3">No agents registered.</li>`;
  }
  return fleet
    .map((a) => {
      const style = fleetStyle(a.status);
      return `<li class="flex items-center justify-between p-2 rounded bg-surface-container-high/50 border border-white/5 hover:border-white/10 transition-colors cursor-pointer" data-agent-id="${escapeHtml(a.id)}">
<div class="flex items-center gap-3">
<div class="w-2 h-2 rounded-full ${style.dot}"></div>
<span class="font-mono-data text-mono-data text-on-surface">${escapeHtml(a.id)}</span>
</div>
<span class="font-label-caps text-label-caps ${style.label}">${escapeHtml(a.status.toUpperCase())}</span>
</li>`;
    })
    .join('');
}

export function renderTelemetry(rows: TelemetryEntry[]): string {
  if (rows.length === 0) {
    return `<div class="font-body-sm text-on-surface-variant italic">No telemetry yet.</div>`;
  }
  const opacities = ['opacity-100', 'opacity-90', 'opacity-80', 'opacity-70', 'opacity-50', 'opacity-40'];
  return rows
    .slice(0, opacities.length)
    .map((row, i) => {
      const style = telemetryStyle(row.status);
      const cost =
        row.actualCost && row.actualCost !== 0
          ? `<span class="text-primary ml-auto">${fmtSignedCost(row.actualCost)}</span>`
          : '';
      return `<div class="flex gap-2 ${opacities[i]}">
<span class="text-outline">${escapeHtml(fmtTime(row.timestamp))}</span>
<span class="${style.tagClass}">[${escapeHtml(style.tag)}]</span>
<span class="truncate">${escapeHtml(row.agentId)} ${escapeHtml(row.status.toLowerCase())}.</span>
${cost}
</div>`;
    })
    .join('');
}

export async function getSnapshot(): Promise<DashboardSnapshot> {
  const [{ spend = 0, budget = 0 } = {}] = await db
    .select({
      spend: sql<number>`coalesce(sum(${agents.spentToday}), 0)::float8`,
      budget: sql<number>`coalesce(sum(${agents.dailyBudget}), 0)::float8`,
    })
    .from(agents);

  const [{ active = 0 } = {}] = await db
    .select({
      active: sql<number>`count(*)::int`,
    })
    .from(agents)
    .where(sql`upper(${agents.status}) = 'ACTIVE'`);

  const [{ blocked = 0 } = {}] = await db
    .select({
      blocked: sql<number>`count(*)::int`,
    })
    .from(usageLogs)
    .where(
      sql`upper(${usageLogs.status}) in ('BLOCKED', 'POLICY_VIOLATION', 'DENIED')
        and ${usageLogs.timestamp} >= now() - interval '24 hours'`,
    );

  const fleet = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .limit(8);

  const telemetryRows = await db
    .select({
      timestamp: usageLogs.timestamp,
      status: usageLogs.status,
      agentId: usageLogs.agentId,
      actualCost: usageLogs.actualCost,
    })
    .from(usageLogs)
    .orderBy(desc(usageLogs.timestamp))
    .limit(8);

  const telemetry: TelemetryEntry[] = telemetryRows.map((r) => ({
    timestamp:
      r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
    status: r.status,
    agentId: r.agentId,
    actualCost: Number(r.actualCost ?? 0),
  }));

  const spendNum = Number(spend);
  const budgetNum = Number(budget);
  const pct = budgetNum > 0 ? Math.min(100, Math.round((spendNum / budgetNum) * 100)) : 0;

  return {
    spendToday: spendNum,
    dailyBudget: budgetNum,
    spendPct: pct,
    activeAgents: Number(active),
    blockedRequests: Number(blocked),
    fleet,
    telemetry,
  };
}

export function snapshotForWire(snap: DashboardSnapshot) {
  return {
    spendToday: snap.spendToday,
    spendTodayLabel: fmtCurrency(snap.spendToday),
    dailyBudget: snap.dailyBudget,
    dailyBudgetLabel: fmtCurrency(snap.dailyBudget),
    spendPct: snap.spendPct,
    activeAgents: snap.activeAgents,
    blockedRequests: snap.blockedRequests,
    fleetHtml: renderFleet(snap.fleet),
    telemetryHtml: renderTelemetry(snap.telemetry),
  };
}
