import type { AuthenticatedUser } from "@brainfog/shared";
import type { MiddlewareHandler } from "hono";
import { lookupAuthenticatedUser, recordTokenUsage } from "../auth-lookup";
import type { Env } from "../env";

export type AuthVariables = {
  user: AuthenticatedUser & { slug?: string | null; isAdmin: boolean };
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

  const user = await lookupAuthenticatedUser(token, c.env);
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(recordTokenUsage(c.env, user.tokenId));

  c.set("user", {
    id: user.id,
    name: user.name,
    slug: user.slug,
    isAdmin: user.isAdmin,
    selfPersonId: user.selfPersonId,
  });
  await next();
};
