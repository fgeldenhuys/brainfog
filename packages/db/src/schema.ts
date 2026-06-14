import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").unique(),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    selfPersonId: text("self_person_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index("users_self_person_idx").on(table.selfPersonId),
    index("users_slug_idx").on(table.slug),
  ],
);

export const tokens = sqliteTable("tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
});

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
};

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    source: text("source").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ...timestamps,
  },
  (table) => [index("projects_owner_name_idx").on(table.ownerId, table.name)],
);

export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    source: text("source").notNull(),
    name: text("name").notNull(),
    aliases: text("aliases", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    contactInfo: text("contact_info", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    notes: text("notes"),
    ...timestamps,
  },
  (table) => [index("people_owner_name_idx").on(table.ownerId, table.name)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    projectId: text("project_id").references(() => projects.id),
    source: text("source").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open"),
    priority: real("priority").notNull().default(0.5),
    dueAt: integer("due_at", { mode: "timestamp" }),
    recurrence: text("recurrence", { mode: "json" }).$type<Record<string, unknown> | null>(),
    ...timestamps,
  },
  (table) => [
    check("tasks_status_check", sql`${table.status} in ('open','in_progress','done','cancelled')`),
    check("tasks_priority_check", sql`${table.priority} >= 0.0 and ${table.priority} <= 1.0`),
    index("tasks_owner_status_idx").on(table.ownerId, table.status),
    index("tasks_owner_project_idx").on(table.ownerId, table.projectId),
    index("tasks_owner_priority_idx").on(table.ownerId, table.priority),
  ],
);

export const facts = sqliteTable(
  "facts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    projectId: text("project_id").references(() => projects.id),
    source: text("source").notNull(),
    statement: text("statement").notNull(),
    citations: text("citations", { mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    confidence: real("confidence").notNull().default(0.5),
    status: text("status").notNull().default("current"),
    metadata: text("metadata", { mode: "json" })
      .$type<{ topics?: string[] }>()
      .notNull()
      .default(sql`'{}'`),
    ...timestamps,
  },
  (table) => [
    check("facts_confidence_check", sql`${table.confidence} >= 0.0 and ${table.confidence} <= 1.0`),
    check("facts_status_check", sql`${table.status} in ('current','superseded','proven_wrong')`),
    index("facts_owner_project_idx").on(table.ownerId, table.projectId),
    index("facts_owner_status_idx").on(table.ownerId, table.status),
  ],
);

export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    projectId: text("project_id").references(() => projects.id),
    source: text("source").notNull(),
    title: text("title").notNull(),
    r2Key: text("r2_key").notNull(),
    mimeType: text("mime_type").notNull().default("text/markdown"),
    sizeBytes: integer("size_bytes"),
    ...timestamps,
  },
  (table) => [index("documents_owner_project_idx").on(table.ownerId, table.projectId)],
);

export const documentChunks = sqliteTable(
  "document_chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    unique("document_chunks_document_index_unique").on(table.documentId, table.chunkIndex),
  ],
);

export const thoughts = sqliteTable(
  "thoughts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    projectId: text("project_id").references(() => projects.id),
    source: text("source").notNull(),
    content: text("content").notNull(),
    type: text("type").notNull().default("observation"),
    metadata: text("metadata", { mode: "json" })
      .$type<{ topics?: string[]; dates_mentioned?: string[] }>()
      .notNull()
      .default(sql`'{}'`),
    ...timestamps,
  },
  (table) => [
    check(
      "thoughts_type_check",
      sql`${table.type} in ('observation','idea','reference','person_note')`,
    ),
    index("thoughts_owner_created_idx").on(table.ownerId, table.createdAt),
    index("thoughts_owner_project_idx").on(table.ownerId, table.projectId),
  ],
);

export const timeSeriesPoints = sqliteTable(
  "time_series_points",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    projectId: text("project_id").references(() => projects.id),
    source: text("source").notNull(),
    seriesKey: text("series_key").notNull(),
    value: real("value"),
    unit: text("unit"),
    observedAt: integer("observed_at", { mode: "timestamp" }).notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    ...timestamps,
  },
  (table) => [
    index("time_series_owner_series_observed_idx").on(
      table.ownerId,
      table.seriesKey,
      table.observedAt,
    ),
    index("time_series_owner_project_observed_idx").on(
      table.ownerId,
      table.projectId,
      table.observedAt,
    ),
  ],
);

export const dependencyEdges = sqliteTable(
  "dependency_edges",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    source: text("source").notNull(),
    dependentKind: text("dependent_kind").notNull(),
    dependentId: text("dependent_id").notNull(),
    dependencyKind: text("dependency_kind").notNull(),
    dependencyId: text("dependency_id").notNull(),
    relationship: text("relationship").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    staleAt: integer("stale_at", { mode: "timestamp" }),
    staleReason: text("stale_reason"),
    lastVerifiedAt: integer("last_verified_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [
    check(
      "dependency_edges_dependent_kind_check",
      sql`${table.dependentKind} in ('project','person','task','fact','time_series_point','document','document_chunk','thought')`,
    ),
    check(
      "dependency_edges_dependency_kind_check",
      sql`${table.dependencyKind} in ('project','person','task','fact','time_series_point','document','document_chunk','thought')`,
    ),
    check(
      "dependency_edges_relationship_check",
      sql`${table.relationship} in ('references','derived_from','summarizes','supersedes','observes_subject','mentions','related_to')`,
    ),
    unique("dependency_edges_unique").on(
      table.ownerId,
      table.dependentKind,
      table.dependentId,
      table.dependencyKind,
      table.dependencyId,
      table.relationship,
    ),
    index("dependency_edges_dependent_idx").on(
      table.ownerId,
      table.dependentKind,
      table.dependentId,
    ),
    index("dependency_edges_dependency_idx").on(
      table.ownerId,
      table.dependencyKind,
      table.dependencyId,
    ),
    index("dependency_edges_relationship_idx").on(table.ownerId, table.relationship),
    index("dependency_edges_stale_idx").on(table.ownerId, table.staleAt),
  ],
);
