import { timingSafeEqual } from "crypto";
import { z } from "zod";
import { createHttpError, toErrorResponse } from "@/lib/api-error";
import { resolveRepoAccessViaApp } from "@/lib/sync/repo-access-app";
import { addManagedCollaborator, removeManagedCollaborator } from "@/lib/sync/collaborator-sync";

/**
 * Worker-driven CMS-access sync endpoint.
 *
 * The Cloudflare worker (spot-kilmer-violin-website) is the source of truth for who may edit content. When
 * a contributor's CMS-editor authorization changes, it calls this endpoint to add (POST) or remove (DELETE)
 * the corresponding Pages CMS collaborator, keyed by the shared identity email. Authentication is a shared
 * secret (NOT a user session) since the caller is the worker. See the worker's
 * src/lib/api/cms_access_sync.ts and docs/dev/pages-cms.md.
 *
 * The collaborator row is provisioned silently (no invite email); the reconcile cron
 * (app/api/cron/sync-cms-access) repairs any push this endpoint misses.
 */

export const dynamic = "force-dynamic";

const DEFAULT_OWNER = "micawoken";
const DEFAULT_REPO = "entrusting-devilish-fish";

const bodySchema = z.object({ email: z.string().email() });

const getSyncRepo = () => ({
  owner: process.env.SYNC_OWNER || DEFAULT_OWNER,
  repo: process.env.SYNC_REPO || DEFAULT_REPO,
});

/** Constant-time bearer-token check against WORKER_SYNC_SECRET. Throws an HTTP error on any mismatch. */
const assertWorkerSecret = (request: Request) => {
  const expected = process.env.WORKER_SYNC_SECRET;
  if (!expected) {
    throw createHttpError("CMS-access sync is not configured (WORKER_SYNC_SECRET unset).", 503);
  }
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw createHttpError("Unauthorized.", 401);
  }
};

const parseEmail = async (request: Request): Promise<string> => {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    throw createHttpError("Invalid request body: a valid \"email\" is required.", 400);
  }
  return parsed.data.email;
};

export async function POST(request: Request) {
  try {
    assertWorkerSecret(request);
    const email = await parseEmail(request);
    const { owner, repo } = getSyncRepo();
    const repoAccess = await resolveRepoAccessViaApp(owner, repo);
    const result = await addManagedCollaborator(repoAccess, email);
    return Response.json({ status: "success", action: "add", result });
  } catch (error: any) {
    console.error(error);
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertWorkerSecret(request);
    const email = await parseEmail(request);
    const { owner, repo } = getSyncRepo();
    const repoAccess = await resolveRepoAccessViaApp(owner, repo);
    const result = await removeManagedCollaborator(repoAccess, email);
    return Response.json({ status: "success", action: "remove", result });
  } catch (error: any) {
    console.error(error);
    return toErrorResponse(error);
  }
}
