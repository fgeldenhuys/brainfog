import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { hashToken } from "@brainfog/shared";

/**
 * Seeds a deterministic local D1 user/token so the Playwright token-entry
 * spec has a known valid bearer token to submit, without depending on the
 * randomly-generated output of `pnpm seed`.
 */
const USER_ID = "e2e-user";
const USER_NAME = "Playwright E2E";
const TOKEN_ID = "e2e-token";
export const TOKEN = "e2e-test-token";
const NON_ADMIN_USER_ID = "e2e-non-admin-user";
const NON_ADMIN_TOKEN_ID = "e2e-non-admin-token";
export const NON_ADMIN_TOKEN = "e2e-non-admin-test-token";

export default async function globalSetup() {
  const workerDir = path.resolve(import.meta.dirname, "..");
  process.loadEnvFile(path.join(workerDir, ".dev.vars"));

  const secret = process.env.BRAINFOG_TOKEN_HASH_SECRET;
  if (!secret) {
    throw new Error("BRAINFOG_TOKEN_HASH_SECRET is not set in .dev.vars (see .dev.vars.example)");
  }

  const tokenHash = await hashToken(TOKEN, secret);
  const nonAdminTokenHash = await hashToken(NON_ADMIN_TOKEN, secret);
  const ownerIds = `'${USER_ID}', '${NON_ADMIN_USER_ID}'`;
  execFileSync(
    "wrangler",
    [
      "d1",
      "execute",
      "brainfog",
      "--local",
      "--file",
      path.join(workerDir, "../../packages/db/migrations/0007_user_pages.sql"),
    ],
    { cwd: workerDir, stdio: "inherit" },
  );
  const sql = [
    "PRAGMA foreign_keys=OFF",
    `DELETE FROM dependency_edges WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM page_access_links WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM pages WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM document_chunks WHERE document_id IN (SELECT id FROM documents WHERE owner_id IN (${ownerIds}))`,
    `DELETE FROM thoughts WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM facts WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM time_series_points WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM tasks WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM people WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM documents WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM projects WHERE owner_id IN (${ownerIds})`,
    `DELETE FROM tokens WHERE id = '${TOKEN_ID}'`,
    `DELETE FROM tokens WHERE id = '${NON_ADMIN_TOKEN_ID}'`,
    `DELETE FROM users WHERE id = '${USER_ID}'`,
    `DELETE FROM users WHERE id = '${NON_ADMIN_USER_ID}'`,
    `INSERT INTO users (id, name, slug, is_admin) VALUES ('${USER_ID}', '${USER_NAME}', 'playwright-e2e', 1)`,
    `INSERT INTO users (id, name, slug, is_admin) VALUES ('${NON_ADMIN_USER_ID}', 'Playwright Non Admin', 'playwright-non-admin', 0)`,
    `INSERT INTO tokens (id, user_id, token_hash) VALUES ('${TOKEN_ID}', '${USER_ID}', '${tokenHash}')`,
    `INSERT INTO tokens (id, user_id, token_hash) VALUES ('${NON_ADMIN_TOKEN_ID}', '${NON_ADMIN_USER_ID}', '${nonAdminTokenHash}')`,
    "PRAGMA foreign_keys=ON",
  ].join("; ");

  execFileSync("wrangler", ["d1", "execute", "brainfog", "--local", "--command", sql], {
    cwd: workerDir,
    stdio: "inherit",
  });

  process.env.E2E_TOKEN = TOKEN;
  process.env.E2E_USER_NAME = USER_NAME;
  process.env.E2E_NON_ADMIN_TOKEN = NON_ADMIN_TOKEN;
}
