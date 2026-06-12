import { Hono } from "hono";
import type { Env } from "../env";
import { type AuthVariables, authMiddleware } from "../middleware/auth";

export const apiRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Unauthenticated health check (ARCHITECTURE.md regression guardrail: must
// stay reachable without a token). Registered before the auth middleware so
// it short-circuits without ever invoking it.
apiRoutes.get("/health", (c) => c.json({ status: "ok" }));

apiRoutes.use("*", authMiddleware);

apiRoutes.get("/whoami", (c) => {
  const user = c.get("user");
  return c.json({ id: user.id, name: user.name });
});
