import {
  createDb,
  dependencyEdges,
  documentChunks,
  documents,
  documentVersions,
  facts,
  people,
  projects,
  tasks,
  thoughts,
  timeSeriesPoints,
  tokens,
  users,
} from "@brainfog/db";
import { generateToken, hashToken } from "@brainfog/shared";
import { and, desc, eq, gte, inArray, isNotNull, like, lte, or, type SQL, sql } from "drizzle-orm";
import type { Env } from "./env";

export type MemoryUser = {
  id: string;
  name: string;
  selfPersonId?: string | null;
  slug?: string | null;
  isAdmin?: boolean;
};
type Ctx = { env: Env; user: MemoryUser; source?: string };
export type MemoryCtx = Ctx;

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
  documentVersion: "d",
  thought: "t",
  dependencyEdge: "e",
  page: "g",
  pageAccessLink: "a",
  ingestionConnector: "n",
  ingestionRun: "u",
  ingestionIdempotencyKey: "i",
  ingestionConnectorCredential: "v",
} as const;

export const graphKinds = [
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
export type GraphKind = (typeof graphKinds)[number];
export type Relationship = (typeof relationships)[number];

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
  new RegExp(`^bf[0-9abcdefghjkmnpqrstvwxyz]{20}${typeSuffix ?? "[rpkfsdcteungiav]"}$`).test(value);

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
      .where(
        and(eq(projects.id, id), or(eq(projects.ownerId, ctx.user.id), eq(projects.shared, true))),
      )
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "project not found");
}

function optionalProjectId(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new MemoryError(400, "project_id must be a string");
  const trimmed = value.trim();
  return trimmed || null;
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

async function entityExists(
  ctx: Ctx,
  kind: GraphKind,
  id: string,
  position: "dependent" | "dependency" = "dependency",
) {
  const db = createDb(ctx.env.DB);

  // For "dependent" position (entity being created/updated), always strict owner check.
  // For "dependency" position (entity being referenced), allow OR shared = true.
  const ownerCheck =
    position === "dependent"
      ? eq(projects.ownerId, ctx.user.id)
      : or(eq(projects.ownerId, ctx.user.id), eq(projects.shared, true));

  const checks: Record<GraphKind, Promise<unknown[]>> = {
    project: db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), ownerCheck))
      .limit(1),
    person: db.select({ id: people.id }).from(people).where(eq(people.id, id)).limit(1),
    task: db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, id),
          position === "dependent"
            ? eq(tasks.ownerId, ctx.user.id)
            : or(eq(tasks.ownerId, ctx.user.id), eq(tasks.shared, true)),
        ),
      )
      .limit(1),
    fact: db
      .select({ id: facts.id })
      .from(facts)
      .where(
        and(
          eq(facts.id, id),
          position === "dependent"
            ? eq(facts.ownerId, ctx.user.id)
            : or(eq(facts.ownerId, ctx.user.id), eq(facts.shared, true)),
        ),
      )
      .limit(1),
    time_series_point: db
      .select({ id: timeSeriesPoints.id })
      .from(timeSeriesPoints)
      .where(
        and(
          eq(timeSeriesPoints.id, id),
          position === "dependent"
            ? eq(timeSeriesPoints.ownerId, ctx.user.id)
            : or(eq(timeSeriesPoints.ownerId, ctx.user.id), eq(timeSeriesPoints.shared, true)),
        ),
      )
      .limit(1),
    document: db
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.id, id),
          position === "dependent"
            ? eq(documents.ownerId, ctx.user.id)
            : or(eq(documents.ownerId, ctx.user.id), eq(documents.shared, true)),
        ),
      )
      .limit(1),
    document_chunk: db
      .select({ id: documentChunks.id })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(
        and(
          eq(documentChunks.id, id),
          position === "dependent"
            ? eq(documents.ownerId, ctx.user.id)
            : or(eq(documents.ownerId, ctx.user.id), eq(documents.shared, true)),
        ),
      )
      .limit(1),
    thought: db
      .select({ id: thoughts.id })
      .from(thoughts)
      .where(
        and(
          eq(thoughts.id, id),
          position === "dependent"
            ? eq(thoughts.ownerId, ctx.user.id)
            : or(eq(thoughts.ownerId, ctx.user.id), eq(thoughts.shared, true)),
        ),
      )
      .limit(1),
  };
  return Boolean((await checks[kind])[0]);
}

async function ensureEntity(
  ctx: Ctx,
  kind: GraphKind,
  id: string,
  position?: "dependent" | "dependency",
  message?: string,
): Promise<void>;
async function ensureEntity(ctx: Ctx, kind: GraphKind, id: string, message?: string): Promise<void>;
async function ensureEntity(
  ctx: Ctx,
  kind: GraphKind,
  id: string,
  positionOrMessage?: string | "dependent" | "dependency",
  message?: string,
) {
  let position: "dependent" | "dependency" = "dependency";
  let finalMessage: string | undefined;

  if (positionOrMessage === "dependent" || positionOrMessage === "dependency") {
    position = positionOrMessage;
    finalMessage = message;
  } else {
    finalMessage = positionOrMessage as string | undefined;
  }

  if (!(await entityExists(ctx, kind, id, position)))
    throw new MemoryError(404, finalMessage ?? "entity not found");
}

// Get entity owner ID for a given kind and id
async function getEntityOwner(
  db: ReturnType<typeof createDb>,
  kind: GraphKind,
  id: string,
): Promise<string | null> {
  const queries: Record<GraphKind, Promise<unknown[]>> = {
    project: db.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, id)),
    person: db.select({ ownerId: sql`NULL` }).from(people).where(eq(people.id, id)),
    task: db.select({ ownerId: tasks.ownerId }).from(tasks).where(eq(tasks.id, id)),
    fact: db.select({ ownerId: facts.ownerId }).from(facts).where(eq(facts.id, id)),
    time_series_point: db
      .select({ ownerId: timeSeriesPoints.ownerId })
      .from(timeSeriesPoints)
      .where(eq(timeSeriesPoints.id, id)),
    document: db.select({ ownerId: documents.ownerId }).from(documents).where(eq(documents.id, id)),
    document_chunk: db
      .select({ ownerId: documents.ownerId })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(eq(documentChunks.id, id)),
    thought: db.select({ ownerId: thoughts.ownerId }).from(thoughts).where(eq(thoughts.id, id)),
  };
  const result = (await queries[kind])[0] as Record<string, unknown> | undefined;
  return (result?.ownerId as string | null | undefined) ?? null;
}

// Get entity shared status
async function getEntityShared(
  db: ReturnType<typeof createDb>,
  kind: GraphKind,
  id: string,
): Promise<boolean> {
  const queries: Record<GraphKind, Promise<unknown[]>> = {
    project: db.select({ shared: projects.shared }).from(projects).where(eq(projects.id, id)),
    person: db.select({ shared: sql`true` }).from(people).where(eq(people.id, id)),
    task: db.select({ shared: tasks.shared }).from(tasks).where(eq(tasks.id, id)),
    fact: db.select({ shared: facts.shared }).from(facts).where(eq(facts.id, id)),
    time_series_point: db
      .select({ shared: timeSeriesPoints.shared })
      .from(timeSeriesPoints)
      .where(eq(timeSeriesPoints.id, id)),
    document: db.select({ shared: documents.shared }).from(documents).where(eq(documents.id, id)),
    document_chunk: db
      .select({ shared: documents.shared })
      .from(documentChunks)
      .innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(eq(documentChunks.id, id)),
    thought: db.select({ shared: thoughts.shared }).from(thoughts).where(eq(thoughts.id, id)),
  };
  const result = (await queries[kind])[0] as Record<string, unknown> | undefined;
  return Boolean(result?.shared);
}

// Cascade-on-share algorithm: mark entities reachable from a target as shared
async function cascadeShare(
  ctx: Ctx,
  targetKind: GraphKind,
  targetId: string,
): Promise<{ kind: GraphKind; id: string }[]> {
  const db = createDb(ctx.env.DB);
  const cascaded: Map<string, { kind: GraphKind; id: string }> = new Map();
  const visited = new Set<string>();
  const queue: { kind: GraphKind; id: string }[] = [{ kind: targetKind, id: targetId }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const key = `${current.kind}:${current.id}`;
    const isTarget = current.kind === targetKind && current.id === targetId;

    if (visited.has(key)) continue;
    visited.add(key);

    // Skip if already shared (except for the original target)
    if (!isTarget) {
      const isAlreadyShared = await getEntityShared(db, current.kind, current.id);
      if (isAlreadyShared) continue;
    }

    // Set shared = true on the entity
    if (current.kind === "project") {
      await db
        .update(projects)
        .set({ shared: true, updatedAt: now() })
        .where(eq(projects.id, current.id));
    } else if (current.kind === "task") {
      await db
        .update(tasks)
        .set({ shared: true, updatedAt: now() })
        .where(eq(tasks.id, current.id));
    } else if (current.kind === "fact") {
      await db
        .update(facts)
        .set({ shared: true, updatedAt: now() })
        .where(eq(facts.id, current.id));
      // Sync Vectorize metadata for the fact
      await resyncVectorSharedMetadata(ctx, current.id);
    } else if (current.kind === "document") {
      await db
        .update(documents)
        .set({ shared: true, updatedAt: now() })
        .where(eq(documents.id, current.id));
      // Sync Vectorize metadata for all document chunks
      const chunks = await db
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, current.id));
      for (const chunk of chunks) {
        await resyncVectorSharedMetadata(ctx, chunk.id);
      }
    } else if (current.kind === "thought") {
      await db
        .update(thoughts)
        .set({ shared: true, updatedAt: now() })
        .where(eq(thoughts.id, current.id));
      // Sync Vectorize metadata for the thought
      await resyncVectorSharedMetadata(ctx, current.id);
    } else if (current.kind === "time_series_point") {
      await db
        .update(timeSeriesPoints)
        .set({ shared: true, updatedAt: now() })
        .where(eq(timeSeriesPoints.id, current.id));
    } else if (current.kind === "document_chunk") {
      // document_chunks inherit shared from their parent document, so update the parent
      const docChunk = (
        await db
          .select({ documentId: documentChunks.documentId })
          .from(documentChunks)
          .where(eq(documentChunks.id, current.id))
          .limit(1)
      )[0];
      if (docChunk) {
        await db
          .update(documents)
          .set({ shared: true, updatedAt: now() })
          .where(eq(documents.id, docChunk.documentId));
        // Sync Vectorize metadata for all document chunks
        const chunks = await db
          .select({ id: documentChunks.id })
          .from(documentChunks)
          .where(eq(documentChunks.documentId, docChunk.documentId));
        for (const chunk of chunks) {
          await resyncVectorSharedMetadata(ctx, chunk.id);
        }
        cascaded.set(`document:${docChunk.documentId}`, {
          kind: "document",
          id: docChunk.documentId,
        });
      }
      continue; // Skip further processing for chunks
    }

    // Track cascaded changes (skip person and original target)
    if (current.kind !== "person" && !isTarget) {
      cascaded.set(key, current);
    }

    // Project containment: enqueue all project-scoped rows
    if (current.kind === "project") {
      const contained = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.projectId, current.id));
      for (const row of contained) queue.push({ kind: "task", id: row.id });

      const facts_ = await db
        .select({ id: facts.id })
        .from(facts)
        .where(eq(facts.projectId, current.id));
      for (const row of facts_) queue.push({ kind: "fact", id: row.id });

      const docs = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.projectId, current.id));
      for (const row of docs) queue.push({ kind: "document", id: row.id });

      const thoughts_ = await db
        .select({ id: thoughts.id })
        .from(thoughts)
        .where(eq(thoughts.projectId, current.id));
      for (const row of thoughts_) queue.push({ kind: "thought", id: row.id });

      const points = await db
        .select({ id: timeSeriesPoints.id })
        .from(timeSeriesPoints)
        .where(eq(timeSeriesPoints.projectId, current.id));
      for (const row of points) queue.push({ kind: "time_series_point", id: row.id });
    }

    // Graph dependencies: enqueue all entities this one depends on
    const dependencies = await db
      .select({
        dependencyKind: dependencyEdges.dependencyKind,
        dependencyId: dependencyEdges.dependencyId,
      })
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.dependentKind, current.kind),
          eq(dependencyEdges.dependentId, current.id),
        ),
      );
    for (const dep of dependencies) {
      queue.push({ kind: dep.dependencyKind as GraphKind, id: dep.dependencyId });
    }
  }

  return Array.from(cascaded.values());
}

