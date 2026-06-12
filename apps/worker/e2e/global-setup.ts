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

export default async function globalSetup() {
  const workerDir = path.resolve(import.meta.dirname, "..");
  process.loadEnvFile(path.join(workerDir, ".dev.vars"));

  const secret = process.env.BRAINFOG_TOKEN_HASH_SECRET;
  if (!secret) {
    throw new Error("BRAINFOG_TOKEN_HASH_SECRET is not set in .dev.vars (see .dev.vars.example)");
  }

  const tokenHash = await hashToken(TOKEN, secret);
  const sql = [
    `DELETE FROM tokens WHERE id = '${TOKEN_ID}'`,
    `DELETE FROM users WHERE id = '${USER_ID}'`,
    `INSERT INTO users (id, name) VALUES ('${USER_ID}', '${USER_NAME}')`,
    `INSERT INTO tokens (id, user_id, token_hash) VALUES ('${TOKEN_ID}', '${USER_ID}', '${tokenHash}')`,
  ].join("; ");

  execFileSync("wrangler", ["d1", "execute", "brainfog", "--local", "--command", sql], {
    cwd: workerDir,
    stdio: "inherit",
  });

  process.env.E2E_TOKEN = TOKEN;
  process.env.E2E_USER_NAME = USER_NAME;
}
