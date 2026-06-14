import {
  createDb,
  dependencyEdges,
  documentChunks,
  documents,
  facts,
  people,
  projects,
  tasks,
  thoughts,
  timeSeriesPoints,
  users,
} from "@brainfog/db";
import { and, desc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Env } from "./env";

export type MemoryUser = { id: string; name: string; selfPersonId?: string | null };
type Ctx = { env: Env; user: MemoryUser; source?: string };

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const model = "@cf/qwen/qwen3-embedding-0.6b";
const suffix = {
  project: "r",
  person: "p",
  task: "k",
  fact: "f",
  timeSeriesPoint: "s",
  document: "d",
  documentChunk: "c",
  thought: "t",
  dependencyEdge: "e",
} as const;

const graphKinds = [
  "project",
  "person",
  "task",
  "fact",
  "time_series_point",
  "document",
  "document_chunk",
  "thought",
] as const;
const relationships = [
  "references",
  "derived_from",
  "summarizes",
  "supersedes",
  "observes_subject",
  "mentions",
  "related_to",
] as const;
const staleRelationships = ["derived_from", "summarizes", "supersedes", "observes_subject"];
type GraphKind = (typeof graphKinds)[number];
type Relationship = (typeof relationships)[number];

export class MemoryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createId(kind: keyof typeof suffix) {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return `bf${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}${suffix[kind]}`;
}

export const isBrainfogId = (value: string, typeSuffix?: string) =>
  new RegExp(`^bf[0-9abcdefghjkmnpqrstvwxyz]{20}${typeSuffix ?? "[rpkfsdcteun]"}$`).test(value);

function now() {
  return new Date();
}

function source(ctx: Ctx) {
  return ctx.source ?? "rest:api";
}

function asDate(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value * 1000);
  throw new MemoryError(400, "timestamp must be unix seconds");
}

async function ensureProject(ctx: Ctx, id?: string | null) {
  if (!id) return;
  const row = (
    await createDb(ctx.env.DB)
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "project not found");
}

function asGraphKind(kind: unknown): GraphKind {
  if (typeof kind === "string" && (graphKinds as readonly string[]).includes(kind))
    return kind as GraphKind;
  throw new MemoryError(400, "invalid entity kind");
}

function asRelationship(value: unknown): Relationship {
  if (typeof value === "string" && (relationships as readonly string[]).includes(value))
    return value as Relationship;
  throw new MemoryError(400, "invalid relationship");
}

async function entityExists(ctx: Ctx, kind: GraphKind, id: string) {
  const db = createDb(ctx.env.DB);
  const checks: Record<GraphKind, Promise<unknown[]>> = {
    project: db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ctx.user.id)))
      .limit(1),
    person: db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.id, id), eq(people.ownerId, ctx.user.id)))
      .limit(1),
    task: db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.ownerId, ctx.user.id)))
      .limit(1),
    fact: db
      .select({ id: facts.id })
      .from(facts)
      .where(and(eq(facts.id, id), eq(facts.ownerId, ctx.user.id)))
      .limit(1),
    time_series_point: db
      .select({ id: timeSeriesPoints.id })
      .from(timeSeriesPoints)
      .where(and(eq(timeSeriesPoints.id, id), eq(timeSeriesPoints.ownerId, ctx.user.id)))
      .limit(1),
    document: db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
      .limit(1),
    document_chunk: db
      .select({ id: documentChunks.id })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(and(eq(documentChunks.id, id), eq(documents.ownerId, ctx.user.id)))
      .limit(1),
    thought: db
      .select({ id: thoughts.id })
      .from(thoughts)
      .where(and(eq(thoughts.id, id), eq(thoughts.ownerId, ctx.user.id)))
      .limit(1),
  };
  return Boolean((await checks[kind])[0]);
}

async function ensureEntity(ctx: Ctx, kind: GraphKind, id: string, message?: string) {
  if (!(await entityExists(ctx, kind, id)))
    throw new MemoryError(404, message ?? "entity not found");
}

export async function createDependency(
  ctx: Ctx,
  input: {
    dependent: { kind: string; id: string };
    dependency: { kind: string; id: string };
    relationship: string;
    metadata?: Record<string, unknown>;
  },
) {
  const dependentKind = asGraphKind(input.dependent?.kind);
  const dependencyKind = asGraphKind(input.dependency?.kind);
  const relationship = asRelationship(input.relationship);
  const dependentId = String(input.dependent?.id ?? "");
  const dependencyId = String(input.dependency?.id ?? "");
  if (!dependentId || !dependencyId) throw new MemoryError(400, "missing dependency endpoint");
  await ensureEntity(ctx, dependentKind, dependentId, "dependent not found");
  await ensureEntity(ctx, dependencyKind, dependencyId, "dependency not found");
  if (dependentKind === dependencyKind && dependentId === dependencyId)
    throw new MemoryError(400, "dependency cannot point to itself");
  const row = {
    id: createId("dependencyEdge"),
    ownerId: ctx.user.id,
    source: source(ctx),
    dependentKind,
    dependentId,
    dependencyKind,
    dependencyId,
    relationship,
    metadata: input.metadata ?? {},
  };
  await createDb(ctx.env.DB).insert(dependencyEdges).values(row).onConflictDoNothing();
  return (
    await createDb(ctx.env.DB)
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.ownerId, ctx.user.id),
          eq(dependencyEdges.dependentKind, dependentKind),
          eq(dependencyEdges.dependentId, dependentId),
          eq(dependencyEdges.dependencyKind, dependencyKind),
          eq(dependencyEdges.dependencyId, dependencyId),
          eq(dependencyEdges.relationship, relationship),
        ),
      )
      .limit(1)
  )[0];
}

async function replaceDependencies(
  ctx: Ctx,
  dependentKind: GraphKind,
  dependentId: string,
  relationship: Relationship,
  dependencies: { kind: GraphKind; id: string }[],
) {
  const db = createDb(ctx.env.DB);
  await db
    .delete(dependencyEdges)
    .where(
      and(
        eq(dependencyEdges.ownerId, ctx.user.id),
        eq(dependencyEdges.dependentKind, dependentKind),
        eq(dependencyEdges.dependentId, dependentId),
        eq(dependencyEdges.relationship, relationship),
      ),
    );
  for (const dependency of dependencies)
    await createDependency(ctx, {
      dependent: { kind: dependentKind, id: dependentId },
      dependency,
      relationship,
    });
}

