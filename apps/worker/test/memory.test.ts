import { applyD1Migrations, env, SELF } from "cloudflare:test";
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
  thoughtFacts,
  thoughtPeople,
  thoughts,
  tokens,
  users,
} from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  addDocument,
  deleteDocument,
  deleteFact,
  deleteThought,
  recall,
  recordFact,
  remember,
  updateDocument,
  updateFact,
  updateTask,
  upsertPerson,
} from "../src/memory";

const TOKEN_A = "memory-token-a";
const TOKEN_B = "memory-token-b";
const idPattern = /^bf[0-9abcdefghjkmnpqrstvwxyz]{20}[rpkfsdct]$/;

async function authFetch(path: string, init: RequestInit = {}, token = TOKEN_A) {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json() as Promise<T>;
}

async function mcpRequest(
  body: Record<string, unknown>,
  sessionId?: string,
  token = TOKEN_A,
): Promise<{ response: Response; message?: Record<string, unknown>; sessionId?: string }> {
  const response = await authFetch(
    "/mcp",
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    },
    token,
  );
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  const message = (dataLine ? JSON.parse(dataLine) : text ? JSON.parse(text) : undefined) as
    | Record<string, unknown>
    | undefined;
  return { response, message, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

async function mcpSession(token = TOKEN_A) {
  const init = await mcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "brainfog-test", version: "0.1.0" },
      },
    },
    undefined,
    token,
  );
  expect(init.response.status).toBe(200);
  expect(init.sessionId).toBeTruthy();
  await mcpRequest(
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    init.sessionId,
    token,
  );
  return init.sessionId ?? "";
}

async function callMcpTool<T>(name: string, args: Record<string, unknown>, token = TOKEN_A) {
  const session = await mcpSession(token);
  const result = await mcpRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    session,
    token,
  );
  expect(result.response.status).toBe(200);
  const m = result.message as { result?: { content?: { text?: string }[] }; error?: unknown };
  expect(m.error).toBeUndefined();
  return JSON.parse(m.result?.content?.[0]?.text ?? "null") as T;
}

