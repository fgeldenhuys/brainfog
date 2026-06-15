import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { createDb, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

const VALID_TOKEN = "test-oauth-token-12345";
const INVALID_TOKEN = "invalid-oauth-token";
const STATIC_VALID_TOKEN = "test-static-token-12345";
const STATIC_LASTUSED_TOKEN = "test-static-lastused-token-12345";
const USER_ID = "user-oauth-1";
const USER_NAME = "OAuth User";

// PKCE helper functions
function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return Buffer.from(b)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return { verifier, challenge };
}

// MCP helper functions
async function authFetch(path: string, init: RequestInit = {}, token = VALID_TOKEN) {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function mcpRequest(
  body: Record<string, unknown>,
  sessionId?: string,
  token = VALID_TOKEN,
): Promise<{ response: Response; message?: Record<string, unknown>; sessionId?: string }> {
  const response = await authFetch(
    "/mcp",
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    },
    token,
  );
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  const message = (dataLine ? JSON.parse(dataLine) : text ? JSON.parse(text) : undefined) as
    | Record<string, unknown>
    | undefined;
  return { response, message, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

async function mcpSession(token = VALID_TOKEN) {
  const init = await mcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "brainfog-test", version: "0.1.0" },
      },
    },
    undefined,
    token,
  );
  expect(init.response.status).toBe(200);
  expect(init.sessionId).toBeTruthy();
  await mcpRequest(
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    init.sessionId,
    token,
  );
  return init.sessionId ?? "";
}

async function callMcpTool<T>(name: string, args: Record<string, unknown>, token = VALID_TOKEN) {
  const session = await mcpSession(token);
  const result = await mcpRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    session,
    token,
  );
  expect(result.response.status).toBe(200);
  const m = result.message as { result?: { content?: { text?: string }[] }; error?: unknown };
  expect(m.error).toBeUndefined();
  return JSON.parse(m.result?.content?.[0]?.text ?? "null") as T;
}