async function markDownstreamStale(
  ctx: Ctx,
  dependencyKind: GraphKind,
  dependencyId: string,
  reason = "upstream_updated",
) {
  await createDb(ctx.env.DB)
    .update(dependencyEdges)
    .set({ staleAt: now(), staleReason: reason, updatedAt: now() })
    .where(
      and(
        eq(dependencyEdges.ownerId, ctx.user.id),
        eq(dependencyEdges.dependencyKind, dependencyKind),
        eq(dependencyEdges.dependencyId, dependencyId),
        inArray(dependencyEdges.relationship, staleRelationships),
      ),
    );
}

async function cleanDocumentChunkGraphEdges(
  ctx: Ctx,
  documentId: string,
  chunkIds: string[],
  retarget?: { staleReason: string },
) {
  if (chunkIds.length === 0) return;
  const db = createDb(ctx.env.DB);

  if (retarget) {
    const timestamp = now();
    const dependencyEdgesFromChunks = await db
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.ownerId, ctx.user.id),
          eq(dependencyEdges.dependencyKind, "document_chunk"),
          inArray(dependencyEdges.dependencyId, chunkIds),
        ),
      );

    for (const edge of dependencyEdgesFromChunks) {
      if (!(staleRelationships as readonly string[]).includes(edge.relationship)) {
        await db.delete(dependencyEdges).where(eq(dependencyEdges.id, edge.id));
        continue;
      }

      const existingDocumentEdge = (
        await db
          .select({ id: dependencyEdges.id })
          .from(dependencyEdges)
          .where(
            and(
              eq(dependencyEdges.ownerId, ctx.user.id),
              eq(dependencyEdges.dependentKind, edge.dependentKind),
              eq(dependencyEdges.dependentId, edge.dependentId),
              eq(dependencyEdges.dependencyKind, "document"),
              eq(dependencyEdges.dependencyId, documentId),
              eq(dependencyEdges.relationship, edge.relationship),
            ),
          )
          .limit(1)
      )[0];

      if (existingDocumentEdge) {
        await db
          .update(dependencyEdges)
          .set({ staleAt: timestamp, staleReason: retarget.staleReason, updatedAt: timestamp })
          .where(eq(dependencyEdges.id, existingDocumentEdge.id));
        await db.delete(dependencyEdges).where(eq(dependencyEdges.id, edge.id));
      } else {
        await db
          .update(dependencyEdges)
          .set({
            dependencyKind: "document",
            dependencyId: documentId,
            staleAt: timestamp,
            staleReason: retarget.staleReason,
            updatedAt: timestamp,
          })
          .where(eq(dependencyEdges.id, edge.id));
      }
    }
  }

  await db
    .delete(dependencyEdges)
    .where(
      and(
        eq(dependencyEdges.ownerId, ctx.user.id),
        eq(dependencyEdges.dependentKind, "document_chunk"),
        inArray(dependencyEdges.dependentId, chunkIds),
      ),
    );

  await db
    .delete(dependencyEdges)
    .where(
      and(
        eq(dependencyEdges.ownerId, ctx.user.id),
        eq(dependencyEdges.dependencyKind, "document_chunk"),
        inArray(dependencyEdges.dependencyId, chunkIds),
      ),
    );
}

