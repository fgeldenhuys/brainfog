/**
 * Seeds a local development user and bearer token into the local D1
 * database (run via `wrangler d1 execute --local`). Run `pnpm db:migrate`
 * first so the `users`/`tokens` tables exist.
 *
 * Usage: pnpm seed ["User Name"]
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { generateToken, hashToken } from "@brainfog/shared";

const workerDir = path.resolve(import.meta.dirname, "..");
process.loadEnvFile(path.join(workerDir, ".dev.vars"));

const secret = process.env.BRAINFOG_TOKEN_HASH_SECRET;
if (!secret) {
  throw new Error("BRAINFOG_TOKEN_HASH_SECRET is not set in .dev.vars (see .dev.vars.example)");
}

const name = process.argv[2] ?? "Local Dev";
const userId = randomUUID();
const tokenId = randomUUID();
const token = generateToken();
const tokenHash = await hashToken(token, secret);

const escapeSql = (value: string) => value.replace(/'/g, "''");

const sql = [
  `INSERT INTO users (id, name) VALUES ('${escapeSql(userId)}', '${escapeSql(name)}')`,
  `INSERT INTO tokens (id, user_id, token_hash) VALUES ('${escapeSql(tokenId)}', '${escapeSql(userId)}', '${escapeSql(tokenHash)}')`,
].join("; ");

execFileSync("wrangler", ["d1", "execute", "brainfog", "--local", "--command", sql], {
  cwd: workerDir,
  stdio: "inherit",
});

console.log(`\nSeeded local user "${name}" (${userId}).`);
console.log(`Bearer token (save this — it is not stored anywhere): ${token}`);
