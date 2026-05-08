/**
 * GitHub App webhook receiver + installation callback.
 *
 * POST /webhooks/github        — receives webhook events, verifies signature, maps to memories
 * GET  /github/install/callback — handles post-install redirect, links installation to org
 */

import { eq, and } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.js';
import {
  githubInstallations,
  githubRepoLinks,
  memoryEntries,
  fileEvents,
  projects,
  organizations,
  githubAccounts,
} from '../db/schema.js';
import {
  verifyWebhookSignature,
  mapWebhookEvent,
  newInstallationId,
  newRepoLinkId,
} from '../lib/github.js';
import type { AppEnv } from '../types.js';

export const githubWebhookRouter = new Hono<AppEnv>();

// ── Webhook receiver ────────────────────────────────────────────────────────

/**
 * POST /webhooks/github
 * Receives all GitHub App webhook events.
 * Verifies HMAC-SHA256 signature, routes by event type, writes to DB.
 */
githubWebhookRouter.post('/webhooks/github', async (c) => {
  // Read raw body for signature verification
  const rawBody = await c.req.text();
  const signature = c.req.header('x-hub-signature-256');
  const eventType = c.req.header('x-github-event');
  const deliveryId = c.req.header('x-github-delivery');

  // Verify signature
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn(`[github-webhook] Invalid signature for delivery ${deliveryId}`);
    return c.json({ error: 'invalid_signature' }, 401);
  }

  // Parse payload
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  console.log(`[github-webhook] ${eventType}.${payload.action ?? ''} delivery=${deliveryId}`);

  // Handle installation events separately
  if (eventType === 'installation') {
    return handleInstallationEvent(c, payload);
  }

  // For all other events, find which project this belongs to
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) {
    return c.json({ ok: true, skipped: true, reason: 'no_repository' });
  }

  // Look up repo → project link
  const [repoLink] = await db
    .select({
      projectId: githubRepoLinks.projectId,
      installationId: githubRepoLinks.installationId,
    })
    .from(githubRepoLinks)
    .where(eq(githubRepoLinks.repoFullName, repoFullName))
    .limit(1);

  if (!repoLink) {
    // Repo not linked — try auto-linking by matching repo name to a project name
    const repoName = repoFullName.split('/').pop()?.toLowerCase();
    const installationIdStr = String(payload.installation?.id ?? '');

    if (repoName && installationIdStr) {
      // Find the installation record
      const [inst] = await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, installationIdStr));

      if (inst) {
        // Find a project in this org whose name contains the repo name
        const orgProjects = await db
          .select()
          .from(projects)
          .where(eq(projects.orgId, inst.orgId));

        const match = orgProjects.find((p) =>
          p.name.toLowerCase().includes(repoName) || repoName.includes(p.name.toLowerCase()),
        );

        if (match) {
          const linkId = newRepoLinkId();
          await db.insert(githubRepoLinks).values({
            id: linkId,
            installationId: inst.id,
            projectId: match.id,
            repoFullName,
            repoId: String(payload.repository?.id ?? ''),
          });
          console.log(`[github-webhook] Auto-linked repo ${repoFullName} → project ${match.id} (${match.name})`);

          // Now process this event with the new link
          const result = mapWebhookEvent(eventType ?? '', payload);
          if (result) {
            if (result.memories.length > 0) {
              await db.insert(memoryEntries).values(
                result.memories.map((m) => ({
                  projectId: match.id,
                  category: m.category,
                  title: m.title,
                  body: m.body,
                  relatedFiles: m.relatedFiles,
                  metadata: m.metadata,
                })),
              );
            }
            if (result.fileEvents.length > 0) {
              await db.insert(fileEvents).values(
                result.fileEvents.map((f) => ({
                  projectId: match.id,
                  filePath: f.filePath,
                  eventType: f.eventType,
                })),
              );
            }
            console.log(`[github-webhook] Wrote ${result.memories.length} memories + ${result.fileEvents.length} file events after auto-link`);
            return c.json({ ok: true, auto_linked: true, memories: result.memories.length, file_events: result.fileEvents.length });
          }
        }
      }
    }

    return c.json({ ok: true, skipped: true, reason: 'repo_not_linked' });
  }

  // Map the event to memories and file events
  const result = mapWebhookEvent(eventType ?? '', payload);
  if (!result) {
    return c.json({ ok: true, skipped: true, reason: 'unhandled_event' });
  }

  // Write memories
  if (result.memories.length > 0) {
    await db.insert(memoryEntries).values(
      result.memories.map((m) => ({
        projectId: repoLink.projectId,
        category: m.category,
        title: m.title,
        body: m.body,
        relatedFiles: m.relatedFiles,
        metadata: m.metadata,
      })),
    );
  }

  // Write file events
  if (result.fileEvents.length > 0) {
    await db.insert(fileEvents).values(
      result.fileEvents.map((f) => ({
        projectId: repoLink.projectId,
        filePath: f.filePath,
        eventType: f.eventType,
      })),
    );
  }

  const totalWritten = result.memories.length + result.fileEvents.length;
  console.log(`[github-webhook] Wrote ${result.memories.length} memories + ${result.fileEvents.length} file events for project ${repoLink.projectId}`);

  return c.json({ ok: true, memories: result.memories.length, file_events: result.fileEvents.length });
});

