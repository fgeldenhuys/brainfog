import { Hono } from "hono";
import type { Env } from "./env";
import { BrainfogMCP } from "./mcp";
import { type AuthVariables, authMiddleware } from "./middleware/auth";
import { apiRoutes } from "./routes/api";
import { uiRoutes } from "./ui";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.route("/api/v1", apiRoutes);

// MCP scaffold (ADR-003), behind the same bearer-token middleware as
// /api/v1 (ARCHITECTURE.md invariant 6). Auth middleware is registered
// before the mount so it runs first for every /mcp request.
app.use("/mcp", authMiddleware);
app.use("/mcp/*", authMiddleware);
// Hono's `app.mount()` strips the `/mcp` prefix before invoking the handler
// (the handler sees `/`), so `BrainfogMCP.serve()` must match against `/`.
app.mount("/mcp", BrainfogMCP.serve("/").fetch);

app.route("/", uiRoutes);

export default app;
export { BrainfogMCP };
