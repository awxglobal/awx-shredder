import { db } from '../src/db/client.js';
import { sql } from 'drizzle-orm';

// Add email column to organizations if it doesn't exist
await db.execute(sql`
  ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS email text;
`);

console.log('✅ email column added to organizations');
process.exit(0);