// ── Installation event handler ──────────────────────────────────────────────

async function handleInstallationEvent(c: any, payload: Record<string, any>) {
  const action = payload.action;
  const installation = payload.installation;

  if (!installation) {
    return c.json({ ok: true, skipped: true, reason: 'no_installation_data' });
  }

  if (action === 'created') {
    // New installation — store the GitHub data so the callback can link it to an org.
    // The callback may arrive before or after this webhook.
    const ghInstallationId = String(installation.id);
    const accountLogin = installation.account?.login ?? 'unknown';
    const accountType = installation.account?.type ?? 'User';
    const repos = payload.repositories?.map((r: any) => r.full_name) ?? null;

    // Check if the callback already created this record
    const [existing] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, ghInstallationId));

    if (existing) {
      // Callback got here first — update with full account info
      await db
        .update(githubInstallations)
        .set({ accountLogin, accountType, repos })
        .where(eq(githubInstallations.id, existing.id));
      console.log(`[github-webhook] Updated installation ${ghInstallationId} with account info: ${accountLogin}`);
    } else {
      // Webhook arrived first — store without org link (callback will add it)
      // We can't link to an org yet because we don't know which user installed it.
      // Store with a placeholder orgId that the callback will update.
      console.log(`[github-webhook] Installation ${ghInstallationId} by ${accountLogin} — waiting for callback to link org`);
    }

    return c.json({ ok: true, action: 'installation_created', account: accountLogin });
  }

  if (action === 'deleted') {
    // Installation removed — clean up
    const [existing] = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, String(installation.id)));

    if (existing) {
      // Cascade will remove repo links
      await db.delete(githubInstallations).where(eq(githubInstallations.id, existing.id));
      console.log(`[github-webhook] Removed installation ${installation.id}`);
    }

    return c.json({ ok: true, action: 'installation_deleted' });
  }

  return c.json({ ok: true, skipped: true, reason: `unhandled_installation_action_${action}` });
}

// ── Installation callback ───────────────────────────────────────────────────

/**
 * GET /github/install/callback
 * After user installs the GitHub App, GitHub redirects here.
 * Links the installation to the user's org.
 *
 * Query params from GitHub:
 *   installation_id — GitHub's installation ID
 *   setup_action    — "install" or "update"
 */
