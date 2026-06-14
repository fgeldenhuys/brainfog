import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { Env } from "../env";
import {
  addDocument,
  createDependency,
  createProject,
  createTask,
  deleteDependency,
  linkThought,
  listDependencies,
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
  remember,
  setSelfPerson,
  updateDocument,
  updateFact,
  updateTask,
  upsertPerson,
} from "../memory";

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
    const strings = z.array(z.string()).optional();
    const nullableString = z.string().nullable().optional();
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

    // Register prompts for agent guidance on memory usage
    this.server.prompt(
      "recall-context",
      "Recall relevant context from brainfog memory before proceeding with the current conversation.",
      {
        topic: z.string().optional(),
        project_id: z.string().optional(),
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
        project_id: z.string().optional(),
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
        project_id: z.string().optional(),
        links: obj,
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
        project_id: z.string().optional(),
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
        project_id: z.string().optional(),
        mime_type: z.string().optional(),
        derived_from: obj,
      },
      (args) => addDocument(this.memoryCtx(), args as Parameters<typeof addDocument>[1]),
    );
    register(
      "update_document",
      "Replace a document's content and regenerate chunks.",
      { id: z.string(), content: z.string(), derived_from: obj },
      (args) =>
        updateDocument(
          this.memoryCtx(),
          String(args.id),
          String(args.content),
          args.derived_from as Parameters<typeof updateDocument>[3],
        ),
    );
    register(
      "recall",
      "Semantic recall over thoughts, facts, and document chunks.",
      {
        query: z.string(),
        kinds: strings,
        project_id: z.string().optional(),
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
        project_id: nullableString,
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
        project_id: nullableString,
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
      { project_id: z.string().optional(), status: z.string().optional() },
      (args) => listTasks(this.memoryCtx(), args),
    );
    register(
      "record_time_series_point",
      "Append a generic time-series point.",
      {
        series_key: z.string(),
        value: nullableNumber,
        unit: nullableString,
        observed_at: nullableNumber,
        project_id: nullableString,
        subject_type: nullableString,
        subject_id: nullableString,
        metadata: obj,
      },
      (args) => recordTimeSeriesPoint(this.memoryCtx(), args),
    );
    register(
      "list_time_series_points",
      "List time-series points.",
      {
        series_key: z.string().optional(),
        project_id: z.string().optional(),
        subject_type: z.string().optional(),
        subject_id: z.string().optional(),
        from: z.number().optional(),
        to: z.number().optional(),
      },
      (args) => listTimeSeriesPoints(this.memoryCtx(), args as Record<string, string | undefined>),
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
      "Link a thought to global people or owned tasks, facts, and documents.",
      { thought_id: z.string(), links: obj },
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
      { kind: z.string().optional(), project_id: z.string().optional() },
      (args) => listStale(this.memoryCtx(), args),
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
