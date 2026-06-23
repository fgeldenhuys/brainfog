import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { createDb, ingestionRuns, timeSeriesPoints, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { dispatchScheduledGarminRuns } from "../src/garmin";

const TOKEN_A = "garmin-token-a";
const TOKEN_B = "garmin-token-b";

async function authFetch(path: string, init: RequestInit = {}, token = TOKEN_A) {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}

async function createConnector(token = TOKEN_A, type = "garmin", status = "active") {
  return json<{ id: string; ownerId: string }>(
    await authFetch(
      "/api/v1/ingestion/connectors",
      {
        method: "POST",
        body: JSON.stringify({ type, name: `${type} connector`, status }),
      },
      token,
    ),
  );
}

async function pauseConnector(id: string, token = TOKEN_A) {
  await authFetch(
    `/api/v1/ingestion/connectors/${id}`,
    { method: "PATCH", body: JSON.stringify({ status: "paused" }) },
    token,
  );
}

function garminPayload() {
  return {
    cursor: { from: "2026-06-22", to: "2026-06-22" },
    daily: [
      {
        date: "2026-06-22",
        steps: 7500,
        resting_heart_rate: 52,
        sleep_seconds: 27_120,
        stress_avg: 28,
        body_battery_min: 35,
        body_battery_max: 88,
        active_calories: 620,
        intensity_minutes: 48,
      },
    ],
    activities: [
      {
        activity_id: "12345678901",
        activity_uuid: "activity-uuid-1",
        activity_name: "Morning Run",
        activity_type: "running",
        start_time: "2026-06-22T05:31:00Z",
        duration_seconds: 2765,
        moving_duration_seconds: 2700,
        distance_meters: 10_250,
        calories: 690,
        avg_heart_rate: 142,
        max_heart_rate: 176,
        elevation_gain_meters: 105,
        avg_speed_mps: 3.79,
        training_effect: 3.2,
      },
    ],
  };
}

describe("Garmin connector", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
    const db = createDb(env.DB);
    await db.insert(users).values({ id: "user-garmin-a", name: "Garmin A" }).onConflictDoNothing();
    await db.insert(users).values({ id: "user-garmin-b", name: "Garmin B" }).onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-garmin-a",
        userId: "user-garmin-a",
        tokenHash: await hashToken(TOKEN_A, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-garmin-b",
        userId: "user-garmin-b",
        tokenHash: await hashToken(TOKEN_B, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
  });

  it("requires auth and rejects unknown, non-Garmin, cross-user, and malformed payloads", async () => {
    const unauthenticated = await SELF.fetch(
      "https://example.com/api/v1/ingestion/connectors/missing/garmin-runs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(garminPayload()),
      },
    );
    expect(unauthenticated.status).toBe(401);

    const unknown = await authFetch("/api/v1/ingestion/connectors/missing/garmin-runs", {
      method: "POST",
      body: JSON.stringify(garminPayload()),
    });
    expect(unknown.status).toBe(404);

    const generic = await createConnector(TOKEN_A, "generic", "active");
    const nonGarmin = await authFetch(`/api/v1/ingestion/connectors/${generic.id}/garmin-runs`, {
      method: "POST",
      body: JSON.stringify(garminPayload()),
    });
    expect(nonGarmin.status).toBe(400);

    const garmin = await createConnector(TOKEN_A, "garmin", "active");
    const crossUser = await authFetch(
      `/api/v1/ingestion/connectors/${garmin.id}/garmin-runs`,
      { method: "POST", body: JSON.stringify(garminPayload()) },
      TOKEN_B,
    );
    expect(crossUser.status).toBe(404);

    const malformed = await authFetch(`/api/v1/ingestion/connectors/${garmin.id}/garmin-runs`, {
      method: "POST",
      body: JSON.stringify({
        ...garminPayload(),
        daily: [{ date: "2026-06-22", raw: { dump: true } }],
      }),
    });
    expect(malformed.status).toBe(400);
    await pauseConnector(garmin.id);
  });

  it("validates and normalizes daily and activity payloads, with idempotent replay counts", async () => {
    const connector = await createConnector(TOKEN_A, "garmin", "active");
    const run = await json<{
      id: string;
      insertedCount: number;
      skippedCount: number;
      status: string;
    }>(
      await authFetch(`/api/v1/ingestion/connectors/${connector.id}/garmin-runs`, {
        method: "POST",
        body: JSON.stringify(garminPayload()),
      }),
    );
    expect(run).toMatchObject({ status: "succeeded", insertedCount: 17, skippedCount: 0 });

    const db = createDb(env.DB);
    const rows = await db
      .select()
      .from(timeSeriesPoints)
      .where(
        and(
          eq(timeSeriesPoints.ownerId, "user-garmin-a"),
          inArray(timeSeriesPoints.seriesKey, [
            "garmin.daily.steps",
            "garmin.daily.sleep_hours",
            "garmin.activities.distance",
            "garmin.activities.avg_speed",
          ]),
        ),
      );
    expect(rows.find((row) => row.seriesKey === "garmin.daily.steps")).toMatchObject({
      value: 7500,
      unit: "count",
    });
    expect(rows.find((row) => row.seriesKey === "garmin.daily.sleep_hours")?.value).toBeCloseTo(
      7.5333,
      3,
    );
    expect(rows.find((row) => row.seriesKey === "garmin.activities.distance")).toMatchObject({
      value: 10250,
      unit: "m",
    });
    expect(
      rows.find((row) => row.seriesKey === "garmin.activities.avg_speed")?.metadata,
    ).toMatchObject({
      activity_id: "12345678901",
      activity_type: "running",
      activity_name: "Morning Run",
      connector_id: connector.id,
      connector_type: "garmin",
      source_system: "garmin",
    });

    const replay = await json<{ insertedCount: number; skippedCount: number; status: string }>(
      await authFetch(`/api/v1/ingestion/connectors/${connector.id}/garmin-runs`, {
        method: "POST",
        body: JSON.stringify(garminPayload()),
      }),
    );
    expect(replay).toMatchObject({ status: "succeeded", insertedCount: 0, skippedCount: 17 });

    await pauseConnector(connector.id);
  });

  it("supports dry-run/manual preview without writing time-series rows", async () => {
    const connector = await createConnector(TOKEN_A, "garmin", "active");
    const before = await createDb(env.DB)
      .select()
      .from(timeSeriesPoints)
      .where(eq(timeSeriesPoints.ownerId, "user-garmin-a"));
    const preview = await json<{ dry_run: boolean; point_count: number }>(
      await authFetch(`/api/v1/ingestion/connectors/${connector.id}/garmin-runs`, {
        method: "POST",
        body: JSON.stringify({ dry_run: true, runner_payload: garminPayload() }),
      }),
    );
    expect(preview).toMatchObject({ dry_run: true, point_count: 17 });
    const after = await createDb(env.DB)
      .select()
      .from(timeSeriesPoints)
      .where(eq(timeSeriesPoints.ownerId, "user-garmin-a"));
    expect(after).toHaveLength(before.length);
    await pauseConnector(connector.id);
  });

  it("scheduled dispatch runs once per active Garmin connector with isolated credentials", async () => {
    const a = await createConnector(TOKEN_A, "garmin", "active");
    const b = await createConnector(TOKEN_B, "garmin", "active");

    await authFetch(`/api/v1/ingestion/connectors/${a.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "garmin_session",
        payload: { username: "alice@example.com", token: "token-a" },
      }),
    });
    await authFetch(
      `/api/v1/ingestion/connectors/${b.id}/credentials`,
      {
        method: "PUT",
        body: JSON.stringify({
          auth_type: "garmin_session",
          payload: { username: "bob@example.com", token: "token-b" },
        }),
      },
      TOKEN_B,
    );

    const seen: Array<{ connectorId: string; username: unknown }> = [];
    const result = await dispatchScheduledGarminRuns(
      { env },
      async (_ctx, connector, credentials) => {
        seen.push({ connectorId: connector.id, username: credentials.username });
        return {
          ...garminPayload(),
          activities: [
            {
              ...(garminPayload().activities[0] as Record<string, unknown>),
              activity_id: connector.id,
            },
          ],
          refreshed_credentials: {
            username: credentials.username,
            token: `refreshed-${connector.id}`,
          },
        };
      },
    );

    expect(result.connector_count).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual(
      expect.arrayContaining([
        { connectorId: a.id, username: "alice@example.com" },
        { connectorId: b.id, username: "bob@example.com" },
      ]),
    );
    expect(
      result.results.map((item) => (item.run as { insertedCount: number }).insertedCount),
    ).toEqual([17, 17]);

    const aPoints = await createDb(env.DB)
      .select()
      .from(timeSeriesPoints)
      .where(
        and(
          eq(timeSeriesPoints.ownerId, "user-garmin-a"),
          eq(timeSeriesPoints.seriesKey, "garmin.activities.duration"),
        ),
      );
    const bPoints = await createDb(env.DB)
      .select()
      .from(timeSeriesPoints)
      .where(
        and(
          eq(timeSeriesPoints.ownerId, "user-garmin-b"),
          eq(timeSeriesPoints.seriesKey, "garmin.activities.duration"),
        ),
      );
    expect(aPoints.some((point) => point.metadata?.connector_id === a.id)).toBe(true);
    expect(bPoints.some((point) => point.metadata?.connector_id === b.id)).toBe(true);
  });

  it("scheduled dispatch records sanitized failures per connector and continues", async () => {
    const a = await createConnector(TOKEN_A, "garmin", "active");
    const b = await createConnector(TOKEN_B, "garmin", "active");

    await authFetch(`/api/v1/ingestion/connectors/${a.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "garmin_session",
        payload: { username: "leaky-alice@example.com", password: "secret-a", token: "token-a" },
      }),
    });
    await authFetch(
      `/api/v1/ingestion/connectors/${b.id}/credentials`,
      {
        method: "PUT",
        body: JSON.stringify({
          auth_type: "garmin_session",
          payload: { username: "safe-bob@example.com", password: "secret-b", token: "token-b" },
        }),
      },
      TOKEN_B,
    );

    const result = await dispatchScheduledGarminRuns(
      { env },
      async (_ctx, connector, credentials) => {
        if (connector.id === a.id) {
          throw new Error(
            `login failed for ${credentials.username} password=${credentials.password} token=${credentials.token}`,
          );
        }
        return {
          ...garminPayload(),
          activities: [
            {
              ...(garminPayload().activities[0] as Record<string, unknown>),
              activity_id: connector.id,
            },
          ],
        };
      },
    );

    expect(result.connector_count).toBeGreaterThanOrEqual(2);
    const failed = result.results.find((item) => item.connector_id === a.id)?.run as {
      status: string;
      error: { message: string };
      failedCount: number;
    };
    const succeeded = result.results.find((item) => item.connector_id === b.id)?.run as {
      status: string;
      insertedCount: number;
    };
    expect(failed).toMatchObject({ status: "failed", failedCount: 1 });
    expect(failed.error.message).not.toContain("leaky-alice@example.com");
    expect(failed.error.message).not.toContain("secret-a");
    expect(failed.error.message).not.toContain("token-a");
    expect(succeeded).toMatchObject({ status: "succeeded", insertedCount: 17 });

    const rows = await createDb(env.DB)
      .select()
      .from(ingestionRuns)
      .where(eq(ingestionRuns.connectorId, a.id));
    expect(rows.some((row) => row.status === "failed" && row.error?.message)).toBe(true);
  });
});
