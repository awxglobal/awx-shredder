import { eq, sql } from 'drizzle-orm';
import { db } from './db/client.js';
import { agents, usageLogs } from './db/schema.js';

let timer: NodeJS.Timeout | null = null;

const STATUS_DECK: string[] = [
  ...Array(68).fill('OK'),
  ...Array(18).fill('REQ'),
  ...Array(10).fill('BLOCKED'),
  ...Array(4).fill('WARN'),
];

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

async function tick() {
  try {
    const all = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents);
    if (all.length === 0) return;

    const status = pick(STATUS_DECK);
    let agent: { id: string; status: string };
    if (status === 'BLOCKED') {
      const blocked = all.filter((a) => a.status === 'BLOCKED');
      agent = blocked.length ? pick(blocked) : pick(all);
    } else if (status === 'WARN') {
      const throttled = all.filter((a) => a.status === 'THROTTLED');
      agent = throttled.length ? pick(throttled) : pick(all);
    } else {
      const active = all.filter((a) => a.status === 'ACTIVE');
      agent = active.length ? pick(active) : pick(all);
    }

    let cost = 0;
    if (status === 'OK') cost = Math.round((0.02 + Math.random() * 0.6) * 100) / 100;

    await db.insert(usageLogs).values({
      agentId: agent.id,
      estimatedCost: cost,
      actualCost: cost,
      status,
    });

    if (cost > 0) {
      await db
        .update(agents)
        .set({ spentToday: sql`${agents.spentToday} + ${cost}` })
        .where(eq(agents.id, agent.id));
    }
  } catch (err) {
    console.error('[tick] failed:', (err as Error).message);
  }
}

export function startTicker(intervalMs = 1500): void {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  console.log(`[tick] demo ticker running every ${intervalMs}ms`);
}

export function stopTicker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