describe("memory model REST service", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
    const db = createDb(env.DB);
    await db.insert(users).values({ id: "user-memory-a", name: "Memory A" }).onConflictDoNothing();
    await db.insert(users).values({ id: "user-memory-b", name: "Memory B" }).onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-memory-a",
        userId: "user-memory-a",
        tokenHash: await hashToken(TOKEN_A, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-memory-b",
        userId: "user-memory-b",
        tokenHash: await hashToken(TOKEN_B, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
  });

  it("creates projects, people, tasks, thoughts with provenance and owner-scoped links", async () => {
    const project = await json<{ id: string }>(
      await authFetch("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Spec work" }),
      }),
    );
    const person = await json<{ id: string }>(
      await authFetch("/api/v1/people", {
        method: "POST",
        body: JSON.stringify({
          name: "Sarah",
          aliases: ["S"],
          contact_info: { email: "sarah@example.invalid" },
        }),
      }),
    );
    const self = await json<{ self_person_id: string; self_person: { id: string } }>(
      await authFetch("/api/v1/whoami", {
        method: "PATCH",
        body: JSON.stringify({ self_person_id: person.id }),
      }),
    );
    expect(self.self_person_id).toBe(person.id);
    expect(self.self_person.id).toBe(person.id);

    const whoami = await json<{ self_person_id: string; self_person: { id: string } }>(
      await authFetch("/api/v1/whoami"),
    );
    expect(whoami.self_person_id).toBe(person.id);
    expect(whoami.self_person.id).toBe(person.id);

    const crossUserSelf = await authFetch(
      "/api/v1/whoami",
      {
        method: "PATCH",
        body: JSON.stringify({ self_person_id: person.id }),
      },
      TOKEN_B,
    );
    expect(crossUserSelf.status).toBe(404);

    const task = await json<{ id: string }>(
      await authFetch("/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: "Write tests",
          project_id: project.id,
          recurrence: { frequency: "weekly", interval: 1, days_of_week: [1] },
        }),
      }),
    );
    const thought = await json<{ id: string; ownerId: string; source: string }>(
      await authFetch("/api/v1/thoughts", {
        method: "POST",
        body: JSON.stringify({
          content: "Sarah prefers async standups over live meetings",
          project_id: project.id,
          links: { people_ids: [person.id], task_ids: [task.id] },
        }),
      }),
    );

    expect(thought.id).toMatch(idPattern);
    expect(thought.id.endsWith("t")).toBe(true);
    expect(thought.ownerId).toBe("user-memory-a");
    expect(thought.source).toBe("rest:api");

    const link = (
      await createDb(env.DB)
        .select()
        .from(thoughtPeople)
        .where(and(eq(thoughtPeople.thoughtId, thought.id), eq(thoughtPeople.personId, person.id)))
    )[0];
    expect(link).toBeTruthy();

    const reject = await authFetch(
      "/api/v1/thoughts",
      {
        method: "POST",
        body: JSON.stringify({ content: "bad cross link", links: { people_ids: [person.id] } }),
      },
      TOKEN_B,
    );
    expect(reject.status).toBe(404);
  });

  it("records facts, derivations, supersession lifecycle, update re-embedding path, and recall", async () => {
    const thought = await json<{ id: string }>(
      await authFetch("/api/v1/thoughts", {
        method: "POST",
        body: JSON.stringify({ content: "D1 remains canonical for memory rows" }),
      }),
    );
    const base = await json<{ id: string }>(
      await authFetch("/api/v1/facts", {
        method: "POST",
        body: JSON.stringify({
          statement: "Vectorize is a derived index",
          citations: ["ADR-005"],
          confidence: 0.95,
        }),
      }),
    );
    const fact = await json<{ id: string; supersedesFactId: string }>(
      await authFetch("/api/v1/facts", {
        method: "POST",
        body: JSON.stringify({
          statement: "D1 is canonical and Vectorize is rebuildable",
          citations: ["ARCHITECTURE.md"],
          confidence: 0.98,
          derived_from: { thought_ids: [thought.id], fact_ids: [base.id] },
          supersedes_fact_id: base.id,
        }),
      }),
    );

    expect(fact.id).toMatch(idPattern);
    expect(fact.id.endsWith("f")).toBe(true);
    expect(fact.supersedesFactId).toBe(base.id);
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(factSourceThoughts)
          .where(eq(factSourceThoughts.factId, fact.id))
      )[0],
    ).toBeTruthy();
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(factSourceFacts)
          .where(eq(factSourceFacts.factId, fact.id))
      )[0],
    ).toBeTruthy();
    const old = (await createDb(env.DB).select().from(facts).where(eq(facts.id, base.id)))[0];
    expect(old).toBeTruthy();
    if (!old) throw new Error("old fact missing");
    expect(old.status).toBe("superseded");
    expect(old.supersededByFactId).toBe(fact.id);

    const updated = await json<{ statement: string; status: string }>(
      await authFetch(`/api/v1/facts/${fact.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          statement: "D1 is the source of truth; Vectorize can be rebuilt",
          status: "proven_wrong",
        }),
      }),
    );
    expect(updated.statement).toContain("source of truth");
    expect(updated.status).toBe("proven_wrong");

    const recall = await json<{ kind: string; row: { id: string } }[]>(
      await authFetch("/api/v1/recall?q=canonical%20vectorize&kinds=thought,fact"),
    );
    expect(recall.some((r) => r.kind === "thought" && r.row.id === thought.id)).toBe(true);
  });

  it("keeps fact supersession reciprocal pointers consistent on update", async () => {
    const olderA = await json<{ id: string }>(
      await authFetch("/api/v1/facts", {
        method: "POST",
        body: JSON.stringify({ statement: "Older fact A" }),
      }),
    );
    const olderB = await json<{ id: string }>(
      await authFetch("/api/v1/facts", {
        method: "POST",
        body: JSON.stringify({ statement: "Older fact B" }),
      }),
    );
    const newer = await json<{ id: string }>(
      await authFetch("/api/v1/facts", {
        method: "POST",
        body: JSON.stringify({ statement: "Newer fact", supersedes_fact_id: olderA.id }),
      }),
    );

    await json(
      await authFetch(`/api/v1/facts/${newer.id}`, {
        method: "PATCH",
        body: JSON.stringify({ supersedes_fact_id: olderB.id }),
      }),
    );

    const db = createDb(env.DB);
    const getFact = async (id: string) => {
      const row = (await db.select().from(facts).where(eq(facts.id, id)))[0];
      if (!row) throw new Error(`fact ${id} missing`);
      return row;
    };
    let refreshedOlderA = await getFact(olderA.id);
    let refreshedOlderB = await getFact(olderB.id);
    expect(refreshedOlderA.supersededByFactId).toBeNull();
    expect(refreshedOlderB.supersededByFactId).toBe(newer.id);

    await json(
      await authFetch(`/api/v1/facts/${newer.id}`, {
        method: "PATCH",
        body: JSON.stringify({ supersedes_fact_id: null }),
      }),
    );

    const refreshedNewer = await getFact(newer.id);
    refreshedOlderB = await getFact(olderB.id);
    expect(refreshedNewer.supersedesFactId).toBeNull();
    expect(refreshedOlderB.supersededByFactId).toBeNull();

    const newest = await json<{ id: string }>(
      await authFetch("/api/v1/facts", {
        method: "POST",
        body: JSON.stringify({ statement: "Newest fact" }),
      }),
    );

    await json(
      await authFetch(`/api/v1/facts/${olderA.id}`, {
        method: "PATCH",
        body: JSON.stringify({ superseded_by_fact_id: newest.id }),
      }),
    );

    refreshedOlderA = await getFact(olderA.id);
    let refreshedNewest = await getFact(newest.id);
    expect(refreshedOlderA.supersededByFactId).toBe(newest.id);
    expect(refreshedNewest.supersedesFactId).toBe(olderA.id);

    await json(
      await authFetch(`/api/v1/facts/${olderA.id}`, {
        method: "PATCH",
        body: JSON.stringify({ superseded_by_fact_id: null }),
      }),
    );

    refreshedOlderA = await getFact(olderA.id);
    refreshedNewest = await getFact(newest.id);
    expect(refreshedOlderA.supersededByFactId).toBeNull();
    expect(refreshedNewest.supersedesFactId).toBeNull();
  });

  it("stores documents in R2, chunks them, updates chunks, and cleans up", async () => {
    const doc = await json<{ id: string; r2Key: string }>(
      await authFetch("/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({
          title: "Doc",
          content: "# Brainfog\n\nDocument chunks are recallable by meaning.",
        }),
      }),
    );
    expect(doc.id.endsWith("d")).toBe(true);
    const content = await authFetch(`/api/v1/documents/${doc.id}/content`);
    expect(await content.text()).toContain("Document chunks");
    let chunks = await json<{ id: string; content: string }[]>(
      await authFetch(`/api/v1/documents/${doc.id}/chunks`),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.id.endsWith("c")).toBe(true);

    await json(
      await authFetch(`/api/v1/documents/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: "Updated document body with fresh chunks." }),
      }),
    );
    chunks = await json<{ id: string; content: string }[]>(
      await authFetch(`/api/v1/documents/${doc.id}/chunks`),
    );
    expect(chunks[0]?.content).toContain("Updated");

    await json(await authFetch(`/api/v1/documents/${doc.id}`, { method: "DELETE" }));
    expect(
      (await createDb(env.DB).select().from(documents).where(eq(documents.id, doc.id)))[0],
    ).toBeUndefined();
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(documentChunks)
          .where(eq(documentChunks.documentId, doc.id))
      ).length,
    ).toBe(0);
  });

  it("validates recurrence and records owner-scoped time-series points", async () => {
    const invalid = await authFetch("/api/v1/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "Bad recurrence",
        recurrence: { frequency: "weekly", interval: 0, days_of_week: [8] },
      }),
    });
    expect(invalid.status).toBe(400);

    const task = await json<{ id: string }>(
      await authFetch("/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "Build", priority: 0.7 }),
      }),
    );
    const point = await json<{ id: string; ownerId: string }>(
      await authFetch("/api/v1/time-series-points", {
        method: "POST",
        body: JSON.stringify({
          series_key: "build.duration_ms",
          value: 123,
          unit: "ms",
          subject_type: "task",
          subject_id: task.id,
          observed_at: 1_800_000_000,
          metadata: { ci: true },
        }),
      }),
    );
    expect(point.id.endsWith("s")).toBe(true);
    expect(point.ownerId).toBe("user-memory-a");
    const points = await json<{ id: string }[]>(
      await authFetch(
        "/api/v1/time-series-points?series_key=build.duration_ms&from=1700000000&to=1900000000",
      ),
    );
    expect(points.map((p) => p.id)).toContain(point.id);

    const otherUsersPoints = await json<unknown[]>(
      await authFetch("/api/v1/time-series-points?series_key=build.duration_ms", {}, TOKEN_B),
    );
    expect(otherUsersPoints).toEqual([]);
  });

  it("deletes thought and fact rows through owner-scoped routes", async () => {
    const thought = await json<{ id: string }>(
      await authFetch("/api/v1/thoughts", {
        method: "POST",
        body: JSON.stringify({ content: "temporary thought" }),
      }),
    );
    const fact = await json<{ id: string }>(
      await authFetch("/api/v1/facts", {
        method: "POST",
        body: JSON.stringify({ statement: "temporary fact" }),
      }),
    );

    expect(
      (await authFetch(`/api/v1/thoughts/${thought.id}`, { method: "DELETE" }, TOKEN_B)).status,
    ).toBe(404);
    expect(
      (await createDb(env.DB).select().from(thoughts).where(eq(thoughts.id, thought.id)))[0],
    ).toBeTruthy();
    await json(await authFetch(`/api/v1/thoughts/${thought.id}`, { method: "DELETE" }));
    await json(await authFetch(`/api/v1/facts/${fact.id}`, { method: "DELETE" }));
    expect(
      (await createDb(env.DB).select().from(thoughts).where(eq(thoughts.id, thought.id)))[0],
    ).toBeUndefined();
    expect(
      (await createDb(env.DB).select().from(facts).where(eq(facts.id, fact.id)))[0],
    ).toBeUndefined();
  });

  it("REST routes do not accept owner_id overrides", async () => {
    const project = await json<{ id: string; ownerId: string }>(
      await authFetch("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Owner override", owner_id: "user-memory-b" }),
      }),
    );
    expect(project.ownerId).toBe("user-memory-a");
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(projects)
          .where(and(eq(projects.id, project.id), eq(projects.ownerId, "user-memory-a")))
      )[0],
    ).toBeTruthy();
  });

  it("MCP tools use bearer auth context and ignore owner_id overrides", async () => {
    const unauthenticated = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(unauthenticated.status).toBe(401);

    const project = await callMcpTool<{ id: string; ownerId: string }>("create_project", {
      name: "MCP project",
      owner_id: "user-memory-b",
    });
    expect(project.ownerId).toBe("user-memory-a");
    const thought = await callMcpTool<{ id: string; ownerId: string; source: string }>("remember", {
      content: "MCP stores authenticated memories",
      project_id: project.id,
      owner_id: "user-memory-b",
    });
    expect(thought.ownerId).toBe("user-memory-a");
    expect(thought.source).toBe("mcp:tool");
    expect(thought.id).toMatch(idPattern);

    const recalled = await callMcpTool<{ kind: string; row: { id: string } }[]>("recall", {
      query: "authenticated memories",
      project_id: project.id,
      kinds: ["thought"],
    });
    expect(recalled.some((r) => r.row.id === thought.id)).toBe(true);
  });

  it("MCP exposes all memory-model tools", async () => {
    const session = await mcpSession();
    const response = await mcpRequest(
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      session,
    );
    expect(response.response.status).toBe(200);
    const names = (
      response.message as { result?: { tools?: { name: string }[] } }
    ).result?.tools?.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "remember",
        "record_fact",
        "update_fact",
        "add_document",
        "update_document",
        "recall",
        "create_task",
        "update_task",
        "list_tasks",
        "record_time_series_point",
        "list_time_series_points",
        "upsert_person",
        "list_people",
        "create_project",
        "list_projects",
        "link",
      ]),
    );
  });

  it("rejects cross-user fact references and derivation document sources", async () => {
    const otherFact = await json<{ id: string }>(
      await authFetch(
        "/api/v1/facts",
        { method: "POST", body: JSON.stringify({ statement: "Other user's fact" }) },
        TOKEN_B,
      ),
    );
    const ownFact = await json<{ id: string }>(
      await authFetch("/api/v1/facts", {
        method: "POST",
        body: JSON.stringify({ statement: "Own fact" }),
      }),
    );
    await expect(
      updateFact(
        { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
        ownFact.id,
        { supersedes_fact_id: otherFact.id },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateFact(
        { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
        ownFact.id,
        { superseded_by_fact_id: ownFact.id },
      ),
    ).rejects.toMatchObject({ status: 400 });

    const otherDoc = await json<{ id: string }>(
      await authFetch(
        "/api/v1/documents",
        { method: "POST", body: JSON.stringify({ title: "Other", content: "other chunk" }) },
        TOKEN_B,
      ),
    );
    const otherChunk = (
      await createDb(env.DB)
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, otherDoc.id))
    )[0];
    await expect(
      recordFact(
        { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
        { statement: "Bad doc derivation", derived_from: { document_ids: [otherDoc.id] } },
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      recordFact(
        { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
        {
          statement: "Bad chunk derivation",
          derived_from: { document_chunk_ids: [otherChunk?.id ?? "missing"] },
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await createDb(env.DB).select().from(factSourceDocuments)).toHaveLength(0);
    expect(await createDb(env.DB).select().from(factSourceDocumentChunks)).toHaveLength(0);
  });

  it("validates recurrence on update_task", async () => {
    const task = await json<{ id: string }>(
      await authFetch("/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "Update me" }),
      }),
    );
    const invalid = await authFetch(`/api/v1/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ recurrence: { frequency: "weekly", interval: -1 } }),
    });
    expect(invalid.status).toBe(400);
    await expect(
      updateTask(
        { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
        task.id,
        { recurrence: { frequency: "daily", starts_at: 20, ends_at: 10 } },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("update_task updates, rejects, and clears project_id with owner validation", async () => {
    const projectA = await json<{ id: string }>(
      await authFetch("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Task Project A" }),
      }),
    );
    const projectB = await json<{ id: string }>(
      await authFetch("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Task Project B" }),
      }),
    );
    const otherProject = await json<{ id: string }>(
      await authFetch(
        "/api/v1/projects",
        { method: "POST", body: JSON.stringify({ name: "Other Task Project" }) },
        TOKEN_B,
      ),
    );
    const task = await json<{ id: string; projectId: string }>(
      await authFetch("/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "Move project", project_id: projectA.id }),
      }),
    );
    expect(task.projectId).toBe(projectA.id);

    const ctx = { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" };
    const moved = await updateTask(ctx, task.id, { project_id: projectB.id });
    expect(moved?.projectId).toBe(projectB.id);
    await expect(updateTask(ctx, task.id, { project_id: otherProject.id })).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await createDb(env.DB).select().from(tasks).where(eq(tasks.id, task.id)))[0]?.projectId,
    ).toBe(projectB.id);

    const cleared = await updateTask(ctx, task.id, { project_id: null });
    expect(cleared?.projectId).toBeNull();
    const unchanged = await updateTask(ctx, task.id, { title: "Still unprojected" });
    expect(unchanged?.projectId).toBeNull();
  });

  it("upsert_person update preserves omitted fields and clears explicit ones", async () => {
    const ctx = { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" };
    const created = await upsertPerson(ctx, {
      name: "Ada Lovelace",
      aliases: ["Ada"],
      contact_info: { email: "ada@example.com" },
      notes: "Mathematician",
    });

    const renamed = await upsertPerson(ctx, { id: created.id, name: "Ada King" });
    expect(renamed).toMatchObject({
      name: "Ada King",
      aliases: ["Ada"],
      contactInfo: { email: "ada@example.com" },
      notes: "Mathematician",
    });

    const cleared = await upsertPerson(ctx, {
      id: created.id,
      name: "Ada King",
      aliases: [],
      contact_info: {},
      notes: null,
    });
    expect(cleared).toMatchObject({ aliases: [], contactInfo: {}, notes: null });

    expect(
      (await createDb(env.DB).select().from(people).where(eq(people.id, created.id)))[0],
    ).toMatchObject({ name: "Ada King", aliases: [], contactInfo: {}, notes: null });

    await expect(
      upsertPerson(ctx, { id: "bfdoesnotexist0000000000p", name: "Nobody" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("failed cross-user remember does not leave parent thoughts or partial links", async () => {
    const ownPerson = await json<{ id: string }>(
      await authFetch("/api/v1/people", {
        method: "POST",
        body: JSON.stringify({ name: "Partial Link Person" }),
      }),
    );
    const otherFact = await json<{ id: string }>(
      await authFetch(
        "/api/v1/facts",
        { method: "POST", body: JSON.stringify({ statement: "Other partial link fact" }) },
        TOKEN_B,
      ),
    );
    await expect(
      remember(
        { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
        {
          content: "failed cross-user remember should not persist",
          links: { people_ids: [ownPerson.id], fact_ids: [otherFact.id] },
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(thoughts)
          .where(eq(thoughts.content, "failed cross-user remember should not persist"))
      ).length,
    ).toBe(0);
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(thoughtPeople)
          .where(eq(thoughtPeople.personId, ownPerson.id))
      ).length,
    ).toBe(0);
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(thoughtFacts)
          .where(eq(thoughtFacts.factId, otherFact.id))
      ).length,
    ).toBe(0);
  });

  it("failed cross-user record_fact does not leave parent facts or partial derivations", async () => {
    const ownThought = await remember(
      { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
      { content: "valid derivation source before rejected fact" },
    );
    const otherFact = await json<{ id: string }>(
      await authFetch(
        "/api/v1/facts",
        { method: "POST", body: JSON.stringify({ statement: "Other partial derivation fact" }) },
        TOKEN_B,
      ),
    );
    await expect(
      recordFact(
        { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
        {
          statement: "failed cross-user record_fact should not persist",
          derived_from: { thought_ids: [ownThought.id], fact_ids: [otherFact.id] },
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(facts)
          .where(eq(facts.statement, "failed cross-user record_fact should not persist"))
      ).length,
    ).toBe(0);
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(factSourceThoughts)
          .where(eq(factSourceThoughts.thoughtId, ownThought.id))
      ).length,
    ).toBe(0);
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(factSourceFacts)
          .where(eq(factSourceFacts.sourceFactId, otherFact.id))
      ).length,
    ).toBe(0);
  });

  it("update_document deletes stale Vectorize IDs before re-chunking", async () => {
    const deleteByIds = vi.fn(async () => undefined);
    const upsert = vi.fn(async () => undefined);
    const serviceEnv = {
      DB: env.DB,
      DOCUMENTS: env.DOCUMENTS,
      VECTORIZE: { upsert, deleteByIds, query: vi.fn() },
      AI: { run: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] })) },
    } as unknown as typeof env;
    const ctx = {
      env: serviceEnv,
      user: { id: "user-memory-a", name: "Memory A" },
      source: "test",
    };
    const doc = await addDocument(ctx, { title: "Rechunk", content: "old content" });
    const oldIds = (
      await createDb(env.DB)
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, doc.id))
    ).map((c) => c.id);
    await updateDocument(ctx, doc.id, "new content after update");
    expect(deleteByIds).toHaveBeenCalledWith(oldIds);
    const currentIds = (
      await createDb(env.DB)
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, doc.id))
    ).map((c) => c.id);
    expect(currentIds.some((id) => oldIds.includes(id))).toBe(false);
  });

  it("recall resolves mixed Vectorize matches through D1 owner and project filters", async () => {
    const projectA = await json<{ id: string }>(
      await authFetch("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Recall A" }),
      }),
    );
    const projectB = await json<{ id: string }>(
      await authFetch("/api/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "Recall B" }),
      }),
    );
    const baseCtx = { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test" };
    const thought = await remember(baseCtx, {
      content: "mixed recall thought",
      project_id: projectA.id,
    });
    const fact = await recordFact(baseCtx, {
      statement: "mixed recall fact",
      project_id: projectA.id,
    });
    const doc = await addDocument(baseCtx, {
      title: "Mixed recall doc",
      content: "mixed recall document chunk",
      project_id: projectA.id,
    });
    const chunk = (
      await createDb(env.DB)
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, doc.id))
    )[0];
    const wrongProjectThought = await remember(baseCtx, {
      content: "mixed recall wrong project",
      project_id: projectB.id,
    });
    const otherUserThought = await remember(
      { env, user: { id: "user-memory-b", name: "Memory B" }, source: "test" },
      { content: "mixed recall other owner" },
    );
    const vectorEnv = {
      DB: env.DB,
      DOCUMENTS: env.DOCUMENTS,
      VECTORIZE: {
        upsert: vi.fn(),
        deleteByIds: vi.fn(),
        query: vi.fn(async () => ({
          matches: [
            { id: thought.id, score: 0.9, metadata: { kind: "thought" } },
            { id: fact.id, score: 0.8, metadata: { kind: "fact" } },
            { id: chunk?.id, score: 0.7, metadata: { kind: "document_chunk" } },
            { id: wrongProjectThought.id, score: 0.99, metadata: { kind: "thought" } },
            { id: otherUserThought.id, score: 0.98, metadata: { kind: "thought" } },
          ],
        })),
      },
      AI: { run: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] })) },
    } as unknown as typeof env;
    const results = await recall(
      { env: vectorEnv, user: { id: "user-memory-a", name: "Memory A" }, source: "test" },
      { query: "mixed recall", project_id: projectA.id, limit: 10 },
    );
    expect(results.map((r) => (r as { kind: string }).kind)).toEqual([
      "thought",
      "fact",
      "document_chunk",
    ]);
    const resultIds = results.map((r) => (r as { row: { id: string } }).row.id);
    expect(resultIds).not.toContain(wrongProjectThought.id);
    expect(resultIds).not.toContain(otherUserThought.id);
  });

  it("recall applies kind filtering in the Vectorize query before topK", async () => {
    const ctx = { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test" };
    const thought = await remember(ctx, { content: "requested kind target" });
    const fact = await recordFact(ctx, { statement: "higher ranked other kind" });
    const vectorMatches = [
      { id: fact.id, score: 0.99, metadata: { kind: "fact" } },
      { id: thought.id, score: 0.5, metadata: { kind: "thought" } },
    ];
    const query = vi.fn(
      async (_values, options?: { topK?: number; filter?: Record<string, unknown> }) => {
        const filterKind = options?.filter?.kind;
        const allowedKinds =
          typeof filterKind === "string"
            ? [filterKind]
            : Array.isArray((filterKind as { $in?: unknown[] } | undefined)?.$in)
              ? (filterKind as { $in: string[] }).$in
              : undefined;
        const matches = allowedKinds
          ? vectorMatches.filter((match) => allowedKinds.includes(match.metadata.kind))
          : vectorMatches;
        return { matches: matches.slice(0, options?.topK ?? 10) };
      },
    );
    const vectorEnv = {
      DB: env.DB,
      DOCUMENTS: env.DOCUMENTS,
      VECTORIZE: { upsert: vi.fn(), deleteByIds: vi.fn(), query },
      AI: { run: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] })) },
    } as unknown as typeof env;

    const results = await recall(
      { env: vectorEnv, user: { id: "user-memory-a", name: "Memory A" }, source: "test" },
      { query: "semantic-only", kinds: ["thought"], limit: 1 },
    );

    expect(query).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ filter: expect.objectContaining({ kind: "thought" }), topK: 1 }),
    );
    expect(results.map((r) => (r as { row: { id: string } }).row.id)).toEqual([thought.id]);
  });

  it("service writes upsert row IDs to Vectorize and cleanup deletes those IDs", async () => {
    const upsert = vi.fn(async () => undefined);
    const deleteByIds = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({
      matches: [{ id: "not-found", score: 0.1, metadata: { kind: "thought" } }],
    }));
    const serviceEnv = {
      DB: env.DB,
      DOCUMENTS: env.DOCUMENTS,
      VECTORIZE: { upsert, deleteByIds, query },
      AI: { run: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] })) },
    } as unknown as typeof env;
    const ctx = {
      env: serviceEnv,
      user: { id: "user-memory-a", name: "Memory A" },
      source: "test:service",
    };

    const thought = await remember(ctx, { content: "vector thought" });
    const fact = await recordFact(ctx, { statement: "vector fact" });
    const doc = await addDocument(ctx, { title: "Vector doc", content: "chunk text" });

    const upsertCalls = upsert.mock.calls as unknown as Array<
      [Array<{ id: string; metadata: { kind: string } }>]
    >;
    const vectorIds = upsertCalls.map((call) => call[0][0]?.id ?? "");
    expect(vectorIds).toContain(thought.id);
    expect(vectorIds).toContain(fact.id);
    expect(vectorIds.some((id) => id.endsWith("c"))).toBe(true);
    expect(vectorIds.every((id) => idPattern.test(id))).toBe(true);
    expect(upsertCalls.map((call) => call[0][0]?.metadata.kind)).toEqual([
      "thought",
      "fact",
      "document_chunk",
    ]);

    await recall(ctx, { query: "vector", kinds: ["thought"], limit: 1 });
    expect(query).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ topK: 1 }));

    await deleteThought(ctx, thought.id);
    await deleteFact(ctx, fact.id);
    await deleteDocument(ctx, doc.id);
    const deleteCalls = deleteByIds.mock.calls as unknown as Array<[string[]]>;
    expect(deleteCalls.flatMap((call) => call[0])).toEqual(
      expect.arrayContaining([thought.id, fact.id]),
    );
  });

  it("cross-user thought and fact deletes do not delete Vectorize IDs", async () => {
    const upsert = vi.fn(async () => undefined);
    const deleteByIds = vi.fn(async () => undefined);
    const serviceEnv = {
      DB: env.DB,
      DOCUMENTS: env.DOCUMENTS,
      VECTORIZE: { upsert, deleteByIds, query: vi.fn() },
      AI: { run: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] })) },
    } as unknown as typeof env;
    const ownerCtx = {
      env: serviceEnv,
      user: { id: "user-memory-a", name: "Memory A" },
      source: "test:service",
    };
    const otherCtx = {
      env: serviceEnv,
      user: { id: "user-memory-b", name: "Memory B" },
      source: "test:service",
    };
    const thought = await remember(ownerCtx, { content: "owned vector delete thought" });
    const fact = await recordFact(ownerCtx, { statement: "owned vector delete fact" });

    await expect(deleteThought(otherCtx, thought.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteFact(otherCtx, fact.id)).rejects.toMatchObject({ status: 404 });
    expect(deleteByIds).not.toHaveBeenCalled();
    expect(
      (await createDb(env.DB).select().from(thoughts).where(eq(thoughts.id, thought.id)))[0],
    ).toBeTruthy();
    expect(
      (await createDb(env.DB).select().from(facts).where(eq(facts.id, fact.id)))[0],
    ).toBeTruthy();

    await deleteThought(ownerCtx, thought.id);
    await deleteFact(ownerCtx, fact.id);
  });

  it("MCP prompts/list returns recall-context and save-session-notes", async () => {
    const session = await mcpSession();
    const response = await mcpRequest(
      { jsonrpc: "2.0", id: 4, method: "prompts/list", params: {} },
      session,
    );
    expect(response.response.status).toBe(200);
    const prompts = (
      response.message as {
        result?: {
          prompts?: {
            name: string;
            description: string;
            arguments?: { name: string; required: boolean }[];
          }[];
        };
      }
    ).result?.prompts;
    expect(prompts).toBeTruthy();
    const names = prompts?.map((p) => p.name);
    expect(names).toContain("recall-context");
    expect(names).toContain("save-session-notes");
    const recallPrompt = prompts?.find((p) => p.name === "recall-context");
    const savePrompt = prompts?.find((p) => p.name === "save-session-notes");
    expect(recallPrompt?.description).toBeTruthy();
    expect(savePrompt?.description).toBeTruthy();
    expect(recallPrompt?.arguments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "topic", required: false }),
        expect.objectContaining({ name: "project_id", required: false }),
      ]),
    );
    expect(savePrompt?.arguments).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "project_id", required: false })]),
    );
  });

  it("MCP prompts/list is rejected without a valid bearer token", async () => {
    const response = await authFetch(
      "/mcp",
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "prompts/list",
          params: {},
        }),
      },
      "invalid-token",
    );
    expect(response.status).toBe(401);
  });

  it("MCP prompts/get recall-context with topic and project_id", async () => {
    const session = await mcpSession();
    const response = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "prompts/get",
        params: {
          name: "recall-context",
          arguments: { topic: "supplement adherence", project_id: "test-project-id" },
        },
      },
      session,
    );
    expect(response.response.status).toBe(200);
    const result = response.message as {
      result?: {
        messages?: { role: string; content: { type: string; text: string } }[];
      };
    };
    expect(result.result?.messages).toBeTruthy();
    expect(result.result?.messages?.length).toBeGreaterThan(0);
    const content = result.result?.messages?.[0]?.content?.text ?? "";
    expect(content).toContain("recall");
    expect(content).toContain('query: "supplement adherence"');
    expect(content).toContain('project_id: "test-project-id"');
    expect(content).toContain("supplement adherence");
    expect(content).toContain("test-project-id");
  });

  it("MCP prompts/get recall-context with topic only", async () => {
    const session = await mcpSession();
    const response = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "prompts/get",
        params: {
          name: "recall-context",
          arguments: { topic: "meeting notes" },
        },
      },
      session,
    );
    expect(response.response.status).toBe(200);
    const result = response.message as {
      result?: {
        messages?: { role: string; content: { type: string; text: string } }[];
      };
    };
    expect(result.result?.messages).toBeTruthy();
    const content = result.result?.messages?.[0]?.content?.text ?? "";
    expect(content).toContain("recall");
    expect(content).toContain('query: "meeting notes"');
    expect(content).toContain("meeting notes");
  });

  it("MCP prompts/get recall-context with no arguments", async () => {
    const session = await mcpSession();
    const response = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "prompts/get",
        params: {
          name: "recall-context",
          arguments: {},
        },
      },
      session,
    );
    expect(response.response.status).toBe(200);
    const result = response.message as {
      result?: {
        messages?: { role: string; content: { type: string; text: string } }[];
      };
    };
    expect(result.result?.messages).toBeTruthy();
    const content = result.result?.messages?.[0]?.content?.text ?? "";
    expect(content).toContain("recall");
    expect(content).toContain("current conversation");
  });

  it("MCP prompts/get save-session-notes with project_id", async () => {
    const session = await mcpSession();
    const response = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "prompts/get",
        params: {
          name: "save-session-notes",
          arguments: { project_id: "test-project-id" },
        },
      },
      session,
    );
    expect(response.response.status).toBe(200);
    const result = response.message as {
      result?: {
        messages?: { role: string; content: { type: string; text: string } }[];
      };
    };
    expect(result.result?.messages).toBeTruthy();
    const content = result.result?.messages?.[0]?.content?.text ?? "";
    expect(content).toContain("record_fact");
    expect(content).toContain("remember");
    expect(content).toContain("create_task");
    expect(content).toContain("test-project-id");
    expect(content).toContain("well-curated memories");
  });

  it("MCP prompts/get save-session-notes with no arguments", async () => {
    const session = await mcpSession();
    const response = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "prompts/get",
        params: {
          name: "save-session-notes",
          arguments: {},
        },
      },
      session,
    );
    expect(response.response.status).toBe(200);
    const result = response.message as {
      result?: {
        messages?: { role: string; content: { type: string; text: string } }[];
      };
    };
    expect(result.result?.messages).toBeTruthy();
    const content = result.result?.messages?.[0]?.content?.text ?? "";
    expect(content).toContain("record_fact");
    expect(content).toContain("remember");
    expect(content).toContain("create_task");
    expect(content).not.toContain("Scope all new records to project");
    expect(content).toContain("well-curated memories");
  });

  it("existing tools/list still includes ping and memory-model tools", async () => {
    const session = await mcpSession();
    const response = await mcpRequest(
      { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} },
      session,
    );
    expect(response.response.status).toBe(200);
    const names = (
      response.message as { result?: { tools?: { name: string }[] } }
    ).result?.tools?.map((tool) => tool.name);
    expect(names).toContain("ping");
    expect(names).toEqual(
      expect.arrayContaining([
        "remember",
        "record_fact",
        "update_fact",
        "add_document",
        "update_document",
        "recall",
        "create_task",
        "update_task",
        "list_tasks",
        "record_time_series_point",
        "list_time_series_points",
        "upsert_person",
        "list_people",
        "create_project",
        "list_projects",
        "link",
      ]),
    );
  });
});
