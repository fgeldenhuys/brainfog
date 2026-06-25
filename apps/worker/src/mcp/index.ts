import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
  createOrReplaceConnectorCredentials,
  deleteConnectorCredentials,
  getCredentialStatus,
} from "../credentials";
import type { Env } from "../env";
import { runGarminConnector } from "../garmin";
import {
  createIngestionConnector,
  listIngestionConnectors,
  listIngestionRuns,
  updateIngestionConnector,
} from "../ingestion";
import {
  addDocument,
  createDependency,
  createDocumentDownloadLink,
  createDocumentUploadLink,
  createProject,
  createTask,
  deleteDependency,
  getDocumentVersionForMcp,
  linkThought,
  listDependencies,
  listDocumentVersions,
  listPeople,
  listProjects,
  listStale,
  listTasks,
  listTimeSeriesPoints,
  MemoryError,
  type MemoryUser,
  markStale,
  recall,
  recordFact,
  recordTimeSeriesPoint,
  recordTimeSeriesPoints,
  remember,
  setSelfPerson,
  setShared,
  updateDocument,
  updateFact,
  updateTask,
  upsertPerson,
  whoami,
} from "../memory";
import {
  createPage,
  createPageAccessLink,
  getPage,
  listPageAccessLinks,
  listPages,
  previewPage,
  revokePageAccessLink,
  updatePage,
} from "../pages";

/**
 * Streamable HTTP MCP server (ADR-003), mounted at `/mcp` behind the
 * shared bearer-token middleware. Tool handlers call the same memory service
 * layer as the REST API: non-person memories are owner-scoped, while people
 * are a global authenticated pool.
 */
export class BrainfogMCP extends McpAgent<Env, unknown, { user?: MemoryUser }> {
  server = new McpServer({ name: "brainfog", version: "0.1.0" });

