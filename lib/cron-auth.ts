import { createHttpError } from "@/lib/api-error";

/**
 * Validates the Vercel cron convention (`Authorization: Bearer ${CRON_SECRET}`): throws a 503 when
 * the secret is unset and a 401 when the header does not match. Shared by the cron route handlers.
 */
export const assertCronSecret = (request: Request) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    throw createHttpError("Cron is not configured (CRON_SECRET unset).", 503);
  }
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${expected}`) {
    throw createHttpError("Unauthorized.", 401);
  }
};
