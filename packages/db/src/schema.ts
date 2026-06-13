import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

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
    supersedesFactId: text("supersedes_fact_id").references((): AnySQLiteColumn => facts.id, {
      onDelete: "set null",
    }),
    supersededByFactId: text("superseded_by_fact_id").references((): AnySQLiteColumn => facts.id, {
      onDelete: "set null",
    }),
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
    index("facts_supersedes_idx").on(table.supersedesFactId),
    index("facts_superseded_by_idx").on(table.supersededByFactId),
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
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
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
    index("time_series_owner_subject_observed_idx").on(
      table.ownerId,
      table.subjectType,
      table.subjectId,
      table.observedAt,
    ),
  ],
);

export const thoughtPeople = sqliteTable(
  "thought_people",
  {
    thoughtId: text("thought_id")
      .notNull()
      .references(() => thoughts.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.thoughtId, table.personId] }),
    index("thought_people_person_idx").on(table.personId),
  ],
);
export const thoughtTasks = sqliteTable(
  "thought_tasks",
  {
    thoughtId: text("thought_id")
      .notNull()
      .references(() => thoughts.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.thoughtId, table.taskId] }),
    index("thought_tasks_task_idx").on(table.taskId),
  ],
);
export const thoughtFacts = sqliteTable(
  "thought_facts",
  {
    thoughtId: text("thought_id")
      .notNull()
      .references(() => thoughts.id, { onDelete: "cascade" }),
    factId: text("fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.thoughtId, table.factId] }),
    index("thought_facts_fact_idx").on(table.factId),
  ],
);
export const thoughtDocuments = sqliteTable(
  "thought_documents",
  {
    thoughtId: text("thought_id")
      .notNull()
      .references(() => thoughts.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.thoughtId, table.documentId] }),
    index("thought_documents_document_idx").on(table.documentId),
  ],
);
export const factSourceThoughts = sqliteTable(
  "fact_source_thoughts",
  {
    factId: text("fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
    thoughtId: text("thought_id")
      .notNull()
      .references(() => thoughts.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.factId, table.thoughtId] }),
    index("fact_source_thoughts_thought_idx").on(table.thoughtId),
  ],
);
export const factSourceFacts = sqliteTable(
  "fact_source_facts",
  {
    factId: text("fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
    sourceFactId: text("source_fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.factId, table.sourceFactId] }),
    index("fact_source_facts_source_idx").on(table.sourceFactId),
  ],
);
export const factSourceDocuments = sqliteTable(
  "fact_source_documents",
  {
    factId: text("fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.factId, table.documentId] }),
    index("fact_source_documents_document_idx").on(table.documentId),
  ],
);
export const factSourceDocumentChunks = sqliteTable(
  "fact_source_document_chunks",
  {
    factId: text("fact_id")
      .notNull()
      .references(() => facts.id, { onDelete: "cascade" }),
    documentChunkId: text("document_chunk_id")
      .notNull()
      .references(() => documentChunks.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.factId, table.documentChunkId] }),
    index("fact_source_document_chunks_chunk_idx").on(table.documentChunkId),
  ],
);