  async init() {
    this.server.tool("ping", "Placeholder health-check tool.", async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    }));

    const obj = z.record(z.string(), z.unknown()).optional();
    const requiredObj = z.record(z.string(), z.unknown());
    const strings = z.array(z.string()).optional();
    const thoughtLinks = z
      .record(z.string(), z.array(z.string()))
      .describe(
        "Optional thought links object. Allowed keys: people_ids, task_ids, fact_ids, document_ids, time_series_point_ids; values must be string arrays.",
      )
      .optional();
    const nullableString = z.string().nullable().optional();
    const projectId = z
      .string()
      .min(1)
      .describe(
        "Existing project ID for project-scoped records. Omit for global/personal records; do not pass an empty string.",
      )
      .optional();
    const nullableProjectId = z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Existing project ID for project-scoped records, or null to clear project scope. Omit for global/personal records; do not pass an empty string.",
      )
      .optional();
    const nullableNumber = z.number().nullable().optional();
    const recurrence = z
      .object({
        frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
        interval: z.number().int().positive().optional(),
        days_of_week: z.array(z.number().int().min(0).max(6)).optional(),
        day_of_month: z.number().int().optional(),
        timezone: z.string().optional(),
        starts_at: z.number().optional(),
        ends_at: z.number().optional(),
        count: z.number().int().optional(),
      })
      .nullable()
      .optional();
    const documentWriteMode = z.enum(["overwrite_current", "create_version"]).optional();

    // Register prompts for agent guidance on memory usage
    this.server.prompt(
      "recall-context",
      "Recall relevant context from brainfog memory before proceeding with the current conversation.",
      {
        topic: z.string().optional(),
        project_id: projectId,
      },
      async (args) => {
        const topic = args.topic ? String(args.topic) : undefined;
        const projectId = args.project_id ? String(args.project_id) : undefined;

        let scope = "that may be relevant to the current conversation";
        const recallArgs: string[] = [];

        if (topic && projectId) {
          scope = `related to "${topic}" in project ${projectId}`;
          recallArgs.push(`query: "${topic}"`, `project_id: "${projectId}"`);
        } else if (topic) {
          scope = `related to "${topic}"`;
          recallArgs.push(`query: "${topic}"`);
        } else if (projectId) {
          scope = `for project ${projectId}`;
          recallArgs.push(`project_id: "${projectId}"`);
        }

        const argumentText = recallArgs.length > 0 ? ` with ${recallArgs.join(" and ")}` : "";
        const message =
          `Before proceeding, please recall relevant context from brainfog memory ${scope}. ` +
          "Call the `recall` tool" +
          argumentText +
          " to retrieve any stored thoughts, facts, or documents, " +
          "and incorporate the returned `thought`, `fact`, or `document_chunk` results into your response.";

        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: message,
              },
            },
          ],
        };
      },
    );

    this.server.prompt(
      "save-session-notes",
      "Persist durable facts, thoughts, and tasks from the current session before finishing.",
      {
        project_id: projectId,
      },
      async (args) => {
        const projectId = args.project_id ? String(args.project_id) : undefined;

        let message =
          "Before finishing this session, review the conversation for durable content to persist in brainfog memory. " +
          "Use the following tools to save what is worth remembering:\n\n" +
          "1. `record_fact`: Save confirmed facts or important decisions with citations and a confidence score (0.0-1.0).\n" +
          "2. `remember`: Save noteworthy observations, ideas, or insights that may be useful in future conversations.\n" +
          "3. `create_task`: Create follow-up work items.\n\n" +
          "As a guiding principle, prefer a few well-curated memories over many low-signal ones. " +
          "Only persist durable, recallable content that will be useful in future sessions — not a transcript of the entire conversation.";

        if (projectId) {
          message += ` Scope all new records to project ${projectId}.`;
        }

        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: message,
              },
            },
          ],
        };
      },
    );

    const register = <T extends Record<string, z.ZodTypeAny>>(
      name: string,
      description: string,
      schema: T,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      const tool = this.server.tool.bind(this.server) as (
        name: string,
        description: string,
        schema: T,
        cb: (args: Record<string, unknown>) => Promise<ReturnType<BrainfogMCP["result"]>>,
      ) => void;
      tool(name, description, schema, async (args) => this.result(await handler(args)));
    };

    register(
      "remember",
      "Store a thought and make it semantically recallable.",
      {
        content: z.string(),
        type: z.enum(["observation", "idea", "reference", "person_note"]).optional(),
        project_id: projectId,
        links: thoughtLinks,
      },
      (args) => remember(this.memoryCtx(), args as Parameters<typeof remember>[1]),
    );
    register(
      "record_fact",
      "Store a fact with citations, derivations, and optional supersession.",
      {
        statement: z.string(),
        citations: strings,
        confidence: z.number().optional(),
        project_id: projectId,
        topics: strings,
        derived_from: obj,
        supersedes_fact_id: z.string().optional(),
      },
      (args) => recordFact(this.memoryCtx(), args as Parameters<typeof recordFact>[1]),
    );
    register(
      "update_fact",
      "Update a fact and lifecycle metadata.",
      {
        id: z.string(),
        statement: z.string().optional(),
        citations: strings,
        confidence: z.number().min(0).max(1).optional(),
        status: z.enum(["current", "superseded", "proven_wrong"]).optional(),
        topics: strings,
        supersedes_fact_id: nullableString,
        superseded_by_fact_id: nullableString,
      },
      ({ id, ...args }) => updateFact(this.memoryCtx(), String(id), args),
    );
    register(
      "add_document",
      "Store a text document in R2 and index chunks.",
      {
        title: z.string(),
        content: z.string(),
        project_id: projectId,
        mime_type: z.string().optional(),
        derived_from: obj,
      },
      (args) => addDocument(this.memoryCtx(), args as Parameters<typeof addDocument>[1]),
    );
    register(
      "update_document",
      "Replace a document's current content and regenerate current chunks. write_mode='overwrite_current' (default for compatibility) creates no history; write_mode='create_version' preserves the outgoing current content as a historical R2-backed version before replacing it.",
      { id: z.string(), content: z.string(), write_mode: documentWriteMode, derived_from: obj },
      (args) =>
        updateDocument(
          this.memoryCtx(),
          String(args.id),
          String(args.content),
          args.write_mode as Parameters<typeof updateDocument>[3],
          args.derived_from as Parameters<typeof updateDocument>[4],
        ),
    );
    register(
      "list_document_versions",
      "List document version metadata for a readable document. Includes current version metadata and historical rows, but never raw R2 keys or content bytes.",
      { document_id: z.string() },
      (args) => listDocumentVersions(this.memoryCtx(), String(args.document_id)),
    );
    register(
      "get_document_version",
      "Retrieve a previous document version by version_id or version_number. Text-like versions return text content; binary/non-text versions return metadata and authenticated REST download instructions, never inline bytes/base64.",
      {
        document_id: z.string(),
        version_id: z.string().optional(),
        version_number: z.number().int().optional(),
      },
      (args) =>
        getDocumentVersionForMcp(
          this.memoryCtx(),
          args as Parameters<typeof getDocumentVersionForMcp>[1],
        ),
    );
    register(
      "create_document_upload_link",
      "Create authenticated REST upload instructions for raw document bytes. File bytes are transferred over HTTP, never returned inline through MCP. Provide a document_id to update an existing document (optionally with versioning); omit document_id to create a new document (title is required for create, rejected for update).",
      {
        title: z.string().optional(),
        filename: z.string().optional(),
        mime_type: z.string().optional(),
        project_id: projectId,
        document_id: z
          .string()
          .describe(
            "Existing document ID to update. When provided, title must not be supplied and write_mode controls versioning.",
          )
          .optional(),
        write_mode: documentWriteMode,
      },
      (args) => {
        const hasDocId = Boolean(args.document_id);
        const hasTitle = Boolean(args.title);
        if (hasDocId && hasTitle)
          throw new MemoryError(400, "title is not accepted when updating an existing document");
        if (!hasDocId && !hasTitle)
          throw new MemoryError(400, "missing title (required when creating a new document)");
        return createDocumentUploadLink(
          this.memoryCtx(),
          args as Parameters<typeof createDocumentUploadLink>[1],
        );
      },
    );
    register(
      "create_document_download_link",
      "Create authenticated REST download instructions for an owned document. File bytes are transferred over HTTP, never returned inline through MCP.",
      { document_id: z.string(), filename: z.string().optional() },
      (args) =>
        createDocumentDownloadLink(
          this.memoryCtx(),
          args as Parameters<typeof createDocumentDownloadLink>[1],
        ),
    );
    register(
      "recall",
      "Semantic recall over thoughts, facts, and document chunks.",
      {
        query: z.string(),
        kinds: strings,
        project_id: projectId,
        limit: z.number().optional(),
      },
      (args) => recall(this.memoryCtx(), args as Parameters<typeof recall>[1]),
    );
    register(
      "create_task",
      "Create a task.",
      {
        title: z.string(),
        description: nullableString,
        project_id: nullableProjectId,
        due_at: nullableNumber,
        status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
        priority: z.number().min(0).max(1).optional(),
        recurrence,
      },
      (args) => createTask(this.memoryCtx(), args),
    );
    register(
      "update_task",
      "Update a task.",
      {
        id: z.string(),
        title: z.string().optional(),
        description: nullableString,
        project_id: nullableProjectId,
        due_at: nullableNumber,
        status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
        priority: z.number().min(0).max(1).optional(),
        recurrence,
      },
      ({ id, ...args }) => updateTask(this.memoryCtx(), String(id), args),
    );
    register(
      "list_tasks",
      "List tasks.",
      { project_id: projectId, status: z.string().optional() },
      (args) => listTasks(this.memoryCtx(), args),
    );
    register(
      "record_time_series_point",
      "Append a single generic time-series point. Use dot-namespaced series_key (e.g. 'electricity.spent', 'sleep.hours'). For multiple related metrics at the same timestamp, use record_time_series_points (bulk) instead. value is the primary numeric scalar (e.g. hours slept, ZAR spent); use metadata for secondary readings and contextual data. Before recording points for a new series namespace, call recall to check for an existing convention fact, then record_fact to document the namespace, series names, units, and metadata schema if one does not exist. This ensures consistency across future insertions.",
      {
        series_key: z.string(),
        value: nullableNumber,
        unit: nullableString,
        observed_at: nullableNumber,
        project_id: nullableProjectId,
        subject_type: nullableString,
        subject_id: nullableString,
        metadata: obj,
      },
      (args) => recordTimeSeriesPoint(this.memoryCtx(), args),
    );
    register(
      "list_time_series_points",
      "List time-series points. Filter by exact series_key or by series_prefix (e.g. series_prefix='electricity' matches 'electricity.before', 'electricity.after', etc.). series_key and series_prefix are mutually exclusive. Use series_prefix to query all metrics under a namespace efficiently. Optionally filter by project_id, subject (type/id), or time range (from/to as Unix seconds). Series naming uses dot-delimited namespaces (domain.metric); value is the primary scalar, metadata holds secondary data. Before recording a new namespace, call recall to check for a convention fact, then record_fact to document the convention if needed.",
      {
        series_key: z.string().optional(),
        series_prefix: z.string().optional(),
        project_id: projectId,
        subject_type: z.string().optional(),
        subject_id: z.string().optional(),
        from: z.number().optional(),
        to: z.number().optional(),
      },
      (args) => listTimeSeriesPoints(this.memoryCtx(), args as Record<string, string | undefined>),
    );
    register(
      "record_time_series_points",
      "Append multiple time-series points in a single batch. points is an array of objects, each with series_key, optional value, unit, observed_at, project_id, and metadata. Use dot-namespaced series_key (e.g. 'electricity.spent'). For related multi-value observations at the same timestamp, record each metric as a separate point in the batch; this keeps each metric independently queryable and plottable. value is the primary scalar; use metadata for secondary/contextual data. Before recording a new series namespace, call recall to check for a convention fact, then record_fact to document the namespace if needed. All rows in the batch are inserted in a single atomic operation; if any row fails validation, the entire batch is rejected.",
      {
        points: z
          .array(
            z.object({
              series_key: z.string(),
              value: nullableNumber,
              unit: nullableString,
              observed_at: nullableNumber,
              project_id: nullableProjectId,
              metadata: obj,
            }),
          )
          .optional(),
      },
      (args) => recordTimeSeriesPoints(this.memoryCtx(), args),
    );
    register(
      "create_ingestion_connector",
      "Create an owner-scoped automated ingestion connector definition.",
      {
        type: z.string(),
        name: z.string().optional(),
        project_id: nullableProjectId,
        source: z.string().optional(),
        status: z.enum(["active", "paused", "disabled"]).optional(),
        config: obj,
        schedule: z.record(z.string(), z.unknown()).nullable().optional(),
        cursor: z.record(z.string(), z.unknown()).nullable().optional(),
      },
      (args) => createIngestionConnector(this.memoryCtx(), args),
    );
    register("list_ingestion_connectors", "List owner-scoped ingestion connectors.", {}, () =>
      listIngestionConnectors(this.memoryCtx()),
    );
    register(
      "update_ingestion_connector",
      "Update an owner-scoped automated ingestion connector definition.",
      {
        id: z.string(),
        type: z.string().optional(),
        name: z.string().optional(),
        project_id: nullableProjectId,
        source: z.string().optional(),
        status: z.enum(["active", "paused", "disabled"]).optional(),
        config: obj,
        schedule: z.record(z.string(), z.unknown()).nullable().optional(),
        cursor: z.record(z.string(), z.unknown()).nullable().optional(),
      },
      ({ id, ...args }) => updateIngestionConnector(this.memoryCtx(), String(id), args),
    );
    register(
      "list_ingestion_runs",
      "List run history for one owner-scoped ingestion connector.",
      { connector_id: z.string() },
      (args) => listIngestionRuns(this.memoryCtx(), String(args.connector_id)),
    );
    register(
      "set_connector_credentials",
      "Create or replace encrypted credentials for one owner-scoped ingestion connector. Plaintext is accepted only in this request and never returned.",
      {
        connector_id: z.string(),
        auth_type: z.string().optional(),
        payload: requiredObj,
        status: z
          .enum(["missing", "valid", "needs_setup", "mfa_required", "expired", "revoked", "error"])
          .optional(),
        expires_at: nullableNumber,
      },
      ({ connector_id, ...args }) =>
        createOrReplaceConnectorCredentials(this.memoryCtx(), String(connector_id), {
          auth_type: args.auth_type as string | undefined,
          payload: args.payload as Record<string, unknown>,
          status: args.status as string | undefined,
          expires_at: args.expires_at as number | undefined,
        }),
    );
    register(
      "get_connector_credentials",
      "Get redacted credential status for one owner-scoped ingestion connector; plaintext is never returned.",
      { connector_id: z.string() },
      (args) => getCredentialStatus(this.memoryCtx(), String(args.connector_id)),
    );
    register(
      "delete_connector_credentials",
      "Revoke encrypted credentials for one owner-scoped ingestion connector.",
      { connector_id: z.string() },
      (args) => deleteConnectorCredentials(this.memoryCtx(), String(args.connector_id)),
    );
    register(
      "run_garmin_connector",
      "Run one owner-scoped Garmin connector. If runner_payload is supplied, validates/records that bounded payload; otherwise invokes the promoted Cloudflare Garmin Container with encrypted connector credentials. Use dry_run to preview normalized points without writing rows.",
      {
        connector_id: z.string(),
        dry_run: z.boolean().optional(),
        runner_payload: requiredObj.optional(),
      },
      ({ connector_id, ...args }) =>
        runGarminConnector(this.memoryCtx(), String(connector_id), {
          dry_run: args.dry_run as boolean | undefined,
          runner_payload: args.runner_payload as Record<string, unknown> | undefined,
        }),
    );
    register(
      "upsert_person",
      "Create or update a person.",
      {
        id: z.string().optional(),
        name: z.string(),
        aliases: strings,
        contact_info: obj,
        notes: nullableString,
      },
      (args) => upsertPerson(this.memoryCtx(), args as Parameters<typeof upsertPerson>[1]),
    );
    register("list_people", "List people.", {}, () => listPeople(this.memoryCtx()));
    register(
      "whoami",
      "Get the current user's account record and linked self person record.",
      {},
      () => whoami(this.memoryCtx()),
    );
    register(
      "set_self_person",
      "Set or clear the current user's self person link.",
      { self_person_id: z.string().nullable() },
      (args) => setSelfPerson(this.memoryCtx(), args.self_person_id as string | null),
    );
    register(
      "create_project",
      "Create a project.",
      { name: z.string(), description: nullableString },
      (args) => createProject(this.memoryCtx(), args as Parameters<typeof createProject>[1]),
    );
    register("list_projects", "List projects.", {}, () => listProjects(this.memoryCtx()));
    register(
      "link",
      "Link a thought to global people or owned tasks, facts, documents, and time-series points.",
      { thought_id: z.string(), links: thoughtLinks },
      (args) =>
        linkThought(
          this.memoryCtx(),
          String(args.thought_id),
          args.links as Parameters<typeof linkThought>[2],
        ),
    );
    const endpoint = z.object({ kind: z.string(), id: z.string() });
    register(
      "create_dependency",
      "Create an owner-scoped dependency graph edge.",
      {
        dependent: endpoint,
        dependency: endpoint,
        relationship: z.enum([
          "references",
          "derived_from",
          "summarizes",
          "supersedes",
          "observes_subject",
          "mentions",
          "related_to",
        ]),
        metadata: obj,
      },
      (args) => createDependency(this.memoryCtx(), args as Parameters<typeof createDependency>[1]),
    );
    register(
      "delete_dependency",
      "Delete one owner-scoped dependency graph edge.",
      { id: z.string() },
      (args) => deleteDependency(this.memoryCtx(), String(args.id)),
    );
    register(
      "list_dependencies",
      "List upstream and/or downstream dependency graph edges for one object.",
      {
        entity_kind: z.string(),
        entity_id: z.string(),
        direction: z.enum(["upstream", "downstream", "both"]).optional(),
        relationship: z.string().optional(),
      },
      (args) => listDependencies(this.memoryCtx(), args as Parameters<typeof listDependencies>[1]),
    );
    register(
      "mark_stale",
      "Mark downstream dependency graph edges stale for an upstream object.",
      {
        entity_kind: z.string(),
        entity_id: z.string(),
        reason: z.string().optional(),
        stale_since: z.number().optional(),
      },
      (args) => markStale(this.memoryCtx(), args as Parameters<typeof markStale>[1]),
    );
    register(
      "list_stale",
      "List stale dependency graph edges.",
      { kind: z.string().optional(), project_id: projectId },
      (args) => listStale(this.memoryCtx(), args),
    );
    register(
      "set_shared",
      "Mark an owned entity as shared with other authenticated users, cascading the shared flag to its contents and dependencies.",
      {
        entity_kind: z.string(),
        entity_id: z.string(),
        shared: z.boolean(),
      },
      (args) => setShared(this.memoryCtx(), args as Parameters<typeof setShared>[1]),
    );
    register(
      "create_page",
      "Create a dynamic user page definition.",
      {
        title: z.string(),
        slug: z.string(),
        template: z.string(),
        queries: z.unknown(),
        description: nullableString,
        status: z.enum(["draft", "published", "archived"]).optional(),
      },
      (args) => createPage(this.memoryCtx(), args as Parameters<typeof createPage>[1]),
    );
    register(
      "update_page",
      "Update a dynamic user page definition.",
      {
        id: z.string(),
        title: z.string().optional(),
        slug: z.string().optional(),
        template: z.string().optional(),
        queries: z.unknown().optional(),
        description: nullableString,
        status: z.enum(["draft", "published", "archived"]).optional(),
      },
      ({ id, ...args }) => updatePage(this.memoryCtx(), String(id), args),
    );
    register(
      "list_pages",
      "List dynamic user page definitions.",
      { status: z.string().optional() },
      (args) => listPages(this.memoryCtx(), args as { status?: string }),
    );
    register("get_page", "Get a dynamic page definition.", { id: z.string() }, (args) =>
      getPage(this.memoryCtx(), String(args.id)),
    );
    register(
      "preview_page",
      "Validate and render a non-persisted page preview.",
      { template: z.string(), queries: z.unknown() },
      (args) => previewPage(this.memoryCtx(), args as Parameters<typeof previewPage>[1]),
    );
    register(
      "create_page_access_link",
      "Create a pre-authenticated page URL and return the plaintext URL exactly once.",
      {
        page_id: z.string(),
        expires_at: nullableNumber,
        ttl_seconds: z.number().optional(),
        max_uses: z.number().int().nullable().optional(),
        label: nullableString,
      },
      ({ page_id, ...args }) => createPageAccessLink(this.memoryCtx(), String(page_id), args),
    );
    register(
      "list_page_access_links",
      "List page access-link metadata without secrets.",
      { page_id: z.string() },
      (args) => listPageAccessLinks(this.memoryCtx(), String(args.page_id)),
    );
    register("revoke_page_access_link", "Revoke a page access link.", { id: z.string() }, (args) =>
      revokePageAccessLink(this.memoryCtx(), String(args.id)),
    );
  }

  private memoryCtx() {
    const user = this.props?.user;
    if (!user) throw new MemoryError(401, "unauthorized");
    return { env: this.env, user, source: "mcp:tool" };
  }

  private result(value: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  }
}