githubWebhookRouter.get('/github/install/callback', async (c) => {
  const installationId = c.req.query('installation_id');
  const setupAction = c.req.query('setup_action');

  if (!installationId) {
    return c.redirect('/app?error=missing_installation_id');
  }

  // Get the logged-in user's org from the awx_session JWT cookie
  const { getCookie } = await import('hono/cookie');
  const { verify } = await import('hono/jwt');

  const sessionToken = getCookie(c, 'awx_session');
  if (!sessionToken) {
    // Not logged in — redirect to login, then back here after
    const returnUrl = encodeURIComponent(`/github/install/callback?installation_id=${installationId}&setup_action=${setupAction ?? 'install'}`);
    return c.redirect(`/auth/github?redirect=${returnUrl}`);
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return c.redirect('/app?error=server_error');
  }

  let orgId: string | null = null;
  try {
    const payload = (await verify(sessionToken, secret, 'HS256')) as {
      org_id?: string;
    };
    orgId = payload?.org_id ?? null;
  } catch {
    // Expired or tampered token — redirect to login
    const returnUrl = encodeURIComponent(`/github/install/callback?installation_id=${installationId}&setup_action=${setupAction ?? 'install'}`);
    return c.redirect(`/auth/github?redirect=${returnUrl}`);
  }

  if (!orgId) {
    return c.redirect('/app?error=no_org');
  }

  // Check if this installation already exists
  const [existing] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId));

  if (existing) {
    // Already linked — update org if it wasn't set, then redirect
    if (existing.orgId !== orgId) {
      await db
        .update(githubInstallations)
        .set({ orgId })
        .where(eq(githubInstallations.id, existing.id));
      console.log(`[github] Linked existing installation ${installationId} to org ${orgId}`);
      await autoLinkRepos(existing.id, orgId);
    }
    return c.redirect('/app?github=connected');
  }

  // We need the account info — we'll get it from the GitHub API later.
  // For now, create the installation record with what we have.
  // The webhook 'installation.created' event has the full data,
  // but the callback might arrive before the webhook.
  const id = newInstallationId();

  await db.insert(githubInstallations).values({
    id,
    orgId,
    installationId,
    accountLogin: orgId, // placeholder — will be updated by webhook or API call
    accountType: 'User',
    repos: null, // null = all repos
  });

  console.log(`[github] Installation ${installationId} linked to org ${orgId}`);

  // Auto-link repos to projects if possible
  await autoLinkRepos(id, orgId);

  return c.redirect('/app?github=connected');
});

// ── Auto-link repos to projects ─────────────────────────────────────────────

/**
 * Try to match installed repos to existing projects by name.
 * For MVP, we create links for any project whose name matches a repo name.
 */
async function autoLinkRepos(installationId: string, orgId: string): Promise<void> {
  const orgProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.orgId, orgId));

  if (orgProjects.length === 0) return;

  // For now, we can't query GitHub's API without a token (future: use JWT + installation token).
  // The auto-linking will happen when the first webhook arrives with repository data,
  // or manually from the dashboard.
  console.log(`[github] Auto-link: ${orgProjects.length} projects found for org ${orgId}. Manual linking available in dashboard.`);
}

// ── Manual repo → project linking (called from dashboard) ───────────────────

/**
 * POST /github/link-repo
 * Manually link a GitHub repo to a project brain.
 * Body: { installation_id, project_id, repo_full_name, repo_id }
 */
githubWebhookRouter.post('/github/link-repo', async (c) => {
  const body = await c.req.json();
  const { installation_id, project_id, repo_full_name, repo_id } = body;

  if (!installation_id || !project_id || !repo_full_name) {
    return c.json({ error: 'missing_fields' }, 400);
  }

  // Verify the installation exists
  const [inst] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installation_id));

  if (!inst) {
    return c.json({ error: 'installation_not_found' }, 404);
  }

  // Verify the project exists and belongs to the same org
  const [proj] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, project_id), eq(projects.orgId, inst.orgId)));

  if (!proj) {
    return c.json({ error: 'project_not_found' }, 404);
  }

  // Check if already linked
  const [existingLink] = await db
    .select()
    .from(githubRepoLinks)
    .where(eq(githubRepoLinks.repoFullName, repo_full_name));

  if (existingLink) {
    return c.json({ error: 'repo_already_linked', existing_project_id: existingLink.projectId }, 409);
  }

  const id = newRepoLinkId();
  const [created] = await db
    .insert(githubRepoLinks)
    .values({
      id,
      installationId: installation_id,
      projectId: project_id,
      repoFullName: repo_full_name,
      repoId: String(repo_id ?? ''),
    })
    .returning();

  console.log(`[github] Linked repo ${repo_full_name} → project ${project_id}`);

  return c.json(created, 201);
});
