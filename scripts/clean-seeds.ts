/**
 * Remove all seeded/simulated data — keep only organic data.
 * Seeded entries have no sessionId (organic file watcher entries do).
 */

import { db } from '../src/db/client.js';
import { fileEvents, memoryEntries } from '../src/db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';

const PROJECT_ID = 'proj_d64bb72433a3e44c';

async function clean() {
  // Delete seeded file_events (ones without a sessionId)
  const deletedFE = await db.delete(fileEvents).where(
    and(eq(fileEvents.projectId, PROJECT_ID), isNull(fileEvents.sessionId)),
  ).returning({ id: fileEvents.id });

  // Delete seeded memory_entries (ones without a sessionId)
  const deletedME = await db.delete(memoryEntries).where(
    and(eq(memoryEntries.projectId, PROJECT_ID), isNull(memoryEntries.sessionId)),
  ).returning({ id: memoryEntries.id });

  console.log(`Deleted ${deletedFE.length} seeded file events`);
  console.log(`Deleted ${deletedME.length} seeded memory entries`);

  // Check what remains
  const remainingFE = await db.select({ id: fileEvents.id }).from(fileEvents).where(eq(fileEvents.projectId, PROJECT_ID));
  const remainingME = await db.select({ id: memoryEntries.id }).from(memoryEntries).where(eq(memoryEntries.projectId, PROJECT_ID));
  console.log(`Remaining: ${remainingFE.length} file events, ${remainingME.length} memories`);
  process.exit(0);
}

clean().catch((err) => {
  console.error('Clean failed:', err);
  process.exit(1);
});
