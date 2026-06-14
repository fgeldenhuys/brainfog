import {
  createDb,
  documentChunks,
  documents,
  factSourceDocumentChunks,
  factSourceDocuments,
  factSourceFacts,
  factSourceThoughts,
  facts,
  people,
  projects,
  tasks,
  thoughtDocuments,
  thoughtFacts,
  thoughtPeople,
  thoughts,
  thoughtTasks,
  timeSeriesPoints,
  users,
} from "@brainfog/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
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
} as const;

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
  new RegExp(`^bf[0-9abcdefghjkmnpqrstvwxyz]{20}${typeSuffix ?? "[rpkfsdctun]"}$`).test(value);

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
  const db = createDb(ctx.env.DB);
  for (const id of links.people_ids ?? []) {
    if (
      !(
        await db
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.id, id), eq(people.ownerId, ctx.user.id)))
          .limit(1)
      )[0]
    )
      throw new MemoryError(404, "person link not found");
    await db.insert(thoughtPeople).values({ thoughtId, personId: id }).onConflictDoNothing();
  }
  for (const id of links.task_ids ?? []) {
    if (
      !(
        await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.ownerId, ctx.user.id)))
          .limit(1)
      )[0]
    )
      throw new MemoryError(404, "task link not found");
    await db.insert(thoughtTasks).values({ thoughtId, taskId: id }).onConflictDoNothing();
  }
  for (const id of links.fact_ids ?? []) {
    if (
      !(
        await db
          .select({ id: facts.id })
          .from(facts)
          .where(and(eq(facts.id, id), eq(facts.ownerId, ctx.user.id)))
          .limit(1)
      )[0]
    )
      throw new MemoryError(404, "fact link not found");
    await db.insert(thoughtFacts).values({ thoughtId, factId: id }).onConflictDoNothing();
  }
  for (const id of links.document_ids ?? []) {
    if (
      !(
        await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
          .limit(1)
      )[0]
    )
      throw new MemoryError(404, "document link not found");
    await db.insert(thoughtDocuments).values({ thoughtId, documentId: id }).onConflictDoNothing();
  }
}

