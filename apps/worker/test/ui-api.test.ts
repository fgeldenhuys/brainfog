import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { createDb, projects, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { beforeAll, describe, expect, it } from "vitest";

const ADMIN_TOKEN = "admin-token-12345";
const USER_TOKEN = "user-token-67890";

describe("/api/v1/ui routes", () => {
  let adminUserId: string;
  let regularUserId: string;

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);

    const db = createDb(env.DB);
    adminUserId = crypto.randomUUID();
    regularUserId = crypto.randomUUID();

    // Insert users separately to ensure values are set correctly
    await db.insert(users).values({ id: adminUserId, name: "Admin User", isAdmin: true });
    await db.insert(users).values({ id: regularUserId, name: "Regular User", isAdmin: false });

    // Insert tokens separately
    await db.insert(tokens).values({
      id: "admin-token-1",
      userId: adminUserId,
      tokenHash: await hashToken(ADMIN_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });
    await db.insert(tokens).values({
      id: "user-token-1",
      userId: regularUserId,
      tokenHash: await hashToken(USER_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });

    await db.insert(projects).values({
      id: "ui-api-admin-project",
      ownerId: adminUserId,
      source: "test",
      name: "Admin Project",
    });
    await db.insert(projects).values({
      id: "ui-api-regular-project",
      ownerId: regularUserId,
      source: "test",
      name: "Regular Project",
    });
  });

  describe("GET /api/v1/ui/summary", () => {
    it("returns 401 without authorization", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/summary");
      expect(response.status).toBe(401);
    });

    it("returns owner-scoped summary for authenticated user", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/summary", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("counts");
      expect(data).toHaveProperty("task_status");
      expect(data).toHaveProperty("fact_status");
      expect(data).toHaveProperty("chunks");
      expect(data).toHaveProperty("recallable");
      expect(data).toHaveProperty("recent");
      expect((data.counts as Record<string, unknown>).projects).toBe(1);

      const regularResponse = await SELF.fetch("https://example.com/api/v1/ui/summary", {
        headers: { Authorization: `Bearer ${USER_TOKEN}` },
      });
      expect(regularResponse.status).toBe(200);
      const regularData = (await regularResponse.json()) as Record<string, unknown>;
      expect((regularData.counts as Record<string, unknown>).projects).toBe(1);
    });

    it("returns JSON content type", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/summary", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
    });
  });

  describe("GET /api/v1/ui/metrics", () => {
    it("returns 401 without authorization", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/metrics");
      expect(response.status).toBe(401);
    });

    it("returns owner-scoped metrics for authenticated user", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/metrics", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("counts");
      expect(data).toHaveProperty("task_status");
      expect(data).toHaveProperty("fact_status");
      expect(data).toHaveProperty("chunks");
      expect(data).toHaveProperty("recallable");
      expect(data).toHaveProperty("recent");
      expect(data).toHaveProperty("time_series");
      expect(data.project_id).toBeNull();
      expect((data.counts as Record<string, unknown>).projects).toBe(1);

      const regularResponse = await SELF.fetch("https://example.com/api/v1/ui/metrics", {
        headers: { Authorization: `Bearer ${USER_TOKEN}` },
      });
      expect(regularResponse.status).toBe(200);
      const regularData = (await regularResponse.json()) as Record<string, unknown>;
      expect((regularData.counts as Record<string, unknown>).projects).toBe(1);
    });

    it("respects query parameters for filtering", async () => {
      const response = await SELF.fetch(
        "https://example.com/api/v1/ui/metrics?from=1609459200&to=1640995200",
        {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        },
      );
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("from");
      expect(data).toHaveProperty("to");
    });
  });

  describe("GET /api/v1/ui/users", () => {
    it("returns 401 without authorization", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/users");
      expect(response.status).toBe(401);
    });

    it("returns 403 for non-admin user", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/users", {
        headers: { Authorization: `Bearer ${USER_TOKEN}` },
      });
      expect(response.status).toBe(403);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });

    it("lists all users for admin user", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/users", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as unknown[];
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThanOrEqual(2);
      const firstUser = data[0] as Record<string, unknown>;
      expect(firstUser).toHaveProperty("id");
      expect(firstUser).toHaveProperty("name");
      expect(firstUser).toHaveProperty("slug");
      expect(firstUser).toHaveProperty("isAdmin");
      expect(firstUser).toHaveProperty("createdAt");
      expect(firstUser).toHaveProperty("tokenCount");
    });
  });

  describe("POST /api/v1/ui/users", () => {
    it("returns 403 for non-admin user", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/users", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${USER_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "New User" }),
      });
      expect(response.status).toBe(403);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });

    it("creates user with admin token", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/users", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "New Test User",
          slug: "new-test-user",
          is_admin: false,
        }),
      });
      expect(response.status).toBe(201);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("id");
      expect(data.name).toBe("New Test User");
      expect(data.slug).toBe("new-test-user");
      expect(data.isAdmin).toBe(false);
    });

    it("returns 400 for missing name", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/users", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ slug: "no-name" }),
      });
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });

    it("returns 409 for duplicate slug", async () => {
      // Create a user with a specific slug
      const firstCreate = await SELF.fetch("https://example.com/api/v1/ui/users", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "User A",
          slug: "unique-slug-xyz",
        }),
      });
      expect(firstCreate.status).toBe(201);

      // Try to create another with same slug
      const secondCreate = await SELF.fetch("https://example.com/api/v1/ui/users", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "User B",
          slug: "unique-slug-xyz",
        }),
      });
      expect(secondCreate.status).toBe(409);
      const data = (await secondCreate.json()) as Record<string, unknown>;
      expect(String(data.error)).toMatch(/slug/i);
    });
  });

  describe("PATCH /api/v1/ui/users/:id", () => {
    it("returns 403 for non-admin user", async () => {
      const response = await SELF.fetch(`https://example.com/api/v1/ui/users/${adminUserId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${USER_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Updated Name" }),
      });
      expect(response.status).toBe(403);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });

    it("updates user with admin token", async () => {
      const createResponse = await SELF.fetch("https://example.com/api/v1/ui/users", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Patch Target User" }),
      });
      expect(createResponse.status).toBe(201);
      const createData = (await createResponse.json()) as Record<string, unknown>;

      const response = await SELF.fetch(`https://example.com/api/v1/ui/users/${createData.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Updated Regular User",
          is_admin: true,
        }),
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.name).toBe("Updated Regular User");
      expect(data.isAdmin).toBe(true);
    });

    it("returns 404 for non-existent user", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/users/nonexistent-id", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Updated Name" }),
      });
      expect(response.status).toBe(404);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });

    it("returns 400 for missing id parameter", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/users/", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Updated" }),
      });
      expect(response.status).toBe(404); // Hono returns 404 for missing route param
    });
  });

  describe("POST /api/v1/ui/users/:id/tokens", () => {
    it("returns 403 for non-admin user", async () => {
      const response = await SELF.fetch(
        `https://example.com/api/v1/ui/users/${regularUserId}/tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${USER_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
      );
      expect(response.status).toBe(403);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });

    it("creates token for user with admin token", async () => {
      const response = await SELF.fetch(
        `https://example.com/api/v1/ui/users/${regularUserId}/tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
      );
      expect(response.status).toBe(201);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("id");
      expect(data).toHaveProperty("token");
      expect(data).toHaveProperty("created_at");
      // Token should be plaintext at creation
      expect(typeof data.token).toBe("string");
      expect((data.token as string).length).toBeGreaterThan(0);
    });

    it("returns 404 for non-existent user", async () => {
      const response = await SELF.fetch(
        "https://example.com/api/v1/ui/users/nonexistent-id/tokens",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
      );
      expect(response.status).toBe(404);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });
  });

  describe("GET /api/v1/ui/users/:id/tokens", () => {
    it("returns 401 without authorization", async () => {
      const response = await SELF.fetch(
        `https://example.com/api/v1/ui/users/${adminUserId}/tokens`,
      );
      expect(response.status).toBe(401);
    });

    it("allows admin user to list any user's tokens", async () => {
      const response = await SELF.fetch(
        `https://example.com/api/v1/ui/users/${regularUserId}/tokens`,
        {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        },
      );
      expect(response.status).toBe(200);
      const data = (await response.json()) as unknown[];
      expect(Array.isArray(data)).toBe(true);
      if (data.length > 0) {
        const token = data[0] as Record<string, unknown>;
        expect(token).toHaveProperty("id");
        expect(token).toHaveProperty("createdAt");
        expect(token).toHaveProperty("lastUsedAt");
        // Should NOT include plaintext token
        expect(token).not.toHaveProperty("token");
      }
    });

    it("allows non-admin user to list own tokens", async () => {
      const response = await SELF.fetch(
        `https://example.com/api/v1/ui/users/${regularUserId}/tokens`,
        {
          headers: { Authorization: `Bearer ${USER_TOKEN}` },
        },
      );
      expect(response.status).toBe(200);
      const data = (await response.json()) as unknown[];
      expect(Array.isArray(data)).toBe(true);
      if (data.length > 0) {
        const token = data[0] as Record<string, unknown>;
        expect(token).toHaveProperty("id");
        expect(token).toHaveProperty("createdAt");
        expect(token).toHaveProperty("lastUsedAt");
        // Should NOT include plaintext token
        expect(token).not.toHaveProperty("token");
      }
    });

    it("prevents non-admin user from listing other user's tokens", async () => {
      const response = await SELF.fetch(
        `https://example.com/api/v1/ui/users/${adminUserId}/tokens`,
        {
          headers: { Authorization: `Bearer ${USER_TOKEN}` },
        },
      );
      expect(response.status).toBe(403);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });

    it("returns 404 for non-existent user", async () => {
      const response = await SELF.fetch(
        "https://example.com/api/v1/ui/users/nonexistent-id/tokens",
        {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        },
      );
      expect(response.status).toBe(404);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
    });
  });

  describe("DELETE /api/v1/ui/tokens/:id", () => {
    let testTokenId: string;

    beforeAll(async () => {
      // Create a token to delete
      const response = await SELF.fetch(
        `https://example.com/api/v1/ui/users/${regularUserId}/tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
      );
      const data = (await response.json()) as Record<string, unknown>;
      testTokenId = String(data.id);
    });

    it("returns 403 for non-admin user", async () => {
      const response = await SELF.fetch(`https://example.com/api/v1/ui/tokens/${testTokenId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${USER_TOKEN}` },
      });
      expect(response.status).toBe(403);
    });

    it("revokes token with admin token", async () => {
      // Create another token to revoke
      const createResp = await SELF.fetch(
        `https://example.com/api/v1/ui/users/${regularUserId}/tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
      );
      const createData = (await createResp.json()) as Record<string, unknown>;
      const id = String(createData.id);

      const response = await SELF.fetch(`https://example.com/api/v1/ui/tokens/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toEqual({ ok: true });
    });

    it("returns 404 for non-existent token", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/tokens/nonexistent-token", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.status).toBe(404);
    });
  });

  describe("Authorization and authentication", () => {
    it("all routes return 401 without valid token", async () => {
      const routes = [
        ["GET", "/api/v1/ui/summary"],
        ["GET", "/api/v1/ui/metrics"],
        ["GET", "/api/v1/ui/users"],
        ["POST", "/api/v1/ui/users"],
        ["PATCH", `/api/v1/ui/users/${adminUserId}`],
        ["POST", `/api/v1/ui/users/${regularUserId}/tokens`],
        ["GET", `/api/v1/ui/users/${regularUserId}/tokens`],
        ["DELETE", "/api/v1/ui/tokens/some-token"],
      ] as const;

      for (const [method, path] of routes) {
        const response = await SELF.fetch(`https://example.com${path}`, {
          method,
          headers: { Authorization: "Bearer invalid-token" },
        });
        expect(response.status).toBe(401);
      }
    });

    it("returns proper JSON error responses", async () => {
      const response = await SELF.fetch("https://example.com/api/v1/ui/users", {
        headers: { Authorization: `Bearer ${USER_TOKEN}` },
      });
      expect(response.status).toBe(403);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("error");
      expect(typeof data.error).toBe("string");
    });
  });
});
