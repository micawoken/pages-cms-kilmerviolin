import { sql } from "drizzle-orm";
import { db } from "@/db";
import { toErrorResponse } from "@/lib/api-error";
import { assertCronSecret } from "@/lib/cron-auth";

/**
 * Keep-alive cron: issues a trivial `SELECT 1` so the Supabase free-tier project backing Pages CMS
 * registers activity and is not auto-paused after its idle window. Deliberately decoupled from the
 * sync-cms-access reconcile cron, whose DB read only runs after a D1 fetch that can fail — leaving
 * the database untouched. A redundant GitHub Actions workflow pings the DB directly on its own
 * schedule; see .github/workflows/supabase-keepalive.yml. The Vercel schedule lives in vercel.json.
 *
 * Guarded by the Vercel cron convention (`Authorization: Bearer ${CRON_SECRET}`).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const keepAlive = async (request: Request) => {
  try {
    assertCronSecret(request);
    await db.execute(sql`select 1`);
    return Response.json({ status: "success", pingedAt: new Date().toISOString() });
  } catch (error: any) {
    console.error(error);
    return toErrorResponse(error);
  }
};

// Vercel Cron triggers via GET; POST is allowed for manual invocation/testing.
export const GET = keepAlive;
export const POST = keepAlive;