export async function deleteDependency(ctx: Ctx, id: string) {
  const db = createDb(ctx.env.DB);
  const row = (
    await db
      .select({ id: dependencyEdges.id })
      .from(dependencyEdges)
      .where(and(eq(dependencyEdges.id, id), eq(dependencyEdges.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "dependency not found");
  await db.delete(dependencyEdges).where(eq(dependencyEdges.id, id));
  return { ok: true };
}

export async function listDependencies(
  ctx: Ctx,
  input: { entity_kind: string; entity_id: string; direction?: string; relationship?: string },
) {
  const entityKind = asGraphKind(input.entity_kind);
  const direction = input.direction ?? "both";
  if (!["upstream", "downstream", "both"].includes(direction))
    throw new MemoryError(400, "invalid direction");
  if (input.relationship) asRelationship(input.relationship);
  await ensureEntity(ctx, entityKind, input.entity_id, "entity not found");
  const filters = [eq(dependencyEdges.ownerId, ctx.user.id)];
  if (direction === "upstream") {
    filters.push(eq(dependencyEdges.dependentKind, entityKind));
    filters.push(eq(dependencyEdges.dependentId, input.entity_id));
  } else if (direction === "downstream") {
    filters.push(eq(dependencyEdges.dependencyKind, entityKind));
    filters.push(eq(dependencyEdges.dependencyId, input.entity_id));
  } else {
    const eitherDirection = or(
      and(
        eq(dependencyEdges.dependentKind, entityKind),
        eq(dependencyEdges.dependentId, input.entity_id),
      ),
      and(
        eq(dependencyEdges.dependencyKind, entityKind),
        eq(dependencyEdges.dependencyId, input.entity_id),
      ),
    );
    if (!eitherDirection) throw new MemoryError(400, "invalid dependency query");
    filters.push(eitherDirection);
  }
  if (input.relationship) filters.push(eq(dependencyEdges.relationship, input.relationship));
  return createDb(ctx.env.DB)
    .select()
    .from(dependencyEdges)
    .where(and(...filters))
    .orderBy(desc(dependencyEdges.createdAt));
}

export async function markStale(
  ctx: Ctx,
  input: { entity_kind: string; entity_id: string; reason?: string; stale_since?: number },
) {
  const entityKind = asGraphKind(input.entity_kind);
  await ensureEntity(ctx, entityKind, input.entity_id, "entity not found");
  const staleAt = asDate(input.stale_since) ?? now();
  await createDb(ctx.env.DB)
    .update(dependencyEdges)
    .set({ staleAt, staleReason: input.reason ?? "explicit_mark_stale", updatedAt: now() })
    .where(
      and(
        eq(dependencyEdges.ownerId, ctx.user.id),
        eq(dependencyEdges.dependencyKind, entityKind),
        eq(dependencyEdges.dependencyId, input.entity_id),
      ),
    );
  return listStale(ctx, {});
}

export async function listStale(ctx: Ctx, input: { kind?: string; project_id?: string }) {
  if (input.kind) asGraphKind(input.kind);
  if (input.project_id) await ensureProject(ctx, input.project_id);
  const filters = [eq(dependencyEdges.ownerId, ctx.user.id), isNotNull(dependencyEdges.staleAt)];
  if (input.kind) filters.push(eq(dependencyEdges.dependentKind, input.kind));
  const rows = await createDb(ctx.env.DB)
    .select()
    .from(dependencyEdges)
    .where(and(...filters))
    .orderBy(desc(dependencyEdges.staleAt));
  if (!input.project_id) return rows;
  const out = [];
  for (const row of rows) {
    if (
      (await projectIdForEntity(ctx, row.dependentKind as GraphKind, row.dependentId)) ===
      input.project_id
    )
      out.push(row);
  }
  return out;
}

async function projectIdForEntity(ctx: Ctx, kind: GraphKind, id: string) {
  const db = createDb(ctx.env.DB);
  if (kind === "project") return id;
  if (kind === "task") {
    const row = (
      await db
        .select({ projectId: tasks.projectId })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  if (kind === "fact") {
    const row = (
      await db
        .select({ projectId: facts.projectId })
        .from(facts)
        .where(and(eq(facts.id, id), eq(facts.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  if (kind === "document") {
    const row = (
      await db
        .select({ projectId: documents.projectId })
        .from(documents)
        .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  if (kind === "document_chunk") {
    const row = (
      await db
        .select({ projectId: documents.projectId })
        .from(documentChunks)
        .innerJoin(documents, eq(documentChunks.documentId, documents.id))
        .where(and(eq(documentChunks.id, id), eq(documents.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  if (kind === "thought") {
    const row = (
      await db
        .select({ projectId: thoughts.projectId })
        .from(thoughts)
        .where(and(eq(thoughts.id, id), eq(thoughts.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  if (kind === "time_series_point") {
    const row = (
      await db
        .select({ projectId: timeSeriesPoints.projectId })
        .from(timeSeriesPoints)
        .where(and(eq(timeSeriesPoints.id, id), eq(timeSeriesPoints.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  return null;
}

async function embed(ctx: Ctx, text: string): Promise<number[]> {
  if (ctx.env.TEST_MIGRATIONS) {
    return Array.from(
      { length: 1024 },
      (_, i) => (text.charCodeAt(i % Math.max(text.length, 1)) % 31) / 31,
    );
  }
  try {
    const result = (await ctx.env.AI.run(model, { text })) as { data?: number[][] | number[] };
    const data = result.data;
    if (Array.isArray(data?.[0])) return data[0] as number[];
    if (Array.isArray(data)) return data as number[];
  } catch {
    // Local tests may not have a real Workers AI emulator response; keep D1 canonical and let Vectorize be rebuildable.
  }
  return Array.from(
    { length: 1024 },
    (_, i) => (text.charCodeAt(i % Math.max(text.length, 1)) % 31) / 31,
  );
}

async function upsertVector(
  ctx: Ctx,
  id: string,
  values: number[],
  metadata: Record<string, unknown>,
) {
  if (ctx.env.TEST_MIGRATIONS) return;
  try {
    await ctx.env.VECTORIZE.upsert([
      { id, values, metadata: metadata as Record<string, VectorizeVectorMetadata> },
    ]);
  } catch {
    // Vectorize is derived; write paths must keep D1 successful even if the index lags.
  }
}

async function deleteVectors(ctx: Ctx, ids: string[]) {
  if (ids.length === 0) return;
  if (ctx.env.TEST_MIGRATIONS) return;
  try {
    await ctx.env.VECTORIZE.deleteByIds(ids);
  } catch {}
}

function chunksFor(content: string) {
  const max = 1200;
  const overlap = 120;
  const chunks: string[] = [];
  for (let start = 0; start < content.length; start += max - overlap) {
    chunks.push(content.slice(start, start + max));
    if (start + max >= content.length) break;
  }
  return chunks.length ? chunks : [""];
}

export async function createProject(
  ctx: Ctx,
  input: { name: string; description?: string | null },
) {
  const row = {
    id: createId("project"),
    ownerId: ctx.user.id,
    source: source(ctx),
    name: input.name,
    description: input.description ?? null,
  };
  await createDb(ctx.env.DB).insert(projects).values(row);
  return row;
}

export async function listProjects(ctx: Ctx) {
  return createDb(ctx.env.DB)
    .select()
    .from(projects)
    .where(eq(projects.ownerId, ctx.user.id))
    .orderBy(projects.name);
}

export async function upsertPerson(
  ctx: Ctx,
  input: {
    id?: string;
    name: string;
    aliases?: string[];
    contact_info?: Record<string, unknown>;
    notes?: string | null;
  },
) {
  const db = createDb(ctx.env.DB);
  if (input.id) {
    const existing = (
      await db
        .select()
        .from(people)
        .where(and(eq(people.id, input.id), eq(people.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!existing) throw new MemoryError(404, "person not found");
    const updated = {
      ...existing,
      name: input.name,
      aliases: input.aliases === undefined ? existing.aliases : input.aliases,
      contactInfo: input.contact_info === undefined ? existing.contactInfo : input.contact_info,
      notes: input.notes === undefined ? existing.notes : input.notes,
      updatedAt: now(),
    };
    await db.update(people).set(updated).where(eq(people.id, input.id));
    await markDownstreamStale(ctx, "person", input.id);
    return updated;
  }
  const row = {
    id: createId("person"),
    ownerId: ctx.user.id,
    source: source(ctx),
    name: input.name,
    aliases: input.aliases ?? [],
    contactInfo: input.contact_info ?? {},
    notes: input.notes ?? null,
  };
  await db.insert(people).values(row);
  return row;
}

export async function listPeople(ctx: Ctx) {
  return createDb(ctx.env.DB)
    .select()
    .from(people)
    .where(eq(people.ownerId, ctx.user.id))
    .orderBy(people.name);
}

export async function getSelfPerson(ctx: Ctx) {
  const selfPersonId = ctx.user.selfPersonId ?? null;
  if (!selfPersonId) return null;
  const row = (
    await createDb(ctx.env.DB)
      .select()
      .from(people)
      .where(and(eq(people.id, selfPersonId), eq(people.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  return row ?? null;
}

export async function setSelfPerson(ctx: Ctx, personId: string | null) {
  const db = createDb(ctx.env.DB);
  if (personId !== null) {
    const row = (
      await db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.id, personId), eq(people.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!row) throw new MemoryError(404, "person not found");
  }
  await db.update(users).set({ selfPersonId: personId }).where(eq(users.id, ctx.user.id));
  ctx.user.selfPersonId = personId;
  return { self_person_id: personId, self_person: await getSelfPerson(ctx) };
}

function validateRecurrence(recurrence: unknown) {
  if (recurrence == null) return null;
  if (typeof recurrence !== "object" || Array.isArray(recurrence))
    throw new MemoryError(400, "recurrence must be an object");
  const r = recurrence as Record<string, unknown>;
  if (!["daily", "weekly", "monthly", "yearly"].includes(String(r.frequency)))
    throw new MemoryError(400, "invalid recurrence frequency");
  if (r.interval !== undefined && (!Number.isInteger(r.interval) || (r.interval as number) <= 0))
    throw new MemoryError(400, "invalid recurrence interval");
  if (
    r.days_of_week !== undefined &&
    (!Array.isArray(r.days_of_week) ||
      r.days_of_week.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
  )
    throw new MemoryError(400, "invalid recurrence days_of_week");
  if (
    r.starts_at !== undefined &&
    r.ends_at !== undefined &&
    Number(r.ends_at) <= Number(r.starts_at)
  )
    throw new MemoryError(400, "recurrence ends_at must be after starts_at");
  return { ...r, interval: r.interval ?? 1 };
}

export async function createTask(ctx: Ctx, input: Record<string, unknown>) {
  await ensureProject(ctx, input.project_id as string | undefined);
  const row = {
    id: createId("task"),
    ownerId: ctx.user.id,
    projectId: (input.project_id as string | undefined) ?? null,
    source: source(ctx),
    title: String(input.title),
    description: (input.description as string | undefined) ?? null,
    status: (input.status as string | undefined) ?? "open",
    priority: Number(input.priority ?? 0.5),
    dueAt: asDate(input.due_at) ?? null,
    recurrence: validateRecurrence(input.recurrence),
  };
  await createDb(ctx.env.DB).insert(tasks).values(row);
  return row;
}

export async function updateTask(ctx: Ctx, id: string, input: Record<string, unknown>) {
  const db = createDb(ctx.env.DB);
  const row = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "task not found");
  const hasProjectId = Object.hasOwn(input, "project_id");
  const projectId = hasProjectId ? (input.project_id as string | null) : row.projectId;
  await ensureProject(ctx, projectId);
  await db
    .update(tasks)
    .set({
      projectId,
      title: (input.title as string) ?? row.title,
      description: (input.description as string | null | undefined) ?? row.description,
      status: (input.status as string) ?? row.status,
      priority: input.priority === undefined ? row.priority : Number(input.priority),
      dueAt: input.due_at === undefined ? row.dueAt : (asDate(input.due_at) ?? null),
      recurrence:
        input.recurrence === undefined ? row.recurrence : validateRecurrence(input.recurrence),
      updatedAt: now(),
    })
    .where(eq(tasks.id, id));
  await markDownstreamStale(ctx, "task", id);
  return (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
}

export async function listTasks(ctx: Ctx, q: { project_id?: string; status?: string }) {
  const filters = [eq(tasks.ownerId, ctx.user.id)];
  if (q.project_id) filters.push(eq(tasks.projectId, q.project_id));
  if (q.status) filters.push(eq(tasks.status, q.status));
  return createDb(ctx.env.DB)
    .select()
    .from(tasks)
    .where(and(...filters))
    .orderBy(desc(tasks.createdAt));
}

async function applyThoughtLinks(
  ctx: Ctx,
  thoughtId: string,
  links?: {
    people_ids?: string[];
    task_ids?: string[];
    fact_ids?: string[];
    document_ids?: string[];
  },
) {
  if (!links) return;
  for (const id of links.people_ids ?? []) {
    await ensureEntity(ctx, "person", id, "person link not found");
    await createDependency(ctx, {
      dependent: { kind: "thought", id: thoughtId },
      dependency: { kind: "person", id },
      relationship: "references",
    });
  }
  for (const id of links.task_ids ?? []) {
    await ensureEntity(ctx, "task", id, "task link not found");
    await createDependency(ctx, {
      dependent: { kind: "thought", id: thoughtId },
      dependency: { kind: "task", id },
      relationship: "references",
    });
  }
  for (const id of links.fact_ids ?? []) {
    await ensureEntity(ctx, "fact", id, "fact link not found");
    await createDependency(ctx, {
      dependent: { kind: "thought", id: thoughtId },
      dependency: { kind: "fact", id },
      relationship: "references",
    });
  }
  for (const id of links.document_ids ?? []) {
    await ensureEntity(ctx, "document", id, "document link not found");
    await createDependency(ctx, {
      dependent: { kind: "thought", id: thoughtId },
      dependency: { kind: "document", id },
      relationship: "references",
    });
  }
}

async function validateThoughtLinks(ctx: Ctx, links?: Parameters<typeof applyThoughtLinks>[2]) {
  if (!links) return;
  for (const id of links.people_ids ?? [])
    await ensureEntity(ctx, "person", id, "person link not found");
  for (const id of links.task_ids ?? []) await ensureEntity(ctx, "task", id, "task link not found");
  for (const id of links.fact_ids ?? []) await ensureEntity(ctx, "fact", id, "fact link not found");
  for (const id of links.document_ids ?? [])
    await ensureEntity(ctx, "document", id, "document link not found");
}

export async function remember(
  ctx: Ctx,
  input: {
    content: string;
    type?: string;
    project_id?: string;
    links?: Parameters<typeof applyThoughtLinks>[2];
  },
) {
  await ensureProject(ctx, input.project_id);
  await validateThoughtLinks(ctx, input.links);
  const db = createDb(ctx.env.DB);
  const row = {
    id: createId("thought"),
    ownerId: ctx.user.id,
    projectId: input.project_id ?? null,
    source: source(ctx),
    content: input.content,
    type: input.type ?? "observation",
    metadata: {},
  };
  await db.insert(thoughts).values(row);
  await applyThoughtLinks(ctx, row.id, input.links);
  await upsertVector(ctx, row.id, await embed(ctx, input.content), {
    kind: "thought",
    owner_id: ctx.user.id,
    ...(input.project_id ? { project_id: input.project_id } : {}),
  });
  return row;
}

export async function linkThought(
  ctx: Ctx,
  thoughtId: string,
  links: Parameters<typeof applyThoughtLinks>[2],
) {
  const row = (
    await createDb(ctx.env.DB)
      .select({ id: thoughts.id })
      .from(thoughts)
      .where(and(eq(thoughts.id, thoughtId), eq(thoughts.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "thought not found");
  await applyThoughtLinks(ctx, thoughtId, links);
  return { ok: true };
}

async function applyFactDerivations(
  ctx: Ctx,
  factId: string,
  derived?: {
    thought_ids?: string[];
    fact_ids?: string[];
    document_ids?: string[];
    document_chunk_ids?: string[];
  },
) {
  if (!derived) return;
  for (const id of derived.thought_ids ?? []) {
    await ensureEntity(ctx, "thought", id, "source thought not found");
    await createDependency(ctx, {
      dependent: { kind: "fact", id: factId },
      dependency: { kind: "thought", id },
      relationship: "derived_from",
    });
  }
  for (const id of derived.fact_ids ?? []) {
    if (id === factId) throw new MemoryError(400, "fact cannot derive from itself");
    await ensureEntity(ctx, "fact", id, "source fact not found");
    await createDependency(ctx, {
      dependent: { kind: "fact", id: factId },
      dependency: { kind: "fact", id },
      relationship: "derived_from",
    });
  }
  for (const id of derived.document_ids ?? []) {
    await ensureEntity(ctx, "document", id, "source document not found");
    await createDependency(ctx, {
      dependent: { kind: "fact", id: factId },
      dependency: { kind: "document", id },
      relationship: "derived_from",
    });
  }
  for (const id of derived.document_chunk_ids ?? []) {
    await ensureEntity(ctx, "document_chunk", id, "source document chunk not found");
    await createDependency(ctx, {
      dependent: { kind: "fact", id: factId },
      dependency: { kind: "document_chunk", id },
      relationship: "derived_from",
    });
  }
}

async function validateFactDerivations(
  ctx: Ctx,
  factId: string,
  derived?: Parameters<typeof applyFactDerivations>[2],
) {
  if (!derived) return;
  for (const id of derived.thought_ids ?? [])
    await ensureEntity(ctx, "thought", id, "source thought not found");
  for (const id of derived.fact_ids ?? []) {
    if (id === factId) throw new MemoryError(400, "fact cannot derive from itself");
    await ensureEntity(ctx, "fact", id, "source fact not found");
  }
  for (const id of derived.document_ids ?? [])
    await ensureEntity(ctx, "document", id, "source document not found");
  for (const id of derived.document_chunk_ids ?? [])
    await ensureEntity(ctx, "document_chunk", id, "source document chunk not found");
}

async function factWithSupersession(ctx: Ctx, fact: typeof facts.$inferSelect) {
  const db = createDb(ctx.env.DB);
  const supersedes = (
    await db
      .select({ id: dependencyEdges.dependencyId })
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.ownerId, ctx.user.id),
          eq(dependencyEdges.dependentKind, "fact"),
          eq(dependencyEdges.dependentId, fact.id),
          eq(dependencyEdges.dependencyKind, "fact"),
          eq(dependencyEdges.relationship, "supersedes"),
        ),
      )
      .limit(1)
  )[0];
  const supersededBy = (
    await db
      .select({ id: dependencyEdges.dependentId })
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.ownerId, ctx.user.id),
          eq(dependencyEdges.dependentKind, "fact"),
          eq(dependencyEdges.dependencyKind, "fact"),
          eq(dependencyEdges.dependencyId, fact.id),
          eq(dependencyEdges.relationship, "supersedes"),
        ),
      )
      .limit(1)
  )[0];
  return {
    ...fact,
    supersedesFactId: supersedes?.id ?? null,
    supersededByFactId: supersededBy?.id ?? null,
  };
}

export async function recordFact(
  ctx: Ctx,
  input: {
    statement: string;
    citations?: string[];
    confidence?: number;
    project_id?: string;
    topics?: string[];
    derived_from?: Parameters<typeof applyFactDerivations>[2];
    supersedes_fact_id?: string;
  },
) {
  await ensureProject(ctx, input.project_id);
  const db = createDb(ctx.env.DB);
  if (input.supersedes_fact_id) {
    const old = (
      await db
        .select()
        .from(facts)
        .where(and(eq(facts.id, input.supersedes_fact_id), eq(facts.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!old) throw new MemoryError(404, "superseded fact not found");
  }
  const id = createId("fact");
  await validateFactDerivations(ctx, id, input.derived_from);
  const row = {
    id,
    ownerId: ctx.user.id,
    projectId: input.project_id ?? null,
    source: source(ctx),
    statement: input.statement,
    citations: input.citations ?? [],
    confidence: input.confidence ?? 0.5,
    status: "current",
    metadata: { topics: input.topics ?? [] },
  };
  if (input.supersedes_fact_id === row.id)
    throw new MemoryError(400, "fact cannot supersede itself");
  await db.insert(facts).values(row);
  if (input.supersedes_fact_id) {
    await createDependency(ctx, {
      dependent: { kind: "fact", id: row.id },
      dependency: { kind: "fact", id: input.supersedes_fact_id },
      relationship: "supersedes",
    });
    await db
      .update(facts)
      .set({ status: "superseded", updatedAt: now() })
      .where(eq(facts.id, input.supersedes_fact_id));
  }
  await applyFactDerivations(ctx, row.id, input.derived_from);
  await upsertVector(ctx, row.id, await embed(ctx, input.statement), {
    kind: "fact",
    owner_id: ctx.user.id,
    ...(input.project_id ? { project_id: input.project_id } : {}),
  });
  const created = (await db.select().from(facts).where(eq(facts.id, row.id)))[0];
  if (!created) throw new MemoryError(500, "fact insert failed");
  return factWithSupersession(ctx, created);
}

export async function updateFact(ctx: Ctx, id: string, input: Record<string, unknown>) {
  const db = createDb(ctx.env.DB);
  const row = (
    await db
      .select()
      .from(facts)
      .where(and(eq(facts.id, id), eq(facts.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "fact not found");
  if (input.supersedes_fact_id === id || input.superseded_by_fact_id === id)
    throw new MemoryError(400, "fact cannot reference itself");
  const current = await factWithSupersession(ctx, row);
  if (input.supersedes_fact_id !== undefined && input.supersedes_fact_id !== null)
    await ensureEntity(ctx, "fact", String(input.supersedes_fact_id), "superseded fact not found");
  if (input.superseded_by_fact_id !== undefined && input.superseded_by_fact_id !== null)
    await ensureEntity(
      ctx,
      "fact",
      String(input.superseded_by_fact_id),
      "superseding fact not found",
    );
  const statement = (input.statement as string | undefined) ?? row.statement;
  const updatesSupersedes = Object.hasOwn(input, "supersedes_fact_id");
  const updatesSupersededBy = Object.hasOwn(input, "superseded_by_fact_id");
  const supersedesFactId = updatesSupersedes
    ? (input.supersedes_fact_id as string | null)
    : current.supersedesFactId;
  const supersededByFactId = updatesSupersededBy
    ? (input.superseded_by_fact_id as string | null)
    : current.supersededByFactId;
  const status =
    (input.status as string | undefined) ??
    (updatesSupersededBy && supersededByFactId ? "superseded" : row.status);
  await db
    .update(facts)
    .set({
      statement,
      citations: (input.citations as string[] | undefined) ?? row.citations,
      confidence: input.confidence === undefined ? row.confidence : Number(input.confidence),
      status,
      metadata: input.topics ? { topics: input.topics as string[] } : row.metadata,
      updatedAt: now(),
    })
    .where(eq(facts.id, id));
  if (updatesSupersedes) {
    await db
      .delete(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.ownerId, ctx.user.id),
          eq(dependencyEdges.dependentKind, "fact"),
          eq(dependencyEdges.dependentId, id),
          eq(dependencyEdges.dependencyKind, "fact"),
          eq(dependencyEdges.relationship, "supersedes"),
        ),
      );
    if (supersedesFactId)
      await createDependency(ctx, {
        dependent: { kind: "fact", id },
        dependency: { kind: "fact", id: supersedesFactId },
        relationship: "supersedes",
      });
  }
  if (updatesSupersededBy) {
    await db
      .delete(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.ownerId, ctx.user.id),
          eq(dependencyEdges.dependentKind, "fact"),
          eq(dependencyEdges.dependencyKind, "fact"),
          eq(dependencyEdges.dependencyId, id),
          eq(dependencyEdges.relationship, "supersedes"),
        ),
      );
    if (supersededByFactId)
      await createDependency(ctx, {
        dependent: { kind: "fact", id: supersededByFactId },
        dependency: { kind: "fact", id },
        relationship: "supersedes",
      });
  }
  if (supersedesFactId)
    await db
      .update(facts)
      .set({ status: "superseded", updatedAt: now() })
      .where(and(eq(facts.id, supersedesFactId), eq(facts.ownerId, ctx.user.id)));
  if (input.statement !== undefined)
    await upsertVector(ctx, id, await embed(ctx, statement), {
      kind: "fact",
      owner_id: ctx.user.id,
      ...(row.projectId ? { project_id: row.projectId } : {}),
    });
  await markDownstreamStale(ctx, "fact", id);
  const updated = (await db.select().from(facts).where(eq(facts.id, id)))[0];
  if (!updated) throw new MemoryError(404, "fact not found");
  return factWithSupersession(ctx, updated);
}

export async function addDocument(
  ctx: Ctx,
  input: {
    title: string;
    content: string;
    project_id?: string;
    mime_type?: string;
    derived_from?: Parameters<typeof applyFactDerivations>[2];
  },
) {
  await ensureProject(ctx, input.project_id);
  const db = createDb(ctx.env.DB);
  const id = createId("document");
  await validateFactDerivations(ctx, id, input.derived_from);
  const r2Key = `${ctx.user.id}/${id}.md`;
  await ctx.env.DOCUMENTS.put(r2Key, input.content, {
    httpMetadata: { contentType: input.mime_type ?? "text/markdown" },
  });
  const row = {
    id,
    ownerId: ctx.user.id,
    projectId: input.project_id ?? null,
    source: source(ctx),
    title: input.title,
    r2Key,
    mimeType: input.mime_type ?? "text/markdown",
    sizeBytes: new TextEncoder().encode(input.content).byteLength,
  };
  await db.insert(documents).values(row);
  await applyDocumentDerivations(ctx, id, input.derived_from);
  await insertChunks(ctx, id, input.content, input.project_id ?? null);
  return row;
}

async function applyDocumentDerivations(
  ctx: Ctx,
  documentId: string,
  derived?: Parameters<typeof applyFactDerivations>[2],
) {
  if (!derived) return;
  for (const id of derived.thought_ids ?? []) {
    await ensureEntity(ctx, "thought", id, "source thought not found");
    await createDependency(ctx, {
      dependent: { kind: "document", id: documentId },
      dependency: { kind: "thought", id },
      relationship: "derived_from",
    });
  }
  for (const id of derived.fact_ids ?? []) {
    await ensureEntity(ctx, "fact", id, "source fact not found");
    await createDependency(ctx, {
      dependent: { kind: "document", id: documentId },
      dependency: { kind: "fact", id },
      relationship: "derived_from",
    });
  }
  for (const id of derived.document_ids ?? []) {
    if (id === documentId) throw new MemoryError(400, "document cannot derive from itself");
    await ensureEntity(ctx, "document", id, "source document not found");
    await createDependency(ctx, {
      dependent: { kind: "document", id: documentId },
      dependency: { kind: "document", id },
      relationship: "derived_from",
    });
  }
  for (const id of derived.document_chunk_ids ?? []) {
    await ensureEntity(ctx, "document_chunk", id, "source document chunk not found");
    await createDependency(ctx, {
      dependent: { kind: "document", id: documentId },
      dependency: { kind: "document_chunk", id },
      relationship: "derived_from",
    });
  }
}

async function insertChunks(
  ctx: Ctx,
  documentId: string,
  content: string,
  projectId: string | null,
) {
  const db = createDb(ctx.env.DB);
  let i = 0;
  for (const chunk of chunksFor(content)) {
    const id = createId("documentChunk");
    await db.insert(documentChunks).values({ id, documentId, chunkIndex: i, content: chunk });
    await upsertVector(ctx, id, await embed(ctx, chunk), {
      kind: "document_chunk",
      owner_id: ctx.user.id,
      ...(projectId ? { project_id: projectId } : {}),
    });
    i += 1;
  }
}

export async function updateDocument(
  ctx: Ctx,
  id: string,
  content: string,
  derivedFrom?: Parameters<typeof applyFactDerivations>[2],
) {
  const db = createDb(ctx.env.DB);
  const doc = (
    await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!doc) throw new MemoryError(404, "document not found");
  if (derivedFrom) await validateFactDerivations(ctx, id, derivedFrom);
  await markDownstreamStale(ctx, "document", id);
  const oldChunks = await db
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, id));
  await cleanDocumentChunkGraphEdges(
    ctx,
    id,
    oldChunks.map((c) => c.id),
    {
      staleReason: "document_chunks_replaced",
    },
  );
  await deleteVectors(
    ctx,
    oldChunks.map((c) => c.id),
  );
  await db.delete(documentChunks).where(eq(documentChunks.documentId, id));
  await ctx.env.DOCUMENTS.put(doc.r2Key, content, { httpMetadata: { contentType: doc.mimeType } });
  await db
    .update(documents)
    .set({ sizeBytes: new TextEncoder().encode(content).byteLength, updatedAt: now() })
    .where(eq(documents.id, id));
  if (derivedFrom) {
    await replaceDependencies(ctx, "document", id, "derived_from", []);
    await applyDocumentDerivations(ctx, id, derivedFrom);
  }
  await insertChunks(ctx, id, content, doc.projectId);
  return (await db.select().from(documents).where(eq(documents.id, id)))[0];
}

export async function getDocumentContent(ctx: Ctx, id: string) {
  const doc = (
    await createDb(ctx.env.DB)
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!doc) throw new MemoryError(404, "document not found");
  const object = await ctx.env.DOCUMENTS.get(doc.r2Key);
  if (!object) throw new MemoryError(404, "document content not found");
  return { doc, content: await object.text() };
}

export async function recordTimeSeriesPoint(ctx: Ctx, input: Record<string, unknown>) {
  await ensureProject(ctx, input.project_id as string | undefined);
  await validateSubject(
    ctx,
    input.subject_type as string | undefined,
    input.subject_id as string | undefined,
  );
  const row = {
    id: createId("timeSeriesPoint"),
    ownerId: ctx.user.id,
    projectId: (input.project_id as string | undefined) ?? null,
    source: source(ctx),
    seriesKey: String(input.series_key),
    value: input.value === undefined || input.value === null ? null : Number(input.value),
    unit: (input.unit as string | undefined) ?? null,
    observedAt: asDate(input.observed_at) ?? now(),
    metadata: (input.metadata as Record<string, unknown> | undefined) ?? {},
  };
  await createDb(ctx.env.DB).insert(timeSeriesPoints).values(row);
  if (input.subject_type && input.subject_id)
    await createDependency(ctx, {
      dependent: { kind: "time_series_point", id: row.id },
      dependency: { kind: asGraphKind(input.subject_type), id: String(input.subject_id) },
      relationship: "observes_subject",
    });
  return {
    ...row,
    subjectType: (input.subject_type as string | undefined) ?? null,
    subjectId: (input.subject_id as string | undefined) ?? null,
  };
}

async function validateSubject(ctx: Ctx, type?: string, id?: string) {
  if (!type || !id) return;
  await ensureEntity(ctx, asGraphKind(type), id, "subject not found");
}

export async function listTimeSeriesPoints(ctx: Ctx, q: Record<string, string | undefined>) {
  const filters = [eq(timeSeriesPoints.ownerId, ctx.user.id)];
  if (q.series_key) filters.push(eq(timeSeriesPoints.seriesKey, q.series_key));
  if (q.project_id) filters.push(eq(timeSeriesPoints.projectId, q.project_id));
  if (q.from) filters.push(gte(timeSeriesPoints.observedAt, asDate(Number(q.from)) ?? now()));
  if (q.to) filters.push(lte(timeSeriesPoints.observedAt, asDate(Number(q.to)) ?? now()));
  const db = createDb(ctx.env.DB);
  if (q.subject_type || q.subject_id) {
    const graphFilters = [
      ...filters,
      eq(dependencyEdges.ownerId, ctx.user.id),
      eq(dependencyEdges.dependentKind, "time_series_point"),
      eq(dependencyEdges.dependentId, timeSeriesPoints.id),
      eq(dependencyEdges.relationship, "observes_subject"),
    ];
    if (q.subject_type) graphFilters.push(eq(dependencyEdges.dependencyKind, q.subject_type));
    if (q.subject_id) graphFilters.push(eq(dependencyEdges.dependencyId, q.subject_id));
    return db
      .select({ point: timeSeriesPoints, edge: dependencyEdges })
      .from(timeSeriesPoints)
      .innerJoin(dependencyEdges, eq(dependencyEdges.dependentId, timeSeriesPoints.id))
      .where(and(...graphFilters))
      .orderBy(desc(timeSeriesPoints.observedAt))
      .then((rows) =>
        rows.map((r) => ({
          ...r.point,
          subjectType: r.edge.dependencyKind,
          subjectId: r.edge.dependencyId,
        })),
      );
  }
  return db
    .select()
    .from(timeSeriesPoints)
    .where(and(...filters))
    .orderBy(desc(timeSeriesPoints.observedAt));
}

export async function recall(
  ctx: Ctx,
  q: { query: string; kinds?: string[]; project_id?: string; limit?: number },
) {
  const kinds = q.kinds?.length ? q.kinds : ["thought", "fact", "document_chunk"];
  const limit = q.limit ?? 10;
  const ids: { id: string; kind: string; score: number }[] = [];
  if (!ctx.env.TEST_MIGRATIONS) {
    try {
      const filter: Record<string, unknown> = {
        owner_id: ctx.user.id,
        kind: kinds.length === 1 ? kinds[0] : { $in: kinds },
        ...(q.project_id ? { project_id: q.project_id } : {}),
      };
      const result = (await ctx.env.VECTORIZE.query(await embed(ctx, q.query), {
        topK: limit,
        filter: filter as VectorizeVectorMetadataFilter,
        returnMetadata: "all",
      })) as { matches?: { id: string; score?: number; metadata?: { kind?: string } }[] };
      for (const m of result.matches ?? [])
        if (m.metadata?.kind && kinds.includes(m.metadata.kind))
          ids.push({ id: m.id, kind: m.metadata.kind, score: m.score ?? 0 });
    } catch {}
  }
  const rows = await resolveRecallRows(ctx, ids, kinds, q.project_id, q.query, limit);
  return rows.slice(0, limit);
}

async function resolveRecallRows(
  ctx: Ctx,
  matches: { id: string; kind: string; score: number }[],
  kinds: string[],
  projectId: string | undefined,
  query: string,
  limit: number,
) {
  const db = createDb(ctx.env.DB);
  const out: unknown[] = [];
  for (const m of matches) {
    if (m.kind === "thought") {
      const r = (
        await db
          .select()
          .from(thoughts)
          .where(
            and(
              eq(thoughts.id, m.id),
              eq(thoughts.ownerId, ctx.user.id),
              projectId ? eq(thoughts.projectId, projectId) : sql`1=1`,
            ),
          )
          .limit(1)
      )[0];
      if (r) out.push({ kind: "thought", score: m.score, row: r });
    } else if (m.kind === "fact") {
      const r = (
        await db
          .select()
          .from(facts)
          .where(
            and(
              eq(facts.id, m.id),
              eq(facts.ownerId, ctx.user.id),
              projectId ? eq(facts.projectId, projectId) : sql`1=1`,
            ),
          )
          .limit(1)
      )[0];
      if (r) out.push({ kind: "fact", score: m.score, row: r });
    } else if (m.kind === "document_chunk") {
      const r = (
        await db
          .select({ chunk: documentChunks, document: documents })
          .from(documentChunks)
          .innerJoin(documents, eq(documentChunks.documentId, documents.id))
          .where(
            and(
              eq(documentChunks.id, m.id),
              eq(documents.ownerId, ctx.user.id),
              projectId ? eq(documents.projectId, projectId) : sql`1=1`,
            ),
          )
          .limit(1)
      )[0];
      if (r)
        out.push({
          kind: "document_chunk",
          score: m.score,
          row: { ...r.chunk, document: { id: r.document.id, title: r.document.title } },
        });
    }
  }
  if (out.length) return out;
  const like = `%${query.split(/\s+/)[0] ?? query}%`;
  if (kinds.includes("thought"))
    out.push(
      ...(
        await db
          .select()
          .from(thoughts)
          .where(
            and(
              eq(thoughts.ownerId, ctx.user.id),
              projectId ? eq(thoughts.projectId, projectId) : sql`1=1`,
              sql`${thoughts.content} like ${like}`,
            ),
          )
          .limit(limit)
      ).map((row) => ({ kind: "thought", score: 0, row })),
    );
  if (kinds.includes("fact"))
    out.push(
      ...(
        await db
          .select()
          .from(facts)
          .where(
            and(
              eq(facts.ownerId, ctx.user.id),
              projectId ? eq(facts.projectId, projectId) : sql`1=1`,
              sql`${facts.statement} like ${like}`,
            ),
          )
          .limit(limit)
      ).map((row) => ({ kind: "fact", score: 0, row })),
    );
  if (kinds.includes("document_chunk"))
    out.push(
      ...(
        await db
          .select({ chunk: documentChunks, document: documents })
          .from(documentChunks)
          .innerJoin(documents, eq(documentChunks.documentId, documents.id))
          .where(
            and(
              eq(documents.ownerId, ctx.user.id),
              projectId ? eq(documents.projectId, projectId) : sql`1=1`,
              sql`${documentChunks.content} like ${like}`,
            ),
          )
          .limit(limit)
      ).map((r) => ({
        kind: "document_chunk",
        score: 0,
        row: { ...r.chunk, document: { id: r.document.id, title: r.document.title } },
      })),
    );
  return out;
}

export async function listFacts(ctx: Ctx) {
  const rows = await createDb(ctx.env.DB)
    .select()
    .from(facts)
    .where(eq(facts.ownerId, ctx.user.id))
    .orderBy(desc(facts.createdAt));
  return Promise.all(rows.map((row) => factWithSupersession(ctx, row)));
}
export async function listThoughts(ctx: Ctx) {
  return createDb(ctx.env.DB)
    .select()
    .from(thoughts)
    .where(eq(thoughts.ownerId, ctx.user.id))
    .orderBy(desc(thoughts.createdAt));
}
export async function listDocuments(ctx: Ctx) {
  return createDb(ctx.env.DB)
    .select()
    .from(documents)
    .where(eq(documents.ownerId, ctx.user.id))
    .orderBy(desc(documents.createdAt));
}

async function deleteGraphEdgesTouching(ctx: Ctx, id: string) {
  const endpointFilter = or(
    eq(dependencyEdges.dependentId, id),
    eq(dependencyEdges.dependencyId, id),
  );
  if (!endpointFilter) return;
  await createDb(ctx.env.DB)
    .delete(dependencyEdges)
    .where(and(eq(dependencyEdges.ownerId, ctx.user.id), endpointFilter));
}

export async function deleteThought(ctx: Ctx, id: string) {
  const db = createDb(ctx.env.DB);
  const row = (
    await db
      .select({ id: thoughts.id })
      .from(thoughts)
      .where(and(eq(thoughts.id, id), eq(thoughts.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "thought not found");
  await deleteGraphEdgesTouching(ctx, id);
  await db.delete(thoughts).where(eq(thoughts.id, id));
  await deleteVectors(ctx, [id]);
  return { ok: true };
}
export async function deleteFact(ctx: Ctx, id: string) {
  const db = createDb(ctx.env.DB);
  const row = (
    await db
      .select({ id: facts.id })
      .from(facts)
      .where(and(eq(facts.id, id), eq(facts.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "fact not found");
  await deleteGraphEdgesTouching(ctx, id);
  await db.delete(facts).where(eq(facts.id, id));
  await deleteVectors(ctx, [id]);
  return { ok: true };
}
export async function deleteDocument(ctx: Ctx, id: string) {
  const db = createDb(ctx.env.DB);
  const doc = (
    await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!doc) throw new MemoryError(404, "document not found");
  const chunkIds = await db
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, id));
  await cleanDocumentChunkGraphEdges(
    ctx,
    id,
    chunkIds.map((c) => c.id),
  );
  await deleteVectors(
    ctx,
    chunkIds.map((c) => c.id),
  );
  await ctx.env.DOCUMENTS.delete(doc.r2Key);
  await deleteGraphEdgesTouching(ctx, id);
  await db.delete(documents).where(eq(documents.id, id));
  return { ok: true };
}

export async function getChunksForDocument(ctx: Ctx, documentId: string) {
  const doc = (
    await createDb(ctx.env.DB)
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!doc) throw new MemoryError(404, "document not found");
  return createDb(ctx.env.DB)
    .select()
    .from(documentChunks)
    .where(eq(documentChunks.documentId, documentId));
}

// Reserved slugs that would collide with route prefixes per ARCHITECTURE.md
const reservedSlugs = new Set(["app", "api", "mcp", "assets", "admin", "system", "brainfog"]);

export function validateSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
  if (!normalized || reservedSlugs.has(normalized)) {
    throw new MemoryError(400, `invalid or reserved slug: ${slug}`);
  }
  return normalized;
}
