import { createDb, ingestionConnectors, ingestionRuns, projects } from "@brainfog/db";
import { and, desc, eq, or } from "drizzle-orm";
import { createId, type MemoryCtx, MemoryError, validateTimeSeriesPointsInput } from "./memory";

const connectorStatuses = ["active", "paused", "disabled"] as const;
const runTriggers = ["manual", "scheduled", "bridge"] as const;

function now() {
  return new Date();
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryError(400, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nullableJsonObject(value: unknown, name: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  return jsonObject(value, name);
}

function connectorStatus(value: unknown) {
  const status = value === undefined ? "active" : String(value);
  if (!(connectorStatuses as readonly string[]).includes(status)) {
    throw new MemoryError(400, "invalid connector status");
  }
  return status;
}

function runTrigger(value: unknown) {
  const trigger = value === undefined ? "manual" : String(value);
  if (!(runTriggers as readonly string[]).includes(trigger)) {
    throw new MemoryError(400, "invalid ingestion trigger");
  }
  return trigger;
}

function asDate(value: unknown) {
  if (value === undefined || value === null) return new Date();
  if (typeof value === "number") return new Date(value * 1000);
  throw new MemoryError(400, "timestamp must be unix seconds");
}

function unixSeconds(value: Date) {
  return Math.floor(value.getTime() / 1000);
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "ingestion failed");
  return { message: message.slice(0, 500) };
}

async function ensureProject(ctx: MemoryCtx, id?: string | null) {
  if (!id) return;
  const row = (
    await createDb(ctx.env.DB)
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, id), or(eq(projects.ownerId, ctx.user.id), eq(projects.shared, true))),
      )
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "project not found");
}