// Apply project contagion: if a project belongs to a different user and is shared,
// mark the entity as shared and cascade
async function applyProjectContagion(
  ctx: Ctx,
  entityKind: GraphKind,
  entityId: string,
  projectId: string | null | undefined,
): Promise<{ kind: GraphKind; id: string }[]> {
  if (!projectId) return [];

  const db = createDb(ctx.env.DB);
  const projectOwner = await getEntityOwner(db, "project", projectId);

  // Only apply contagion if project is owned by a different user
  if (!projectOwner || projectOwner === ctx.user.id) return [];

  const projectIsShared = await getEntityShared(db, "project", projectId);
  if (!projectIsShared) return [];

  // Project is owned by another user and is shared - apply contagion
  const entityIsShared = await getEntityShared(db, entityKind, entityId);
  if (entityIsShared) return [];

  // Mark entity as shared
  if (entityKind === "project") {
    await db
      .update(projects)
      .set({ shared: true, updatedAt: now() })
      .where(eq(projects.id, entityId));
  } else if (entityKind === "task") {
    await db.update(tasks).set({ shared: true, updatedAt: now() }).where(eq(tasks.id, entityId));
  } else if (entityKind === "fact") {
    await db.update(facts).set({ shared: true, updatedAt: now() }).where(eq(facts.id, entityId));
  } else if (entityKind === "document") {
    await db
      .update(documents)
      .set({ shared: true, updatedAt: now() })
      .where(eq(documents.id, entityId));
  } else if (entityKind === "thought") {
    await db
      .update(thoughts)
      .set({ shared: true, updatedAt: now() })
      .where(eq(thoughts.id, entityId));
  } else if (entityKind === "time_series_point") {
    await db
      .update(timeSeriesPoints)
      .set({ shared: true, updatedAt: now() })
      .where(eq(timeSeriesPoints.id, entityId));
  }

  const cascaded = [{ kind: entityKind, id: entityId }];
  const cascadedFromEntity = await cascadeShare(ctx, entityKind, entityId);
  cascaded.push(...cascadedFromEntity);

  return cascaded;
}

