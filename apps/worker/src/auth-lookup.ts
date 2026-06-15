import { createDb, tokens, users } from "@brainfog/db";
import { type AuthenticatedUser, hashToken } from "@brainfog/shared";
import { eq } from "drizzle-orm";
import type { Env } from "./env";

/**
 * Authenticates a bearer token against D1 and returns the user record.
 * Used by authMiddleware, /authorize, and resolveExternalToken.
 *
 * Returns the user fields needed for ctx.props.user:
 * - id, name, selfPersonId, slug, isAdmin
 *
 * Returns null if the token is not found. Unexpected errors (e.g. D1
 * connectivity issues) propagate to the caller rather than being reported
 * as an invalid token.
 */
export async function lookupAuthenticatedUser(
  token: string,
  env: Env,
): Promise<
  (AuthenticatedUser & { slug?: string | null; isAdmin: boolean; tokenId: string }) | null
> {
  const tokenHash = await hashToken(token, env.BRAINFOG_TOKEN_HASH_SECRET);
  const db = createDb(env.DB);
  const rows = await db
    .select({
      tokenId: tokens.id,
      userId: users.id,
      name: users.name,
      slug: users.slug,
      isAdmin: users.isAdmin,
      selfPersonId: users.selfPersonId,
    })
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .where(eq(tokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    tokenId: row.tokenId,
    id: row.userId,
    name: row.name,
    slug: row.slug,
    isAdmin: row.isAdmin,
    selfPersonId: row.selfPersonId,
  };
}

/**
 * Records that a token was used (last_used_at), shown on the token
 * management page. Used by authMiddleware and resolveExternalToken so that
 * /mcp requests update usage regardless of which auth path validated them.
 */
export async function recordTokenUsage(env: Env, tokenId: string): Promise<void> {
  const db = createDb(env.DB);
  await db.update(tokens).set({ lastUsedAt: new Date() }).where(eq(tokens.id, tokenId));
}
