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

export const pages = sqliteTable(
  "pages",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    source: text("source").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    template: text("template").notNull(),
    queries: text("queries", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    validationErrors: text("validation_errors", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    ...timestamps,
  },
  (table) => [
    check("pages_status_check", sql`${table.status} in ('draft','published','archived')`),
    unique("pages_owner_slug_unique").on(table.ownerId, table.slug),
    index("pages_owner_status_idx").on(table.ownerId, table.status),
    index("pages_owner_slug_idx").on(table.ownerId, table.slug),
  ],
);

export const pageAccessLinks = sqliteTable(
  "page_access_links",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    label: text("label"),
    secretHash: text("secret_hash").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [
    index("page_access_links_owner_page_idx").on(table.ownerId, table.pageId),
    index("page_access_links_secret_hash_idx").on(table.secretHash),
    index("page_access_links_expires_at_idx").on(table.expiresAt),
  ],
);

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
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    index("projects_owner_name_idx").on(table.ownerId, table.name),
    index("projects_shared_idx").on(table.shared),
  ],
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
  (table) => [index("people_name_idx").on(table.name)],
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
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    check("tasks_status_check", sql`${table.status} in ('open','in_progress','done','cancelled')`),
    check("tasks_priority_check", sql`${table.priority} >= 0.0 and ${table.priority} <= 1.0`),
    index("tasks_owner_status_idx").on(table.ownerId, table.status),
    index("tasks_owner_project_idx").on(table.ownerId, table.projectId),
    index("tasks_owner_priority_idx").on(table.ownerId, table.priority),
    index("tasks_shared_idx").on(table.shared),
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
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    check("facts_confidence_check", sql`${table.confidence} >= 0.0 and ${table.confidence} <= 1.0`),
    check("facts_status_check", sql`${table.status} in ('current','superseded','proven_wrong')`),
    index("facts_owner_project_idx").on(table.ownerId, table.projectId),
    index("facts_owner_status_idx").on(table.ownerId, table.status),
    index("facts_shared_idx").on(table.shared),
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
    currentVersionNumber: integer("current_version_number").notNull().default(1),
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    index("documents_owner_project_idx").on(table.ownerId, table.projectId),
    index("documents_shared_idx").on(table.shared),
  ],
);

export const documentVersions = sqliteTable(
  "document_versions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    source: text("source").notNull(),
    versionNumber: integer("version_number").notNull(),
    r2Key: text("r2_key").notNull(),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    sizeBytes: integer("size_bytes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    unique("document_versions_document_version_unique").on(table.documentId, table.versionNumber),
    index("document_versions_document_version_idx").on(table.documentId, table.versionNumber),
    index("document_versions_owner_created_idx").on(table.ownerId, table.createdAt),
    index("document_versions_document_id_idx").on(table.documentId, table.id),
  ],
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
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    check(
      "thoughts_type_check",
      sql`${table.type} in ('observation','idea','reference','person_note')`,
    ),
    index("thoughts_owner_created_idx").on(table.ownerId, table.createdAt),
    index("thoughts_owner_project_idx").on(table.ownerId, table.projectId),
    index("thoughts_shared_idx").on(table.shared),
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
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
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
    index("time_series_shared_idx").on(table.shared),
  ],
);

export const ingestionConnectors = sqliteTable(
  "ingestion_connectors",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    projectId: text("project_id").references(() => projects.id),
    source: text("source").notNull(),
    type: text("type").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("active"),
    config: text("config", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    schedule: text("schedule", { mode: "json" })
      .$type<Record<string, unknown> | null>()
      .default(sql`NULL`),
    cursor: text("cursor", { mode: "json" })
      .$type<Record<string, unknown> | null>()
      .default(sql`NULL`),
    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp" }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    check(
      "ingestion_connectors_status_check",
      sql`${table.status} in ('active','paused','disabled')`,
    ),
    index("ingestion_connectors_owner_status_idx").on(table.ownerId, table.status),
    index("ingestion_connectors_owner_type_idx").on(table.ownerId, table.type),
    index("ingestion_connectors_owner_project_idx").on(table.ownerId, table.projectId),
  ],
);

