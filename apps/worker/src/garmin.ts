import { createDb, ingestionConnectors, ingestionRuns, users } from "@brainfog/db";
import { getContainer } from "@cloudflare/containers";
import { and, eq } from "drizzle-orm";
import { createOrReplaceConnectorCredentials, decryptConnectorCredentials } from "./credentials";
import type { Env } from "./env";
import { getConnector, recordIngestionRun } from "./ingestion";
import type { MemoryCtx, MemoryUser } from "./memory";
import { createId, MemoryError } from "./memory";

const DAILY_FIELDS = new Set([
  "date",
  "steps",
  "resting_heart_rate",
  "sleep_seconds",
  "stress_avg",
  "body_battery_min",
  "body_battery_max",
  "active_calories",
  "intensity_minutes",
]);

const ACTIVITY_FIELDS = new Set([
  "activity_id",
  "activity_uuid",
  "activity_name",
  "activity_type",
  "start_time",
  "duration_seconds",
  "moving_duration_seconds",
  "distance_meters",
  "calories",
  "avg_heart_rate",
  "max_heart_rate",
  "elevation_gain_meters",
  "avg_speed_mps",
  "training_effect",
]);

const TOP_LEVEL_FIELDS = new Set([
  "cursor",
  "daily",
  "activities",
  "refreshed_credentials",
  "credential_status",
]);

const REFRESHED_CREDENTIAL_FIELDS = new Set([
  "username",
  "email",
  "password",
  "token",
  "tokens",
  "tokenstore",
  "oauth1",
  "oauth2",
  "session",
  "cookies",
  "expires_at",
]);

const SENSITIVE_KEY_PATTERN =
  /(username|email|password|passwd|pwd|token|session|cookie|authorization|bearer)/i;

type GarminDaily = {
  date: string;
  steps?: number;
  resting_heart_rate?: number;
  sleep_seconds?: number;
  stress_avg?: number;
  body_battery_min?: number;
  body_battery_max?: number;
  active_calories?: number;
  intensity_minutes?: number;
};

type GarminActivity = {
  activity_id: string;
  activity_uuid?: string;
  activity_name?: string;
  activity_type?: string;
  start_time: string;
  duration_seconds?: number;
  moving_duration_seconds?: number;
  distance_meters?: number;
  calories?: number;
  avg_heart_rate?: number;
  max_heart_rate?: number;
  elevation_gain_meters?: number;
  avg_speed_mps?: number;
  training_effect?: number;
};

type GarminPayload = {
  cursor?: Record<string, unknown> | null;
  daily: GarminDaily[];
  activities: GarminActivity[];
  refreshed_credentials?: Record<string, unknown>;
  credential_status?: string;
};

