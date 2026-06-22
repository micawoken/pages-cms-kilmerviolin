import "server-only";

/**
 * Reads the worker's D1 `contributors` table directly via the Cloudflare D1 REST API and derives each
 * contributor's CMS-editor authorization. This is the read side of the reconcile cron
 * (app/api/cron/sync-cms-access); the worker push endpoint handles real-time changes.
 *
 * Auth is a Cloudflare API token; a token scoped to D1 read is sufficient (the query is a SELECT). See
 * docs/dev/pages-cms.md and the worker's wrangler.jsonc for the account/database identifiers.
 */

/**
 * Roles that grant CMS-editor access, mirroring the worker's cms_editor permission. Keep in sync with the
 * roles in the worker's src/lib/api/authorize.ts whose RoleProfile sets `cms_editor: true` (today only
 * `siteeditor`). The worker push path uses the live permission map; this list is the cron's static mirror.
 */
const CMS_EDITOR_ROLES = ["siteeditor"];

export type ContributorAuth = {
  /** lowercased identity email — the key shared with the Pages CMS collaborator table */
  email: string;
  /** whether this contributor should currently have CMS-editor access */
  authorized: boolean;
};

type D1Row = {
  identity_email?: unknown;
  roles?: unknown;
  active?: unknown;
  admin?: unknown;
};

const csvIncludesRole = (roles: unknown, target: string[]): boolean => {
  if (typeof roles !== "string") return false;
  const held = roles.split(",").map((r) => r.trim()).filter(Boolean);
  return held.some((r) => target.includes(r));
};

/**
 * Mirrors the worker's authorization rule: a contributor is a CMS editor when they are an administrator, or
 * they are active AND hold a role granting cms_editor. (active/admin are SQLite integers 0/1.)
 */
const isAuthorized = (row: D1Row): boolean => {
  if (row.admin === 1) return true;
  return row.active === 1 && csvIncludesRole(row.roles, CMS_EDITOR_ROLES);
};

/**
 * Fetches every contributor's email + authorization state from D1. Throws if the Cloudflare API is not
 * configured or the query fails.
 */
export const fetchContributorAuth = async (): Promise<ContributorAuth[]> => {
  const accountId = process.env.CF_ACCOUNT_ID;
  const databaseId = process.env.CF_D1_DATABASE_ID;
  const token = process.env.CF_D1_API_TOKEN;
  if (!accountId || !databaseId || !token) {
    throw new Error(
      "D1 reconcile is not configured (CF_ACCOUNT_ID / CF_D1_DATABASE_ID / CF_D1_API_TOKEN).",
    );
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sql: "SELECT identity_email, roles, active, admin FROM contributors",
      }),
    },
  );

  const json = (await response.json().catch(() => null)) as
    | { success?: boolean; result?: { results?: D1Row[] }[]; errors?: unknown }
    | null;

  if (!response.ok || !json?.success) {
    const detail = json?.errors ? JSON.stringify(json.errors) : `${response.status} ${response.statusText}`;
    throw new Error(`Cloudflare D1 query failed: ${detail}`);
  }

  const rows = json.result?.[0]?.results ?? [];
  return rows
    .filter((row): row is D1Row & { identity_email: string } => typeof row.identity_email === "string")
    .map((row) => ({
      email: row.identity_email.trim().toLowerCase(),
      authorized: isAuthorized(row),
    }));
};
