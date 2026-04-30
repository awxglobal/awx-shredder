/**
 * Shared Hono context types for AWX Shredder.
 *
 * Import AppEnv in every Hono router that needs to read/write context variables
 * set by the auth middleware (orgId, etc.).
 */

export type AppVariables = {
  /** ID of the authenticated organisation (set by requireApiKey / requireAuth). */
  orgId: string;
};

export type AppEnv = {
  Variables: AppVariables;
};
