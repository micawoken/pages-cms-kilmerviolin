import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { collaboratorInviteTable, collaboratorTable } from "@/db/schema";
import { findVerifiedUserByEmail, normalizeEmail } from "@/lib/collaborator-access";
import type { AppRepoAccess } from "@/lib/sync/repo-access-app";

/**
 * Worker-driven collaborator provisioning. These mirror the DB writes in lib/actions/collaborator.ts
 * (handleAddCollaborator / handleRemoveCollaborator) but are session-less and **silent**: no invite token
 * is created and no email is sent. They are the shared write path for the worker push endpoint
 * (app/api/sync/cms-access) and the reconcile cron (app/api/cron/sync-cms-access).
 *
 * Access still works the moment the person signs in with the matching email (collaborator OTP sign-in or a
 * linked GitHub user); `userId` is linked eagerly here when an already-verified user exists.
 */

/**
 * Ensures a collaborator row exists for `email` on the resolved repo. Idempotent: if the row already
 * exists it links a newly-resolvable verified user and otherwise no-ops. Returns whether a row was created.
 */
export const addManagedCollaborator = async (
  repoAccess: AppRepoAccess,
  email: string,
): Promise<"created" | "exists"> => {
  const normalized = normalizeEmail(email);
  const existingUser = await findVerifiedUserByEmail(normalized);

  const existing = await db.query.collaboratorTable.findFirst({
    where: and(
      eq(collaboratorTable.ownerId, repoAccess.ownerId),
      eq(collaboratorTable.repoId, repoAccess.repoId),
      sql`lower(${collaboratorTable.email}) = lower(${normalized})`,
    ),
  });

  if (existing) {
    if (existingUser && existing.userId !== existingUser.id) {
      await db
        .update(collaboratorTable)
        .set({ userId: existingUser.id })
        .where(eq(collaboratorTable.id, existing.id));
    }
    return "exists";
  }

  await db.insert(collaboratorTable).values({
    type: repoAccess.ownerType,
    installationId: repoAccess.installationId,
    ownerId: repoAccess.ownerId,
    repoId: repoAccess.repoId,
    owner: repoAccess.ownerLogin,
    repo: repoAccess.repoName,
    email: normalized,
    userId: existingUser?.id ?? null,
    invitedBy: null,
  });

  return "created";
};

/**
 * Removes the collaborator row for `email` on the resolved repo (and any matching pending invite).
 * Idempotent: removing a non-existent collaborator is a no-op. Returns whether a row was deleted.
 */
export const removeManagedCollaborator = async (
  repoAccess: AppRepoAccess,
  email: string,
): Promise<"deleted" | "absent"> => {
  const normalized = normalizeEmail(email);

  const deleted = await db
    .delete(collaboratorTable)
    .where(
      and(
        eq(collaboratorTable.ownerId, repoAccess.ownerId),
        eq(collaboratorTable.repoId, repoAccess.repoId),
        sql`lower(${collaboratorTable.email}) = lower(${normalized})`,
      ),
    )
    .returning();

  await db
    .delete(collaboratorInviteTable)
    .where(
      and(
        sql`lower(${collaboratorInviteTable.email}) = lower(${normalized})`,
        sql`lower(${collaboratorInviteTable.owner}) = lower(${repoAccess.ownerLogin})`,
        sql`lower(${collaboratorInviteTable.repo}) = lower(${repoAccess.repoName})`,
      ),
    );

  return deleted.length > 0 ? "deleted" : "absent";
};