type GarminRunner = (
  ctx: MemoryCtx,
  connector: { id: string; cursor: Record<string, unknown> | null },
  credentials: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

function unixSeconds(value: Date) {
  return Math.floor(value.getTime() / 1000);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectSensitiveValues(value: unknown): string[] {
  if (!isObject(value) && !Array.isArray(value)) return [];
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  const secrets: string[] = [];
  for (const [key, child] of entries) {
    const keyText = String(key);
    if (SENSITIVE_KEY_PATTERN.test(keyText) && typeof child === "string" && child.length >= 3) {
      secrets.push(child);
      continue;
    }
    secrets.push(...collectSensitiveValues(child));
  }
  return secrets;
}

function scrubSensitiveText(value: unknown, ...secretSources: unknown[]) {
  let text = value instanceof Error ? value.message : String(value || "garmin runner failed");
  for (const source of secretSources) {
    for (const secret of collectSensitiveValues(source))
      text = text.split(secret).join("[redacted]");
  }
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
  text = text.replace(
    /(password|passwd|pwd|token|session|cookie|authorization|bearer)(\s*[=:]\s*)[^\s,;]+/gi,
    "$1$2[redacted]",
  );
  return text.slice(0, 500);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, name: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new MemoryError(400, `${name} contains unsupported field: ${key}`);
  }
}

function refreshedCredentials(value: unknown) {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new MemoryError(400, "refreshed_credentials must be an object");
  assertKnownKeys(value, REFRESHED_CREDENTIAL_FIELDS, "refreshed_credentials");
  if (JSON.stringify(value).length > 20_000) {
    throw new MemoryError(400, "refreshed_credentials is too large");
  }
  return value;
}

function finiteMetric(value: unknown, name: string, { integer = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MemoryError(400, `${name} must be a finite number`);
  }
  if (integer && !Number.isInteger(value)) throw new MemoryError(400, `${name} must be an integer`);
  if (value < 0) throw new MemoryError(400, `${name} must be non-negative`);
  return value;
}

function stringField(value: unknown, name: string, max = 120) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new MemoryError(400, `${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new MemoryError(400, `${name} must not be empty`);
  if (trimmed.length > max) throw new MemoryError(400, `${name} is too long`);
  return trimmed;
}

function requiredString(value: unknown, name: string, max = 120) {
  const parsed = stringField(value, name, max);
  if (!parsed) throw new MemoryError(400, `missing ${name}`);
  return parsed;
}

function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new MemoryError(400, "date must be YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new MemoryError(400, "date must be a valid calendar date");
  }
  return date;
}

function assertIsoTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new MemoryError(400, "start_time must be an ISO timestamp");
  return date;
}

function validatePayload(input: Record<string, unknown>): GarminPayload {
  assertKnownKeys(input, TOP_LEVEL_FIELDS, "garmin payload");
  const dailyRaw = input.daily ?? [];
  const activitiesRaw = input.activities ?? [];
  if (!Array.isArray(dailyRaw)) throw new MemoryError(400, "daily must be an array");
  if (!Array.isArray(activitiesRaw)) throw new MemoryError(400, "activities must be an array");
  if (dailyRaw.length > 31) throw new MemoryError(400, "daily contains too many entries");
  if (activitiesRaw.length > 100)
    throw new MemoryError(400, "activities contains too many entries");
  const daily = dailyRaw.map((entry, index) => {
    if (!isObject(entry)) throw new MemoryError(400, `daily[${index}] must be an object`);
    assertKnownKeys(entry, DAILY_FIELDS, `daily[${index}]`);
    const date = requiredString(entry.date, "date", 10);
    assertDate(date);
    return {
      date,
      steps: finiteMetric(entry.steps, "steps", { integer: true }),
      resting_heart_rate: finiteMetric(entry.resting_heart_rate, "resting_heart_rate"),
      sleep_seconds: finiteMetric(entry.sleep_seconds, "sleep_seconds"),
      stress_avg: finiteMetric(entry.stress_avg, "stress_avg"),
      body_battery_min: finiteMetric(entry.body_battery_min, "body_battery_min"),
      body_battery_max: finiteMetric(entry.body_battery_max, "body_battery_max"),
      active_calories: finiteMetric(entry.active_calories, "active_calories"),
      intensity_minutes: finiteMetric(entry.intensity_minutes, "intensity_minutes"),
    };
  });
  const activities = activitiesRaw.map((entry, index) => {
    if (!isObject(entry)) throw new MemoryError(400, `activities[${index}] must be an object`);
    assertKnownKeys(entry, ACTIVITY_FIELDS, `activities[${index}]`);
    const startTime = requiredString(entry.start_time, "start_time", 40);
    assertIsoTime(startTime);
    return {
      activity_id: requiredString(entry.activity_id, "activity_id", 80),
      activity_uuid: stringField(entry.activity_uuid, "activity_uuid", 120),
      activity_name: stringField(entry.activity_name, "activity_name", 200),
      activity_type: stringField(entry.activity_type, "activity_type", 80),
      start_time: startTime,
      duration_seconds: finiteMetric(entry.duration_seconds, "duration_seconds"),
      moving_duration_seconds: finiteMetric(
        entry.moving_duration_seconds,
        "moving_duration_seconds",
      ),
      distance_meters: finiteMetric(entry.distance_meters, "distance_meters"),
      calories: finiteMetric(entry.calories, "calories"),
      avg_heart_rate: finiteMetric(entry.avg_heart_rate, "avg_heart_rate"),
      max_heart_rate: finiteMetric(entry.max_heart_rate, "max_heart_rate"),
      elevation_gain_meters: finiteMetric(entry.elevation_gain_meters, "elevation_gain_meters"),
      avg_speed_mps: finiteMetric(entry.avg_speed_mps, "avg_speed_mps"),
      training_effect: finiteMetric(entry.training_effect, "training_effect"),
    };
  });
  return {
    cursor: input.cursor === undefined ? undefined : objectOrNull(input.cursor, "cursor"),
    daily,
    activities,
    refreshed_credentials: refreshedCredentials(input.refreshed_credentials),
    credential_status:
      input.credential_status === undefined
        ? undefined
        : requiredString(input.credential_status, "credential_status", 40),
  };
}

function objectOrNull(value: unknown, name: string) {
  if (value === null) return null;
  if (!isObject(value)) throw new MemoryError(400, `${name} must be an object`);
  return value;
}

function pushMetric(
  points: Array<Record<string, unknown>>,
  sourceItemId: string,
  seriesKey: string,
  value: number | undefined,
  unit: string,
  observedAt: number,
  metadata: Record<string, unknown>,
) {
  if (value === undefined) return;
  points.push({
    source_item_id: sourceItemId,
    series_key: seriesKey,
    value,
    unit,
    observed_at: observedAt,
    metadata,
  });
}

export function normalizeGarminPayload(input: Record<string, unknown>) {
  const payload = validatePayload(input);
  const points: Array<Record<string, unknown>> = [];

  for (const day of payload.daily) {
    const observedAt = unixSeconds(assertDate(day.date));
    const metadata = { external_date: day.date, source_system: "garmin" };
    pushMetric(
      points,
      `daily:${day.date}`,
      "garmin.daily.steps",
      day.steps,
      "count",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `daily:${day.date}`,
      "garmin.daily.resting_heart_rate",
      day.resting_heart_rate,
      "bpm",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `daily:${day.date}`,
      "garmin.daily.sleep_hours",
      day.sleep_seconds === undefined ? undefined : day.sleep_seconds / 3600,
      "h",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `daily:${day.date}`,
      "garmin.daily.stress_avg",
      day.stress_avg,
      "score",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `daily:${day.date}`,
      "garmin.daily.body_battery_min",
      day.body_battery_min,
      "score",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `daily:${day.date}`,
      "garmin.daily.body_battery_max",
      day.body_battery_max,
      "score",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `daily:${day.date}`,
      "garmin.daily.active_calories",
      day.active_calories,
      "kcal",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `daily:${day.date}`,
      "garmin.daily.intensity_minutes",
      day.intensity_minutes,
      "min",
      observedAt,
      metadata,
    );
  }

  for (const activity of payload.activities) {
    const observedAt = unixSeconds(assertIsoTime(activity.start_time));
    const metadata = {
      external_activity_id: activity.activity_id,
      activity_id: activity.activity_id,
      activity_uuid: activity.activity_uuid,
      activity_name: activity.activity_name,
      activity_type: activity.activity_type,
      start_time: activity.start_time,
      source_system: "garmin",
    };
    pushMetric(
      points,
      `activity:${activity.activity_id}`,
      "garmin.activities.duration",
      activity.duration_seconds,
      "s",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `activity:${activity.activity_id}`,
      "garmin.activities.moving_duration",
      activity.moving_duration_seconds,
      "s",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `activity:${activity.activity_id}`,
      "garmin.activities.distance",
      activity.distance_meters,
      "m",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `activity:${activity.activity_id}`,
      "garmin.activities.calories",
      activity.calories,
      "kcal",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `activity:${activity.activity_id}`,
      "garmin.activities.avg_heart_rate",
      activity.avg_heart_rate,
      "bpm",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `activity:${activity.activity_id}`,
      "garmin.activities.max_heart_rate",
      activity.max_heart_rate,
      "bpm",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `activity:${activity.activity_id}`,
      "garmin.activities.elevation_gain",
      activity.elevation_gain_meters,
      "m",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `activity:${activity.activity_id}`,
      "garmin.activities.avg_speed",
      activity.avg_speed_mps,
      "m/s",
      observedAt,
      metadata,
    );
    pushMetric(
      points,
      `activity:${activity.activity_id}`,
      "garmin.activities.training_effect",
      activity.training_effect,
      "score",
      observedAt,
      metadata,
    );
  }

  return { payload, points };
}

export async function recordGarminRunnerPayload(
  ctx: MemoryCtx,
  connectorId: string,
  input: Record<string, unknown>,
  options: { trigger?: "manual" | "scheduled"; dryRun?: boolean } = {},
) {
  const connector = await getConnector(ctx, connectorId);
  if (connector.type !== "garmin")
    throw new MemoryError(400, "connector is not a Garmin connector");
  const { payload, points } = normalizeGarminPayload(input);
  if (options.dryRun)
    return { dry_run: true, point_count: points.length, points, cursor: payload.cursor };
  return recordIngestionRun(ctx, connectorId, {
    trigger: options.trigger ?? "manual",
    cursor_after: payload.cursor ?? connector.cursor,
    metadata: {
      connector_type: "garmin",
      garmin_payload_version: 1,
      daily_count: payload.daily.length,
      activity_count: payload.activities.length,
    },
    points,
  });
}

export async function invokeGarminContainer(
  env: Env,
  connector: { id: string; cursor: Record<string, unknown> | null },
  credentials: Record<string, unknown>,
) {
  if (!env.GARMIN_CONTAINER) throw new MemoryError(500, "garmin_container_missing");
  const container = getContainer(env.GARMIN_CONTAINER, `connector-${connector.id}`);
  const response = await container.fetch("https://garmin-runner.local/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credentials, cursor: connector.cursor }),
  });
  const result = (await response.json().catch(() => ({ error: "container_error" }))) as Record<
    string,
    unknown
  >;
  if (!response.ok)
    throw new MemoryError(
      502,
      scrubSensitiveText(result.error ?? "garmin_runner_failed", credentials, result),
    );
  return result;
}

async function recordFailedScheduledGarminRun(
  ctx: MemoryCtx,
  connector: typeof ingestionConnectors.$inferSelect,
  error: unknown,
  secretSource?: unknown,
) {
  const db = createDb(ctx.env.DB);
  const timestamp = new Date();
  const sanitized = { message: scrubSensitiveText(error, secretSource) };
  const run = {
    id: createId("ingestionRun"),
    ownerId: ctx.user.id,
    connectorId: connector.id,
    source: connector.source,
    trigger: "scheduled",
    status: "failed",
    startedAt: timestamp,
    finishedAt: timestamp,
    cursorBefore: connector.cursor,
    cursorAfter: connector.cursor,
    insertedCount: 0,
    skippedCount: 0,
    failedCount: 1,
    error: sanitized,
    metadata: { connector_type: "garmin", garmin_payload_version: 1 },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await db.insert(ingestionRuns).values(run);
  await db
    .update(ingestionConnectors)
    .set({ lastRunAt: timestamp, lastError: sanitized.message, updatedAt: timestamp })
    .where(eq(ingestionConnectors.id, connector.id));
  return run;
}

export async function dispatchScheduledGarminRuns(
  ctx: { env: Env },
  runner: GarminRunner = async (runCtx, connector, credentials) =>
    invokeGarminContainer(runCtx.env, connector, credentials),
) {
  const db = createDb(ctx.env.DB);
  const rows = await db
    .select({ connector: ingestionConnectors, user: users })
    .from(ingestionConnectors)
    .innerJoin(users, eq(users.id, ingestionConnectors.ownerId))
    .where(and(eq(ingestionConnectors.type, "garmin"), eq(ingestionConnectors.status, "active")));

  const results = [];
  for (const row of rows) {
    const user: MemoryUser = {
      id: row.user.id,
      name: row.user.name,
      selfPersonId: row.user.selfPersonId,
      slug: row.user.slug,
      isAdmin: row.user.isAdmin,
    };
    const runCtx: MemoryCtx = { env: ctx.env, user, source: "ingestion:garmin:scheduled" };
    let secretSource: unknown;
    try {
      const credentials = await decryptConnectorCredentials(runCtx, row.connector.id);
      secretSource = credentials.payload;
      const runnerPayload = await runner(
        runCtx,
        row.connector,
        credentials.payload as Record<string, unknown>,
      );
      const run = await recordGarminRunnerPayload(runCtx, row.connector.id, runnerPayload, {
        trigger: "scheduled",
      });
      const normalized = normalizeGarminPayload(runnerPayload);
      if (normalized.payload.refreshed_credentials) {
        await createOrReplaceConnectorCredentials(runCtx, row.connector.id, {
          auth_type: "garmin_session",
          payload: normalized.payload.refreshed_credentials,
          status: normalized.payload.credential_status ?? "valid",
        });
      }
      results.push({ connector_id: row.connector.id, run });
    } catch (error) {
      const run = await recordFailedScheduledGarminRun(runCtx, row.connector, error, secretSource);
      results.push({ connector_id: row.connector.id, run });
    }
  }
  return { connector_count: rows.length, results };
}
