import "server-only";

import { App } from "@octokit/app";
import { getInstallationToken } from "@/lib/token";
import { createOctokitInstance } from "@/lib/utils/octokit";

/**
 * The GitHub coordinates needed to insert a row into the collaborator table, resolved without a user
 * session. Mirrors the `repoAccess` object built in lib/authz-server.ts:requireGithubRepoWriteAccess, plus
 * the installation id (which a collaborator row also requires) and an installation token for further calls.
 */
export type AppRepoAccess = {
  installationId: number;
  repoId: number;
  ownerId: number;
  ownerLogin: string;
  repoName: string;
  ownerType: "user" | "org";
  token: string;
};

/**
 * Resolves the GitHub installation/repo identifiers for `owner/repo` using only the GitHub App credentials
 * (no signed-in user). This is the server-to-server path used by the worker-driven sync endpoint and the
 * reconcile cron, which act on behalf of the worker rather than a Pages CMS user.
 *
 * The installation id comes from the App's repo-installation lookup; the remaining ids come from a
 * `repos.get` made with the installation token (reused from {@link getInstallationToken}, which caches and
 * encrypts it in the database).
 */
export const resolveRepoAccessViaApp = async (
  owner: string,
  repo: string,
): Promise<AppRepoAccess> => {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error("GitHub App credentials are not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY).");
  }

  const app = new App({ appId, privateKey });
  const repoInstallation = await app.octokit.request(
    "GET /repos/{owner}/{repo}/installation",
    { owner, repo },
  );
  if (!repoInstallation?.data?.id) {
    throw new Error(`Pages CMS is not installed on "${owner}/${repo}".`);
  }
  const installationId = repoInstallation.data.id;

  const token = await getInstallationToken(owner, repo);
  const octokit = createOctokitInstance(token);
  const response = await octokit.rest.repos.get({ owner, repo });

  return {
    installationId,
    repoId: response.data.id,
    ownerId: response.data.owner.id,
    ownerLogin: response.data.owner.login,
    repoName: response.data.name,
    ownerType: response.data.owner.type === "User" ? "user" : "org",
    token,
  };
};