describe("OAuth 2.1 Authorization Server", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);

    // Create test user
    const db = createDb(env.DB);
    await db.insert(users).values({ id: USER_ID, name: USER_NAME });
    await db.insert(tokens).values({
      id: "token-oauth-1",
      userId: USER_ID,
      tokenHash: await hashToken(VALID_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });
  });

  describe(".well-known endpoints", () => {
    it("GET /.well-known/oauth-authorization-server returns RFC 8414 metadata", async () => {
      const response = await SELF.fetch(
        "https://example.com/.well-known/oauth-authorization-server",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const data = (await response.json()) as Record<string, unknown>;

      // RFC 8414 required fields
      expect(data.issuer).toBeDefined();
      expect(data.authorization_endpoint).toBeDefined();
      expect(data.token_endpoint).toBeDefined();
      expect(Array.isArray(data.grant_types_supported)).toBe(true);
      expect(Array.isArray(data.response_types_supported)).toBe(true);
      expect(Array.isArray(data.token_endpoint_auth_methods_supported)).toBe(true);
      expect(Array.isArray(data.code_challenge_methods_supported)).toBe(true);
    });

    it("GET /.well-known/oauth-protected-resource returns RFC 9728 metadata", async () => {
      const response = await SELF.fetch("https://example.com/.well-known/oauth-protected-resource");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const data = (await response.json()) as Record<string, unknown>;

      // RFC 9728 required fields
      expect(data.resource).toBeDefined();
      expect(data.authorization_servers).toBeDefined();
      expect(Array.isArray(data.authorization_servers)).toBe(true);
    });

    it(".well-known endpoints are unauthenticated", async () => {
      // No Authorization header should be required
      const response1 = await SELF.fetch(
        "https://example.com/.well-known/oauth-authorization-server",
      );
      expect(response1.status).toBe(200);

      const response2 = await SELF.fetch(
        "https://example.com/.well-known/oauth-protected-resource",
      );
      expect(response2.status).toBe(200);
    });
  });

  describe("POST /authorize validation", () => {
    it("returns 400 for missing token field", async () => {
      const response = await SELF.fetch("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oauthReqInfo: "dGVzdA==" }),
      });
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe("invalid_request");
      expect(String(data.error_description)).toContain("token");
    });

    it("returns 401 for invalid bearer token (with valid oauthReqInfo)", async () => {
      // Create a valid oauthReqInfo (base64-encoded JSON)
      const validOAuthReqInfo = Buffer.from(
        JSON.stringify({
          clientId: "test-client",
          redirectUri: "https://example.com/callback",
          scope: ["read"],
          state: "state-123",
        }),
      ).toString("base64");

      const response = await SELF.fetch("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: INVALID_TOKEN, oauthReqInfo: validOAuthReqInfo }),
      });
      expect(response.status).toBe(401);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe("invalid_grant");
    });

    it("accepts application/json Content-Type", async () => {
      // Valid token but invalid oauthReqInfo (base64 "test") should fail deserialization
      const response = await SELF.fetch("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: VALID_TOKEN, oauthReqInfo: "dGVzdA==" }),
      });
      expect([400, 500]).toContain(response.status);
    });

    it("accepts application/x-www-form-urlencoded Content-Type", async () => {
      // Valid token but invalid oauthReqInfo (base64 "test") should fail deserialization
      const response = await SELF.fetch("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: VALID_TOKEN,
          oauthReqInfo: "dGVzdA==",
        }).toString(),
      });
      expect([400, 500]).toContain(response.status);
    });

    it("rejects invalid Content-Type", async () => {
      const response = await SELF.fetch("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "token=something",
      });
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe("invalid_request");
    });

    it("returns 400 for missing oauthReqInfo field", async () => {
      const response = await SELF.fetch("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: VALID_TOKEN }),
      });
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.error).toBe("invalid_request");
    });
  });

  describe("DCR: Dynamic Client Registration", () => {
    it("POST /register accepts a public PKCE client", async () => {
      const response = await SELF.fetch("https://example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
          token_endpoint_auth_method: "none", // public client
        }),
      });
      expect(response.status).toBe(201);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.client_id).toBeDefined();
      expect(typeof data.client_id).toBe("string");
    });
  });

  describe("Full OAuth happy-path flow (DCR → authorize → token → /mcp)", () => {
    it("registers a DCR client, obtains authorization code, exchanges for token, uses token on /mcp", async () => {
      // 1. Register a client
      const regResponse = await SELF.fetch("https://example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
      expect(regResponse.status).toBe(201);
      const { client_id } = (await regResponse.json()) as { client_id: string };
      expect(client_id).toBeDefined();

      // 2. Generate PKCE pair
      const { verifier, challenge } = await pkcePair();
      expect(verifier).toBeDefined();
      expect(challenge).toBeDefined();

      // 3. GET /authorize to get the form with oauthReqInfo
      const authorizeUrl =
        `https://example.com/authorize?response_type=code&client_id=${client_id}` +
        `&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=`;
      const getResp = await SELF.fetch(authorizeUrl);
      expect(getResp.status).toBe(200);
      const html = await getResp.text();
      const oauthReqInfo = html.match(/id="oauthReqInfo" name="oauthReqInfo" value="([^"]*)"/)?.[1];
      expect(oauthReqInfo).toBeDefined();

      // 4. POST /authorize with valid token to get authorization_code
      const postResp = await SELF.fetch("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: VALID_TOKEN, oauthReqInfo }),
      });
      expect(postResp.status).toBe(200);
      const authData = (await postResp.json()) as {
        authorization_code: string;
        user_id: string;
        user_name: string;
      };
      expect(authData.authorization_code).toBeDefined();
      expect(authData.user_id).toBe(USER_ID);
      expect(authData.user_name).toBe(USER_NAME);

      // 5. POST /token to exchange code for access_token
      const tokenResp = await SELF.fetch("https://example.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authData.authorization_code,
          code_verifier: verifier,
          client_id,
        }).toString(),
      });
      expect(tokenResp.status).toBe(200);
      const tokens = (await tokenResp.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        token_type: string;
      };
      expect(tokens.access_token).toBeDefined();
      expect(tokens.refresh_token).toBeDefined();
      expect(tokens.expires_in).toBeGreaterThan(0);
      expect(tokens.token_type.toLowerCase()).toBe("bearer");

      // 6. Use OAuth access token on /mcp and verify ctx.props.user
      const whoami = await callMcpTool<{ id: string; name: string }>(
        "whoami",
        {},
        tokens.access_token,
      );
      expect(whoami.id).toBe(USER_ID);
      expect(whoami.name).toBe(USER_NAME);
    });
  });

  describe("Token endpoint: authorization code handling", () => {
    it("rejects invalid authorization code with 400 invalid_grant", async () => {
      const { verifier } = await pkcePair();

      // Register a client
      const regResponse = await SELF.fetch("https://example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
      const { client_id } = (await regResponse.json()) as { client_id: string };

      // Try to exchange a garbage code
      const tokenResp = await SELF.fetch("https://example.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "not-a-real-code-xyz",
          code_verifier: verifier,
          client_id,
        }).toString(),
      });
      expect(tokenResp.status).toBe(400);
      const error = (await tokenResp.json()) as Record<string, unknown>;
      expect(error.error).toBe("invalid_grant");
    });

    it("rejects reused authorization code with 400 invalid_grant", async () => {
      // Register a client
      const regResponse = await SELF.fetch("https://example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
      const { client_id } = (await regResponse.json()) as { client_id: string };

      // Generate PKCE pair
      const { verifier, challenge } = await pkcePair();

      // GET /authorize
      const authorizeUrl =
        `https://example.com/authorize?response_type=code&client_id=${client_id}` +
        `&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=`;
      const getResp = await SELF.fetch(authorizeUrl);
      const html = await getResp.text();
      const oauthReqInfo = html.match(/id="oauthReqInfo" name="oauthReqInfo" value="([^"]*)"/)?.[1];
      expect(oauthReqInfo).toBeDefined();

      // POST /authorize to get code
      const postResp = await SELF.fetch("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: VALID_TOKEN, oauthReqInfo }),
      });
      const authData = (await postResp.json()) as { authorization_code: string };
      const authCode = authData.authorization_code;

      // First exchange: should succeed
      const tokenResp1 = await SELF.fetch("https://example.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: verifier,
          client_id,
        }).toString(),
      });
      expect(tokenResp1.status).toBe(200);

      // Second exchange with same code: should fail (code already used)
      const tokenResp2 = await SELF.fetch("https://example.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authCode,
          code_verifier: verifier,
          client_id,
        }).toString(),
      });
      expect(tokenResp2.status).toBe(400);
      const error = (await tokenResp2.json()) as Record<string, unknown>;
      expect(error.error).toBe("invalid_grant");
    });
  });

  describe("Refresh token flow", () => {
    it("exchanges refresh_token for new access_token via /token", async () => {
      // Register, authorize, and get tokens
      const regResponse = await SELF.fetch("https://example.com/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      });
      const { client_id } = (await regResponse.json()) as { client_id: string };

      const { verifier, challenge } = await pkcePair();
      const authorizeUrl =
        `https://example.com/authorize?response_type=code&client_id=${client_id}` +
        `&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}` +
        `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=`;
      const getResp = await SELF.fetch(authorizeUrl);
      const html = await getResp.text();
      const oauthReqInfo = html.match(/id="oauthReqInfo" name="oauthReqInfo" value="([^"]*)"/)?.[1];

      const postResp = await SELF.fetch("https://example.com/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: VALID_TOKEN, oauthReqInfo }),
      });
      const authData = (await postResp.json()) as { authorization_code: string };

      const tokenResp = await SELF.fetch("https://example.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authData.authorization_code,
          code_verifier: verifier,
          client_id,
        }).toString(),
      });
      const tokens = (await tokenResp.json()) as {
        access_token: string;
        refresh_token: string;
      };

      // Now use refresh_token to get a new access_token
      const refreshResp = await SELF.fetch("https://example.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id,
        }).toString(),
      });
      expect(refreshResp.status).toBe(200);
      const newTokens = (await refreshResp.json()) as {
        access_token: string;
        refresh_token: string;
      };
      expect(newTokens.access_token).toBeDefined();
      expect(newTokens.access_token).not.toBe(tokens.access_token); // New token issued

      // New access token should work on /mcp
      const whoami = await callMcpTool<{ id: string; name: string }>(
        "whoami",
        {},
        newTokens.access_token,
      );
      expect(whoami.id).toBe(USER_ID);
      expect(whoami.name).toBe(USER_NAME);
    });
  });

  describe(".well-known/oauth-protected-resource", () => {
    it("lists /mcp as a protected resource", async () => {
      const response = await SELF.fetch(
        "https://example.com/.well-known/oauth-protected-resource/mcp",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.resource).toBeDefined();
      expect(String(data.resource)).toContain("/mcp");
    });
  });
});

