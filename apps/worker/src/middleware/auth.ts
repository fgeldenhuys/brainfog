import { createDb, tokens, users } from "@brainfog/db";
import { type AuthenticatedUser, hashToken } from "@brainfog/shared";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

export type AuthVariables = {
  user: AuthenticatedUser;
};

/**
 * Shared bearer-token middleware for `/api/v1/*` (except `/api/v1/health`)
 * and `/mcp` (ADR-004, ARCHITECTURE.md invariant 6). Looks up the hashed
 * token in D1, attaches the authenticated user to the request context, and
 * records `last_used_at` on the token row.
 */
export const authMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthVariables;
}> = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.match(/^Bearer\s+(.+)$/)?.[1];
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const tokenHash = await hashToken(token, c.env.BRAINFOG_TOKEN_HASH_SECRET);
  const db = createDb(c.env.DB);
  const rows = await db
    .select({ tokenId: tokens.id, userId: users.id, name: users.name })
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .where(eq(tokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(
    db
      .update(tokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(tokens.id, row.tokenId))
      .then(() => undefined),
  );

  c.set("user", { id: row.userId, name: row.name });
  await next();
};
