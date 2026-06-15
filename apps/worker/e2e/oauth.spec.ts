import process from "node:process";
import { expect, test } from "@playwright/test";

test("OAuth 2.1 full flow: DCR → authorize → token → /mcp", async ({ page, request }) => {
  const token = process.env.E2E_TOKEN;
  if (!token) {
    throw new Error("E2E_TOKEN not set — did globalSetup run?");
  }

  // Helper function for PKCE
  function base64url(bytes: ArrayBuffer | Uint8Array): string {
    const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    return Buffer.from(b)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // 1. Register a client via DCR
  const regResponse = await request.post("/register", {
    data: {
      redirect_uris: ["http://localhost:8787/callback"],
      token_endpoint_auth_method: "none", // public client
    },
    headers: { "Content-Type": "application/json" },
  });
  expect(regResponse.ok()).toBe(true);
  const regData = await regResponse.json();
  const clientId = regData.client_id;
  expect(clientId).toBeTruthy();

  // 2. Generate PKCE pair
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(verifierBytes);
  const challengeHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(challengeHash);

  // 3. Navigate to /authorize and fill in the form
  const authorizeUrl =
    `/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent("http://localhost:8787/callback")}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=`;

  await page.goto(authorizeUrl);

  // Wait for the form to be visible
  const tokenInput = page.getByLabel("Bearer Token:");
  await expect(tokenInput).toBeVisible();

  // 4. Fill in the token field and submit the form
  await tokenInput.fill(token);
  await page.getByRole("button", { name: "Authorize" }).click();

  // 5. Wait for the authorization code to appear in the code-block
  const codeBlock = page.locator("#code-block");
  await expect(codeBlock).toHaveClass(/active/);
  const codeValue = await page.locator("#code-value").textContent();
  expect(codeValue).toBeTruthy();
  const authCode = (codeValue ?? "").trim();

  // 6. Exchange authorization code for access token via /token
  const tokenResponse = await request.post("/token", {
    form: {
      grant_type: "authorization_code",
      code: authCode,
      code_verifier: verifier,
      client_id: clientId,
    },
  });
  expect(tokenResponse.ok()).toBe(true);
  const tokenData = await tokenResponse.json();
  const accessToken = tokenData.access_token;
  expect(accessToken).toBeTruthy();

  // 7. Use the access token to verify it's accepted by /mcp
  const mcpResponse = await request.post("/mcp", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "playwright-e2e", version: "0.1.0" },
      },
    },
  });
  // MCP endpoint should accept the request (may return 200 with SSE stream or similar)
  expect(mcpResponse.status()).toBeLessThan(400); // Not 401, 403, or error
  const mcpData = await mcpResponse.text();
  // Response should contain MCP protocol response data
  expect(mcpData.length).toBeGreaterThan(0);
});