async function getConnector(ctx: MemoryCtx, id: string) {
  const connector = (
    await createDb(ctx.env.DB)
      .select()
      .from(ingestionConnectors)
      .where(and(eq(ingestionConnectors.id, id), eq(ingestionConnectors.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!connector) throw new MemoryError(404, "ingestion connector not found");
  return connector;
}

export async function createIngestionConnector(ctx: MemoryCtx, input: Record<string, unknown>) {
  const type = String(input.type ?? "").trim();
  if (!type) throw new MemoryError(400, "missing connector type");
  const name = String(input.name ?? type).trim();
  if (!name) throw new MemoryError(400, "missing connector name");
  const projectId = (input.project_id as string | undefined) ?? null;
  await ensureProject(ctx, projectId);
  const timestamp = now();
  const row = {
    id: createId("ingestionConnector"),
    ownerId: ctx.user.id,
    projectId,
    source: String(input.source ?? `ingestion:${type}`),
    type,
    name,
    status: connectorStatus(input.status),
    config: jsonObject(input.config, "config"),
    schedule: nullableJsonObject(input.schedule, "schedule"),
    cursor: nullableJsonObject(input.cursor, "cursor"),
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await createDb(ctx.env.DB).insert(ingestionConnectors).values(row);
  return row;
}

export async function listIngestionConnectors(ctx: MemoryCtx) {
  return createDb(ctx.env.DB)
    .select()
    .from(ingestionConnectors)
    .where(eq(ingestionConnectors.ownerId, ctx.user.id))
    .orderBy(desc(ingestionConnectors.createdAt));
}

export async function updateIngestionConnector(
  ctx: MemoryCtx,
  id: string,
  input: Record<string, unknown>,
) {
  const existing = await getConnector(ctx, id);
  const projectId = Object.hasOwn(input, "project_id")
    ? ((input.project_id as string | null | undefined) ?? null)
    : existing.projectId;
  await ensureProject(ctx, projectId);
  const patch = {
    projectId,
    source: input.source === undefined ? existing.source : String(input.source),
    type: input.type === undefined ? existing.type : String(input.type),
    name: input.name === undefined ? existing.name : String(input.name),
    status: input.status === undefined ? existing.status : connectorStatus(input.status),
    config: input.config === undefined ? existing.config : jsonObject(input.config, "config"),
    schedule:
      input.schedule === undefined
        ? existing.schedule
        : nullableJsonObject(input.schedule, "schedule"),
    cursor:
      input.cursor === undefined ? existing.cursor : nullableJsonObject(input.cursor, "cursor"),
    updatedAt: now(),
  };
  await createDb(ctx.env.DB)
    .update(ingestionConnectors)
    .set(patch)
    .where(and(eq(ingestionConnectors.id, id), eq(ingestionConnectors.ownerId, ctx.user.id)));
  return getConnector(ctx, id);
}

export async function listIngestionRuns(ctx: MemoryCtx, connectorId: string) {
  await getConnector(ctx, connectorId);
  return createDb(ctx.env.DB)
    .select()
    .from(ingestionRuns)
    .where(and(eq(ingestionRuns.ownerId, ctx.user.id), eq(ingestionRuns.connectorId, connectorId)))
    .orderBy(desc(ingestionRuns.startedAt));
}

function sourceItemId(point: Record<string, unknown>) {
  const metadata = (point.metadata ?? {}) as Record<string, unknown>;
  const raw =
    point.source_item_id ?? metadata.source_item_id ?? metadata.external_id ?? metadata.id;
  const id = String(raw ?? "").trim();
  if (!id) throw new MemoryError(400, "missing source_item_id for ingestion point");
  return id;
}

type AtomicIngestionItem = {
  idempotencyKeyId: string;
  pointId: string;
  sourceItemId: string;
  seriesKey: string;
  observedAt: Date;
  point: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

async function insertIngestionPointsAtomically(
  ctx: MemoryCtx,
  connector: { id: string; source: string },
  runId: string,
  items: AtomicIngestionItem[],
) {
  if (items.length === 0) return [];

  const timestamp = unixSeconds(now());
  const statements = items.flatMap((item) => {
    const projectId = (item.point.project_id as string | undefined) ?? null;
    const value =
      item.point.value === undefined || item.point.value === null ? null : Number(item.point.value);
    const unit = (item.point.unit as string | undefined) ?? null;
    const observedAt = unixSeconds(item.observedAt);
    const metadata = JSON.stringify(item.metadata);
    return [
      ctx.env.DB.prepare(
        `insert or ignore into ingestion_idempotency_keys
          (id, owner_id, connector_id, source_item_id, series_key, observed_at, time_series_point_id, run_id, created_at)
          values (?, ?, ?, ?, ?, ?, null, ?, ?)`,
      ).bind(
        item.idempotencyKeyId,
        ctx.user.id,
        connector.id,
        item.sourceItemId,
        item.seriesKey,
        observedAt,
        runId,
        timestamp,
      ),
      ctx.env.DB.prepare(
        `insert into time_series_points
          (id, owner_id, project_id, source, series_key, value, unit, observed_at, metadata, shared, created_at, updated_at)
          select ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
          where exists (
            select 1 from ingestion_idempotency_keys
            where id = ? and time_series_point_id is null
          )`,
      ).bind(
        item.pointId,
        ctx.user.id,
        projectId,
        connector.source,
        item.seriesKey,
        value,
        unit,
        observedAt,
        metadata,
        timestamp,
        timestamp,
        item.idempotencyKeyId,
      ),
      ctx.env.DB.prepare(
        `update ingestion_idempotency_keys
          set time_series_point_id = ?
          where id = ? and time_series_point_id is null`,
      ).bind(item.pointId, item.idempotencyKeyId),
    ];
  });

  const results = await ctx.env.DB.batch(statements);
  return items
    .map((item, index) => ({ item, changes: results[index * 3 + 1]?.meta.changes ?? 0 }))
    .filter(({ changes }) => changes > 0)
    .map(({ item }) => ({
      id: item.pointId,
      ownerId: ctx.user.id,
      projectId: (item.point.project_id as string | undefined) ?? null,
      source: connector.source,
      seriesKey: item.seriesKey,
      value:
        item.point.value === undefined || item.point.value === null
          ? null
          : Number(item.point.value),
      unit: (item.point.unit as string | undefined) ?? null,
      observedAt: item.observedAt,
      metadata: item.metadata,
    }));
}

export async function recordIngestionRun(
  ctx: MemoryCtx,
  connectorId: string,
  input: Record<string, unknown>,
) {
  const db = createDb(ctx.env.DB);
  const connector = await getConnector(ctx, connectorId);
  if (connector.status !== "active")
    throw new MemoryError(400, "ingestion connector is not active");
  const points = input.points ?? [];
  if (!Array.isArray(points)) throw new MemoryError(400, "points must be an array");
  const pointInputs = points as Array<Record<string, unknown>>;
  const trigger = runTrigger(input.trigger);
  const startedAt = now();
  const cursorAfter = Object.hasOwn(input, "cursor_after")
    ? nullableJsonObject(input.cursor_after, "cursor_after")
    : connector.cursor;
  const run = {
    id: createId("ingestionRun"),
    ownerId: ctx.user.id,
    connectorId: connector.id,
    source: connector.source,
    trigger,
    status: "running",
    startedAt,
    finishedAt: null,
    cursorBefore: connector.cursor,
    cursorAfter,
    insertedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    error: null,
    metadata: jsonObject(input.metadata, "metadata"),
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  await db.insert(ingestionRuns).values(run);

  try {
    await validateTimeSeriesPointsInput(
      ctx,
      pointInputs.map((point) => ({
        ...point,
        project_id: point.project_id ?? connector.projectId ?? undefined,
      })),
    );
    const normalized = pointInputs.map((point) => {
      const metadata = jsonObject(point.metadata, "metadata");
      return {
        point,
        sourceItemId: sourceItemId(point),
        seriesKey: String(point.series_key ?? ""),
        observedAt: asDate(point.observed_at),
        metadata: {
          ...metadata,
          connector_id: connector.id,
          connector_type: connector.type,
          ingestion_run_id: run.id,
          source_system: connector.type,
        },
      };
    });
    const seenInPayload = new Set<string>();
    const uniqueNewItems = normalized.filter((item) => {
      const key = `${item.sourceItemId}\u0000${item.seriesKey}\u0000${item.observedAt.getTime()}`;
      if (seenInPayload.has(key)) return false;
      seenInPayload.add(key);
      return true;
    });
    const atomicItems = uniqueNewItems.map((item) => ({
      ...item,
      idempotencyKeyId: createId("ingestionIdempotencyKey"),
      pointId: createId("timeSeriesPoint"),
      point: {
        ...item.point,
        project_id: item.point.project_id ?? connector.projectId ?? undefined,
      },
    }));
    const inserted = await insertIngestionPointsAtomically(ctx, connector, run.id, atomicItems);
    const finishedAt = now();
    const skippedCount = normalized.length - inserted.length;
    await db
      .update(ingestionRuns)
      .set({
        status: "succeeded",
        finishedAt,
        insertedCount: inserted.length,
        skippedCount,
        failedCount: 0,
        updatedAt: finishedAt,
      })
      .where(eq(ingestionRuns.id, run.id));
    await db
      .update(ingestionConnectors)
      .set({
        cursor: run.cursorAfter,
        lastRunAt: startedAt,
        lastSuccessAt: finishedAt,
        lastError: null,
        updatedAt: finishedAt,
      })
      .where(eq(ingestionConnectors.id, connector.id));
  } catch (error) {
    const finishedAt = now();
    const sanitized = sanitizeError(error);
    await db
      .update(ingestionRuns)
      .set({
        status: "failed",
        finishedAt,
        failedCount: pointInputs.length,
        error: sanitized,
        updatedAt: finishedAt,
      })
      .where(eq(ingestionRuns.id, run.id));
    await db
      .update(ingestionConnectors)
      .set({ lastRunAt: startedAt, lastError: sanitized.message, updatedAt: finishedAt })
      .where(eq(ingestionConnectors.id, connector.id));
  }
  return (await db.select().from(ingestionRuns).where(eq(ingestionRuns.id, run.id)).limit(1))[0];
}
