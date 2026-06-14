import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { createDb, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { beforeAll, describe, expect, it } from "vitest";

const VALID_TOKEN = "test-token-12345";

describe("GET /api/v1/whoami", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);

    const db = createDb(env.DB);
    await db.insert(users).values({ id: "user-1", name: "Ada Lovelace" });
    await db.insert(tokens).values({
      id: "token-1",
      userId: "user-1",
      tokenHash: await hashToken(VALID_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });
  });

  it("returns 401 when no Authorization header is present", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/whoami");
    expect(response.status).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/whoami", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(response.status).toBe(401);
  });

  it("returns the authenticated user for a valid token", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/whoami", {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "user-1",
      name: "Ada Lovelace",
      self_person_id: null,
      self_person: null,
    });
  });
});
