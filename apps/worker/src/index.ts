import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { lookupAuthenticatedUser, recordTokenUsage } from "./auth-lookup";
import type { Env } from "./env";
import { BrainfogMCP } from "./mcp";
import type { AuthVariables } from "./middleware/auth";
import { handleAuthorizeGet, handleAuthorizePost } from "./oauth";
import { apiRoutes } from "./routes/api";
import { uiApiRoutes } from "./routes/ui-api";
import { uiRoutes } from "./ui";

export { D1BackupWorkflow } from "./d1-backup-workflow";
export { GarminSpikeContainer } from "./garmin-spike-container";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.route("/api/v1", apiRoutes);
app.route("/api/v1/ui", uiApiRoutes);

// OAuth endpoints (ADR-012) for claude.ai Custom Connectors
// GET /authorize renders the authorization form
app.get("/authorize", (c) => handleAuthorizeGet(c));
// POST /authorize exchanges a bearer token for an authorization code
app.post("/authorize", (c) => handleAuthorizePost(c));

// RFC 8414 OAuth authorization server metadata and RFC 9728 protected resource metadata
// are served automatically by OAuthProvider below

app.route("/", uiRoutes);

// MCP handler for OAuthProvider's apiHandler
const mcpHandler = BrainfogMCP.serve("/mcp").fetch;

// Export OAuthProvider as the default Worker handler, wrapping the Hono app
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: {
    fetch: async (request, env, ctx) => {
      return mcpHandler(request, env, ctx);
    },
  },
  defaultHandler: app,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 3600, // 1 hour
  refreshTokenTTL: 90 * 24 * 3600, // 90 days
  resolveExternalToken: async ({ token, env }) => {
    // Resolve static bearer tokens (ADR-004) to the same user identity
    // so they continue to work on /mcp without OAuth
    const user = await lookupAuthenticatedUser(token, env as Env);
    if (!user) {
      return null;
    }
    await recordTokenUsage(env as Env, user.tokenId);
    return {
      props: {
        user: {
          id: user.id,
          name: user.name,
          selfPersonId: user.selfPersonId,
          slug: user.slug,
          isAdmin: user.isAdmin,
        },
      },
    };
  },
});

export { BrainfogMCP };