export const ingestionRuns = sqliteTable(
  "ingestion_runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    connectorId: text("connector_id")
      .notNull()
      .references(() => ingestionConnectors.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp" }),
    cursorBefore: text("cursor_before", { mode: "json" }).$type<Record<string, unknown> | null>(),
    cursorAfter: text("cursor_after", { mode: "json" }).$type<Record<string, unknown> | null>(),
    insertedCount: integer("inserted_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    error: text("error", { mode: "json" }).$type<Record<string, unknown> | null>(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    ...timestamps,
  },
  (table) => [
    check("ingestion_runs_trigger_check", sql`${table.trigger} in ('manual','scheduled','bridge')`),
    check("ingestion_runs_status_check", sql`${table.status} in ('running','succeeded','failed')`),
    index("ingestion_runs_owner_connector_idx").on(table.ownerId, table.connectorId),
    index("ingestion_runs_owner_started_idx").on(table.ownerId, table.startedAt),
  ],
);

export const ingestionIdempotencyKeys = sqliteTable(
  "ingestion_idempotency_keys",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    connectorId: text("connector_id")
      .notNull()
      .references(() => ingestionConnectors.id, { onDelete: "cascade" }),
    sourceItemId: text("source_item_id").notNull(),
    seriesKey: text("series_key").notNull(),
    observedAt: integer("observed_at", { mode: "timestamp" }).notNull(),
    timeSeriesPointId: text("time_series_point_id").references(() => timeSeriesPoints.id, {
      onDelete: "cascade",
    }),
    runId: text("run_id")
      .notNull()
      .references(() => ingestionRuns.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    unique("ingestion_idempotency_unique").on(
      table.ownerId,
      table.connectorId,
      table.sourceItemId,
      table.seriesKey,
      table.observedAt,
    ),
    index("ingestion_idempotency_connector_idx").on(table.ownerId, table.connectorId),
  ],
);

export const ingestionConnectorCredentials = sqliteTable(
  "ingestion_connector_credentials",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    connectorId: text("connector_id")
      .notNull()
      .references(() => ingestionConnectors.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    authType: text("auth_type").notNull(),
    status: text("status").notNull().default("valid"),
    encryptedPayload: text("encrypted_payload").notNull(),
    encryptionMetadata: text("encryption_metadata", { mode: "json" })
      .$type<{ algorithm: string; iv: string; keyVersion: number }>()
      .notNull()
      .default(sql`'{}'`),
    redactedSummary: text("redacted_summary", { mode: "json" })
      .$type<{ username?: string; token_prefix?: string; domain?: string }>()
      .notNull()
      .default(sql`'{}'`),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    lastVerifiedAt: integer("last_verified_at", { mode: "timestamp" }),
    shared: integer("shared", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    check(
      "ingestion_connector_credentials_status_check",
      sql`${table.status} in ('missing','valid','needs_setup','mfa_required','expired','revoked','error')`,
    ),
    unique("ingestion_connector_credentials_owner_connector_unique").on(
      table.ownerId,
      table.connectorId,
    ),
    index("ingestion_connector_credentials_owner_status_idx").on(table.ownerId, table.status),
    index("ingestion_connector_credentials_connector_idx").on(table.ownerId, table.connectorId),
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

export const documentTransferCapabilities = sqliteTable(
  "document_transfer_capabilities",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    source: text("source").notNull(),
    operation: text("operation").notNull(),
    secretHash: text("secret_hash").notNull().unique(),
    projectId: text("project_id"),
    documentId: text("document_id"),
    title: text("title"),
    filename: text("filename"),
    mimeType: text("mime_type"),
    writeMode: text("write_mode"),
    indexingMode: text("indexing_mode"),
    maxSizeBytes: integer("max_size_bytes"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [
    index("document_transfer_capabilities_expires_at_idx").on(table.expiresAt),
    index("document_transfer_capabilities_owner_idx").on(table.ownerId),
  ],
);
