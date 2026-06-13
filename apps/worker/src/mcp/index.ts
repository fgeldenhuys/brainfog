import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import type { Env } from "../env";
import {
  addDocument,
  createProject,
  createTask,
  linkThought,
  listPeople,
  listProjects,
  listTasks,
  listTimeSeriesPoints,
  MemoryError,
  type MemoryUser,
  recall,
  recordFact,
  recordTimeSeriesPoint,
  remember,
  updateDocument,
  updateFact,
  updateTask,
  upsertPerson,
} from "../memory";

/**
 * Streamable HTTP MCP server (ADR-003), mounted at `/mcp` behind the
 * shared bearer-token middleware. Tool handlers call the same owner-scoped
 * memory service layer as the REST API.
 */
export class BrainfogMCP extends McpAgent<Env, unknown, { user?: MemoryUser }> {
  server = new McpServer({ name: "brainfog", version: "0.1.0" });

  async init() {
    this.server.tool("ping", "Placeholder health-check tool.", async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    }));

    const any = z.any().optional();
    const obj = z.record(z.string(), z.unknown()).optional();
    const strings = z.array(z.string()).optional();

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
        statement: any,
        citations: any,
        confidence: any,
        status: any,
        topics: any,
        supersedes_fact_id: any,
        superseded_by_fact_id: any,
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
      },
      (args) => addDocument(this.memoryCtx(), args as Parameters<typeof addDocument>[1]),
    );
    register(
      "update_document",
      "Replace a document's content and regenerate chunks.",
      { id: z.string(), content: z.string() },
      (args) => updateDocument(this.memoryCtx(), String(args.id), String(args.content)),
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
        description: any,
        project_id: any,
        due_at: any,
        status: any,
        priority: any,
        recurrence: any,
      },
      (args) => createTask(this.memoryCtx(), args),
    );
    register(
      "update_task",
      "Update a task.",
      {
        id: z.string(),
        title: any,
        description: any,
        project_id: any,
        due_at: any,
        status: any,
        priority: any,
        recurrence: any,
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
        value: any,
        unit: any,
        observed_at: any,
        project_id: any,
        subject_type: any,
        subject_id: any,
        metadata: any,
      },
      (args) => recordTimeSeriesPoint(this.memoryCtx(), args),
    );
    register(
      "list_time_series_points",
      "List time-series points.",
      { series_key: any, project_id: any, subject_type: any, subject_id: any, from: any, to: any },
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
        notes: any,
      },
      (args) => upsertPerson(this.memoryCtx(), args as Parameters<typeof upsertPerson>[1]),
    );
    register("list_people", "List people.", {}, () => listPeople(this.memoryCtx()));
    register(
      "create_project",
      "Create a project.",
      { name: z.string(), description: any },
      (args) => createProject(this.memoryCtx(), args as Parameters<typeof createProject>[1]),
    );
    register("list_projects", "List projects.", {}, () => listProjects(this.memoryCtx()));
    register(
      "link",
      "Link a thought to owned people, tasks, facts, and documents.",
      { thought_id: z.string(), links: obj },
      (args) =>
        linkThought(
          this.memoryCtx(),
          String(args.thought_id),
          args.links as Parameters<typeof linkThought>[2],
        ),
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