async function validateThoughtLinks(ctx: Ctx, links?: Parameters<typeof applyThoughtLinks>[2]) {
  if (!links) return;
  const db = createDb(ctx.env.DB);
  for (const id of links.people_ids ?? []) {
    const row = (
      await db
        .select({ id: people.id })
        .from(people)
        .where(and(eq(people.id, id), eq(people.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!row) throw new MemoryError(404, "person link not found");
  }
  for (const id of links.task_ids ?? []) {
    const row = (
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!row) throw new MemoryError(404, "task link not found");
  }
  for (const id of links.fact_ids ?? []) {
    const row = (
      await db
        .select({ id: facts.id })
        .from(facts)
        .where(and(eq(facts.id, id), eq(facts.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!row) throw new MemoryError(404, "fact link not found");
  }
  for (const id of links.document_ids ?? []) {
    const row = (
      await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!row) throw new MemoryError(404, "document link not found");
  }
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
  const db = createDb(ctx.env.DB);
  for (const id of derived.thought_ids ?? []) {
    if (
      !(
        await db
          .select({ id: thoughts.id })
          .from(thoughts)
          .where(and(eq(thoughts.id, id), eq(thoughts.ownerId, ctx.user.id)))
          .limit(1)
      )[0]
    )
      throw new MemoryError(404, "source thought not found");
    await db.insert(factSourceThoughts).values({ factId, thoughtId: id }).onConflictDoNothing();
  }
  for (const id of derived.fact_ids ?? []) {
    if (id === factId) throw new MemoryError(400, "fact cannot derive from itself");
    if (
      !(
        await db
          .select({ id: facts.id })
          .from(facts)
          .where(and(eq(facts.id, id), eq(facts.ownerId, ctx.user.id)))
          .limit(1)
      )[0]
    )
      throw new MemoryError(404, "source fact not found");
    await db.insert(factSourceFacts).values({ factId, sourceFactId: id }).onConflictDoNothing();
  }
  for (const id of derived.document_ids ?? []) {
    if (
      !(
        await db
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
          .limit(1)
      )[0]
    )
      throw new MemoryError(404, "source document not found");
    await db.insert(factSourceDocuments).values({ factId, documentId: id }).onConflictDoNothing();
  }
  for (const id of derived.document_chunk_ids ?? []) {
    const ok = (
      await db
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .innerJoin(documents, eq(documentChunks.documentId, documents.id))
        .where(and(eq(documentChunks.id, id), eq(documents.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!ok) throw new MemoryError(404, "source document chunk not found");
    await db
      .insert(factSourceDocumentChunks)
      .values({ factId, documentChunkId: id })
      .onConflictDoNothing();
  }
}

async function validateFactDerivations(
  ctx: Ctx,
  factId: string,
  derived?: Parameters<typeof applyFactDerivations>[2],
) {
  if (!derived) return;
  const db = createDb(ctx.env.DB);
  for (const id of derived.thought_ids ?? []) {
    const row = (
      await db
        .select({ id: thoughts.id })
        .from(thoughts)
        .where(and(eq(thoughts.id, id), eq(thoughts.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!row) throw new MemoryError(404, "source thought not found");
  }
  for (const id of derived.fact_ids ?? []) {
    if (id === factId) throw new MemoryError(400, "fact cannot derive from itself");
    const row = (
      await db
        .select({ id: facts.id })
        .from(facts)
        .where(and(eq(facts.id, id), eq(facts.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!row) throw new MemoryError(404, "source fact not found");
  }
  for (const id of derived.document_ids ?? []) {
    const row = (
      await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!row) throw new MemoryError(404, "source document not found");
  }
  for (const id of derived.document_chunk_ids ?? []) {
    const row = (
      await db
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .innerJoin(documents, eq(documentChunks.documentId, documents.id))
        .where(and(eq(documentChunks.id, id), eq(documents.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!row) throw new MemoryError(404, "source document chunk not found");
  }
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
    supersedesFactId: input.supersedes_fact_id ?? null,
    supersededByFactId: null,
    metadata: { topics: input.topics ?? [] },
  };
  if (row.supersedesFactId === row.id) throw new MemoryError(400, "fact cannot supersede itself");
  await db.insert(facts).values(row);
  if (row.supersedesFactId)
    await db
      .update(facts)
      .set({ status: "superseded", supersededByFactId: row.id, updatedAt: now() })
      .where(eq(facts.id, row.supersedesFactId));
  await applyFactDerivations(ctx, row.id, input.derived_from);
  await upsertVector(ctx, row.id, await embed(ctx, input.statement), {
    kind: "fact",
    owner_id: ctx.user.id,
    ...(input.project_id ? { project_id: input.project_id } : {}),
  });
  return row;
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
  for (const [field, message] of [
    ["supersedes_fact_id", "superseded fact not found"],
    ["superseded_by_fact_id", "superseding fact not found"],
  ] as const) {
    const referencedId = input[field];
    if (referencedId === undefined || referencedId === null) continue;
    const referenced = (
      await db
        .select({ id: facts.id })
        .from(facts)
        .where(and(eq(facts.id, String(referencedId)), eq(facts.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!referenced) throw new MemoryError(404, message);
  }
  const statement = (input.statement as string | undefined) ?? row.statement;
  const updatesSupersedes = Object.hasOwn(input, "supersedes_fact_id");
  const updatesSupersededBy = Object.hasOwn(input, "superseded_by_fact_id");
  const supersedesFactId = updatesSupersedes
    ? (input.supersedes_fact_id as string | null)
    : row.supersedesFactId;
  const supersededByFactId = updatesSupersededBy
    ? (input.superseded_by_fact_id as string | null)
    : row.supersededByFactId;
  await db
    .update(facts)
    .set({
      statement,
      citations: (input.citations as string[] | undefined) ?? row.citations,
      confidence: input.confidence === undefined ? row.confidence : Number(input.confidence),
      status: (input.status as string | undefined) ?? row.status,
      supersedesFactId,
      supersededByFactId,
      metadata: input.topics ? { topics: input.topics as string[] } : row.metadata,
      updatedAt: now(),
    })
    .where(eq(facts.id, id));
  if (updatesSupersedes && row.supersedesFactId && row.supersedesFactId !== supersedesFactId)
    await db
      .update(facts)
      .set({ supersededByFactId: null, updatedAt: now() })
      .where(
        and(
          eq(facts.id, row.supersedesFactId),
          eq(facts.ownerId, ctx.user.id),
          eq(facts.supersededByFactId, id),
        ),
      );
  if (supersedesFactId)
    await db
      .update(facts)
      .set({ status: "superseded", supersededByFactId: id, updatedAt: now() })
      .where(and(eq(facts.id, supersedesFactId), eq(facts.ownerId, ctx.user.id)));
  if (
    updatesSupersededBy &&
    row.supersededByFactId &&
    row.supersededByFactId !== supersededByFactId
  )
    await db
      .update(facts)
      .set({ supersedesFactId: null, updatedAt: now() })
      .where(
        and(
          eq(facts.id, row.supersededByFactId),
          eq(facts.ownerId, ctx.user.id),
          eq(facts.supersedesFactId, id),
        ),
      );
  if (supersededByFactId)
    await db
      .update(facts)
      .set({ supersedesFactId: id, updatedAt: now() })
      .where(and(eq(facts.id, supersededByFactId), eq(facts.ownerId, ctx.user.id)));
  if (input.statement !== undefined)
    await upsertVector(ctx, id, await embed(ctx, statement), {
      kind: "fact",
      owner_id: ctx.user.id,
      ...(row.projectId ? { project_id: row.projectId } : {}),
    });
  return (await db.select().from(facts).where(eq(facts.id, id)))[0];
}

export async function addDocument(
  ctx: Ctx,
  input: { title: string; content: string; project_id?: string; mime_type?: string },
) {
  await ensureProject(ctx, input.project_id);
  const db = createDb(ctx.env.DB);
  const id = createId("document");
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
  await insertChunks(ctx, id, input.content, input.project_id ?? null);
  return row;
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

export async function updateDocument(ctx: Ctx, id: string, content: string) {
  const db = createDb(ctx.env.DB);
  const doc = (
    await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!doc) throw new MemoryError(404, "document not found");
  const oldChunks = await db
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, id));
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
    subjectType: (input.subject_type as string | undefined) ?? null,
    subjectId: (input.subject_id as string | undefined) ?? null,
    value: input.value === undefined || input.value === null ? null : Number(input.value),
    unit: (input.unit as string | undefined) ?? null,
    observedAt: asDate(input.observed_at) ?? now(),
    metadata: (input.metadata as Record<string, unknown> | undefined) ?? {},
  };
  await createDb(ctx.env.DB).insert(timeSeriesPoints).values(row);
  return row;
}

async function validateSubject(ctx: Ctx, type?: string, id?: string) {
  if (!type || !id) return;
  const db = createDb(ctx.env.DB);
  const checks: Record<string, Promise<unknown[]>> = {
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
    project: db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.ownerId, ctx.user.id)))
      .limit(1),
    fact: db
      .select({ id: facts.id })
      .from(facts)
      .where(and(eq(facts.id, id), eq(facts.ownerId, ctx.user.id)))
      .limit(1),
  };
  if (checks[type] && !(await checks[type])[0]) throw new MemoryError(404, "subject not found");
}

export async function listTimeSeriesPoints(ctx: Ctx, q: Record<string, string | undefined>) {
  const filters = [eq(timeSeriesPoints.ownerId, ctx.user.id)];
  if (q.series_key) filters.push(eq(timeSeriesPoints.seriesKey, q.series_key));
  if (q.project_id) filters.push(eq(timeSeriesPoints.projectId, q.project_id));
  if (q.subject_type) filters.push(eq(timeSeriesPoints.subjectType, q.subject_type));
  if (q.subject_id) filters.push(eq(timeSeriesPoints.subjectId, q.subject_id));
  if (q.from) filters.push(gte(timeSeriesPoints.observedAt, asDate(Number(q.from)) ?? now()));
  if (q.to) filters.push(lte(timeSeriesPoints.observedAt, asDate(Number(q.to)) ?? now()));
  return createDb(ctx.env.DB)
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
  return createDb(ctx.env.DB)
    .select()
    .from(facts)
    .where(eq(facts.ownerId, ctx.user.id))
    .orderBy(desc(facts.createdAt));
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
  await deleteVectors(
    ctx,
    chunkIds.map((c) => c.id),
  );
  await ctx.env.DOCUMENTS.delete(doc.r2Key);
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
