import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { db } from '../db/client.js';
import { waitlistEmails } from '../db/schema.js';

export const waitlistRouter = new Hono();

const joinSchema = z.object({
  email: z.string().email(),
  source: z.string().optional(),
});

// POST /waitlist/join — store an email address
waitlistRouter.post(
  '/join',
  zValidator('json', joinSchema),
  async (c) => {
    const { email, source } = c.req.valid('json');
    try {
      await db
        .insert(waitlistEmails)
        .values({ email: email.toLowerCase().trim(), source: source ?? 'landing' })
        .onConflictDoNothing();
      return c.json({ ok: true, message: "You're on the list!" });
    } catch (err) {
      return c.json({ ok: false, error: 'Failed to save email.' }, 500);
    }
  },
);
