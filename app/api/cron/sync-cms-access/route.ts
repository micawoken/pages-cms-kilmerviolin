import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { collaboratorTable } from "@/db/schema";
import { toErrorResponse } from "@/lib/api-error";
import { assertCronSecret } from "@/lib/cron-auth";
import { resolveRepoAccessViaApp } from "@/lib/sync/repo-access-app";
import { addManagedCollaborator, removeManagedCollaborator } from "@/lib/sync/collaborator-sync";
import { fetchContributorAuth } from "@/lib/sync/d1-contributors";

/**
 * Reconcile cron: repairs drift between the worker's D1 authorization state and the Pages CMS collaborator
 * table (missed real-time pushes, direct DB edits). Reads contributors from D1 (Cloudflare REST API) and:
 *
 *   - ADDS a collaborator for every authorized contributor email missing a row;
 *   - REMOVES a collaborator whose email IS a contributor but is no longer authorized;
 *   - NEVER touches a collaborator whose email is NOT a contributor (hand-added collaborators are left alone
 *     — this is the agreed safety model that avoids a schema change to mark "managed" rows).
 *
 * Guarded by the Vercel cron convention (`Authorization: Bearer ${CRON_SECRET}`). The schedule lives in
 * vercel.json. See docs/dev/pages-cms.md.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_OWNER = "micawoken";
const DEFAULT_REPO = "entrusting-devilish-fish";

const reconcile = async (request: Request) => {
  try {
    assertCronSecret(request);

    const owner = process.env.SYNC_OWNER || DEFAULT_OWNER;
    const repo = process.env.SYNC_REPO || DEFAULT_REPO;

    const contributors = await fetchContributorAuth();
    const contributorEmails = new Set(contributors.map((c) => c.email));
    const authorizedEmails = new Set(contributors.filter((c) => c.authorized).map((c) => c.email));

    const repoAccess = await resolveRepoAccessViaApp(owner, repo);
    const current = await db.query.collaboratorTable.findMany({
      where: and(
        eq(collaboratorTable.ownerId, repoAccess.ownerId),
        eq(collaboratorTable.repoId, repoAccess.repoId),
      ),
    });
    const currentEmails = new Set(current.map((c) => c.email.trim().toLowerCase()));

    const added: string[] = [];
    const removed: string[] = [];

    // add authorized contributors that have no collaborator row yet
    for (const email of authorizedEmails) {
      if (!currentEmails.has(email)) {
        await addManagedCollaborator(repoAccess, email);
        added.push(email);
      }
    }

    // remove collaborators who are known contributors but are no longer authorized; hand-added
    // collaborators whose email is not a contributor are deliberately left untouched
    for (const collaborator of current) {
      const email = collaborator.email.trim().toLowerCase();
      if (contributorEmails.has(email) && !authorizedEmails.has(email)) {
        await removeManagedCollaborator(repoAccess, email);
        removed.push(email);
      }
    }

    return Response.json({
      status: "success",
      added,
      removed,
      scanned: { contributors: contributors.length, collaborators: current.length },
    });
  } catch (error: any) {
    console.error(error);
    return toErrorResponse(error);
  }
};

// Vercel Cron triggers via GET; POST is allowed for manual invocation/testing.
export const GET = reconcile;
export const POST = reconcile;
