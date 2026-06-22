import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { createDb, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { beforeAll, describe, expect, it } from "vitest";

const ADMIN_TOKEN = "garmin-spike-admin-token";
const USER_TOKEN = "garmin-spike-user-token";

async function authFetch(token: string, body: Record<string, unknown> = {}) {
  return SELF.fetch("https://example.com/api/v1/ingestion/spikes/garmin", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Garmin Cloudflare egress spike route", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
    const db = createDb(env.DB);
    await db
      .insert(users)
      .values({ id: "user-garmin-spike-admin", name: "Garmin Spike Admin", isAdmin: true })
      .onConflictDoNothing();
    await db
      .insert(users)
      .values({ id: "user-garmin-spike-user", name: "Garmin Spike User", isAdmin: false })
      .onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-garmin-spike-admin",
        userId: "user-garmin-spike-admin",
        tokenHash: await hashToken(ADMIN_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-garmin-spike-user",
        userId: "user-garmin-spike-user",
        tokenHash: await hashToken(USER_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
  });

  it("requires authentication", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/ingestion/spikes/garmin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });

  it("requires admin access", async () => {
    const response = await authFetch(USER_TOKEN, {
      email: "garmin@example.com",
      password: "do-not-use",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "admin_required" });
  });

  it("validates credentials before invoking the container", async () => {
    const response = await authFetch(ADMIN_TOKEN, {});

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toEqual({ error: "missing Garmin email or password" });
  });
});