export async function createDependency(
  ctx: Ctx,
  input: {
    dependent: { kind: string; id: string };
    dependency: { kind: string; id: string };
    relationship: string;
    metadata?: Record<string, unknown>;
  },
): Promise<Record<string, unknown> & { cascaded?: { kind: GraphKind; id: string }[] }> {
  const dependentKind = asGraphKind(input.dependent?.kind);
  const dependencyKind = asGraphKind(input.dependency?.kind);
  const relationship = asRelationship(input.relationship);
  const dependentId = String(input.dependent?.id ?? "");
  const dependencyId = String(input.dependency?.id ?? "");
  if (!dependentId || !dependencyId) throw new MemoryError(400, "missing dependency endpoint");

  // Dependent must always be owned by caller (strict)
  await ensureEntity(ctx, dependentKind, dependentId, "dependent", "dependent not found");

  // Check if dependent is owned by caller (double-check)
  const db = createDb(ctx.env.DB);
  const dependentOwner = await getEntityOwner(db, dependentKind, dependentId);
  if (dependentOwner !== ctx.user.id)
    throw new MemoryError(403, "cannot modify dependent not owned by caller");

  // Dependency can be owned by caller or be shared (unless person/document_chunk exemptions)
  const dependencyOwner = await getEntityOwner(db, dependencyKind, dependencyId);
  const dependencyIsShared = await getEntityShared(db, dependencyKind, dependencyId);

  // Cross-owner reference rule with exemptions
  let contagion = false;
  if (dependencyOwner && dependencyOwner !== ctx.user.id) {
    // Exemption: person references never trigger contagion
    if (dependencyKind === "person") {
      // Allowed, no contagion
    }
    // Exemption: document_chunk via parent document
    else if (dependencyKind === "document_chunk") {
      // Allowed only if parent document is shared, no contagion
      if (!dependencyIsShared) throw new MemoryError(404, "dependency not found");
    }
    // Non-exempted cross-owner reference
    else {
      // Allowed only if dependency is shared
      if (!dependencyIsShared) throw new MemoryError(404, "dependency not found");
      contagion = true;
    }
  }

  // Verify dependency exists
  await ensureEntity(ctx, dependencyKind, dependencyId, "dependency", "dependency not found");

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
  await db.insert(dependencyEdges).values(row).onConflictDoNothing();

  // If contagion, mark dependent as shared and cascade
  let cascaded: { kind: GraphKind; id: string }[] = [];
  if (contagion) {
    const dependentIsShared = await getEntityShared(db, dependentKind, dependentId);
    if (!dependentIsShared) {
      // Mark dependent as shared
      if (dependentKind === "project") {
        await db
          .update(projects)
          .set({ shared: true, updatedAt: now() })
          .where(eq(projects.id, dependentId));
      } else if (dependentKind === "task") {
        await db
          .update(tasks)
          .set({ shared: true, updatedAt: now() })
          .where(eq(tasks.id, dependentId));
      } else if (dependentKind === "fact") {
        await db
          .update(facts)
          .set({ shared: true, updatedAt: now() })
          .where(eq(facts.id, dependentId));
      } else if (dependentKind === "document") {
        await db
          .update(documents)
          .set({ shared: true, updatedAt: now() })
          .where(eq(documents.id, dependentId));
      } else if (dependentKind === "thought") {
        await db
          .update(thoughts)
          .set({ shared: true, updatedAt: now() })
          .where(eq(thoughts.id, dependentId));
      } else if (dependentKind === "time_series_point") {
        await db
          .update(timeSeriesPoints)
          .set({ shared: true, updatedAt: now() })
          .where(eq(timeSeriesPoints.id, dependentId));
      }
      cascaded.push({ kind: dependentKind, id: dependentId });

      // Run cascade from dependent
      const cascadedFromDependent = await cascadeShare(ctx, dependentKind, dependentId);
      cascaded = cascaded.concat(cascadedFromDependent);
    }
  }

  const edges = await db
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
    .limit(1);
  const edge = edges[0];

  if (cascaded.length > 0) {
    return { ...edge, cascaded } as Record<string, unknown> & {
      cascaded: { kind: GraphKind; id: string }[];
    };
  }
  return edge as Record<string, unknown>;
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
  const db = createDb(ctx.env.DB);
  const isGlobal =
    dependencyKind === "person" || (await getEntityShared(db, dependencyKind, dependencyId));
  const timestamp = now();

  // If the dependency is global (person) or shared, mark stale across all owners
  // Otherwise, scope to caller's edges only
  const ownerFilter = isGlobal ? [] : [eq(dependencyEdges.ownerId, ctx.user.id)];

  await db
    .update(dependencyEdges)
    .set({ staleAt: timestamp, staleReason: reason, updatedAt: timestamp })
    .where(
      and(
        ...ownerFilter,
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

// Kinds that support shared flag
const shareableKinds = ["project", "task", "fact", "document", "thought", "time_series_point"];

export async function setShared(
  ctx: Ctx,
  input: { entity_kind: string; entity_id: string; shared: boolean },
) {
  const entityKind = asGraphKind(input.entity_kind);

  // Validate that this kind supports shared flag
  if (!(shareableKinds as readonly string[]).includes(entityKind))
    throw new MemoryError(400, "entity kind does not support shared flag");

  const entityId = String(input.entity_id ?? "");
  if (!entityId) throw new MemoryError(400, "missing entity_id");

  const db = createDb(ctx.env.DB);

  // Entity must be owned by caller (strict - no shared=true relaxation)
  const owner = await getEntityOwner(db, entityKind, entityId);
  if (owner !== ctx.user.id) throw new MemoryError(404, "entity not found");

  let result: Record<string, unknown> | undefined;
  const timestamp = now();

  if (input.shared) {
    // Setting to true: run cascade
    // First, mark the target itself as shared
    if (entityKind === "project") {
      await db
        .update(projects)
        .set({ shared: true, updatedAt: timestamp })
        .where(eq(projects.id, entityId));
      result = (await db.select().from(projects).where(eq(projects.id, entityId)).limit(1))[0];
    } else if (entityKind === "task") {
      await db
        .update(tasks)
        .set({ shared: true, updatedAt: timestamp })
        .where(eq(tasks.id, entityId));
      result = (await db.select().from(tasks).where(eq(tasks.id, entityId)).limit(1))[0];
    } else if (entityKind === "fact") {
      await db
        .update(facts)
        .set({ shared: true, updatedAt: timestamp })
        .where(eq(facts.id, entityId));
      result = (await db.select().from(facts).where(eq(facts.id, entityId)).limit(1))[0];
    } else if (entityKind === "document") {
      await db
        .update(documents)
        .set({ shared: true, updatedAt: timestamp })
        .where(eq(documents.id, entityId));
      result = (await db.select().from(documents).where(eq(documents.id, entityId)).limit(1))[0];
    } else if (entityKind === "thought") {
      await db
        .update(thoughts)
        .set({ shared: true, updatedAt: timestamp })
        .where(eq(thoughts.id, entityId));
      result = (await db.select().from(thoughts).where(eq(thoughts.id, entityId)).limit(1))[0];
    } else if (entityKind === "time_series_point") {
      await db
        .update(timeSeriesPoints)
        .set({ shared: true, updatedAt: timestamp })
        .where(eq(timeSeriesPoints.id, entityId));
      result = (
        await db.select().from(timeSeriesPoints).where(eq(timeSeriesPoints.id, entityId)).limit(1)
      )[0];
    }

    // Run cascade
    const cascaded = await cascadeShare(ctx, entityKind, entityId);
    return { ...result, cascaded } as Record<string, unknown> & {
      cascaded: { kind: GraphKind; id: string }[];
    };
  } else {
    // Setting to false: only flip the target's own flag, no cascade reversal
    if (entityKind === "project") {
      await db
        .update(projects)
        .set({ shared: false, updatedAt: timestamp })
        .where(eq(projects.id, entityId));
      result = (await db.select().from(projects).where(eq(projects.id, entityId)).limit(1))[0];
    } else if (entityKind === "task") {
      await db
        .update(tasks)
        .set({ shared: false, updatedAt: timestamp })
        .where(eq(tasks.id, entityId));
      result = (await db.select().from(tasks).where(eq(tasks.id, entityId)).limit(1))[0];
    } else if (entityKind === "fact") {
      await db
        .update(facts)
        .set({ shared: false, updatedAt: timestamp })
        .where(eq(facts.id, entityId));
      result = (await db.select().from(facts).where(eq(facts.id, entityId)).limit(1))[0];
    } else if (entityKind === "document") {
      await db
        .update(documents)
        .set({ shared: false, updatedAt: timestamp })
        .where(eq(documents.id, entityId));
      result = (await db.select().from(documents).where(eq(documents.id, entityId)).limit(1))[0];
    } else if (entityKind === "thought") {
      await db
        .update(thoughts)
        .set({ shared: false, updatedAt: timestamp })
        .where(eq(thoughts.id, entityId));
      result = (await db.select().from(thoughts).where(eq(thoughts.id, entityId)).limit(1))[0];
    } else if (entityKind === "time_series_point") {
      await db
        .update(timeSeriesPoints)
        .set({ shared: false, updatedAt: timestamp })
        .where(eq(timeSeriesPoints.id, entityId));
      result = (
        await db.select().from(timeSeriesPoints).where(eq(timeSeriesPoints.id, entityId)).limit(1)
      )[0];
    }

    return result as Record<string, unknown>;
  }
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
  // Relax existence check to "dependency" position to allow reading edges where the queried entity is shared
  await ensureEntity(ctx, entityKind, input.entity_id, "dependency", "entity not found");

  const db = createDb(ctx.env.DB);
  const filters = [];
  let queryDirection: "upstream" | "downstream" | "both" = direction as
    | "upstream"
    | "downstream"
    | "both";

  if (direction === "upstream") {
    filters.push(eq(dependencyEdges.dependentKind, entityKind));
    filters.push(eq(dependencyEdges.dependentId, input.entity_id));
    queryDirection = "upstream";
  } else if (direction === "downstream") {
    filters.push(eq(dependencyEdges.dependencyKind, entityKind));
    filters.push(eq(dependencyEdges.dependencyId, input.entity_id));
    queryDirection = "downstream";
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
    queryDirection = "both";
  }
  if (input.relationship) filters.push(eq(dependencyEdges.relationship, input.relationship));

  const allEdges = await db
    .select()
    .from(dependencyEdges)
    .where(and(...filters))
    .orderBy(desc(dependencyEdges.createdAt));

  // Filter edges: return if caller owns it, or the non-queried endpoint is accessible
  const visibleEdges = [];
  for (const edge of allEdges) {
    // Always return if caller owns the edge
    if (edge.ownerId === ctx.user.id) {
      visibleEdges.push(edge);
      continue;
    }

    // For cross-owner edges, check if the non-queried endpoint is accessible to caller
    let otherEndpointAccessible = false;
    if (queryDirection === "upstream") {
      // Entity is the dependent; check if the dependency is accessible
      otherEndpointAccessible = await entityExists(
        ctx,
        edge.dependencyKind as GraphKind,
        edge.dependencyId,
        "dependency",
      );
    } else if (queryDirection === "downstream") {
      // Entity is the dependency; check if the dependent is accessible
      otherEndpointAccessible = await entityExists(
        ctx,
        edge.dependentKind as GraphKind,
        edge.dependentId,
        "dependency",
      );
    } else {
      // Both directions; check both endpoints (but one is the queried entity, so check the other)
      if (edge.dependentKind === entityKind && edge.dependentId === input.entity_id) {
        // Entity is the dependent; check dependency
        otherEndpointAccessible = await entityExists(
          ctx,
          edge.dependencyKind as GraphKind,
          edge.dependencyId,
          "dependency",
        );
      } else {
        // Entity is the dependency; check dependent
        otherEndpointAccessible = await entityExists(
          ctx,
          edge.dependentKind as GraphKind,
          edge.dependentId,
          "dependency",
        );
      }
    }

    if (otherEndpointAccessible) {
      visibleEdges.push(edge);
    }
  }

  return visibleEdges;
}

export async function markStale(
  ctx: Ctx,
  input: { entity_kind: string; entity_id: string; reason?: string; stale_since?: number },
) {
  const entityKind = asGraphKind(input.entity_kind);
  // Relax to "dependency" position so a caller can mark stale their own edges pointing at a shared entity owned by someone else
  await ensureEntity(ctx, entityKind, input.entity_id, "dependency", "entity not found");
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
  // Query all stale edges across all owners (drop the ownerId = caller filter from base query)
  const filters = [isNotNull(dependencyEdges.staleAt)];
  if (input.kind) filters.push(eq(dependencyEdges.dependentKind, input.kind));
  const allRows = await createDb(ctx.env.DB)
    .select()
    .from(dependencyEdges)
    .where(and(...filters))
    .orderBy(desc(dependencyEdges.staleAt));

  // Apply in-app filter: keep row if caller owns it, or either endpoint is caller-accessible
  const visibleRows = [];
  for (const row of allRows) {
    const isOwnedByCallerEdge = row.ownerId === ctx.user.id;
    const dependentAccessible = await entityExists(
      ctx,
      row.dependentKind as GraphKind,
      row.dependentId,
      "dependency",
    );
    const dependencyAccessible = await entityExists(
      ctx,
      row.dependencyKind as GraphKind,
      row.dependencyId,
      "dependency",
    );
    if (isOwnedByCallerEdge || dependentAccessible || dependencyAccessible) {
      visibleRows.push(row);
    }
  }

  // Apply project_id post-filter if provided
  if (!input.project_id) return visibleRows;
  const out = [];
  for (const row of visibleRows) {
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
        .where(and(eq(tasks.id, id), or(eq(tasks.ownerId, ctx.user.id), eq(tasks.shared, true))))
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  if (kind === "fact") {
    const row = (
      await db
        .select({ projectId: facts.projectId })
        .from(facts)
        .where(and(eq(facts.id, id), or(eq(facts.ownerId, ctx.user.id), eq(facts.shared, true))))
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  if (kind === "document") {
    const row = (
      await db
        .select({ projectId: documents.projectId })
        .from(documents)
        .where(
          and(
            eq(documents.id, id),
            or(eq(documents.ownerId, ctx.user.id), eq(documents.shared, true)),
          ),
        )
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
        .where(
          and(
            eq(documentChunks.id, id),
            or(eq(documents.ownerId, ctx.user.id), eq(documents.shared, true)),
          ),
        )
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  if (kind === "thought") {
    const row = (
      await db
        .select({ projectId: thoughts.projectId })
        .from(thoughts)
        .where(
          and(
            eq(thoughts.id, id),
            or(eq(thoughts.ownerId, ctx.user.id), eq(thoughts.shared, true)),
          ),
        )
        .limit(1)
    )[0];
    return row?.projectId ?? null;
  }
  if (kind === "time_series_point") {
    const row = (
      await db
        .select({ projectId: timeSeriesPoints.projectId })
        .from(timeSeriesPoints)
        .where(
          and(
            eq(timeSeriesPoints.id, id),
            or(eq(timeSeriesPoints.ownerId, ctx.user.id), eq(timeSeriesPoints.shared, true)),
          ),
        )
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

async function resyncVectorSharedMetadata(ctx: Ctx, vectorId: string) {
  if (ctx.env.TEST_MIGRATIONS) return;
  try {
    const existing = await ctx.env.VECTORIZE.getByIds([vectorId]);
    const vector = existing?.[0];
    if (!vector) return;
    await ctx.env.VECTORIZE.upsert([
      { id: vectorId, values: vector.values, metadata: { ...vector.metadata, shared: true } },
    ]);
  } catch {
    // best-effort re-upsert; Vectorize remains a derived, rebuildable index
  }
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
    .where(or(eq(projects.ownerId, ctx.user.id), eq(projects.shared, true)))
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
    const existing = (await db.select().from(people).where(eq(people.id, input.id)).limit(1))[0];
    if (!existing) throw new MemoryError(404, "person not found");
    const updated = {
      ...existing,
      name: input.name,
      source: source(ctx),
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
  return createDb(ctx.env.DB).select().from(people).orderBy(people.name);
}

export async function getSelfPerson(ctx: Ctx) {
  const selfPersonId = ctx.user.selfPersonId ?? null;
  if (!selfPersonId) return null;
  const row = (
    await createDb(ctx.env.DB).select().from(people).where(eq(people.id, selfPersonId)).limit(1)
  )[0];
  return row ?? null;
}

export async function whoami(ctx: Ctx) {
  return {
    id: ctx.user.id,
    name: ctx.user.name,
    self_person_id: ctx.user.selfPersonId ?? null,
    self_person: await getSelfPerson(ctx),
  };
}

export async function setSelfPerson(ctx: Ctx, personId: string | null) {
  const db = createDb(ctx.env.DB);
  if (personId !== null) {
    const row = (
      await db.select({ id: people.id }).from(people).where(eq(people.id, personId)).limit(1)
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
  const projectId = optionalProjectId(input.project_id);
  await ensureProject(ctx, projectId);
  const row = {
    id: createId("task"),
    ownerId: ctx.user.id,
    projectId,
    source: source(ctx),
    title: String(input.title),
    description: (input.description as string | undefined) ?? null,
    status: (input.status as string | undefined) ?? "open",
    priority: Number(input.priority ?? 0.5),
    dueAt: asDate(input.due_at) ?? null,
    recurrence: validateRecurrence(input.recurrence),
  };
  await createDb(ctx.env.DB).insert(tasks).values(row);
  const cascaded = await applyProjectContagion(ctx, "task", row.id, row.projectId);
  if (cascaded.length > 0) {
    return { ...row, cascaded };
  }
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
  const projectId = hasProjectId ? optionalProjectId(input.project_id) : row.projectId;
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
  const cascaded = hasProjectId ? await applyProjectContagion(ctx, "task", id, projectId) : [];
  await markDownstreamStale(ctx, "task", id);
  const updated = (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
  if (cascaded.length > 0) {
    return { ...updated, cascaded };
  }
  return updated;
}

export async function listTasks(ctx: Ctx, q: { project_id?: string; status?: string }) {
  const filters = [or(eq(tasks.ownerId, ctx.user.id), eq(tasks.shared, true))];
  if (q.project_id) filters.push(eq(tasks.projectId, q.project_id));
  if (q.status) filters.push(eq(tasks.status, q.status));
  return createDb(ctx.env.DB)
    .select()
    .from(tasks)
    .where(and(...filters))
    .orderBy(desc(tasks.createdAt));
}

type ThoughtLinks = {
  people_ids?: string[];
  task_ids?: string[];
  fact_ids?: string[];
  document_ids?: string[];
  time_series_point_ids?: string[];
};

const thoughtLinkKeys = new Set([
  "people_ids",
  "task_ids",
  "fact_ids",
  "document_ids",
  "time_series_point_ids",
]);

function assertThoughtLinksShape(links?: unknown): asserts links is ThoughtLinks | undefined {
  if (!links) return;
  if (typeof links !== "object" || Array.isArray(links)) {
    throw new MemoryError(400, "links must be an object");
  }
  const unknownKeys = Object.keys(links).filter((key) => !thoughtLinkKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new MemoryError(400, `unknown thought link key: ${unknownKeys[0]}`);
  }
  for (const [key, value] of Object.entries(links)) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new MemoryError(400, `thought link key must be a string array: ${key}`);
    }
  }
}

async function applyThoughtLinks(ctx: Ctx, thoughtId: string, links?: ThoughtLinks) {
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
  for (const id of links.time_series_point_ids ?? []) {
    await ensureEntity(ctx, "time_series_point", id, "time-series point link not found");
    await createDependency(ctx, {
      dependent: { kind: "thought", id: thoughtId },
      dependency: { kind: "time_series_point", id },
      relationship: "references",
    });
  }
}

async function validateThoughtLinks(ctx: Ctx, links?: unknown) {
  assertThoughtLinksShape(links);
  if (!links) return;
  for (const id of links.people_ids ?? [])
    await ensureEntity(ctx, "person", id, "person link not found");
  for (const id of links.task_ids ?? []) await ensureEntity(ctx, "task", id, "task link not found");
  for (const id of links.fact_ids ?? []) await ensureEntity(ctx, "fact", id, "fact link not found");
  for (const id of links.document_ids ?? [])
    await ensureEntity(ctx, "document", id, "document link not found");
  for (const id of links.time_series_point_ids ?? [])
    await ensureEntity(ctx, "time_series_point", id, "time-series point link not found");
}

export async function remember(
  ctx: Ctx,
  input: {
    content: string;
    type?: string;
    project_id?: string;
    links?: ThoughtLinks;
  },
) {
  const projectId = optionalProjectId(input.project_id);
  await ensureProject(ctx, projectId);
  await validateThoughtLinks(ctx, input.links);
  const db = createDb(ctx.env.DB);
  const row = {
    id: createId("thought"),
    ownerId: ctx.user.id,
    projectId,
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
    shared: false,
    ...(projectId ? { project_id: projectId } : {}),
  });
  const cascaded = await applyProjectContagion(ctx, "thought", row.id, row.projectId);
  if (cascaded.length > 0) {
    return { ...row, cascaded };
  }
  return row;
}

export async function linkThought(ctx: Ctx, thoughtId: string, links: ThoughtLinks) {
  const row = (
    await createDb(ctx.env.DB)
      .select({ id: thoughts.id })
      .from(thoughts)
      .where(and(eq(thoughts.id, thoughtId), eq(thoughts.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "thought not found");
  await validateThoughtLinks(ctx, links);
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
  const projectId = optionalProjectId(input.project_id);
  await ensureProject(ctx, projectId);
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
    projectId,
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
    shared: false,
    ...(projectId ? { project_id: projectId } : {}),
  });
  const created = (await db.select().from(facts).where(eq(facts.id, row.id)))[0];
  if (!created) throw new MemoryError(500, "fact insert failed");
  const cascaded = await applyProjectContagion(ctx, "fact", row.id, row.projectId);
  const result = factWithSupersession(ctx, created);
  if (cascaded.length > 0) {
    return { ...result, cascaded };
  }
  return result;
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
      shared: row.shared,
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
  const projectId = optionalProjectId(input.project_id);
  await ensureProject(ctx, projectId);
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
    projectId,
    source: source(ctx),
    title: input.title,
    r2Key,
    mimeType: input.mime_type ?? "text/markdown",
    sizeBytes: new TextEncoder().encode(input.content).byteLength,
  };
  await db.insert(documents).values(row);
  await applyDocumentDerivations(ctx, id, input.derived_from);
  await insertChunks(ctx, id, input.content, projectId);
  const cascaded = await applyProjectContagion(ctx, "document", row.id, row.projectId);
  if (cascaded.length > 0) {
    return { ...row, cascaded };
  }
  return row;
}

const directDocumentUploadMaxBytes = 25 * 1024 * 1024;
export const documentWriteModes = ["overwrite_current", "create_version"] as const;
export type DocumentWriteMode = (typeof documentWriteModes)[number];

function documentWriteMode(value: unknown): DocumentWriteMode {
  if (value === undefined || value === null) return "overwrite_current";
  if (typeof value === "string" && (documentWriteModes as readonly string[]).includes(value)) {
    return value as DocumentWriteMode;
  }
  throw new MemoryError(400, "invalid document write_mode");
}

function safeVersionMetadata<T extends { r2Key?: string }>(row: T) {
  const { r2Key: _r2Key, ...safe } = row;
  return safe;
}

function isTextLikeMimeType(mimeType: string) {
  const value = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    value.startsWith("text/") ||
    [
      "application/json",
      "application/ld+json",
      "application/markdown",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/javascript",
      "application/typescript",
      "image/svg+xml",
    ].includes(value) ||
    value.endsWith("+json") ||
    value.endsWith("+xml")
  );
}

function decodeUtf8(bytes: ArrayBuffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch (_error) {
    throw new MemoryError(400, "text-like document bytes must be valid UTF-8");
  }
}

function validateMimeType(mimeType: string | null | undefined): string {
  if (!mimeType) return "application/octet-stream";
  const trimmed = mimeType.trim();
  if (!trimmed) return "application/octet-stream";
  if (trimmed.length > 200) throw new MemoryError(400, "MIME type exceeds 200 characters");
  if (trimmed.length > 0 && [...trimmed].some((ch) => ch < " " || ch === "\x7f"))
    throw new MemoryError(400, "MIME type contains control characters");
  if (!trimmed.includes("/")) throw new MemoryError(400, "MIME type must have type/subtype format");
  if (trimmed.includes('"')) throw new MemoryError(400, "MIME type must not contain double quotes");
  return trimmed;
}

function safeFilename(value?: string | null) {
  const cleaned = (value ?? "document").replace(/[\\/\r\n\0"]/g, "_").trim();
  return cleaned || "document";
}

export async function createDocumentFromBytes(
  ctx: Ctx,
  input: {
    title: string;
    bytes: ArrayBuffer;
    project_id?: string | null;
    mime_type?: string | null;
    filename?: string | null;
  },
) {
  const title = input.title.trim();
  if (!title) throw new MemoryError(400, "missing title");
  if (input.bytes.byteLength > directDocumentUploadMaxBytes) {
    throw new MemoryError(400, "document upload exceeds 25 MiB limit");
  }
  const projectId = optionalProjectId(input.project_id);
  await ensureProject(ctx, projectId);
  const db = createDb(ctx.env.DB);
  const id = createId("document");
  const mimeType = validateMimeType(input.mime_type);
  // Decode text-like content before persisting to R2/D1 so invalid UTF-8
  // fails with 400 and leaves no stored state.
  let decodedText: string | undefined;
  if (isTextLikeMimeType(mimeType)) {
    decodedText = decodeUtf8(input.bytes);
  }
  const extension = isTextLikeMimeType(mimeType) ? ".txt" : ".bin";
  const r2Key = `${ctx.user.id}/${id}${extension}`;
  await ctx.env.DOCUMENTS.put(r2Key, input.bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: input.filename ? { filename: safeFilename(input.filename) } : undefined,
  });
  const row = {
    id,
    ownerId: ctx.user.id,
    projectId,
    source: source(ctx),
    title,
    r2Key,
    mimeType,
    sizeBytes: input.bytes.byteLength,
  };
  await db.insert(documents).values(row);
  if (decodedText !== undefined) {
    await insertChunks(ctx, id, decodedText, projectId);
  }
  const cascaded = await applyProjectContagion(ctx, "document", row.id, row.projectId);
  if (cascaded.length > 0) return { ...row, cascaded };
  return row;
}

export async function updateDocumentFromBytes(
  ctx: Ctx,
  id: string,
  bytes: ArrayBuffer,
  write_mode?: DocumentWriteMode,
  mime_type?: string | null,
  filename?: string | null,
) {
  const db = createDb(ctx.env.DB);
  const doc = await getOwnedDocument(ctx, id);
  const writeMode = documentWriteMode(write_mode);

  if (bytes.byteLength > directDocumentUploadMaxBytes) {
    throw new MemoryError(400, "document upload exceeds 25 MiB limit");
  }

  const callerProvidedMimeType = typeof mime_type === "string" && mime_type.trim().length > 0;
  const mimeType = callerProvidedMimeType ? validateMimeType(mime_type) : doc.mimeType;

  // Decode text-like content before any R2/D1 writes so invalid UTF-8
  // fails with 400 and leaves no stored state.
  let decodedText: string | undefined;
  if (isTextLikeMimeType(mimeType)) {
    decodedText = decodeUtf8(bytes);
  }

  if (writeMode === "create_version") {
    const historicalKey = `${ctx.user.id}/${id}/versions/${doc.currentVersionNumber}-${createId("documentVersion")}`;
    const currentObject = await ctx.env.DOCUMENTS.get(doc.r2Key);
    if (!currentObject) throw new MemoryError(404, "document content not found");
    const previousBytes = await currentObject.arrayBuffer();
    await ctx.env.DOCUMENTS.put(historicalKey, previousBytes, {
      httpMetadata: { contentType: doc.mimeType },
      customMetadata: currentObject.customMetadata,
    });
    await db.insert(documentVersions).values({
      id: createId("documentVersion"),
      documentId: doc.id,
      ownerId: doc.ownerId,
      source: source(ctx),
      versionNumber: doc.currentVersionNumber,
      r2Key: historicalKey,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes ?? previousBytes.byteLength,
    });
  }

  await markDownstreamStale(ctx, "document", id);

  const oldChunks = await db
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(eq(documentChunks.documentId, id));

  await cleanDocumentChunkGraphEdges(
    ctx,
    id,
    oldChunks.map((c) => c.id),
    { staleReason: "document_chunks_replaced" },
  );
  await deleteVectors(
    ctx,
    oldChunks.map((c) => c.id),
  );
  await db.delete(documentChunks).where(eq(documentChunks.documentId, id));

  await ctx.env.DOCUMENTS.put(doc.r2Key, bytes, {
    httpMetadata: { contentType: mimeType },
    customMetadata: filename ? { filename: safeFilename(filename) } : undefined,
  });

  const updateFields: Record<string, unknown> = {
    sizeBytes: bytes.byteLength,
    currentVersionNumber:
      writeMode === "create_version" ? doc.currentVersionNumber + 1 : doc.currentVersionNumber,
    updatedAt: now(),
  };
  if (callerProvidedMimeType) {
    updateFields.mimeType = mimeType;
  }
  await db.update(documents).set(updateFields).where(eq(documents.id, id));

  if (decodedText !== undefined) {
    await insertChunks(ctx, id, decodedText, doc.projectId, doc.shared);
  }

  const updated = (await db.select().from(documents).where(eq(documents.id, id)))[0];
  if (!updated) throw new MemoryError(500, "updated document not found");
  return updated;
}

export async function getDocumentBytes(ctx: Ctx, id: string) {
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
  return { doc, bytes: await object.arrayBuffer(), filename: object.customMetadata?.filename };
}

async function getReadableDocument(ctx: Ctx, id: string) {
  const doc = (
    await createDb(ctx.env.DB)
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, id),
          or(eq(documents.ownerId, ctx.user.id), eq(documents.shared, true)),
        ),
      )
      .limit(1)
  )[0];
  if (!doc) throw new MemoryError(404, "document not found");
  return doc;
}

async function getOwnedDocument(ctx: Ctx, id: string) {
  const doc = (
    await createDb(ctx.env.DB)
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!doc) throw new MemoryError(404, "document not found");
  return doc;
}

function transferPath(path: string, params: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, value);
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export async function createDocumentUploadLink(
  ctx: Ctx,
  input: {
    title?: string;
    filename?: string;
    mime_type?: string;
    project_id?: string;
    document_id?: string;
    write_mode?: string;
  },
) {
  if (input.document_id) {
    // Update mode: target an existing document
    if (input.project_id !== undefined)
      throw new MemoryError(400, "project_id is not accepted when updating an existing document");
    const doc = await getOwnedDocument(ctx, input.document_id);
    if (input.title !== undefined)
      throw new MemoryError(400, "title is not accepted when updating an existing document");
    const writeMode = documentWriteMode(input.write_mode);
    const callerProvidedMimeType =
      typeof input.mime_type === "string" && input.mime_type.trim().length > 0;
    const responseMimeType = callerProvidedMimeType
      ? validateMimeType(input.mime_type)
      : doc.mimeType;
    const path = transferPath(`/api/v1/documents/${doc.id}/direct-upload`, {
      filename: input.filename,
      mime_type: callerProvidedMimeType ? responseMimeType : undefined,
      write_mode: writeMode === "overwrite_current" ? undefined : writeMode,
    });
    return {
      url: path,
      method: "PATCH",
      headers: {
        Authorization: "Bearer <your existing brainfog bearer token>",
        "Content-Type": responseMimeType,
      },
      expires_at: null,
      max_size_bytes: directDocumentUploadMaxBytes,
      notes:
        "Upload raw file bytes to this authenticated REST endpoint to update an existing document. Do not put file bytes in MCP tool arguments or outputs. No bearer token value is returned; use the caller's existing brainfog bearer token.",
      command_example:
        'curl -X PATCH "$BRAINFOG_BASE_URL/api/v1/documents/<document-id>/direct-upload?mime_type=<mime-type>&filename=<filename>&write_mode=create_version" -H "Authorization: Bearer $BRAINFOG_TOKEN" -H "Content-Type: <mime-type>" --data-binary @<path-to-file>',
    };
  }

  // Create mode: create a new document (existing behavior)
  if (!input.title?.trim()) throw new MemoryError(400, "missing title");
  const projectId = optionalProjectId(input.project_id);
  await ensureProject(ctx, projectId);
  const mimeType = validateMimeType(input.mime_type);
  const path = transferPath("/api/v1/documents/direct-upload", {
    title: input.title,
    filename: input.filename,
    mime_type: mimeType,
    project_id: projectId ?? undefined,
  });
  return {
    url: path,
    method: "POST",
    headers: {
      Authorization: "Bearer <your existing brainfog bearer token>",
      "Content-Type": mimeType,
    },
    expires_at: null,
    max_size_bytes: directDocumentUploadMaxBytes,
    notes:
      "Upload raw file bytes to this authenticated REST endpoint. Do not put file bytes in MCP tool arguments or outputs. No bearer token value is returned; use the caller's existing brainfog bearer token.",
    command_example:
      'curl -X POST "$BRAINFOG_BASE_URL/api/v1/documents/direct-upload?title=<title>&mime_type=<mime-type>&filename=<filename>" -H "Authorization: Bearer $BRAINFOG_TOKEN" -H "Content-Type: <mime-type>" --data-binary @<path-to-file>',
  };
}

export async function createDocumentDownloadLink(
  ctx: Ctx,
  input: { document_id: string; filename?: string },
) {
  const doc = (
    await createDb(ctx.env.DB)
      .select()
      .from(documents)
      .where(and(eq(documents.id, input.document_id), eq(documents.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!doc) throw new MemoryError(404, "document not found");
  const path = transferPath(`/api/v1/documents/${doc.id}/download`, {
    filename: input.filename,
  });
  return {
    url: path,
    method: "GET",
    headers: { Authorization: "Bearer <your existing brainfog bearer token>" },
    expires_at: null,
    document_id: doc.id,
    mime_type: doc.mimeType,
    size_bytes: doc.sizeBytes,
    notes:
      "Download raw document bytes from this authenticated REST endpoint. No file bytes or bearer token value are returned through MCP.",
    command_example:
      'curl -L "$BRAINFOG_BASE_URL/api/v1/documents/<document-id>/download?filename=<filename>" -H "Authorization: Bearer $BRAINFOG_TOKEN" -o <output-path>',
  };
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
  shared = false,
) {
  const db = createDb(ctx.env.DB);
  let i = 0;
  for (const chunk of chunksFor(content)) {
    const id = createId("documentChunk");
    await db.insert(documentChunks).values({ id, documentId, chunkIndex: i, content: chunk });
    await upsertVector(ctx, id, await embed(ctx, chunk), {
      kind: "document_chunk",
      owner_id: ctx.user.id,
      shared,
      ...(projectId ? { project_id: projectId } : {}),
    });
    i += 1;
  }
}

export async function updateDocument(
  ctx: Ctx,
  id: string,
  content: string,
  writeModeOrDerivedFrom?: DocumentWriteMode | Parameters<typeof applyFactDerivations>[2],
  derivedFromInput?: Parameters<typeof applyFactDerivations>[2],
) {
  const db = createDb(ctx.env.DB);
  const doc = await getOwnedDocument(ctx, id);
  const writeMode = (() => {
    if (typeof writeModeOrDerivedFrom === "string" || writeModeOrDerivedFrom == null) {
      return documentWriteMode(writeModeOrDerivedFrom);
    }
    if (derivedFromInput !== undefined) return documentWriteMode(writeModeOrDerivedFrom);
    if (typeof writeModeOrDerivedFrom === "object") return "overwrite_current";
    return documentWriteMode(writeModeOrDerivedFrom);
  })();
  const derivedFrom =
    typeof writeModeOrDerivedFrom === "string" || derivedFromInput !== undefined
      ? derivedFromInput
      : writeModeOrDerivedFrom;
  if (derivedFrom) await validateFactDerivations(ctx, id, derivedFrom);
  if (writeMode === "create_version") {
    const historicalKey = `${ctx.user.id}/${id}/versions/${doc.currentVersionNumber}-${createId("documentVersion")}`;
    const currentObject = await ctx.env.DOCUMENTS.get(doc.r2Key);
    if (!currentObject) throw new MemoryError(404, "document content not found");
    const previousBytes = await currentObject.arrayBuffer();
    await ctx.env.DOCUMENTS.put(historicalKey, previousBytes, {
      httpMetadata: { contentType: doc.mimeType },
      customMetadata: currentObject.customMetadata,
    });
    await db.insert(documentVersions).values({
      id: createId("documentVersion"),
      documentId: doc.id,
      ownerId: doc.ownerId,
      source: source(ctx),
      versionNumber: doc.currentVersionNumber,
      r2Key: historicalKey,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes ?? previousBytes.byteLength,
    });
  }
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
    .set({
      sizeBytes: new TextEncoder().encode(content).byteLength,
      currentVersionNumber:
        writeMode === "create_version" ? doc.currentVersionNumber + 1 : doc.currentVersionNumber,
      updatedAt: now(),
    })
    .where(eq(documents.id, id));
  if (derivedFrom) {
    await replaceDependencies(ctx, "document", id, "derived_from", []);
    await applyDocumentDerivations(ctx, id, derivedFrom);
  }
  if (isTextLikeMimeType(doc.mimeType)) {
    await insertChunks(ctx, id, content, doc.projectId, doc.shared);
  }
  const updated = (await db.select().from(documents).where(eq(documents.id, id)))[0];
  if (!updated) throw new MemoryError(500, "updated document not found");
  return updated;
}

export async function getDocumentContent(ctx: Ctx, id: string) {
  const doc = await getReadableDocument(ctx, id);
  const object = await ctx.env.DOCUMENTS.get(doc.r2Key);
  if (!object) throw new MemoryError(404, "document content not found");
  return { doc, content: await object.text() };
}

export async function listDocumentVersions(ctx: Ctx, documentId: string) {
  const doc = await getReadableDocument(ctx, documentId);
  const historical = await createDb(ctx.env.DB)
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.documentId, doc.id))
    .orderBy(desc(documentVersions.versionNumber));
  return [
    {
      document_id: doc.id,
      version_number: doc.currentVersionNumber,
      is_current: true,
      mime_type: doc.mimeType,
      size_bytes: doc.sizeBytes,
      created_at: doc.updatedAt,
      source: doc.source,
    },
    ...historical.map((version) => ({
      ...safeVersionMetadata(version),
      document_id: version.documentId,
      version_number: version.versionNumber,
      mime_type: version.mimeType,
      size_bytes: version.sizeBytes,
      created_at: version.createdAt,
      is_current: false,
    })),
  ];
}

async function getHistoricalDocumentVersion(
  ctx: Ctx,
  documentId: string,
  selector: { version_id?: string; version_number?: number },
) {
  const doc = await getReadableDocument(ctx, documentId);
  const filters = [eq(documentVersions.documentId, doc.id)];
  if (selector.version_id) filters.push(eq(documentVersions.id, selector.version_id));
  else if (selector.version_number !== undefined)
    filters.push(eq(documentVersions.versionNumber, selector.version_number));
  else throw new MemoryError(400, "missing version selector");
  const version = (
    await createDb(ctx.env.DB)
      .select()
      .from(documentVersions)
      .where(and(...filters))
      .limit(1)
  )[0];
  if (!version) throw new MemoryError(404, "document version not found");
  return { doc, version };
}

export async function getDocumentVersionBytes(
  ctx: Ctx,
  documentId: string,
  selector: { version_id?: string; version_number?: number },
) {
  const { version } = await getHistoricalDocumentVersion(ctx, documentId, selector);
  const object = await ctx.env.DOCUMENTS.get(version.r2Key);
  if (!object) throw new MemoryError(404, "document version content not found");
  return {
    version: safeVersionMetadata(version),
    bytes: await object.arrayBuffer(),
    filename: object.customMetadata?.filename,
  };
}

export async function getDocumentVersionContent(
  ctx: Ctx,
  documentId: string,
  selector: { version_id?: string; version_number?: number },
) {
  const { version } = await getHistoricalDocumentVersion(ctx, documentId, selector);
  if (!isTextLikeMimeType(version.mimeType)) {
    throw new MemoryError(400, "document version is not text-like; use download route");
  }
  const object = await ctx.env.DOCUMENTS.get(version.r2Key);
  if (!object) throw new MemoryError(404, "document version content not found");
  return { version: safeVersionMetadata(version), content: await object.text() };
}

export async function getDocumentVersionForMcp(
  ctx: Ctx,
  input: { document_id: string; version_id?: string; version_number?: number },
) {
  const selector = input.version_id
    ? { version_id: input.version_id }
    : input.version_number !== undefined
      ? { version_number: Number(input.version_number) }
      : undefined;
  if (!selector) throw new MemoryError(400, "version_id or version_number is required");
  const { version } = await getHistoricalDocumentVersion(ctx, input.document_id, selector);
  const metadata = {
    ...safeVersionMetadata(version),
    document_id: version.documentId,
    version_number: version.versionNumber,
    mime_type: version.mimeType,
    size_bytes: version.sizeBytes,
    created_at: version.createdAt,
  };
  if (isTextLikeMimeType(version.mimeType)) {
    const object = await ctx.env.DOCUMENTS.get(version.r2Key);
    if (!object) throw new MemoryError(404, "document version content not found");
    return { metadata, content: await object.text() };
  }
  const versionRef = version.id;
  return {
    metadata,
    content: null,
    download: {
      url: `/api/v1/documents/${input.document_id}/versions/${versionRef}/download`,
      method: "GET",
      headers: { Authorization: "Bearer <your existing brainfog bearer token>" },
      notes:
        "This historical version is not text-like. Download exact bytes via the authenticated REST route; no file bytes or bearer token value are returned through MCP.",
    },
  };
}

export async function recordTimeSeriesPoints(
  ctx: Ctx,
  input: {
    points?: Array<Record<string, unknown>>;
  },
) {
  const points = input.points ?? [];
  if (!Array.isArray(points)) {
    throw new MemoryError(400, "points must be an array");
  }

  await validateTimeSeriesPointsInput(ctx, points);

  // Build rows and ensure no partial inserts
  const rows = points.map((point) => ({
    id: createId("timeSeriesPoint"),
    ownerId: ctx.user.id,
    projectId: optionalProjectId(point.project_id),
    source: source(ctx),
    seriesKey: String(point.series_key ?? ""),
    value: point.value === undefined || point.value === null ? null : Number(point.value),
    unit: (point.unit as string | undefined) ?? null,
    observedAt: asDate(point.observed_at) ?? now(),
    metadata: (point.metadata as Record<string, unknown> | undefined) ?? {},
  }));

  if (rows.length === 0) {
    return [];
  }

  // Single insert call for all rows
  await createDb(ctx.env.DB).insert(timeSeriesPoints).values(rows);

  // Return the inserted rows
  return rows;
}

export async function validateTimeSeriesPointsInput(
  ctx: Ctx,
  points: Array<Record<string, unknown>>,
) {
  for (const point of points) {
    await ensureProject(ctx, optionalProjectId(point.project_id));
    asDate(point.observed_at);
  }
}

export async function recordTimeSeriesPoint(ctx: Ctx, input: Record<string, unknown>) {
  const projectId = optionalProjectId(input.project_id);
  await ensureProject(ctx, projectId);
  await validateSubject(
    ctx,
    input.subject_type as string | undefined,
    input.subject_id as string | undefined,
  );
  const row = {
    id: createId("timeSeriesPoint"),
    ownerId: ctx.user.id,
    projectId,
    source: source(ctx),
    seriesKey: String(input.series_key),
    value: input.value === undefined || input.value === null ? null : Number(input.value),
    unit: (input.unit as string | undefined) ?? null,
    observedAt: asDate(input.observed_at) ?? now(),
    metadata: (input.metadata as Record<string, unknown> | undefined) ?? {},
  };
  await createDb(ctx.env.DB).insert(timeSeriesPoints).values(row);
  let cascaded: { kind: GraphKind; id: string }[] = [];
  if (input.subject_type && input.subject_id) {
    const depResult = await createDependency(ctx, {
      dependent: { kind: "time_series_point", id: row.id },
      dependency: { kind: asGraphKind(input.subject_type), id: String(input.subject_id) },
      relationship: "observes_subject",
    });
    if (depResult.cascaded) {
      cascaded = depResult.cascaded;
    }
  }
  if (!cascaded.length) {
    cascaded = await applyProjectContagion(ctx, "time_series_point", row.id, row.projectId);
  }
  const result = {
    ...row,
    subjectType: (input.subject_type as string | undefined) ?? null,
    subjectId: (input.subject_id as string | undefined) ?? null,
  };
  if (cascaded.length > 0) {
    return { ...result, cascaded };
  }
  return result;
}

async function validateSubject(ctx: Ctx, type?: string, id?: string) {
  if (!type || !id) return;
  await ensureEntity(ctx, asGraphKind(type), id, "subject not found");
}

export async function listTimeSeriesPoints(ctx: Ctx, q: Record<string, string | undefined>) {
  // Validate that series_key and series_prefix are mutually exclusive
  if (q.series_key && q.series_prefix) {
    throw new MemoryError(400, "series_key and series_prefix are mutually exclusive");
  }

  // Validate that series_prefix does not contain SQL wildcards
  if (q.series_prefix) {
    if (q.series_prefix.includes("%") || q.series_prefix.includes("_")) {
      throw new MemoryError(400, "series_prefix must not contain SQL wildcards (% or _)");
    }
  }

  const filters = [
    or(eq(timeSeriesPoints.ownerId, ctx.user.id), eq(timeSeriesPoints.shared, true)),
  ];
  if (q.series_key) filters.push(eq(timeSeriesPoints.seriesKey, q.series_key));
  if (q.series_prefix) {
    // Use LIKE 'prefix.%' for prefix matching
    filters.push(like(timeSeriesPoints.seriesKey, `${q.series_prefix}.%`));
  }
  if (q.project_id) filters.push(eq(timeSeriesPoints.projectId, q.project_id));
  if (q.from) filters.push(gte(timeSeriesPoints.observedAt, asDate(Number(q.from)) ?? now()));
  if (q.to) filters.push(lte(timeSeriesPoints.observedAt, asDate(Number(q.to)) ?? now()));
  const db = createDb(ctx.env.DB);
  if (q.subject_type || q.subject_id) {
    // For subject-edge queries, relax the edge owner filter to include edges
    // where the point itself is shared, since a shared point's observes_subject edge
    // may belong to the point's owner rather than the caller.
    const graphFilters = [
      ...filters,
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
      const embedding = await embed(ctx, q.query);

      // Query A: owner-scoped (caller's own rows)
      const filterA: Record<string, unknown> = {
        owner_id: ctx.user.id,
        kind: kinds.length === 1 ? kinds[0] : { $in: kinds },
        ...(q.project_id ? { project_id: q.project_id } : {}),
      };
      const resultA = (await ctx.env.VECTORIZE.query(embedding, {
        topK: limit,
        filter: filterA as VectorizeVectorMetadataFilter,
        returnMetadata: "all",
      })) as { matches?: { id: string; score?: number; metadata?: { kind?: string } }[] };

      // Query B: shared-scoped (shared rows from all owners)
      const filterB: Record<string, unknown> = {
        shared: true,
        kind: kinds.length === 1 ? kinds[0] : { $in: kinds },
        ...(q.project_id ? { project_id: q.project_id } : {}),
      };
      const resultB = (await ctx.env.VECTORIZE.query(embedding, {
        topK: limit,
        filter: filterB as VectorizeVectorMetadataFilter,
        returnMetadata: "all",
      })) as { matches?: { id: string; score?: number; metadata?: { kind?: string } }[] };

      // Merge results by id, keeping highest score per id
      const idMap = new Map<string, { id: string; kind: string; score: number }>();
      for (const m of resultA.matches ?? [])
        if (m.metadata?.kind && kinds.includes(m.metadata.kind)) {
          const key = m.id;
          const score = m.score ?? 0;
          if (!idMap.has(key) || (idMap.get(key)?.score ?? 0) < score) {
            idMap.set(key, { id: m.id, kind: m.metadata.kind, score });
          }
        }
      for (const m of resultB.matches ?? [])
        if (m.metadata?.kind && kinds.includes(m.metadata.kind)) {
          const key = m.id;
          const score = m.score ?? 0;
          if (!idMap.has(key) || (idMap.get(key)?.score ?? 0) < score) {
            idMap.set(key, { id: m.id, kind: m.metadata.kind, score });
          }
        }

      // De-duplicate and sort by score descending
      ids.push(...Array.from(idMap.values()).sort((a, b) => b.score - a.score));
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
              or(eq(thoughts.ownerId, ctx.user.id), eq(thoughts.shared, true)),
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
              or(eq(facts.ownerId, ctx.user.id), eq(facts.shared, true)),
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
              or(eq(documents.ownerId, ctx.user.id), eq(documents.shared, true)),
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
              or(eq(thoughts.ownerId, ctx.user.id), eq(thoughts.shared, true)),
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
              or(eq(facts.ownerId, ctx.user.id), eq(facts.shared, true)),
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
              or(eq(documents.ownerId, ctx.user.id), eq(documents.shared, true)),
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
    .where(or(eq(facts.ownerId, ctx.user.id), eq(facts.shared, true)))
    .orderBy(desc(facts.createdAt));
  return Promise.all(rows.map((row) => factWithSupersession(ctx, row)));
}
export async function listThoughts(ctx: Ctx) {
  return createDb(ctx.env.DB)
    .select()
    .from(thoughts)
    .where(or(eq(thoughts.ownerId, ctx.user.id), eq(thoughts.shared, true)))
    .orderBy(desc(thoughts.createdAt));
}
export async function listDocuments(ctx: Ctx) {
  return createDb(ctx.env.DB)
    .select()
    .from(documents)
    .where(or(eq(documents.ownerId, ctx.user.id), eq(documents.shared, true)))
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
  const versionRows = await db
    .select({ r2Key: documentVersions.r2Key })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, id));
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
  await Promise.all(versionRows.map((version) => ctx.env.DOCUMENTS.delete(version.r2Key)));
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
const reservedSlugs = new Set([
  "api",
  "mcp",
  "app",
  "assets",
  "authorize",
  "token",
  "register",
  ".well-known",
  "well-known",
  "login",
  "logout",
  "health",
  "admin",
  "system",
  "brainfog",
]);

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

// ---------------------------------------------------------------------------
// Data browser (PBI-006): kind mapping, generic browse/detail queries,
// dependency-graph enrichment for detail pages, summary/metrics rollups, and
// admin user/token management.
// ---------------------------------------------------------------------------

export const BROWSER_KINDS = [
  "projects",
  "people",
  "tasks",
  "facts",
  "documents",
  "thoughts",
  "time-series-points",
] as const;
export type BrowserKind = (typeof BROWSER_KINDS)[number];

export function isBrowserKind(value: string): value is BrowserKind {
  return (BROWSER_KINDS as readonly string[]).includes(value);
}

export const browserToGraphKind: Record<BrowserKind, GraphKind> = {
  projects: "project",
  people: "person",
  tasks: "task",
  facts: "fact",
  documents: "document",
  thoughts: "thought",
  "time-series-points": "time_series_point",
};

const graphToBrowserKind: Partial<Record<GraphKind, BrowserKind>> = {
  project: "projects",
  person: "people",
  task: "tasks",
  fact: "facts",
  document: "documents",
  thought: "thoughts",
  time_series_point: "time-series-points",
};

/** URL of an entity within `/app`, or `null` for kinds with no detail page (document chunks). */
export function entityHref(kind: GraphKind, id: string): string | null {
  if (kind === "document") return `/app/documents/${id}`;
  const browserKind = graphToBrowserKind[kind];
  return browserKind ? `/app/browser/${browserKind}/${id}` : null;
}

function truncateLabel(text: string, max = 80): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Human-readable label for a graph entity, used when rendering dependency edges. */
export async function labelForEntity(ctx: Ctx, kind: GraphKind, id: string): Promise<string> {
  const db = createDb(ctx.env.DB);
  const ownerId = ctx.user.id;
  switch (kind) {
    case "project": {
      const row = (
        await db
          .select({ v: projects.name })
          .from(projects)
          .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)))
          .limit(1)
      )[0];
      return row?.v ?? id;
    }
    case "person": {
      const row = (
        await db.select({ v: people.name }).from(people).where(eq(people.id, id)).limit(1)
      )[0];
      return row?.v ?? id;
    }
    case "task": {
      const row = (
        await db
          .select({ v: tasks.title })
          .from(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.ownerId, ownerId)))
          .limit(1)
      )[0];
      return row?.v ?? id;
    }
    case "fact": {
      const row = (
        await db
          .select({ v: facts.statement })
          .from(facts)
          .where(and(eq(facts.id, id), eq(facts.ownerId, ownerId)))
          .limit(1)
      )[0];
      return row ? truncateLabel(row.v) : id;
    }
    case "thought": {
      const row = (
        await db
          .select({ v: thoughts.content })
          .from(thoughts)
          .where(and(eq(thoughts.id, id), eq(thoughts.ownerId, ownerId)))
          .limit(1)
      )[0];
      return row ? truncateLabel(row.v) : id;
    }
    case "document": {
      const row = (
        await db
          .select({ v: documents.title })
          .from(documents)
          .where(and(eq(documents.id, id), eq(documents.ownerId, ownerId)))
          .limit(1)
      )[0];
      return row?.v ?? id;
    }
    case "document_chunk": {
      const row = (
        await db
          .select({ v: documentChunks.content })
          .from(documentChunks)
          .innerJoin(documents, eq(documentChunks.documentId, documents.id))
          .where(and(eq(documentChunks.id, id), eq(documents.ownerId, ownerId)))
          .limit(1)
      )[0];
      return row ? truncateLabel(row.v) : id;
    }
    case "time_series_point": {
      const row = (
        await db
          .select({ v: timeSeriesPoints.seriesKey })
          .from(timeSeriesPoints)
          .where(and(eq(timeSeriesPoints.id, id), eq(timeSeriesPoints.ownerId, ownerId)))
          .limit(1)
      )[0];
      return row?.v ?? id;
    }
  }
}

/** Combines filters with AND, falling back to an always-true clause for the (unreachable) empty case. */
function whereAll(filters: SQL<unknown>[]): SQL<unknown> {
  return and(...filters) ?? sql`1=1`;
}

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

export type BrowseQuery = {
  page?: number;
  per_page?: number;
  project_id?: string;
  status?: string;
  q?: string;
  from?: string;
  to?: string;
};

export type BrowsePage<T> = { rows: T[]; total: number; page: number; per_page: number };

function pagination(q: BrowseQuery) {
  const page = q.page && q.page > 0 ? Math.floor(q.page) : 1;
  const perPage =
    q.per_page && q.per_page > 0
      ? Math.min(Math.floor(q.per_page), MAX_PER_PAGE)
      : DEFAULT_PER_PAGE;
  return { page, perPage, offset: (page - 1) * perPage };
}

/** Paginated, filtered list for `/app/browser/:kind` and `/api/v1/ui/...` (owner-scoped). */
export async function browseEntities(
  ctx: Ctx,
  kind: BrowserKind,
  q: BrowseQuery,
): Promise<BrowsePage<Record<string, unknown>>> {
  if (q.project_id) await ensureProject(ctx, q.project_id);
  const { page, perPage, offset } = pagination(q);
  const db = createDb(ctx.env.DB);
  const ownerId = ctx.user.id;

  switch (kind) {
    case "projects": {
      const filters: SQL<unknown>[] = [eq(projects.ownerId, ownerId)];
      if (q.q) filters.push(sql`${projects.name} like ${`%${q.q}%`}`);
      const where = whereAll(filters);
      const [rows, total] = await Promise.all([
        db
          .select()
          .from(projects)
          .where(where)
          .orderBy(projects.name)
          .limit(perPage)
          .offset(offset),
        db.$count(projects, where),
      ]);
      return { rows, total, page, per_page: perPage };
    }
    case "people": {
      const filters: SQL<unknown>[] = [];
      if (q.q) filters.push(sql`${people.name} like ${`%${q.q}%`}`);
      const where = whereAll(filters);
      const [rows, total] = await Promise.all([
        db.select().from(people).where(where).orderBy(people.name).limit(perPage).offset(offset),
        db.$count(people, where),
      ]);
      return { rows, total, page, per_page: perPage };
    }
    case "tasks": {
      const filters: SQL<unknown>[] = [eq(tasks.ownerId, ownerId)];
      if (q.project_id) filters.push(eq(tasks.projectId, q.project_id));
      if (q.status) filters.push(eq(tasks.status, q.status));
      if (q.q) filters.push(sql`${tasks.title} like ${`%${q.q}%`}`);
      const where = whereAll(filters);
      const [rows, total] = await Promise.all([
        db
          .select()
          .from(tasks)
          .where(where)
          .orderBy(desc(tasks.createdAt))
          .limit(perPage)
          .offset(offset),
        db.$count(tasks, where),
      ]);
      return { rows, total, page, per_page: perPage };
    }
    case "facts": {
      const filters: SQL<unknown>[] = [eq(facts.ownerId, ownerId)];
      if (q.project_id) filters.push(eq(facts.projectId, q.project_id));
      if (q.status) filters.push(eq(facts.status, q.status));
      if (q.q) filters.push(sql`${facts.statement} like ${`%${q.q}%`}`);
      const where = whereAll(filters);
      const [rows, total] = await Promise.all([
        db
          .select()
          .from(facts)
          .where(where)
          .orderBy(desc(facts.createdAt))
          .limit(perPage)
          .offset(offset),
        db.$count(facts, where),
      ]);
      const enriched = await Promise.all(rows.map((row) => factWithSupersession(ctx, row)));
      return { rows: enriched, total, page, per_page: perPage };
    }
    case "thoughts": {
      const filters: SQL<unknown>[] = [eq(thoughts.ownerId, ownerId)];
      if (q.project_id) filters.push(eq(thoughts.projectId, q.project_id));
      if (q.q) filters.push(sql`${thoughts.content} like ${`%${q.q}%`}`);
      const where = whereAll(filters);
      const [rows, total] = await Promise.all([
        db
          .select()
          .from(thoughts)
          .where(where)
          .orderBy(desc(thoughts.createdAt))
          .limit(perPage)
          .offset(offset),
        db.$count(thoughts, where),
      ]);
      return { rows, total, page, per_page: perPage };
    }
    case "documents": {
      const filters: SQL<unknown>[] = [eq(documents.ownerId, ownerId)];
      if (q.project_id) filters.push(eq(documents.projectId, q.project_id));
      if (q.q) filters.push(sql`${documents.title} like ${`%${q.q}%`}`);
      const where = whereAll(filters);
      const [rows, total] = await Promise.all([
        db
          .select()
          .from(documents)
          .where(where)
          .orderBy(desc(documents.createdAt))
          .limit(perPage)
          .offset(offset),
        db.$count(documents, where),
      ]);
      const ids = rows.map((r) => r.id);
      const chunkCounts = ids.length
        ? await db
            .select({ documentId: documentChunks.documentId, count: sql<number>`count(*)` })
            .from(documentChunks)
            .where(inArray(documentChunks.documentId, ids))
            .groupBy(documentChunks.documentId)
        : [];
      const countMap = new Map(chunkCounts.map((c) => [c.documentId, Number(c.count)]));
      return {
        rows: rows.map((r) => ({ ...r, chunkCount: countMap.get(r.id) ?? 0 })),
        total,
        page,
        per_page: perPage,
      };
    }
    case "time-series-points": {
      const filters: SQL<unknown>[] = [eq(timeSeriesPoints.ownerId, ownerId)];
      if (q.project_id) filters.push(eq(timeSeriesPoints.projectId, q.project_id));
      if (q.q) filters.push(sql`${timeSeriesPoints.seriesKey} like ${`%${q.q}%`}`);
      if (q.from) filters.push(gte(timeSeriesPoints.observedAt, asDate(Number(q.from)) ?? now()));
      if (q.to) filters.push(lte(timeSeriesPoints.observedAt, asDate(Number(q.to)) ?? now()));
      const where = whereAll(filters);
      const [rows, total] = await Promise.all([
        db
          .select()
          .from(timeSeriesPoints)
          .where(where)
          .orderBy(desc(timeSeriesPoints.observedAt))
          .limit(perPage)
          .offset(offset),
        db.$count(timeSeriesPoints, where),
      ]);
      return { rows, total, page, per_page: perPage };
    }
  }
}

/** Owner-scoped detail fetch for `/app/browser/:kind/:id`. */
export async function getEntity(
  ctx: Ctx,
  kind: BrowserKind,
  id: string,
): Promise<Record<string, unknown>> {
  const db = createDb(ctx.env.DB);
  const ownerId = ctx.user.id;
  switch (kind) {
    case "projects": {
      const row = (
        await db
          .select()
          .from(projects)
          .where(and(eq(projects.id, id), eq(projects.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!row) throw new MemoryError(404, "project not found");
      return row;
    }
    case "people": {
      const row = (await db.select().from(people).where(eq(people.id, id)).limit(1))[0];
      if (!row) throw new MemoryError(404, "person not found");
      return row;
    }
    case "tasks": {
      const row = (
        await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, id), eq(tasks.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!row) throw new MemoryError(404, "task not found");
      return row;
    }
    case "facts": {
      const row = (
        await db
          .select()
          .from(facts)
          .where(and(eq(facts.id, id), eq(facts.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!row) throw new MemoryError(404, "fact not found");
      return factWithSupersession(ctx, row);
    }
    case "thoughts": {
      const row = (
        await db
          .select()
          .from(thoughts)
          .where(and(eq(thoughts.id, id), eq(thoughts.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!row) throw new MemoryError(404, "thought not found");
      return row;
    }
    case "documents": {
      const row = (
        await db
          .select()
          .from(documents)
          .where(and(eq(documents.id, id), eq(documents.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!row) throw new MemoryError(404, "document not found");
      const chunkCount = await db.$count(documentChunks, eq(documentChunks.documentId, id));
      return { ...row, chunkCount };
    }
    case "time-series-points": {
      const row = (
        await db
          .select()
          .from(timeSeriesPoints)
          .where(and(eq(timeSeriesPoints.id, id), eq(timeSeriesPoints.ownerId, ownerId)))
          .limit(1)
      )[0];
      if (!row) throw new MemoryError(404, "time series point not found");
      return row;
    }
  }
}

export type EnrichedDependency = {
  id: string;
  relationship: Relationship;
  /** "out": this entity points at `other`; "in": `other` points at this entity. */
  direction: "out" | "in";
  otherKind: GraphKind;
  otherId: string;
  otherLabel: string;
  otherHref: string | null;
  staleAt: Date | null;
  staleReason: string | null;
};

/** Dependency-graph edges touching an entity, enriched with labels/links for detail pages. */
export async function getEntityRelations(
  ctx: Ctx,
  kind: BrowserKind,
  id: string,
): Promise<EnrichedDependency[]> {
  const graphKind = browserToGraphKind[kind];
  const edges = await listDependencies(ctx, {
    entity_kind: graphKind,
    entity_id: id,
    direction: "both",
  });
  return Promise.all(
    edges.map(async (edge) => {
      const isDependent = edge.dependentKind === graphKind && edge.dependentId === id;
      const otherKind = (isDependent ? edge.dependencyKind : edge.dependentKind) as GraphKind;
      const otherId = isDependent ? edge.dependencyId : edge.dependentId;
      return {
        id: edge.id,
        relationship: edge.relationship as Relationship,
        direction: isDependent ? "out" : "in",
        otherKind,
        otherId,
        otherLabel: await labelForEntity(ctx, otherKind, otherId),
        otherHref: entityHref(otherKind, otherId),
        staleAt: edge.staleAt,
        staleReason: edge.staleReason,
      } satisfies EnrichedDependency;
    }),
  );
}

const RECENT_ACTIVITY_LIMIT = 10;

async function getRecentActivity(ctx: Ctx, limit: number, projectId?: string) {
  const db = createDb(ctx.env.DB);
  const ownerId = ctx.user.id;

  const [thoughtRows, factRows, taskRows, documentRows] = await Promise.all([
    db
      .select({ id: thoughts.id, label: thoughts.content, createdAt: thoughts.createdAt })
      .from(thoughts)
      .where(
        whereAll(
          projectId
            ? [eq(thoughts.ownerId, ownerId), eq(thoughts.projectId, projectId)]
            : [eq(thoughts.ownerId, ownerId)],
        ),
      )
      .orderBy(desc(thoughts.createdAt))
      .limit(limit),
    db
      .select({ id: facts.id, label: facts.statement, createdAt: facts.createdAt })
      .from(facts)
      .where(
        whereAll(
          projectId
            ? [eq(facts.ownerId, ownerId), eq(facts.projectId, projectId)]
            : [eq(facts.ownerId, ownerId)],
        ),
      )
      .orderBy(desc(facts.createdAt))
      .limit(limit),
    db
      .select({ id: tasks.id, label: tasks.title, createdAt: tasks.createdAt })
      .from(tasks)
      .where(
        whereAll(
          projectId
            ? [eq(tasks.ownerId, ownerId), eq(tasks.projectId, projectId)]
            : [eq(tasks.ownerId, ownerId)],
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(limit),
    db
      .select({ id: documents.id, label: documents.title, createdAt: documents.createdAt })
      .from(documents)
      .where(
        whereAll(
          projectId
            ? [eq(documents.ownerId, ownerId), eq(documents.projectId, projectId)]
            : [eq(documents.ownerId, ownerId)],
        ),
      )
      .orderBy(desc(documents.createdAt))
      .limit(limit),
  ]);

  const merged = [
    ...thoughtRows.map((r) => ({
      kind: "thought" as const,
      id: r.id,
      label: truncateLabel(r.label),
      createdAt: r.createdAt,
    })),
    ...factRows.map((r) => ({
      kind: "fact" as const,
      id: r.id,
      label: truncateLabel(r.label),
      createdAt: r.createdAt,
    })),
    ...taskRows.map((r) => ({
      kind: "task" as const,
      id: r.id,
      label: r.label,
      createdAt: r.createdAt,
    })),
    ...documentRows.map((r) => ({
      kind: "document" as const,
      id: r.id,
      label: r.label,
      createdAt: r.createdAt,
    })),
  ];
  merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return merged.slice(0, limit).map((r) => ({
    kind: r.kind,
    id: r.id,
    label: r.label,
    href: entityHref(r.kind, r.id),
    created_at: r.createdAt,
  }));
}

export type MetricsQuery = { project_id?: string; from?: string; to?: string };

const MAX_SERIES_POINTS = 50;

/** Entity counts, status breakdowns, recent activity, and time-series rollups for `/app/metrics`. */
export async function getMetrics(ctx: Ctx, q: MetricsQuery) {
  if (q.project_id) await ensureProject(ctx, q.project_id);
  const db = createDb(ctx.env.DB);
  const ownerId = ctx.user.id;
  const projectId = q.project_id;
  const fromDate = q.from ? asDate(Number(q.from)) : undefined;
  const toDate = q.to ? asDate(Number(q.to)) : undefined;

  const counts = {
    projects: projectId ? 1 : await db.$count(projects, eq(projects.ownerId, ownerId)),
    people: await db.$count(people),
    tasks: await db.$count(
      tasks,
      whereAll(
        projectId
          ? [eq(tasks.ownerId, ownerId), eq(tasks.projectId, projectId)]
          : [eq(tasks.ownerId, ownerId)],
      ),
    ),
    facts: await db.$count(
      facts,
      whereAll(
        projectId
          ? [eq(facts.ownerId, ownerId), eq(facts.projectId, projectId)]
          : [eq(facts.ownerId, ownerId)],
      ),
    ),
    documents: await db.$count(
      documents,
      whereAll(
        projectId
          ? [eq(documents.ownerId, ownerId), eq(documents.projectId, projectId)]
          : [eq(documents.ownerId, ownerId)],
      ),
    ),
    thoughts: await db.$count(
      thoughts,
      whereAll(
        projectId
          ? [eq(thoughts.ownerId, ownerId), eq(thoughts.projectId, projectId)]
          : [eq(thoughts.ownerId, ownerId)],
      ),
    ),
    time_series_points: await db.$count(
      timeSeriesPoints,
      whereAll(
        projectId
          ? [eq(timeSeriesPoints.ownerId, ownerId), eq(timeSeriesPoints.projectId, projectId)]
          : [eq(timeSeriesPoints.ownerId, ownerId)],
      ),
    ),
  };

  const taskStatusRows = await db
    .select({ status: tasks.status, count: sql<number>`count(*)` })
    .from(tasks)
    .where(
      whereAll(
        projectId
          ? [eq(tasks.ownerId, ownerId), eq(tasks.projectId, projectId)]
          : [eq(tasks.ownerId, ownerId)],
      ),
    )
    .groupBy(tasks.status);
  const factStatusRows = await db
    .select({ status: facts.status, count: sql<number>`count(*)` })
    .from(facts)
    .where(
      whereAll(
        projectId
          ? [eq(facts.ownerId, ownerId), eq(facts.projectId, projectId)]
          : [eq(facts.ownerId, ownerId)],
      ),
    )
    .groupBy(facts.status);

  const chunkCountRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(
      whereAll(
        projectId
          ? [eq(documents.ownerId, ownerId), eq(documents.projectId, projectId)]
          : [eq(documents.ownerId, ownerId)],
      ),
    );
  const chunkCount = Number(chunkCountRows[0]?.count ?? 0);

  const tspFilters: SQL<unknown>[] = [eq(timeSeriesPoints.ownerId, ownerId)];
  if (projectId) tspFilters.push(eq(timeSeriesPoints.projectId, projectId));
  if (fromDate) tspFilters.push(gte(timeSeriesPoints.observedAt, fromDate));
  if (toDate) tspFilters.push(lte(timeSeriesPoints.observedAt, toDate));
  const tspRows = await db
    .select()
    .from(timeSeriesPoints)
    .where(whereAll(tspFilters))
    .orderBy(timeSeriesPoints.observedAt);

  const seriesMap = new Map<string, (typeof tspRows)[number][]>();
  for (const row of tspRows) {
    const list = seriesMap.get(row.seriesKey) ?? [];
    list.push(row);
    seriesMap.set(row.seriesKey, list);
  }
  const timeSeries = Array.from(seriesMap.entries()).map(([seriesKey, points]) => {
    const values = points.map((p) => p.value).filter((v): v is number => v !== null);
    const latest = points[points.length - 1];
    return {
      series_key: seriesKey,
      unit: latest?.unit ?? null,
      count: points.length,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      avg: values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null,
      latest_value: latest?.value ?? null,
      latest_observed_at: latest?.observedAt ?? null,
      points: points
        .slice(-MAX_SERIES_POINTS)
        .map((p) => ({ observed_at: p.observedAt, value: p.value })),
    };
  });

  return {
    project_id: projectId ?? null,
    from: fromDate ?? null,
    to: toDate ?? null,
    counts,
    task_status: Object.fromEntries(taskStatusRows.map((r) => [r.status, Number(r.count)])),
    fact_status: Object.fromEntries(factStatusRows.map((r) => [r.status, Number(r.count)])),
    chunks: chunkCount,
    recallable: counts.thoughts + counts.facts + chunkCount,
    recent: await getRecentActivity(ctx, RECENT_ACTIVITY_LIMIT, projectId),
    time_series: timeSeries,
  };
}

/** Lightweight overview for `/app` and `/api/v1/ui/summary`. */
export async function getSummary(ctx: Ctx) {
  const metrics = await getMetrics(ctx, {});
  return {
    counts: metrics.counts,
    task_status: metrics.task_status,
    fact_status: metrics.fact_status,
    chunks: metrics.chunks,
    recallable: metrics.recallable,
    recent: metrics.recent,
  };
}

// ---------------------------------------------------------------------------
// Admin user/token management (`/api/v1/ui/users*`, `/api/v1/ui/tokens/:id`).
// Every export here except `listUserTokens` requires `ctx.user.isAdmin`;
// `/app/users` returns 403 for non-admins per the Contract.
// ---------------------------------------------------------------------------

function requireAdmin(ctx: Ctx) {
  if (!ctx.user.isAdmin) throw new MemoryError(403, "admin required");
}

async function ensureSlugAvailable(ctx: Ctx, slug: string, excludeUserId?: string) {
  const existing = (
    await createDb(ctx.env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.slug, slug))
      .limit(1)
  )[0];
  if (existing && existing.id !== excludeUserId) throw new MemoryError(409, "slug already in use");
}

export type AdminUserRow = {
  id: string;
  name: string;
  slug: string | null;
  isAdmin: boolean;
  createdAt: Date;
  tokenCount: number;
};

export async function listUsers(ctx: Ctx): Promise<AdminUserRow[]> {
  requireAdmin(ctx);
  const db = createDb(ctx.env.DB);
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      slug: users.slug,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(users.name);
  const tokenCounts = await db
    .select({ userId: tokens.userId, count: sql<number>`count(*)` })
    .from(tokens)
    .groupBy(tokens.userId);
  const countMap = new Map(tokenCounts.map((t) => [t.userId, Number(t.count)]));
  return rows.map((row) => ({ ...row, tokenCount: countMap.get(row.id) ?? 0 }));
}

export async function createUser(
  ctx: Ctx,
  input: { name: string; slug?: string | null; is_admin?: boolean },
) {
  requireAdmin(ctx);
  const name = (input.name ?? "").trim();
  if (!name) throw new MemoryError(400, "missing name");
  const slug = validateSlug(input.slug ?? null);
  if (slug) await ensureSlugAvailable(ctx, slug);
  const row = {
    id: crypto.randomUUID(),
    name,
    slug,
    isAdmin: Boolean(input.is_admin),
  };
  await createDb(ctx.env.DB).insert(users).values(row);
  return row;
}

export async function updateUser(
  ctx: Ctx,
  id: string,
  input: { name?: string; slug?: string | null; is_admin?: boolean },
) {
  requireAdmin(ctx);
  const db = createDb(ctx.env.DB);
  const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
  if (!row) throw new MemoryError(404, "user not found");
  let slug = row.slug;
  if (Object.hasOwn(input, "slug")) {
    slug = validateSlug(input.slug ?? null);
    if (slug) await ensureSlugAvailable(ctx, slug, id);
  }
  const name = input.name !== undefined ? input.name.trim() : row.name;
  if (!name) throw new MemoryError(400, "name cannot be empty");
  const isAdmin = input.is_admin === undefined ? row.isAdmin : Boolean(input.is_admin);
  await db.update(users).set({ name, slug, isAdmin }).where(eq(users.id, id));
  return { id: row.id, name, slug, isAdmin, createdAt: row.createdAt };
}

/** Issues a one-time bearer token for `userId`; the plaintext is returned only here. */
export async function createUserToken(ctx: Ctx, userId: string) {
  requireAdmin(ctx);
  const db = createDb(ctx.env.DB);
  const target = (
    await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  )[0];
  if (!target) throw new MemoryError(404, "user not found");
  const token = generateToken();
  const tokenHash = await hashToken(token, ctx.env.BRAINFOG_TOKEN_HASH_SECRET);
  const id = crypto.randomUUID();
  const createdAt = now();
  await db.insert(tokens).values({ id, userId, tokenHash, createdAt });
  return { id, token, created_at: createdAt };
}

export type TokenRow = { id: string; createdAt: Date; lastUsedAt: Date | null };

/** Token metadata (never hashes/plaintext) for a user; self-access allowed for "view own tokens". */
export async function listUserTokens(ctx: Ctx, userId: string): Promise<TokenRow[]> {
  if (!ctx.user.isAdmin && ctx.user.id !== userId) throw new MemoryError(403, "admin required");
  const db = createDb(ctx.env.DB);
  const target = (
    await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  )[0];
  if (!target) throw new MemoryError(404, "user not found");
  return db
    .select({ id: tokens.id, createdAt: tokens.createdAt, lastUsedAt: tokens.lastUsedAt })
    .from(tokens)
    .where(eq(tokens.userId, userId))
    .orderBy(desc(tokens.createdAt));
}

export async function revokeToken(ctx: Ctx, tokenId: string) {
  requireAdmin(ctx);
  const db = createDb(ctx.env.DB);
  const row = (
    await db.select({ id: tokens.id }).from(tokens).where(eq(tokens.id, tokenId)).limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "token not found");
  await db.delete(tokens).where(eq(tokens.id, tokenId));
  return { ok: true };
}
