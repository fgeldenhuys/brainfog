import { Hono } from "hono";
import type { Env } from "./env";
import { BrainfogMCP } from "./mcp";
import { type AuthVariables, authMiddleware } from "./middleware/auth";
import { apiRoutes } from "./routes/api";
import { uiApiRoutes } from "./routes/ui-api";
import { uiRoutes } from "./ui";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.route("/api/v1", apiRoutes);
app.route("/api/v1/ui", uiApiRoutes);

// MCP scaffold (ADR-003), behind the same bearer-token middleware as
// /api/v1 (ARCHITECTURE.md invariant 6). Auth middleware is registered
// before the mount so it runs first for every /mcp request.
app.use("/mcp", authMiddleware);
app.use("/mcp/*", authMiddleware);
const mcpHandler = BrainfogMCP.serve("/mcp").fetch;
const mcpExecutionCtx = (c: { executionCtx: unknown; get: (key: "user") => unknown }) =>
  Object.assign(c.executionCtx as object, {
    props: { user: c.get("user") },
  }) as ExecutionContext<unknown>;
app.all("/mcp", (c) => mcpHandler(c.req.raw, c.env, mcpExecutionCtx(c)));
app.all("/mcp/*", (c) => mcpHandler(c.req.raw, c.env, mcpExecutionCtx(c)));

app.route("/", uiRoutes);

export default app;
export { BrainfogMCP };