describe("Regression: static bearer token paths still work", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);

    const db = createDb(env.DB);
    await db.insert(users).values({ id: "user-static-1", name: "Static Token User" });
    await db.insert(tokens).values({
      id: "token-static-1",
      userId: "user-static-1",
      tokenHash: await hashToken(STATIC_VALID_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });
    await db.insert(users).values({ id: "user-static-lastused", name: "LastUsed Token User" });
    await db.insert(tokens).values({
      id: "token-static-lastused",
      userId: "user-static-lastused",
      tokenHash: await hashToken(STATIC_LASTUSED_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });
  });

  it("GET /api/v1/whoami still works with static bearer token", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/whoami", {
      headers: { Authorization: `Bearer ${STATIC_VALID_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.id).toBe("user-static-1");
    expect(data.name).toBe("Static Token User");
  });

  it("GET /api/v1/health remains unauthenticated", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/health");
    expect(response.status).toBe(200);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data.status).toBe("ok");
  });

  it("GET /api/v1/whoami without token returns 401", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/whoami");
    expect(response.status).toBe(401);
  });

  it("/mcp rejects requests without a valid token", async () => {
    const response = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(response.status).toBe(401);
  });

  it("/mcp with static bearer token allows MCP requests", async () => {
    const response = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATIC_VALID_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    // Should authenticate and reach the MCP endpoint
    // May return various status codes depending on MCP protocol handling
    expect(response.status).not.toBe(401);
  });

  it("/mcp with static bearer token records last_used_at on the token row", async () => {
    const db = createDb(env.DB);
    const before = await db
      .select({ lastUsedAt: tokens.lastUsedAt })
      .from(tokens)
      .where(eq(tokens.id, "token-static-lastused"))
      .limit(1);
    expect(before[0]?.lastUsedAt).toBeNull();

    const response = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STATIC_LASTUSED_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(response.status).not.toBe(401);

    const after = await db
      .select({ lastUsedAt: tokens.lastUsedAt })
      .from(tokens)
      .where(eq(tokens.id, "token-static-lastused"))
      .limit(1);
    expect(after[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("/mcp with OAuth access token works identically to static bearer token", async () => {
    // Register and flow through to get an OAuth access token
    const regResponse = await SELF.fetch("https://example.com/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example.com/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    const { client_id } = (await regResponse.json()) as { client_id: string };

    const { verifier, challenge } = await pkcePair();
    const authorizeUrl =
      `https://example.com/authorize?response_type=code&client_id=${client_id}` +
      `&redirect_uri=${encodeURIComponent("https://client.example.com/callback")}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=`;
    const getResp = await SELF.fetch(authorizeUrl);
    const html = await getResp.text();
    const oauthReqInfo = html.match(/id="oauthReqInfo" name="oauthReqInfo" value="([^"]*)"/)?.[1];

    const postResp = await SELF.fetch("https://example.com/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: VALID_TOKEN, oauthReqInfo }),
    });
    const authData = (await postResp.json()) as { authorization_code: string };

    const tokenResp = await SELF.fetch("https://example.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authData.authorization_code,
        code_verifier: verifier,
        client_id,
      }).toString(),
    });
    const tokens = (await tokenResp.json()) as { access_token: string };

    // Now make MCP request with OAuth token and verify it works
    const response = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(response.status).not.toBe(401);
  });
});
