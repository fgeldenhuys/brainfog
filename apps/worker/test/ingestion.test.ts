import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { createDb, ingestionIdempotencyKeys, timeSeriesPoints, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

const TOKEN_A = "ingestion-token-a";
const TOKEN_B = "ingestion-token-b";

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

describe("ingestion framework", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
    const db = createDb(env.DB);
    await db
      .insert(users)
      .values({ id: "user-ingestion-a", name: "Ingestion A" })
      .onConflictDoNothing();
    await db
      .insert(users)
      .values({ id: "user-ingestion-b", name: "Ingestion B" })
      .onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-ingestion-a",
        userId: "user-ingestion-a",
        tokenHash: await hashToken(TOKEN_A, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-ingestion-b",
        userId: "user-ingestion-b",
        tokenHash: await hashToken(TOKEN_B, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
  });

  it("creates, lists, and owner-scopes connector definitions", async () => {
    const connector = await json<{ id: string; ownerId: string; source: string; status: string }>(
      await authFetch("/api/v1/ingestion/connectors", {
        method: "POST",
        body: JSON.stringify({
          type: "bridge",
          name: "Generic bridge",
          config: { window: "daily" },
        }),
      }),
    );
    expect(connector).toMatchObject({
      ownerId: "user-ingestion-a",
      source: "ingestion:bridge",
      status: "active",
    });

    const visible = await json<Array<{ id: string }>>(
      await authFetch("/api/v1/ingestion/connectors"),
    );
    expect(visible.map((row) => row.id)).toContain(connector.id);

    const hidden = await json<Array<{ id: string }>>(
      await authFetch("/api/v1/ingestion/connectors", {}, TOKEN_B),
    );
    expect(hidden.map((row) => row.id)).not.toContain(connector.id);

    const forbiddenUpdate = await authFetch(
      `/api/v1/ingestion/connectors/${connector.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "paused" }) },
      TOKEN_B,
    );
    expect(forbiddenUpdate.status).toBe(404);
  });

  it("records run lifecycle, provenance, connector cursor, and idempotent skips", async () => {
    const connector = await json<{ id: string }>(
      await authFetch("/api/v1/ingestion/connectors", {
        method: "POST",
        body: JSON.stringify({ type: "generic", name: "Metrics bridge" }),
      }),
    );
    const run = await json<{
      id: string;
      status: string;
      trigger: string;
      insertedCount: number;
      skippedCount: number;
    }>(
      await authFetch(`/api/v1/ingestion/connectors/${connector.id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          trigger: "bridge",
          cursor_after: { last: "2026-06-22" },
          metadata: { submitted_by: "test" },
          points: [
            {
              source_item_id: "source-1",
              series_key: "generic.steps",
              value: 123,
              unit: "count",
              observed_at: 1782086400,
              metadata: { external_id: "source-1" },
            },
          ],
        }),
      }),
    );
    expect(run).toMatchObject({
      status: "succeeded",
      trigger: "bridge",
      insertedCount: 1,
      skippedCount: 0,
    });

    const points = await createDb(env.DB)
      .select()
      .from(timeSeriesPoints)
      .where(eq(timeSeriesPoints.seriesKey, "generic.steps"));
    const point = points.find((row) => row.metadata?.ingestion_run_id === run.id);
    expect(point).toMatchObject({
      ownerId: "user-ingestion-a",
      source: "ingestion:generic",
      value: 123,
    });
    expect(point?.metadata).toMatchObject({
      connector_id: connector.id,
      connector_type: "generic",
      ingestion_run_id: run.id,
      external_id: "source-1",
    });

    const replay = await json<{ status: string; insertedCount: number; skippedCount: number }>(
      await authFetch(`/api/v1/ingestion/connectors/${connector.id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          trigger: "bridge",
          points: [
            {
              source_item_id: "source-1",
              series_key: "generic.steps",
              value: 123,
              unit: "count",
              observed_at: 1782086400,
            },
          ],
        }),
      }),
    );
    expect(replay).toMatchObject({ status: "succeeded", insertedCount: 0, skippedCount: 1 });

    const runs = await json<Array<{ id: string }>>(
      await authFetch(`/api/v1/ingestion/connectors/${connector.id}/runs`),
    );
    expect(runs.map((row) => row.id)).toEqual(expect.arrayContaining([run.id]));

    const connectors = await json<
      Array<{ id: string; cursor: Record<string, unknown>; lastSuccessAt: string }>
    >(await authFetch("/api/v1/ingestion/connectors"));
    expect(connectors.find((row) => row.id === connector.id)?.cursor).toEqual({
      last: "2026-06-22",
    });
  });

  it("atomically contests idempotency during overlapping replay", async () => {
    const connector = await json<{ id: string }>(
      await authFetch("/api/v1/ingestion/connectors", {
        method: "POST",
        body: JSON.stringify({ type: "atomic", name: "Atomic replay bridge" }),
      }),
    );
    const payload = {
      trigger: "bridge",
      points: [
        {
          source_item_id: "atomic-source-1",
          series_key: "atomic.metric",
          value: 42,
          unit: "count",
          observed_at: 1782172800,
          metadata: { external_id: "atomic-source-1" },
        },
      ],
    };

    const runRequest = () =>
      authFetch(`/api/v1/ingestion/connectors/${connector.id}/runs`, {
        method: "POST",
        body: JSON.stringify(payload),
      }).then((response) =>
        json<{ status: string; insertedCount: number; skippedCount: number }>(response),
      );
    const [first, second] = await Promise.all([runRequest(), runRequest()]);

    expect([first.status, second.status]).toEqual(["succeeded", "succeeded"]);
    expect(first.insertedCount + second.insertedCount).toBe(1);
    expect(first.skippedCount + second.skippedCount).toBe(1);

    const points = await createDb(env.DB)
      .select()
      .from(timeSeriesPoints)
      .where(eq(timeSeriesPoints.seriesKey, "atomic.metric"));
    expect(points).toHaveLength(1);

    const keys = await createDb(env.DB)
      .select()
      .from(ingestionIdempotencyKeys)
      .where(eq(ingestionIdempotencyKeys.connectorId, connector.id));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toMatch(/^bf[0-9abcdefghjkmnpqrstvwxyz]{20}i$/);
    expect(keys[0]?.timeSeriesPointId).toBe(points[0]?.id);
  });

  it("records sanitized failed runs without partial time-series writes", async () => {
    const project = await json<{ id: string }>(
      await authFetch("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Ingestion project" }),
      }),
    );
    const connector = await json<{ id: string }>(
      await authFetch("/api/v1/ingestion/connectors", {
        method: "POST",
        body: JSON.stringify({ type: "failure", name: "Failure bridge" }),
      }),
    );
    const run = await json<{ status: string; failedCount: number; error: { message: string } }>(
      await authFetch(`/api/v1/ingestion/connectors/${connector.id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          points: [
            {
              source_item_id: "valid-before-invalid",
              series_key: "failure.metric",
              value: 1,
              project_id: project.id,
              observed_at: 1782086400,
            },
            {
              source_item_id: "invalid-project",
              series_key: "failure.metric",
              value: 2,
              project_id: "missing-project",
              observed_at: 1782086401,
            },
          ],
        }),
      }),
    );
    expect(run.status).toBe("failed");
    expect(run.failedCount).toBe(2);
    expect(run.error.message).toBe("project not found");
    expect(JSON.stringify(run.error)).not.toContain("stack");

    const points = await createDb(env.DB)
      .select()
      .from(timeSeriesPoints)
      .where(eq(timeSeriesPoints.seriesKey, "failure.metric"));
    expect(points).toHaveLength(0);
  });
});
