import { applyD1Migrations, env, SELF } from "cloudflare:test";
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
  setShared,
  updateDocument,
  updateFact,
  updateTask,
  upsertPerson,
} from "../src/memory";

const TOKEN_A = "memory-token-a";
const TOKEN_B = "memory-token-b";
const TOKEN_SHARED_A = "memory-token-shared-a";
const TOKEN_SHARED_B = "memory-token-shared-b";
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

function dependencyGraphMigrationSql() {
  const migration = (
    env.TEST_MIGRATIONS as unknown as Array<{ name?: string; queries?: string[] }>
  ).find((m) => m.name?.includes("0003_dependency_graph"));
  if (!migration) throw new Error("0003_dependency_graph migration not found");
  return migration.queries?.join("\n") ?? "";
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

  it("creates projects, global people, tasks, thoughts with provenance and scoped non-person links", async () => {
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

    const peopleForOtherUser = await json<{ id: string }[]>(
      await authFetch("/api/v1/people", {}, TOKEN_B),
    );
    expect(peopleForOtherUser.map((p) => p.id)).toContain(person.id);

    const updatedByOtherUser = await json<{ id: string; name: string; ownerId: string }>(
      await authFetch(
        "/api/v1/people",
        {
          method: "POST",
          body: JSON.stringify({ id: person.id, name: "Sarah Global", notes: "shared pool" }),
        },
        TOKEN_B,
      ),
    );
    expect(updatedByOtherUser).toMatchObject({
      id: person.id,
      name: "Sarah Global",
      ownerId: "user-memory-a",
    });

    const peopleForOriginalUser = await json<{ id: string; name: string }[]>(
      await authFetch("/api/v1/people"),
    );
    expect(peopleForOriginalUser).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: person.id, name: "Sarah Global" })]),
    );

    const crossUserSelf = await json<{ self_person_id: string; self_person: { id: string } }>(
      await authFetch(
        "/api/v1/whoami",
        {
          method: "PATCH",
          body: JSON.stringify({ self_person_id: person.id }),
        },
        TOKEN_B,
      ),
    );
    expect(crossUserSelf.self_person_id).toBe(person.id);
    expect(crossUserSelf.self_person.id).toBe(person.id);

    const whoamiOtherUser = await json<{ self_person_id: string; self_person: { id: string } }>(
      await authFetch("/api/v1/whoami", {}, TOKEN_B),
    );
    expect(whoamiOtherUser.self_person_id).toBe(person.id);
    expect(whoamiOtherUser.self_person.id).toBe(person.id);

    const otherUserThought = await json<{ id: string; ownerId: string }>(
      await authFetch(
        "/api/v1/thoughts",
        {
          method: "POST",
          body: JSON.stringify({
            content: "Other user can reference the same global person",
            links: { people_ids: [person.id] },
          }),
        },
        TOKEN_B,
      ),
    );
    expect(otherUserThought.ownerId).toBe("user-memory-b");
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(dependencyEdges)
          .where(
            and(
              eq(dependencyEdges.ownerId, "user-memory-b"),
              eq(dependencyEdges.dependentId, otherUserThought.id),
              eq(dependencyEdges.dependencyId, person.id),
              eq(dependencyEdges.relationship, "references"),
            ),
          )
      )[0],
    ).toBeTruthy();

    const clearOtherSelf = await authFetch(
      "/api/v1/whoami",
      {
        method: "PATCH",
        body: JSON.stringify({ self_person_id: null }),
      },
      TOKEN_B,
    );
    expect(clearOtherSelf.status).toBe(200);

    const otherUserPersonDependencies = await json<{ dependentId: string; dependencyId: string }[]>(
      await authFetch(
        `/api/v1/dependencies?entity_kind=person&entity_id=${person.id}&direction=downstream`,
        {},
        TOKEN_B,
      ),
    );
    expect(otherUserPersonDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependentId: otherUserThought.id, dependencyId: person.id }),
      ]),
    );

    const otherUserPersonPoint = await json<{ id: string; subjectType: string; subjectId: string }>(
      await authFetch(
        "/api/v1/time-series-points",
        {
          method: "POST",
          body: JSON.stringify({
            series_key: "person.interaction_count",
            value: 1,
            subject_type: "person",
            subject_id: person.id,
          }),
        },
        TOKEN_B,
      ),
    );
    expect(otherUserPersonPoint).toMatchObject({ subjectType: "person", subjectId: person.id });

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
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.dependentId, thought.id),
            eq(dependencyEdges.dependencyId, person.id),
            eq(dependencyEdges.relationship, "references"),
          ),
        )
    )[0];
    expect(link).toBeTruthy();

    const reject = await authFetch(
      "/api/v1/thoughts",
      {
        method: "POST",
        body: JSON.stringify({ content: "bad cross link", links: { task_ids: [task.id] } }),
      },
      TOKEN_B,
    );
    expect(reject.status).toBe(404);
  });

  it("links thoughts to time-series points via remember(..., links.time_series_point_ids)", async () => {
    // Create a time-series point owned by user A
    const point = await json<{ id: string; ownerId: string }>(
      await authFetch("/api/v1/time-series-points", {
        method: "POST",
        body: JSON.stringify({
          series_key: "dummy.test",
          value: 42,
          unit: "units",
          observed_at: 1_800_000_000,
        }),
      }),
    );
    expect(point.ownerId).toBe("user-memory-a");

    // Create a thought linked to the time-series point via links
    const thought = await json<{ id: string }>(
      await authFetch("/api/v1/thoughts", {
        method: "POST",
        body: JSON.stringify({
          content: "Linked to a time-series point",
          links: { time_series_point_ids: [point.id] },
        }),
      }),
    );

    // Verify the dependency_edges row
    const edges = await createDb(env.DB)
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.dependentId, thought.id),
          eq(dependencyEdges.dependencyId, point.id),
          eq(dependencyEdges.relationship, "references"),
        ),
      );
    expect(edges).toEqual([
      expect.objectContaining({
        dependentKind: "thought",
        dependencyKind: "time_series_point",
        ownerId: "user-memory-a",
      }),
    ]);
  });

  it("links time-series points to an existing thought via the link endpoint", async () => {
    const point = await json<{ id: string }>(
      await authFetch("/api/v1/time-series-points", {
        method: "POST",
        body: JSON.stringify({
          series_key: "dummy.test",
          value: 1,
          observed_at: 1_800_000_000,
        }),
      }),
    );

    const thought = await json<{ id: string }>(
      await authFetch("/api/v1/thoughts", {
        method: "POST",
        body: JSON.stringify({ content: "Thought to be linked" }),
      }),
    );

    // Link the existing thought to the time-series point
    const linkResult = await json<{ ok: boolean }>(
      await authFetch(`/api/v1/thoughts/${thought.id}/links`, {
        method: "POST",
        body: JSON.stringify({ time_series_point_ids: [point.id] }),
      }),
    );
    expect(linkResult.ok).toBe(true);

    const edges = await createDb(env.DB)
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.dependentId, thought.id),
          eq(dependencyEdges.dependencyId, point.id),
          eq(dependencyEdges.relationship, "references"),
        ),
      );
    expect(edges).toEqual([
      expect.objectContaining({
        dependentKind: "thought",
        dependencyKind: "time_series_point",
      }),
    ]);
  });

  it("rejects cross-owner private time-series point links via remember", async () => {
    // User A creates a time-series point (not shared)
    const point = await json<{ id: string }>(
      await authFetch("/api/v1/time-series-points", {
        method: "POST",
        body: JSON.stringify({
          series_key: "dummy.private",
          value: 99,
          observed_at: 1_800_000_000,
        }),
      }),
    );

    // User B tries to link to User A's private time-series point
    const reject = await authFetch(
      "/api/v1/thoughts",
      {
        method: "POST",
        body: JSON.stringify({
          content: "Cross-owner link attempt",
          links: { time_series_point_ids: [point.id] },
        }),
      },
      TOKEN_B,
    );
    expect(reject.status).toBe(404);
  });

  it("rejects cross-owner private time-series point links via link endpoint", async () => {
    // User A creates a time-series point (not shared)
    const point = await json<{ id: string }>(
      await authFetch("/api/v1/time-series-points", {
        method: "POST",
        body: JSON.stringify({
          series_key: "dummy.private",
          value: 88,
          observed_at: 1_800_000_000,
        }),
      }),
    );

    // User B creates their own thought
    const thought = await json<{ id: string }>(
      await authFetch(
        "/api/v1/thoughts",
        {
          method: "POST",
          body: JSON.stringify({ content: "B's thought" }),
        },
        TOKEN_B,
      ),
    );

    // User B tries to link to User A's private time-series point
    const reject = await authFetch(
      `/api/v1/thoughts/${thought.id}/links`,
      {
        method: "POST",
        body: JSON.stringify({ time_series_point_ids: [point.id] }),
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
          .from(dependencyEdges)
          .where(
            and(
              eq(dependencyEdges.dependentId, fact.id),
              eq(dependencyEdges.dependencyId, thought.id),
              eq(dependencyEdges.relationship, "derived_from"),
            ),
          )
      )[0],
    ).toBeTruthy();
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(dependencyEdges)
          .where(
            and(
              eq(dependencyEdges.dependentId, fact.id),
              eq(dependencyEdges.dependencyId, base.id),
              eq(dependencyEdges.relationship, "derived_from"),
            ),
          )
      )[0],
    ).toBeTruthy();
    const old = (await createDb(env.DB).select().from(facts).where(eq(facts.id, base.id)))[0];
    expect(old).toBeTruthy();
    if (!old) throw new Error("old fact missing");
    expect(old.status).toBe("superseded");
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(dependencyEdges)
          .where(
            and(
              eq(dependencyEdges.dependentId, fact.id),
              eq(dependencyEdges.dependencyId, base.id),
              eq(dependencyEdges.relationship, "supersedes"),
            ),
          )
      )[0],
    ).toBeTruthy();

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
    const supersedesEdge = async (dependentId: string, dependencyId: string) =>
      (
        await db
          .select()
          .from(dependencyEdges)
          .where(
            and(
              eq(dependencyEdges.dependentId, dependentId),
              eq(dependencyEdges.dependencyId, dependencyId),
              eq(dependencyEdges.relationship, "supersedes"),
            ),
          )
      )[0];
    await getFact(olderA.id);
    await getFact(olderB.id);
    expect(await supersedesEdge(newer.id, olderA.id)).toBeUndefined();
    expect(await supersedesEdge(newer.id, olderB.id)).toBeTruthy();

    await json(
      await authFetch(`/api/v1/facts/${newer.id}`, {
        method: "PATCH",
        body: JSON.stringify({ supersedes_fact_id: null }),
      }),
    );

    await getFact(newer.id);
    await getFact(olderB.id);
    expect(await supersedesEdge(newer.id, olderB.id)).toBeUndefined();

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

    await getFact(olderA.id);
    await getFact(newest.id);
    expect(await supersedesEdge(newest.id, olderA.id)).toBeTruthy();

    await json(
      await authFetch(`/api/v1/facts/${olderA.id}`, {
        method: "PATCH",
        body: JSON.stringify({ superseded_by_fact_id: null }),
      }),
    );

    await getFact(olderA.id);
    await getFact(newest.id);
    expect(await supersedesEdge(newest.id, olderA.id)).toBeUndefined();
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

  it("document overwrite mode creates no historical version", async () => {
    const doc = await json<{ id: string; currentVersionNumber: number }>(
      await authFetch("/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({ title: "Overwrite", content: "first body" }),
      }),
    );
    expect(doc.currentVersionNumber).toBeUndefined();

    const updated = await json<{ currentVersionNumber: number; sizeBytes: number }>(
      await authFetch(`/api/v1/documents/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: "second body", write_mode: "overwrite_current" }),
      }),
    );
    expect(updated.currentVersionNumber).toBe(1);
    expect(
      await createDb(env.DB)
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id)),
    ).toHaveLength(0);
  });

  it("rejects malformed REST document write_mode values", async () => {
    const doc = await json<{ id: string }>(
      await authFetch("/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({ title: "Bad mode", content: "first body" }),
      }),
    );

    const response = await authFetch(`/api/v1/documents/${doc.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: "second body", write_mode: 42 }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid document write_mode" });
    const content = await authFetch(`/api/v1/documents/${doc.id}/content`);
    expect(await content.text()).toContain("first body");
    expect(
      await createDb(env.DB)
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id)),
    ).toHaveLength(0);
  });

  it("create_version preserves previous text and keeps current chunks/recall current-only", async () => {
    const doc = await json<{ id: string }>(
      await authFetch("/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({
          title: "Versioned",
          content: "old historical-only zephyr keyword",
        }),
      }),
    );
    const updated = await json<{ currentVersionNumber: number }>(
      await authFetch(`/api/v1/documents/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          content: "new current-only aurora keyword",
          write_mode: "create_version",
        }),
      }),
    );
    expect(updated.currentVersionNumber).toBe(2);
    const afterUpdate = (
      await createDb(env.DB).select().from(documents).where(eq(documents.id, doc.id))
    )[0];
    if (!afterUpdate) throw new Error("expected updated document");
    const versions = await json<
      Array<{ id?: string; is_current: boolean; version_number: number; r2Key?: string }>
    >(await authFetch(`/api/v1/documents/${doc.id}/versions`));
    expect(versions.map((v) => v.version_number)).toEqual([2, 1]);
    expect(versions.every((v) => v.r2Key === undefined)).toBe(true);
    const historical = versions.find((v) => !v.is_current);
    expect(historical?.id?.endsWith("d")).toBe(true);

    const previous = await authFetch(`/api/v1/documents/${doc.id}/versions/1/content`);
    expect(previous.status).toBe(200);
    expect(await previous.text()).toContain("old historical-only zephyr");
    const afterRead = (
      await createDb(env.DB).select().from(documents).where(eq(documents.id, doc.id))
    )[0];
    if (!afterRead) throw new Error("expected document after version read");
    expect(afterRead.updatedAt?.getTime()).toBe(afterUpdate.updatedAt?.getTime());

    const chunks = await json<{ content: string }[]>(
      await authFetch(`/api/v1/documents/${doc.id}/chunks`),
    );
    expect(chunks.map((c) => c.content).join("\n")).toContain("new current-only aurora");
    expect(chunks.map((c) => c.content).join("\n")).not.toContain("old historical-only zephyr");
    const recalledOld = await json<{ kind: string }[]>(
      await authFetch("/api/v1/recall?q=zephyr%20keyword&kinds=document_chunk"),
    );
    expect(recalledOld.some((r) => r.kind === "document_chunk")).toBe(false);
  });

  it("deleting a versioned document cascades version rows and removes historical R2 bytes", async () => {
    const doc = await json<{ id: string }>(
      await authFetch("/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({ title: "Delete versions", content: "historical content" }),
      }),
    );
    await json(
      await authFetch(`/api/v1/documents/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: "current content", write_mode: "create_version" }),
      }),
    );
    const version = (
      await createDb(env.DB)
        .select({ r2Key: documentVersions.r2Key })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id))
    )[0];
    if (!version) throw new Error("expected historical version row");
    expect(await env.DOCUMENTS.get(version.r2Key)).not.toBeNull();

    await json(await authFetch(`/api/v1/documents/${doc.id}`, { method: "DELETE" }));

    expect(
      await createDb(env.DB)
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id)),
    ).toHaveLength(0);
    expect(await env.DOCUMENTS.get(version.r2Key)).toBeNull();
  });

  it("document versions enforce owner/private reads and allow shared reads", async () => {
    const doc = await json<{ id: string }>(
      await authFetch("/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({ title: "Private versions", content: "private v1" }),
      }),
    );
    await json(
      await authFetch(`/api/v1/documents/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: "private v2", write_mode: "create_version" }),
      }),
    );
    expect((await authFetch(`/api/v1/documents/${doc.id}/versions`, {}, TOKEN_B)).status).toBe(404);
    expect(
      (await authFetch(`/api/v1/documents/${doc.id}/versions/1/content`, {}, TOKEN_B)).status,
    ).toBe(404);
    expect(
      (
        await authFetch(
          `/api/v1/documents/${doc.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({ content: "bad", write_mode: "create_version" }),
          },
          TOKEN_B,
        )
      ).status,
    ).toBe(404);
    await setShared(
      { env, user: { id: "user-memory-a", name: "Memory A" } },
      {
        entity_kind: "document",
        entity_id: doc.id,
        shared: true,
      },
    );
    expect((await authFetch(`/api/v1/documents/${doc.id}/versions`, {}, TOKEN_B)).status).toBe(200);
    expect(
      (await authFetch(`/api/v1/documents/${doc.id}/versions/1/content`, {}, TOKEN_B)).status,
    ).toBe(200);
  });

  it("direct text upload stores R2 bytes, chunks them, and supports recall", async () => {
    const body = new TextEncoder().encode("Direct text upload has a recallable nebula keyword.");
    const doc = await json<{ id: string; r2Key: string; source: string; ownerId: string }>(
      await authFetch(
        "/api/v1/documents/direct-upload?title=Direct%20Text&mime_type=text%2Fplain&filename=direct.txt",
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body,
        },
      ),
    );
    expect(doc.ownerId).toBe("user-memory-a");
    expect(doc.source).toBe("rest:api");
    expect(doc.r2Key).toContain(`${doc.id}.txt`);

    const chunks = await json<{ id: string; content: string }[]>(
      await authFetch(`/api/v1/documents/${doc.id}/chunks`),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.content).toContain("nebula keyword");

    const recalled = await json<{ kind: string; row: { document?: { id: string } } }[]>(
      await authFetch("/api/v1/recall?q=nebula%20keyword&kinds=document_chunk"),
    );
    expect(recalled.some((r) => r.kind === "document_chunk" && r.row.document?.id === doc.id)).toBe(
      true,
    );
  });

  it("direct binary upload creates no chunks and downloads exact bytes with owner scoping", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255, 1, 2, 3, 4]);
    const doc = await json<{ id: string; mimeType: string; sizeBytes: number }>(
      await authFetch(
        "/api/v1/documents/direct-upload?title=Archive&mime_type=application%2Fzip&filename=backup.zip",
        {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: bytes,
        },
      ),
    );
    expect(doc.mimeType).toBe("application/zip");
    expect(doc.sizeBytes).toBe(bytes.byteLength);
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(documentChunks)
          .where(eq(documentChunks.documentId, doc.id))
      ).length,
    ).toBe(0);

    const denied = await authFetch(`/api/v1/documents/${doc.id}/download`, {}, TOKEN_B);
    expect(denied.status).toBe(404);

    const download = await authFetch(`/api/v1/documents/${doc.id}/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/zip");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  });

  it("binary historical version downloads exact previous bytes", async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0, 1, 2]);
    const doc = await json<{ id: string }>(
      await authFetch(
        "/api/v1/documents/direct-upload?title=Binary%20Version&mime_type=application%2Foctet-stream&filename=backup.bin",
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: bytes,
        },
      ),
    );
    await json(
      await authFetch(`/api/v1/documents/${doc.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content: "new opaque current", write_mode: "create_version" }),
      }),
    );
    const textRoute = await authFetch(`/api/v1/documents/${doc.id}/versions/1/content`);
    expect(textRoute.status).toBe(400);
    const download = await authFetch(`/api/v1/documents/${doc.id}/versions/1/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/octet-stream");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  });

  it("direct upload validates project ownership", async () => {
    const otherProject = await json<{ id: string }>(
      await authFetch(
        "/api/v1/projects",
        { method: "POST", body: JSON.stringify({ name: "Other project" }) },
        TOKEN_B,
      ),
    );
    const response = await authFetch(
      `/api/v1/documents/direct-upload?title=Bad&project_id=${otherProject.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(response.status).toBe(404);
  });

  it("update_document preserves stale chunk-derived dependencies without dangling chunk edges", async () => {
    const ctx = { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" };
    const doc = await addDocument(ctx, {
      title: "Chunk source update",
      content: "chunk source body",
    });
    const oldChunk = (
      await createDb(env.DB)
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, doc.id))
    )[0];
    if (!oldChunk) throw new Error("expected document chunk");
    const fact = await recordFact(ctx, {
      statement: "Fact derived from a soon-to-be-replaced chunk",
      derived_from: { document_chunk_ids: [oldChunk.id] },
    });

    await updateDocument(ctx, doc.id, "replacement body with replacement chunks");

    const db = createDb(env.DB);
    expect(
      await db
        .select()
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.dependencyKind, "document_chunk"),
            eq(dependencyEdges.dependencyId, oldChunk.id),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.dependentKind, "document_chunk"),
            eq(dependencyEdges.dependentId, oldChunk.id),
          ),
        ),
    ).toHaveLength(0);

    const retargeted = (
      await db
        .select()
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.dependentKind, "fact"),
            eq(dependencyEdges.dependentId, fact.id),
            eq(dependencyEdges.dependencyKind, "document"),
            eq(dependencyEdges.dependencyId, doc.id),
            eq(dependencyEdges.relationship, "derived_from"),
          ),
        )
    )[0];
    expect(retargeted).toBeTruthy();
    expect(retargeted?.staleAt).not.toBeNull();
    expect(retargeted?.staleReason).toBe("document_chunks_replaced");
  });

  it("delete_document removes graph edges touching deleted document chunks", async () => {
    const ctx = { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" };
    const doc = await addDocument(ctx, {
      title: "Chunk source delete",
      content: "delete chunk source body",
    });
    const chunk = (
      await createDb(env.DB)
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, doc.id))
    )[0];
    if (!chunk) throw new Error("expected document chunk");
    const fact = await recordFact(ctx, {
      statement: "Fact derived from a soon-to-be-deleted chunk",
      derived_from: { document_chunk_ids: [chunk.id] },
    });

    await deleteDocument(ctx, doc.id);

    const db = createDb(env.DB);
    expect(
      await db
        .select()
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.dependencyKind, "document_chunk"),
            eq(dependencyEdges.dependencyId, chunk.id),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.dependentKind, "document_chunk"),
            eq(dependencyEdges.dependentId, chunk.id),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.dependentKind, "fact"),
            eq(dependencyEdges.dependentId, fact.id),
            eq(dependencyEdges.dependencyId, chunk.id),
          ),
        ),
    ).toHaveLength(0);
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

    const subjectFiltered = await json<{ id: string; subjectType: string; subjectId: string }[]>(
      await authFetch(
        `/api/v1/time-series-points?subject_type=task&subject_id=${task.id}&series_key=build.duration_ms`,
      ),
    );
    expect(subjectFiltered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: point.id, subjectType: "task", subjectId: task.id }),
      ]),
    );
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(dependencyEdges)
          .where(
            and(
              eq(dependencyEdges.dependentId, point.id),
              eq(dependencyEdges.dependencyId, task.id),
              eq(dependencyEdges.relationship, "observes_subject"),
            ),
          )
      )[0],
    ).toBeTruthy();
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(timeSeriesPoints)
          .where(eq(timeSeriesPoints.id, point.id))
      )[0],
    ).not.toHaveProperty("subjectType");

    const otherUsersPoints = await json<unknown[]>(
      await authFetch("/api/v1/time-series-points?series_key=build.duration_ms", {}, TOKEN_B),
    );
    expect(otherUsersPoints).toEqual([]);
  });

  it("bulk inserts multiple time-series points in a single batch", async () => {
    const points = (await json(
      await authFetch("/api/v1/time-series-points/batch", {
        method: "POST",
        body: JSON.stringify({
          points: [
            {
              series_key: "electricity.before",
              value: 375,
              unit: "kWh",
              observed_at: 1_800_000_000,
              metadata: { topology: "meter1" },
            },
            {
              series_key: "electricity.after",
              value: 583,
              unit: "kWh",
              observed_at: 1_800_000_000,
              metadata: { topology: "meter1" },
            },
            {
              series_key: "electricity.spent",
              value: 208,
              unit: "kWh",
              observed_at: 1_800_000_000,
            },
          ],
        }),
      }),
    )) as Array<{
      id: string;
      ownerId: string;
      source: string;
      seriesKey: string;
      value: number | null;
      unit: string | null;
      metadata: Record<string, unknown>;
    }>;

    expect(points).toHaveLength(3);
    const [p0, p1, p2] = points;
    if (!p0 || !p1 || !p2) {
      throw new Error("Expected 3 points");
    }
    expect(p0.ownerId).toBe("user-memory-a");
    expect(p0.source).toBe("rest:api");
    expect(p0.seriesKey).toBe("electricity.before");
    expect(p0.value).toBe(375);
    expect(p1.seriesKey).toBe("electricity.after");
    expect(p2.seriesKey).toBe("electricity.spent");
  });

  it("rejects bulk insert if any point has invalid project_id", async () => {
    const response = await authFetch("/api/v1/time-series-points/batch", {
      method: "POST",
      body: JSON.stringify({
        points: [
          {
            series_key: "bulk.test.before",
            value: 375,
            observed_at: 1_800_000_000,
          },
          {
            series_key: "bulk.test.after",
            value: 583,
            project_id: `bf${"0".repeat(20)}r`, // Invalid project ID
            observed_at: 1_800_000_000,
          },
        ],
      }),
    });

    expect(response.status).toBe(404);
    // Verify no points were inserted
    const allPoints = await json<Array<{ seriesKey: string }>>(
      await authFetch("/api/v1/time-series-points"),
    );
    const bulkTest = allPoints.filter((p) => p.seriesKey.startsWith("bulk.test."));
    expect(bulkTest).toHaveLength(0);
  });

  it("filters time-series points by series_prefix", async () => {
    // Insert points with different namespaces
    const uniqueSuffix = Date.now();
    await json(
      await authFetch("/api/v1/time-series-points/batch", {
        method: "POST",
        body: JSON.stringify({
          points: [
            {
              series_key: `ptest.electricity${uniqueSuffix}.before`,
              value: 100,
              observed_at: 1_800_000_000,
            },
            {
              series_key: `ptest.electricity${uniqueSuffix}.after`,
              value: 200,
              observed_at: 1_800_000_000,
            },
            {
              series_key: `ptest.electricity${uniqueSuffix}.spent`,
              value: 100,
              observed_at: 1_800_000_000,
            },
            {
              series_key: `ptest.sleep${uniqueSuffix}.hours`,
              value: 8,
              observed_at: 1_800_000_000,
            },
            {
              series_key: `ptest.sleep${uniqueSuffix}.quality`,
              value: 0.8,
              observed_at: 1_800_000_000,
            },
          ],
        }),
      }),
    );

    // Query by prefix
    const electricityPoints = await json<Array<{ seriesKey: string }>>(
      await authFetch(`/api/v1/time-series-points?series_prefix=ptest.electricity${uniqueSuffix}`),
    );
    expect(electricityPoints).toHaveLength(3);
    expect(
      electricityPoints.every((p) => p.seriesKey.startsWith(`ptest.electricity${uniqueSuffix}.`)),
    ).toBe(true);

    const sleepPoints = await json<Array<{ seriesKey: string }>>(
      await authFetch(`/api/v1/time-series-points?series_prefix=ptest.sleep${uniqueSuffix}`),
    );
    expect(sleepPoints).toHaveLength(2);
    expect(sleepPoints.every((p) => p.seriesKey.startsWith(`ptest.sleep${uniqueSuffix}.`))).toBe(
      true,
    );
  });

  it("rejects list if both series_key and series_prefix are supplied", async () => {
    const response = await authFetch(
      "/api/v1/time-series-points?series_key=electricity.before&series_prefix=electricity",
    );
    expect(response.status).toBe(400);
  });

  it("rejects series_prefix if it contains SQL wildcards", async () => {
    const response = await authFetch("/api/v1/time-series-points?series_prefix=electric%");
    expect(response.status).toBe(400);

    const response2 = await authFetch("/api/v1/time-series-points?series_prefix=electric_");
    expect(response2.status).toBe(400);
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

  it("normalizes blank project_id to global scope for service memory writes", async () => {
    const ctx = { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" };
    const thought = await remember(ctx, {
      content: "blank project id should be global",
      project_id: "",
    });

    expect(thought.projectId).toBeNull();
    const rows = await createDb(env.DB).select().from(thoughts).where(eq(thoughts.id, thought.id));
    expect(rows[0]?.projectId).toBeNull();
  });

  it("MCP remember rejects empty project_id before persistence", async () => {
    const session = await mcpSession();
    const result = await mcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "remember",
          arguments: { content: "MCP empty project id should not persist", project_id: "" },
        },
      },
      session,
    );

    expect(result.response.status).toBe(200);
    const text = (result.message as { result?: { content?: { text?: string }[] } }).result
      ?.content?.[0]?.text;
    expect(text).toContain("MCP error");
    const rows = await createDb(env.DB)
      .select()
      .from(thoughts)
      .where(eq(thoughts.content, "MCP empty project id should not persist"));
    expect(rows).toHaveLength(0);
  });

  it("MCP link tool can link a thought to a time-series point", async () => {
    // Create a time-series point via REST
    const point = await json<{ id: string }>(
      await authFetch("/api/v1/time-series-points", {
        method: "POST",
        body: JSON.stringify({
          series_key: "mcp.link.test",
          value: 7,
          observed_at: 1_800_000_000,
        }),
      }),
    );

    // Create a thought via MCP
    const thought = await callMcpTool<{ id: string }>("remember", {
      content: "MCP thought for time-series link test",
    });

    // Link the thought to the time-series point via MCP link tool
    const linkResult = await callMcpTool<{ ok: boolean }>("link", {
      thought_id: thought.id,
      links: { time_series_point_ids: [point.id] },
    });
    expect(linkResult.ok).toBe(true);

    // Verify the dependency edge via direct DB query
    const edges = await createDb(env.DB)
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.dependentId, thought.id),
          eq(dependencyEdges.dependencyId, point.id),
          eq(dependencyEdges.relationship, "references"),
        ),
      );
    expect(edges).toEqual([
      expect.objectContaining({
        dependentKind: "thought",
        dependencyKind: "time_series_point",
        source: "mcp:tool",
      }),
    ]);
  });

  it("MCP remember tool with links.time_series_point_ids creates a references edge", async () => {
    // Create a time-series point via REST
    const point = await json<{ id: string }>(
      await authFetch("/api/v1/time-series-points", {
        method: "POST",
        body: JSON.stringify({
          series_key: "mcp.remember.test",
          value: 3,
          observed_at: 1_800_000_000,
        }),
      }),
    );

    // Create a thought via MCP remember with time_series_point_ids in links
    const thought = await callMcpTool<{ id: string }>("remember", {
      content: "MCP thought with time-series link in remember",
      links: { time_series_point_ids: [point.id] },
    });

    // Verify the dependency edge via direct DB query
    const edges = await createDb(env.DB)
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.dependentId, thought.id),
          eq(dependencyEdges.dependencyId, point.id),
          eq(dependencyEdges.relationship, "references"),
        ),
      );
    expect(edges).toEqual([
      expect.objectContaining({
        dependentKind: "thought",
        dependencyKind: "time_series_point",
        source: "mcp:tool",
      }),
    ]);
  });

  it("whoami MCP tool mirrors the REST /api/v1/whoami service layer", async () => {
    const restWhoami = await json<{
      id: string;
      name: string;
      self_person_id: string | null;
      self_person: { id: string } | null;
    }>(await authFetch("/api/v1/whoami"));

    const mcpWhoami = await callMcpTool<typeof restWhoami>("whoami", {});
    expect(mcpWhoami).toEqual(restWhoami);
    expect(mcpWhoami.id).toBe("user-memory-a");
    expect(mcpWhoami.name).toBe("Memory A");
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
        "create_document_upload_link",
        "create_document_download_link",
        "recall",
        "create_task",
        "update_task",
        "list_tasks",
        "record_time_series_point",
        "list_time_series_points",
        "upsert_person",
        "list_people",
        "whoami",
        "create_project",
        "list_projects",
        "link",
        "create_dependency",
        "delete_dependency",
        "list_dependencies",
        "mark_stale",
        "list_stale",
      ]),
    );
  });

  it("mirrors dependency graph tools through REST with owner scope and staleness", async () => {
    const thought = await json<{ id: string }>(
      await authFetch("/api/v1/thoughts", {
        method: "POST",
        body: JSON.stringify({ content: "graph upstream thought" }),
      }),
    );
    const doc = await json<{ id: string }>(
      await authFetch("/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({
          title: "Generated graph doc",
          content: "derived document",
          derived_from: { thought_ids: [thought.id] },
        }),
      }),
    );

    const upstream = await json<{ id: string; relationship: string }[]>(
      await authFetch(
        `/api/v1/dependencies?entity_kind=document&entity_id=${doc.id}&direction=upstream`,
      ),
    );
    expect(upstream).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependencyId: thought.id, relationship: "derived_from" }),
      ]),
    );
    expect(upstream[0]?.id).toMatch(/^bf[0-9abcdefghjkmnpqrstvwxyz]{20}e$/);

    const downstream = await json<
      { dependentId: string; dependentKind: string; relationship: string }[]
    >(
      await authFetch(
        `/api/v1/dependencies?entity_kind=thought&entity_id=${thought.id}&direction=downstream`,
      ),
    );
    expect(downstream).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dependentKind: "document",
          dependentId: doc.id,
          relationship: "derived_from",
        }),
      ]),
    );

    await updateDocument(
      { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
      doc.id,
      "updated derived document",
    );
    const staleAfterDocumentUpdate = await json<unknown[]>(
      await authFetch("/api/v1/dependencies/stale?kind=document"),
    );
    expect(staleAfterDocumentUpdate).toEqual([]);

    const stale = await json<{ dependentId: string; dependencyId: string; staleReason: string }[]>(
      await authFetch("/api/v1/dependencies/stale", {
        method: "POST",
        body: JSON.stringify({
          entity_kind: "thought",
          entity_id: thought.id,
          reason: "source_changed",
        }),
      }),
    );
    expect(stale).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dependentId: doc.id,
          dependencyId: thought.id,
          staleReason: "source_changed",
        }),
      ]),
    );

    const weakDependent = await json<{ id: string }>(
      await authFetch("/api/v1/thoughts", {
        method: "POST",
        body: JSON.stringify({ content: "weak downstream reference" }),
      }),
    );
    const weakDependency = await json<{ id: string }>(
      await authFetch("/api/v1/people", {
        method: "POST",
        body: JSON.stringify({ name: "Weak Reference Person" }),
      }),
    );
    await json(
      await authFetch("/api/v1/dependencies", {
        method: "POST",
        body: JSON.stringify({
          dependent: { kind: "thought", id: weakDependent.id },
          dependency: { kind: "person", id: weakDependency.id },
          relationship: "references",
        }),
      }),
    );
    await upsertPerson(
      { env, user: { id: "user-memory-a", name: "Memory A" }, source: "test:service" },
      { id: weakDependency.id, name: "Weak Reference Person Updated" },
    );
    const weakBeforeExplicit = (
      await createDb(env.DB)
        .select()
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.dependentId, weakDependent.id),
            eq(dependencyEdges.dependencyId, weakDependency.id),
            eq(dependencyEdges.relationship, "references"),
          ),
        )
    )[0];
    expect(weakBeforeExplicit?.staleAt).toBeNull();

    const explicitWeakStale = await json<{ dependentId: string; relationship: string }[]>(
      await authFetch("/api/v1/dependencies/stale", {
        method: "POST",
        body: JSON.stringify({
          entity_kind: "person",
          entity_id: weakDependency.id,
          reason: "explicit_weak_review",
        }),
      }),
    );
    expect(explicitWeakStale).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dependentId: weakDependent.id, relationship: "references" }),
      ]),
    );

    const otherFact = await json<{ id: string }>(
      await authFetch(
        "/api/v1/facts",
        { method: "POST", body: JSON.stringify({ statement: "other graph fact" }) },
        TOKEN_B,
      ),
    );
    const rejected = await authFetch("/api/v1/dependencies", {
      method: "POST",
      body: JSON.stringify({
        dependent: { kind: "document", id: doc.id },
        dependency: { kind: "fact", id: otherFact.id },
        relationship: "derived_from",
      }),
    });
    expect(rejected.status).toBe(404);

    const rejectedDependent = await authFetch("/api/v1/dependencies", {
      method: "POST",
      body: JSON.stringify({
        dependent: { kind: "fact", id: otherFact.id },
        dependency: { kind: "thought", id: thought.id },
        relationship: "derived_from",
      }),
    });
    expect(rejectedDependent.status).toBe(404);
  });

  it("migration SQL moves pre-graph relationships to dependency_edges and drops redundant shapes", () => {
    const sql = dependencyGraphMigrationSql();

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS `dependency_edges`");
    expect(sql).toMatch(/'references'[\s\S]*FROM thought_people tp JOIN thoughts t/);
    expect(sql).toMatch(/'references'[\s\S]*FROM thought_tasks tt JOIN thoughts t/);
    expect(sql).toMatch(/'references'[\s\S]*FROM thought_facts tf JOIN thoughts t/);
    expect(sql).toMatch(/'references'[\s\S]*FROM thought_documents td JOIN thoughts t/);
    expect(sql).toMatch(/'derived_from'[\s\S]*FROM fact_source_thoughts fst JOIN facts f/);
    expect(sql).toMatch(/'derived_from'[\s\S]*FROM fact_source_facts fsf JOIN facts f/);
    expect(sql).toMatch(/'derived_from'[\s\S]*FROM fact_source_documents fsd JOIN facts f/);
    expect(sql).toMatch(/'derived_from'[\s\S]*FROM fact_source_document_chunks fsc JOIN facts f/);
    expect(sql).toMatch(/'supersedes'[\s\S]*FROM facts nf JOIN facts of/);
    expect(sql).toMatch(/'supersedes'[\s\S]*FROM facts older JOIN facts newer/);
    expect(sql).toMatch(
      /'time_series_point'[\s\S]*'observes_subject'[\s\S]*FROM time_series_points s/,
    );

    for (const dropped of [
      "thought_people",
      "thought_tasks",
      "thought_facts",
      "thought_documents",
      "fact_source_thoughts",
      "fact_source_facts",
      "fact_source_documents",
      "fact_source_document_chunks",
    ]) {
      expect(sql).toContain(`DROP TABLE IF EXISTS \`${dropped}\``);
    }
    expect(sql.match(/CREATE TABLE `facts_new`[^;]+/i)?.[0]).not.toContain("supersedes_fact_id");
    expect(sql.match(/CREATE TABLE `facts_new`[^;]+/i)?.[0]).not.toContain("superseded_by_fact_id");
    expect(sql.match(/CREATE TABLE `time_series_points_new`[^;]+/i)?.[0]).not.toContain(
      "subject_type",
    );
    expect(sql.match(/CREATE TABLE `time_series_points_new`[^;]+/i)?.[0]).not.toContain(
      "subject_id",
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
    expect(
      await createDb(env.DB)
        .select()
        .from(dependencyEdges)
        .where(eq(dependencyEdges.dependencyId, otherDoc.id)),
    ).toHaveLength(0);
    expect(
      await createDb(env.DB)
        .select()
        .from(dependencyEdges)
        .where(eq(dependencyEdges.dependencyId, otherChunk?.id ?? "missing")),
    ).toHaveLength(0);
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

  it("marks all owners' person dependency edges stale when another user updates a global person", async () => {
    const person = await json<{ id: string }>(
      await authFetch("/api/v1/people", {
        method: "POST",
        body: JSON.stringify({ name: "Global Observed Person" }),
      }),
    );
    const thought = await json<{ id: string }>(
      await authFetch("/api/v1/thoughts", {
        method: "POST",
        body: JSON.stringify({ content: "User A observes the global person" }),
      }),
    );
    await json(
      await authFetch("/api/v1/dependencies", {
        method: "POST",
        body: JSON.stringify({
          dependent: { kind: "thought", id: thought.id },
          dependency: { kind: "person", id: person.id },
          relationship: "observes_subject",
        }),
      }),
    );

    await json(
      await authFetch(
        "/api/v1/people",
        {
          method: "POST",
          body: JSON.stringify({ id: person.id, name: "Global Observed Person Updated" }),
        },
        TOKEN_B,
      ),
    );

    const userAEdges = await json<
      {
        dependentId: string;
        dependencyId: string;
        staleAt: number | null;
        staleReason: string | null;
      }[]
    >(
      await authFetch(
        `/api/v1/dependencies?entity_kind=person&entity_id=${person.id}&direction=downstream`,
      ),
    );
    expect(userAEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dependentId: thought.id,
          dependencyId: person.id,
          staleReason: "upstream_updated",
        }),
      ]),
    );
    expect(userAEdges.find((edge) => edge.dependentId === thought.id)?.staleAt).not.toBeNull();

    const userBEdges = await json<unknown[]>(
      await authFetch(
        `/api/v1/dependencies?entity_kind=person&entity_id=${person.id}&direction=downstream`,
        {},
        TOKEN_B,
      ),
    );
    expect(userBEdges).toEqual([]);
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
          .from(dependencyEdges)
          .where(eq(dependencyEdges.dependencyId, ownPerson.id))
      ).length,
    ).toBe(0);
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(dependencyEdges)
          .where(eq(dependencyEdges.dependencyId, otherFact.id))
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
          .from(dependencyEdges)
          .where(eq(dependencyEdges.dependencyId, ownThought.id))
      ).length,
    ).toBe(0);
    expect(
      (
        await createDb(env.DB)
          .select()
          .from(dependencyEdges)
          .where(eq(dependencyEdges.dependencyId, otherFact.id))
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
        "list_document_versions",
        "get_document_version",
        "recall",
        "create_task",
        "update_task",
        "list_tasks",
        "record_time_series_point",
        "record_time_series_points",
        "list_time_series_points",
        "upsert_person",
        "list_people",
        "whoami",
        "create_project",
        "list_projects",
        "link",
        "create_dependency",
        "delete_dependency",
        "list_dependencies",
        "mark_stale",
        "list_stale",
        "set_shared",
      ]),
    );
  });

  it("MCP document transfer tools return authenticated REST instructions without bytes or tokens", async () => {
    const upload = await callMcpTool<{
      url: string;
      method: string;
      headers: Record<string, string>;
      command_example: string;
    }>("create_document_upload_link", {
      title: "MCP Upload",
      filename: "backup.zip",
      mime_type: "application/zip",
    });
    expect(upload.method).toBe("POST");
    expect(upload.url).toContain("/api/v1/documents/direct-upload");
    expect(upload.headers.Authorization).toContain("<your existing brainfog bearer token>");
    expect(upload.command_example).toContain("--data-binary @<path-to-file>");
    // Static template never interpolates caller-supplied values
    expect(upload.command_example).not.toContain("backup.zip");
    expect(upload.command_example).not.toContain("application/zip");
    expect(JSON.stringify(upload)).not.toContain(TOKEN_A);
    expect(JSON.stringify(upload)).not.toContain("UEsDB");

    const doc = await json<{ id: string }>(
      await authFetch(
        "/api/v1/documents/direct-upload?title=MCP%20Download&mime_type=application%2Foctet-stream",
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array([9, 8, 7]),
        },
      ),
    );
    const download = await callMcpTool<{
      url: string;
      method: string;
      headers: Record<string, string>;
      document_id: string;
    }>("create_document_download_link", { document_id: doc.id, filename: "restore.bin" });
    expect(download.method).toBe("GET");
    expect(download.url).toContain(`/api/v1/documents/${doc.id}/download`);
    expect(download.document_id).toBe(doc.id);
    expect(download.headers.Authorization).toContain("<your existing brainfog bearer token>");
    expect(JSON.stringify(download)).not.toContain(TOKEN_A);
  });

  it("MCP document version tools list metadata and return text or download instructions", async () => {
    const doc = await json<{ id: string }>(
      await authFetch("/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({ title: "MCP versions", content: "mcp previous text" }),
      }),
    );
    await callMcpTool("update_document", {
      id: doc.id,
      content: "mcp current text",
      write_mode: "create_version",
    });
    const versions = await callMcpTool<
      Array<{ r2Key?: string; is_current: boolean; version_number: number }>
    >("list_document_versions", { document_id: doc.id });
    expect(versions.map((v) => v.version_number)).toEqual([2, 1]);
    expect(JSON.stringify(versions)).not.toContain("r2Key");
    const previous = await callMcpTool<{ content: string; metadata: { r2Key?: string } }>(
      "get_document_version",
      { document_id: doc.id, version_number: 1 },
    );
    expect(previous.content).toContain("mcp previous text");
    expect(previous.metadata.r2Key).toBeUndefined();

    const binaryDoc = await json<{ id: string }>(
      await authFetch(
        "/api/v1/documents/direct-upload?title=MCP%20binary%20version&mime_type=application%2Foctet-stream",
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array([1, 3, 5]),
        },
      ),
    );
    await callMcpTool("update_document", {
      id: binaryDoc.id,
      content: "opaque replacement",
      write_mode: "create_version",
    });
    const binaryPrevious = await callMcpTool<{
      content: null;
      download: { url: string };
      metadata: object;
    }>("get_document_version", { document_id: binaryDoc.id, version_number: 1 });
    expect(binaryPrevious.content).toBeNull();
    expect(binaryPrevious.download.url).toContain(`/api/v1/documents/${binaryDoc.id}/versions/`);
    expect(JSON.stringify(binaryPrevious)).not.toContain(TOKEN_A);
    expect(JSON.stringify(binaryPrevious)).not.toContain("AQMF");
  });

  it("MCP upload-link command_example is a static template and does not interpolate hostile values", async () => {
    // Hostile filename with shell metacharacters — valid MIME type
    const upload = await callMcpTool<{ command_example: string }>("create_document_upload_link", {
      title: "Normal",
      filename: '"; rm -rf /; echo "',
      mime_type: "text/plain",
    });
    // command_example is a static template — no caller-controlled values appear
    expect(upload.command_example).not.toContain("rm -rf");
    expect(upload.command_example).toContain("<path-to-file>");
    expect(upload.command_example).toContain("<mime-type>");
    expect(upload.command_example).toContain("<title>");

    // Shell backticks in filename
    const upload2 = await callMcpTool<{ command_example: string }>("create_document_upload_link", {
      title: "Normal",
      filename: "`whoami`.txt",
      mime_type: "text/plain",
    });
    expect(upload2.command_example).not.toContain("`whoami`");
    expect(upload2.command_example).toContain("<path-to-file>");

    // $(id) in title
    const upload3 = await callMcpTool<{ command_example: string }>("create_document_upload_link", {
      title: "$(id)",
      filename: "file.txt",
      mime_type: "text/plain",
    });
    expect(upload3.command_example).not.toContain("$(id)");
    expect(upload3.command_example).toContain("<title>");

    // No token leakage
    expect(JSON.stringify(upload)).not.toContain(TOKEN_A);
    expect(JSON.stringify(upload2)).not.toContain(TOKEN_A);
    expect(JSON.stringify(upload3)).not.toContain(TOKEN_A);
  });

  it("MCP download-link command_example is also a safe static template", async () => {
    // Create a document first so the tool succeeds
    const doc = await json<{ id: string }>(
      await authFetch("/api/v1/documents", {
        method: "POST",
        body: JSON.stringify({ title: "DL Template", content: "download template test" }),
      }),
    );
    const download = await callMcpTool<{ command_example: string }>(
      "create_document_download_link",
      { document_id: doc.id, filename: "; rm -rf /; " },
    );
    expect(download.command_example).not.toContain("rm -rf");
    expect(download.command_example).toContain("<output-path>");
    expect(download.command_example).toContain("<document-id>");

    // No token leakage
    expect(JSON.stringify(download)).not.toContain(TOKEN_A);

    // Cleanup
    await authFetch(`/api/v1/documents/${doc.id}`, { method: "DELETE" });
  });

  it("direct upload rejects invalid MIME types with 400", async () => {
    // MIME with double-quote injection attempt
    const resp1 = await authFetch(
      '/api/v1/documents/direct-upload?title=Bad&mime_type=text/plain";%20rm%20-rf',
      {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(resp1.status).toBe(400);

    // MIME with control character
    const resp2 = await authFetch(
      "/api/v1/documents/direct-upload?title=Bad&mime_type=text/plain%00x",
      {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(resp2.status).toBe(400);

    // MIME missing subtype (no slash)
    const resp3 = await authFetch("/api/v1/documents/direct-upload?title=Bad&mime_type=text", {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(resp3.status).toBe(400);

    // Explicit valid MIME is still accepted
    const resp4 = await authFetch(
      "/api/v1/documents/direct-upload?title=Good&mime_type=text/plain",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: new TextEncoder().encode("valid"),
      },
    );
    expect(resp4.status).toBe(201);
  });

  it("invalid UTF-8 with text/plain returns 400 and creates no documents or chunks or R2 object", async () => {
    const badBytes = new Uint8Array([0xff, 0xfe, 0x80, 0x00, 0x01]); // invalid UTF-8

    const db = createDb(env.DB);
    const beforeDocs = await db.select({ id: documents.id }).from(documents);
    const beforeChunks = await db.select().from(documentChunks);
    const beforeR2Keys = (await env.DOCUMENTS.list({ prefix: "user-memory-a/" })).objects.map(
      (o) => o.key,
    );

    const response = await authFetch(
      "/api/v1/documents/direct-upload?title=Bad%20UTF-8&mime_type=text%2Fplain",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: badBytes,
      },
    );
    expect(response.status).toBe(400);

    // No new document rows
    const afterDocs = await db.select({ id: documents.id }).from(documents);
    expect(afterDocs.length).toBe(beforeDocs.length);

    // No new document_chunks rows
    const afterChunks = await db.select().from(documentChunks);
    expect(afterChunks.length).toBe(beforeChunks.length);

    // No new R2 objects for user-memory-a
    const afterR2Keys = (await env.DOCUMENTS.list({ prefix: "user-memory-a/" })).objects.map(
      (o) => o.key,
    );
    expect(afterR2Keys).toEqual(beforeR2Keys);
  });

  it("time-series tool descriptions include agent guidance on convention, metadata, and recall", async () => {
    const session = await mcpSession();
    const response = await mcpRequest(
      { jsonrpc: "2.0", id: 12, method: "tools/list", params: {} },
      session,
    );
    expect(response.response.status).toBe(200);
    const tools = (
      response.message as {
        result?: { tools?: Array<{ name: string; description: string }> };
      }
    ).result?.tools;
    expect(tools).toBeDefined();

    const recordPoint = tools?.find((t) => t.name === "record_time_series_point");
    const recordPoints = tools?.find((t) => t.name === "record_time_series_points");
    const listPoints = tools?.find((t) => t.name === "list_time_series_points");

    // Verify all three tools have descriptions containing required keywords
    for (const tool of [recordPoint, recordPoints, listPoints]) {
      expect(tool?.description).toBeDefined();
      expect(tool?.description).toMatch(/convention/i);
      expect(tool?.description).toMatch(/metadata/i);
      expect(tool?.description).toMatch(/recall/i);
    }

    // recordPoints should mention "series_prefix"
    expect(listPoints?.description).toMatch(/series_prefix/i);

    // recordPoint and recordPoints should mention the guidance about documenting conventions
    expect(recordPoint?.description).toMatch(/record_fact/i);
    expect(recordPoints?.description).toMatch(/record_fact/i);
  });
});

describe("Shared visibility", async () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
    const db = createDb(env.DB);
    await db.insert(users).values({ id: "user-shared-a", name: "Shared A" }).onConflictDoNothing();
    await db.insert(users).values({ id: "user-shared-b", name: "Shared B" }).onConflictDoNothing();
    const hashA = await hashToken(TOKEN_SHARED_A, env.BRAINFOG_TOKEN_HASH_SECRET);
    const hashB = await hashToken(TOKEN_SHARED_B, env.BRAINFOG_TOKEN_HASH_SECRET);
    await db
      .insert(tokens)
      .values({
        id: "token-shared-a",
        userId: "user-shared-a",
        tokenHash: hashA,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-shared-b",
        userId: "user-shared-b",
        tokenHash: hashB,
        createdAt: new Date(),
      })
      .onConflictDoNothing();
  });

  it("Marking a project shared cascades to its contents", async () => {
    const projectRes = await authFetch(
      "/api/v1/projects",
      {
        method: "POST",
        body: JSON.stringify({ name: "Test Project" }),
      },
      TOKEN_SHARED_A,
    );
    const project = await json<{ id: string }>(projectRes);

    const taskRes = await authFetch(
      "/api/v1/tasks",
      {
        method: "POST",
        body: JSON.stringify({ title: "Test Task", project_id: project.id }),
      },
      TOKEN_SHARED_A,
    );
    const task = await json<{ id: string }>(taskRes);

    const factRes = await authFetch(
      "/api/v1/facts",
      {
        method: "POST",
        body: JSON.stringify({ statement: "Test Fact", project_id: project.id }),
      },
      TOKEN_SHARED_A,
    );
    const fact = await json<{ id: string }>(factRes);

    // Set project to shared
    const shareRes = await authFetch(
      "/api/v1/shared",
      {
        method: "POST",
        body: JSON.stringify({ entity_kind: "project", entity_id: project.id, shared: true }),
      },
      TOKEN_SHARED_A,
    );
    const shared = await json<{
      shared: boolean;
      cascaded: { kind: string; id: string }[];
    }>(shareRes);

    expect(shared.shared).toBe(true);
    expect(shared.cascaded).toBeDefined();
    expect(shared.cascaded.length).toBeGreaterThan(0);

    // Verify task and fact are now shared
    const db = createDb(env.DB);
    const taskRow = (
      await db.select({ shared: tasks.shared }).from(tasks).where(eq(tasks.id, task.id)).limit(1)
    )[0];
    expect(taskRow?.shared).toBe(true);

    const factRow = (
      await db.select({ shared: facts.shared }).from(facts).where(eq(facts.id, fact.id)).limit(1)
    )[0];
    expect(factRow?.shared).toBe(true);
  });

  it("Cascade follows dependency edges transitively and is cycle-safe", async () => {
    const projectRes = await authFetch(
      "/api/v1/projects",
      {
        method: "POST",
        body: JSON.stringify({ name: "Cycle Project" }),
      },
      TOKEN_SHARED_A,
    );
    const project = await json<{ id: string }>(projectRes);

    // Create a fact in the project
    const factRes = await authFetch(
      "/api/v1/facts",
      {
        method: "POST",
        body: JSON.stringify({ statement: "Fact F1", project_id: project.id }),
      },
      TOKEN_SHARED_A,
    );
    const fact = await json<{ id: string }>(factRes);

    // Create a thought not in the project
    const thoughtRes = await authFetch(
      "/api/v1/thoughts",
      {
        method: "POST",
        body: JSON.stringify({ content: "Thought T1" }),
      },
      TOKEN_SHARED_A,
    );
    const thought = await json<{ id: string }>(thoughtRes);

    // Create circular dependencies: F1 -> T1, T1 -> F1
    await authFetch(
      "/api/v1/dependencies",
      {
        method: "POST",
        body: JSON.stringify({
          dependent: { kind: "fact", id: fact.id },
          dependency: { kind: "thought", id: thought.id },
          relationship: "derived_from",
        }),
      },
      TOKEN_SHARED_A,
    );

    await authFetch(
      "/api/v1/dependencies",
      {
        method: "POST",
        body: JSON.stringify({
          dependent: { kind: "thought", id: thought.id },
          dependency: { kind: "fact", id: fact.id },
          relationship: "derived_from",
        }),
      },
      TOKEN_SHARED_A,
    );

    // Mark project shared
    const shareRes = await authFetch(
      "/api/v1/shared",
      {
        method: "POST",
        body: JSON.stringify({ entity_kind: "project", entity_id: project.id, shared: true }),
      },
      TOKEN_SHARED_A,
    );
    expect(shareRes.status).toBeLessThan(300);

    // Both fact and thought should be marked shared
    const db = createDb(env.DB);
    const factRow = (
      await db.select({ shared: facts.shared }).from(facts).where(eq(facts.id, fact.id)).limit(1)
    )[0];
    expect(factRow?.shared).toBe(true);

    const thoughtRow = (
      await db
        .select({ shared: thoughts.shared })
        .from(thoughts)
        .where(eq(thoughts.id, thought.id))
        .limit(1)
    )[0];
    expect(thoughtRow?.shared).toBe(true);
  });

  it("Cross-owner dependency edge is rejected when target is not shared", async () => {
    // User A creates a private fact
    const aFactRes = await authFetch(
      "/api/v1/facts",
      {
        method: "POST",
        body: JSON.stringify({ statement: "User A Private Fact" }),
      },
      TOKEN_SHARED_A,
    );
    const aFact = await json<{ id: string }>(aFactRes);

    // User B creates a thought first
    const bThoughtRes = await authFetch(
      "/api/v1/thoughts",
      {
        method: "POST",
        body: JSON.stringify({ content: "User B Test Thought" }),
      },
      TOKEN_SHARED_B,
    );
    const bThought = await json<{ id: string }>(bThoughtRes);

    // User B tries to create a dependency from their thought to User A's private fact
    const depRes = await authFetch(
      "/api/v1/dependencies",
      {
        method: "POST",
        body: JSON.stringify({
          dependent: { kind: "thought", id: bThought.id },
          dependency: { kind: "fact", id: aFact.id },
          relationship: "derived_from",
        }),
      },
      TOKEN_SHARED_B,
    );
    expect(depRes.status).toBe(404);
  });

  it("Cross-owner dependency edge shares the dependent when target is shared", async () => {
    // User A creates and shares a fact
    const aFactRes = await authFetch(
      "/api/v1/facts",
      {
        method: "POST",
        body: JSON.stringify({ statement: "User A Shared Fact" }),
      },
      TOKEN_SHARED_A,
    );
    const aFact = await json<{ id: string }>(aFactRes);

    await authFetch(
      "/api/v1/shared",
      {
        method: "POST",
        body: JSON.stringify({ entity_kind: "fact", entity_id: aFact.id, shared: true }),
      },
      TOKEN_SHARED_A,
    );

    // User B creates a thought
    const bThoughtRes = await authFetch(
      "/api/v1/thoughts",
      {
        method: "POST",
        body: JSON.stringify({ content: "User B Thought" }),
      },
      TOKEN_SHARED_B,
    );
    const bThought = await json<{ id: string }>(bThoughtRes);

    // User B creates a dependency from their thought to User A's shared fact
    const depRes = await authFetch(
      "/api/v1/dependencies",
      {
        method: "POST",
        body: JSON.stringify({
          dependent: { kind: "thought", id: bThought.id },
          dependency: { kind: "fact", id: aFact.id },
          relationship: "derived_from",
        }),
      },
      TOKEN_SHARED_B,
    );
    expect(depRes.status).toBeLessThan(300);
    const dep = await json<{
      cascaded?: { kind: string; id: string }[];
    }>(depRes);

    // User B's thought should now be shared
    expect(dep.cascaded).toBeDefined();
    if (dep.cascaded) {
      expect(dep.cascaded.length).toBeGreaterThan(0);
    }

    const db = createDb(env.DB);
    const thoughtRow = (
      await db
        .select({ shared: thoughts.shared, ownerId: thoughts.ownerId })
        .from(thoughts)
        .where(eq(thoughts.id, bThought.id))
        .limit(1)
    )[0];
    expect(thoughtRow?.shared).toBe(true);
    expect(thoughtRow?.ownerId).toBe("user-shared-b");
  });

  it("Referencing a global person does not trigger sharing", async () => {
    // Create a global person
    const personRes = await authFetch(
      "/api/v1/people",
      {
        method: "POST",
        body: JSON.stringify({ name: "Test Person" }),
      },
      TOKEN_SHARED_A,
    );
    const person = await json<{ id: string }>(personRes);

    // User B creates a thought and links to the person
    const thoughtRes = await authFetch(
      "/api/v1/thoughts",
      {
        method: "POST",
        body: JSON.stringify({
          content: "Thought about person",
          links: { people_ids: [person.id] },
        }),
      },
      TOKEN_SHARED_B,
    );
    const thought = await json<{ id: string }>(thoughtRes);

    // Thought should remain non-shared
    const db = createDb(env.DB);
    const thoughtRow = (
      await db
        .select({ shared: thoughts.shared })
        .from(thoughts)
        .where(eq(thoughts.id, thought.id))
        .limit(1)
    )[0];
    expect(thoughtRow?.shared).toBe(false);
  });

  it("Assigning project_id to a shared project shares the new row", async () => {
    // User A creates and shares a project
    const projectRes = await authFetch(
      "/api/v1/projects",
      {
        method: "POST",
        body: JSON.stringify({ name: "Shared Project for Contagion" }),
      },
      TOKEN_SHARED_A,
    );
    const project = await json<{ id: string }>(projectRes);

    await authFetch(
      "/api/v1/shared",
      {
        method: "POST",
        body: JSON.stringify({ entity_kind: "project", entity_id: project.id, shared: true }),
      },
      TOKEN_SHARED_A,
    );

    // User B creates a task with the shared project_id
    const taskRes = await authFetch(
      "/api/v1/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          title: "Task in Shared Project",
          project_id: project.id,
        }),
      },
      TOKEN_SHARED_B,
    );
    const task = await json<{
      id: string;
      shared?: boolean;
      cascaded?: { kind: string; id: string }[];
    }>(taskRes);

    // Task should be shared and include cascaded response
    expect(task.cascaded).toBeDefined();
    expect(task.cascaded?.length).toBeGreaterThan(0);

    // Verify in database that task is owned by user B and is shared
    const db = createDb(env.DB);
    const taskRow = (
      await db
        .select({ shared: tasks.shared, ownerId: tasks.ownerId })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .limit(1)
    )[0];
    expect(taskRow?.shared).toBe(true);
    expect(taskRow?.ownerId).toBe("user-shared-b");
  });

  it("set_shared is owner-only", async () => {
    // User A creates a task
    const taskRes = await authFetch(
      "/api/v1/tasks",
      {
        method: "POST",
        body: JSON.stringify({ title: "User A Task" }),
      },
      TOKEN_SHARED_A,
    );
    const task = await json<{ id: string }>(taskRes);

    // User B tries to share it
    const shareRes = await authFetch(
      "/api/v1/shared",
      {
        method: "POST",
        body: JSON.stringify({ entity_kind: "task", entity_id: task.id, shared: true }),
      },
      TOKEN_SHARED_B,
    );
    expect(shareRes.status).toBe(404);
  });

  it("Un-sharing the root does not retract cascaded shares", async () => {
    // User A creates a project with a task
    const projectRes = await authFetch(
      "/api/v1/projects",
      {
        method: "POST",
        body: JSON.stringify({ name: "Unshare Test Project" }),
      },
      TOKEN_SHARED_A,
    );
    const project = await json<{ id: string }>(projectRes);

    const taskRes = await authFetch(
      "/api/v1/tasks",
      {
        method: "POST",
        body: JSON.stringify({ title: "Cascaded Task", project_id: project.id }),
      },
      TOKEN_SHARED_A,
    );
    const task = await json<{ id: string }>(taskRes);

    // Share the project
    await authFetch(
      "/api/v1/shared",
      {
        method: "POST",
        body: JSON.stringify({ entity_kind: "project", entity_id: project.id, shared: true }),
      },
      TOKEN_SHARED_A,
    );

    // Unshare the project
    await authFetch(
      "/api/v1/shared",
      {
        method: "POST",
        body: JSON.stringify({ entity_kind: "project", entity_id: project.id, shared: false }),
      },
      TOKEN_SHARED_A,
    );

    // Task should still be shared (cascade not retracted)
    const db = createDb(env.DB);
    const taskRow = (
      await db.select({ shared: tasks.shared }).from(tasks).where(eq(tasks.id, task.id)).limit(1)
    )[0];
    expect(taskRow?.shared).toBe(true);
  });

  // ==================== PBI-010: Shared Visibility Read Paths ====================

  describe("Recall returns shared content cross-owner (two-query merge)", () => {
    it("recall includes another user's shared thought via merged two-query results", async () => {
      // User A creates and shares a thought
      const aThoughtRes = await authFetch(
        "/api/v1/thoughts",
        {
          method: "POST",
          body: JSON.stringify({ content: "shared project kickoff notes and planning" }),
        },
        TOKEN_SHARED_A,
      );
      const aThought = await json<{ id: string }>(aThoughtRes);

      // Mark it shared
      await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "thought", entity_id: aThought.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );

      // User B creates a private thought (should not be in results)
      const bPrivateRes = await authFetch(
        "/api/v1/thoughts",
        {
          method: "POST",
          body: JSON.stringify({ content: "private user B thought unrelated" }),
        },
        TOKEN_SHARED_B,
      );
      await json<{ id: string }>(bPrivateRes);

      // Mock Vectorize to return both owner-scoped (A's private) and shared-scoped (A's shared) results
      const query = vi.fn(
        async (_values, options?: { topK?: number; filter?: Record<string, unknown> }) => {
          const filter = options?.filter as Record<string, unknown> | undefined;
          const isOwnerScoped = filter?.owner_id === "user-shared-b";
          const isSharedScoped = filter?.shared === true;

          if (isOwnerScoped) {
            // B's own results (should not include A's shared thought)
            return { matches: [] };
          } else if (isSharedScoped) {
            // Shared results (includes A's shared thought)
            return {
              matches: [{ id: aThought.id, score: 0.95, metadata: { kind: "thought" } }],
            };
          }
          return { matches: [] };
        },
      );

      const vectorEnv = {
        DB: env.DB,
        DOCUMENTS: env.DOCUMENTS,
        VECTORIZE: { upsert: vi.fn(), deleteByIds: vi.fn(), query },
        AI: { run: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] })) },
      } as unknown as typeof env;

      const results = await recall(
        { env: vectorEnv, user: { id: "user-shared-b", name: "Shared B" }, source: "test" },
        { query: "shared project kickoff", limit: 10 },
      );

      expect(results.length).toBeGreaterThan(0);
      const resultIds = results.map((r) => (r as { row: { id: string } }).row.id);
      expect(resultIds).toContain(aThought.id);
    });

    it("recall de-duplicates and re-ranks when same entity appears in both queries", async () => {
      // User A creates and shares a fact
      const aFactRes = await authFetch(
        "/api/v1/facts",
        {
          method: "POST",
          body: JSON.stringify({ statement: "shared fact about metrics" }),
        },
        TOKEN_SHARED_A,
      );
      const aFact = await json<{ id: string }>(aFactRes);

      // Mark it shared
      await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "fact", entity_id: aFact.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );

      // Mock Vectorize to return same fact in both queries (but with different scores)
      const query = vi.fn(
        async (_values, options?: { topK?: number; filter?: Record<string, unknown> }) => {
          const filter = options?.filter as Record<string, unknown> | undefined;
          const isOwnerScoped = filter?.owner_id === "user-shared-b";
          const isSharedScoped = filter?.shared === true;

          if (isOwnerScoped) {
            // B's own results: lower score
            return {
              matches: [{ id: aFact.id, score: 0.5, metadata: { kind: "fact" } }],
            };
          } else if (isSharedScoped) {
            // Shared results: higher score
            return {
              matches: [{ id: aFact.id, score: 0.9, metadata: { kind: "fact" } }],
            };
          }
          return { matches: [] };
        },
      );

      const vectorEnv = {
        DB: env.DB,
        DOCUMENTS: env.DOCUMENTS,
        VECTORIZE: { upsert: vi.fn(), deleteByIds: vi.fn(), query },
        AI: { run: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] })) },
      } as unknown as typeof env;

      const results = await recall(
        { env: vectorEnv, user: { id: "user-shared-b", name: "Shared B" }, source: "test" },
        { query: "metrics", limit: 10 },
      );

      expect(query).toHaveBeenCalledTimes(2);
      expect(results.length).toBe(1);
      expect((results[0] as { row: { id: string } }).row.id).toBe(aFact.id);
    });
  });

  describe("REST list routes return shared=true rows", () => {
    it("listProjects includes another user's shared project", async () => {
      // User A creates and shares a project
      const aProjectRes = await authFetch(
        "/api/v1/projects",
        {
          method: "POST",
          body: JSON.stringify({ name: "User A Shared Project" }),
        },
        TOKEN_SHARED_A,
      );
      const aProject = await json<{ id: string }>(aProjectRes);

      await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "project", entity_id: aProject.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );

      // User A also creates a private project
      const aPrivateRes = await authFetch(
        "/api/v1/projects",
        {
          method: "POST",
          body: JSON.stringify({ name: "User A Private Project" }),
        },
        TOKEN_SHARED_A,
      );
      const aPrivate = await json<{ id: string }>(aPrivateRes);

      // User B lists projects
      const bProjectsRes = await authFetch("/api/v1/projects", {}, TOKEN_SHARED_B);
      const bProjects = await json<{ id: string; name: string }[]>(bProjectsRes);
      const bProjectIds = bProjects.map((p) => p.id);

      // B should see A's shared project but not A's private project
      expect(bProjectIds).toContain(aProject.id);
      expect(bProjectIds).not.toContain(aPrivate.id);
    });

    it("listTasks includes another user's shared task", async () => {
      // User A creates and shares a task
      const aTaskRes = await authFetch(
        "/api/v1/tasks",
        {
          method: "POST",
          body: JSON.stringify({ title: "User A Shared Task" }),
        },
        TOKEN_SHARED_A,
      );
      const aTask = await json<{ id: string }>(aTaskRes);

      await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "task", entity_id: aTask.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );

      // User A creates a private task
      const aPrivateRes = await authFetch(
        "/api/v1/tasks",
        {
          method: "POST",
          body: JSON.stringify({ title: "User A Private Task" }),
        },
        TOKEN_SHARED_A,
      );
      const aPrivate = await json<{ id: string }>(aPrivateRes);

      // User B lists tasks
      const bTasksRes = await authFetch("/api/v1/tasks", {}, TOKEN_SHARED_B);
      const bTasks = await json<{ id: string; title: string }[]>(bTasksRes);
      const bTaskIds = bTasks.map((t) => t.id);

      expect(bTaskIds).toContain(aTask.id);
      expect(bTaskIds).not.toContain(aPrivate.id);
    });

    it("listFacts includes another user's shared fact", async () => {
      // User A creates and shares a fact
      const aFactRes = await authFetch(
        "/api/v1/facts",
        {
          method: "POST",
          body: JSON.stringify({ statement: "User A Shared Fact" }),
        },
        TOKEN_SHARED_A,
      );
      const aFact = await json<{ id: string }>(aFactRes);

      await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "fact", entity_id: aFact.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );

      // User A creates a private fact
      const aPrivateRes = await authFetch(
        "/api/v1/facts",
        {
          method: "POST",
          body: JSON.stringify({ statement: "User A Private Fact" }),
        },
        TOKEN_SHARED_A,
      );
      const aPrivate = await json<{ id: string }>(aPrivateRes);

      // User B lists facts
      const bFactsRes = await authFetch("/api/v1/facts", {}, TOKEN_SHARED_B);
      const bFacts = await json<{ id: string; statement: string }[]>(bFactsRes);
      const bFactIds = bFacts.map((f) => f.id);

      expect(bFactIds).toContain(aFact.id);
      expect(bFactIds).not.toContain(aPrivate.id);
    });

    it("listThoughts includes another user's shared thought", async () => {
      // User A creates and shares a thought
      const aThoughtRes = await authFetch(
        "/api/v1/thoughts",
        {
          method: "POST",
          body: JSON.stringify({ content: "User A Shared Thought" }),
        },
        TOKEN_SHARED_A,
      );
      const aThought = await json<{ id: string }>(aThoughtRes);

      await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "thought", entity_id: aThought.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );

      // User A creates a private thought
      const aPrivateRes = await authFetch(
        "/api/v1/thoughts",
        {
          method: "POST",
          body: JSON.stringify({ content: "User A Private Thought" }),
        },
        TOKEN_SHARED_A,
      );
      const aPrivate = await json<{ id: string }>(aPrivateRes);

      // User B lists thoughts
      const bThoughtsRes = await authFetch("/api/v1/thoughts", {}, TOKEN_SHARED_B);
      const bThoughts = await json<{ id: string; content: string }[]>(bThoughtsRes);
      const bThoughtIds = bThoughts.map((t) => t.id);

      expect(bThoughtIds).toContain(aThought.id);
      expect(bThoughtIds).not.toContain(aPrivate.id);
    });

    it("listDocuments includes another user's shared document", async () => {
      // User A creates and shares a document
      const aDocRes = await authFetch(
        "/api/v1/documents",
        {
          method: "POST",
          body: JSON.stringify({ title: "User A Shared Document", content: "shared doc content" }),
        },
        TOKEN_SHARED_A,
      );
      const aDoc = await json<{ id: string }>(aDocRes);

      await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "document", entity_id: aDoc.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );

      // User A creates a private document
      const aPrivateRes = await authFetch(
        "/api/v1/documents",
        {
          method: "POST",
          body: JSON.stringify({
            title: "User A Private Document",
            content: "private doc content",
          }),
        },
        TOKEN_SHARED_A,
      );
      const aPrivate = await json<{ id: string }>(aPrivateRes);

      // User B lists documents
      const bDocsRes = await authFetch("/api/v1/documents", {}, TOKEN_SHARED_B);
      const bDocs = await json<{ id: string; title: string }[]>(bDocsRes);
      const bDocIds = bDocs.map((d) => d.id);

      expect(bDocIds).toContain(aDoc.id);
      expect(bDocIds).not.toContain(aPrivate.id);
    });
  });

  describe("Dependency graph supports shared entity access", () => {
    it("Edges referencing shared entities are listed without errors", async () => {
      // User A creates and shares a fact
      const aFactRes = await authFetch(
        "/api/v1/facts",
        {
          method: "POST",
          body: JSON.stringify({ statement: "Shared fact for dependency listing" }),
        },
        TOKEN_SHARED_A,
      );
      const aFact = await json<{ id: string }>(aFactRes);

      await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "fact", entity_id: aFact.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );

      // User B creates a thought and links it to A's shared fact (contagion marks B's thought shared)
      const bThoughtRes = await authFetch(
        "/api/v1/thoughts",
        {
          method: "POST",
          body: JSON.stringify({ content: "User B Thought referencing shared fact" }),
        },
        TOKEN_SHARED_B,
      );
      const bThought = await json<{ id: string }>(bThoughtRes);

      const depRes = await authFetch(
        "/api/v1/dependencies",
        {
          method: "POST",
          body: JSON.stringify({
            dependent: { kind: "thought", id: bThought.id },
            dependency: { kind: "fact", id: aFact.id },
            relationship: "derived_from",
          }),
        },
        TOKEN_SHARED_B,
      );
      expect(depRes.status).toBeLessThan(300);

      // User B should be able to list dependencies (basic smoke test)
      const depsRes = await authFetch(
        `/api/v1/dependencies?entity_kind=thought&entity_id=${bThought.id}`,
        {},
        TOKEN_SHARED_B,
      );
      expect(depsRes.status).toBeLessThan(300);
    });
  });

  describe("Cross-owner stale propagation via shared entities", () => {
    it("Updating a shared fact marks dependent edges stale across owners", async () => {
      // User A creates and shares a fact
      const aFactRes = await authFetch(
        "/api/v1/facts",
        {
          method: "POST",
          body: JSON.stringify({ statement: "User A Shared Fact for staleness" }),
        },
        TOKEN_SHARED_A,
      );
      const aFact = await json<{ id: string }>(aFactRes);

      await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "fact", entity_id: aFact.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );

      // User B creates a thought with a derived_from edge to A's shared fact
      const bThoughtRes = await authFetch(
        "/api/v1/thoughts",
        {
          method: "POST",
          body: JSON.stringify({ content: "User B Thought depending on A's fact" }),
        },
        TOKEN_SHARED_B,
      );
      const bThought = await json<{ id: string }>(bThoughtRes);

      const depRes = await authFetch(
        "/api/v1/dependencies",
        {
          method: "POST",
          body: JSON.stringify({
            dependent: { kind: "thought", id: bThought.id },
            dependency: { kind: "fact", id: aFact.id },
            relationship: "derived_from",
          }),
        },
        TOKEN_SHARED_B,
      );
      expect(depRes.status).toBeLessThan(300);

      // User A updates the fact
      const updateRes = await authFetch(
        `/api/v1/facts/${aFact.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ statement: "User A Updated Shared Fact" }),
        },
        TOKEN_SHARED_A,
      );
      expect(updateRes.status).toBeLessThan(300);

      // User B lists stale edges (should see their own edge marked stale)
      const staleRes = await authFetch("/api/v1/dependencies/stale", {}, TOKEN_SHARED_B);
      expect(staleRes.status).toBeLessThan(300);
      const staleEdges =
        await json<
          {
            dependentKind: string;
            dependentId: string;
            dependencyKind: string;
            dependencyId: string;
          }[]
        >(staleRes);

      // The edge from B's thought to A's fact should be marked stale
      const foundStale = staleEdges.some(
        (e) =>
          e.dependentKind === "thought" &&
          e.dependentId === bThought.id &&
          e.dependencyKind === "fact" &&
          e.dependencyId === aFact.id,
      );
      expect(foundStale).toBe(true);
    });

    it("markDownstreamStale marks edges of non-owner dependents when dependency is shared", async () => {
      // User A creates and shares a fact
      const aFactRes = await authFetch(
        "/api/v1/facts",
        {
          method: "POST",
          body: JSON.stringify({ statement: "Shared fact for cross-owner stale" }),
        },
        TOKEN_SHARED_A,
      );
      const aFact = await json<{ id: string }>(aFactRes);

      const shareRes = await authFetch(
        "/api/v1/shared",
        {
          method: "POST",
          body: JSON.stringify({ entity_kind: "fact", entity_id: aFact.id, shared: true }),
        },
        TOKEN_SHARED_A,
      );
      expect(shareRes.status).toBeLessThan(300);

      // User B creates a thought and links to A's shared fact (B's thought becomes shared)
      const bThoughtRes = await authFetch(
        "/api/v1/thoughts",
        {
          method: "POST",
          body: JSON.stringify({ content: "User B Thought linking to shared fact" }),
        },
        TOKEN_SHARED_B,
      );
      const bThought = await json<{ id: string }>(bThoughtRes);

      const depRes = await authFetch(
        "/api/v1/dependencies",
        {
          method: "POST",
          body: JSON.stringify({
            dependent: { kind: "thought", id: bThought.id },
            dependency: { kind: "fact", id: aFact.id },
            relationship: "derived_from",
          }),
        },
        TOKEN_SHARED_B,
      );
      expect(depRes.status).toBeLessThan(300);

      // Verify that when A updates their fact, B sees the edge as stale
      const updateRes = await authFetch(
        `/api/v1/facts/${aFact.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ statement: "Updated shared fact version 2" }),
        },
        TOKEN_SHARED_A,
      );
      expect(updateRes.status).toBeLessThan(300);

      // B should see the stale edge
      const staleRes = await authFetch("/api/v1/dependencies/stale", {}, TOKEN_SHARED_B);
      expect(staleRes.status).toBeLessThan(300);
      const staleEdges =
        await json<
          {
            dependentKind: string;
            dependentId: string;
            dependencyKind: string;
            dependencyId: string;
          }[]
        >(staleRes);

      const foundStale = staleEdges.some(
        (e) =>
          e.dependentKind === "thought" &&
          e.dependentId === bThought.id &&
          e.dependencyKind === "fact" &&
          e.dependencyId === aFact.id,
      );
      expect(foundStale).toBe(true);
    });
  });

  describe("Vectorize metadata shared sync", () => {
    it("setShared on thought calls resyncVectorSharedMetadata", async () => {
      const getByIdsMock = vi.fn(async (ids: string[]) => {
        return ids.map((id) => ({
          id,
          values: Array.from({ length: 1024 }, () => 0.25),
          metadata: { kind: "thought", owner_id: "user-shared-a" },
        }));
      });
      const upsertMock = vi.fn(async () => undefined);

      const serviceEnv = {
        DB: env.DB,
        DOCUMENTS: env.DOCUMENTS,
        VECTORIZE: {
          upsert: upsertMock,
          deleteByIds: vi.fn(),
          query: vi.fn(),
          getByIds: getByIdsMock,
        },
        AI: { run: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] })) },
      } as unknown as typeof env;

      const ctx = {
        env: serviceEnv,
        user: { id: "user-shared-a", name: "Shared A" },
        source: "test:service",
      };
      const thought = await remember(ctx, { content: "vector shared test thought" });

      // Call setShared directly
      await setShared(ctx, {
        entity_kind: "thought",
        entity_id: thought.id,
        shared: true,
      });

      // Verify getByIds was called
      expect(getByIdsMock).toHaveBeenCalledWith([thought.id]);

      // Verify upsert was called with shared metadata
      expect(upsertMock).toHaveBeenCalled();
      const upsertCalls = upsertMock.mock.calls as unknown as Array<
        [Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>]
      >;

      const hasSharedMetadata = upsertCalls.some((call) => {
        const vector = call[0]?.[0];
        return vector?.id === thought.id && vector?.metadata?.shared === true;
      });
      expect(hasSharedMetadata).toBe(true);
    });

    it("setShared on document syncs chunk vectors", async () => {
      const getByIdsMock = vi.fn(async (ids: string[]) => {
        return ids.map((id) => ({
          id,
          values: Array.from({ length: 1024 }, () => 0.25),
          metadata: { kind: "document_chunk", owner_id: "user-shared-a" },
        }));
      });
      const upsertMock = vi.fn(async () => undefined);

      const serviceEnv = {
        DB: env.DB,
        DOCUMENTS: env.DOCUMENTS,
        VECTORIZE: {
          upsert: upsertMock,
          deleteByIds: vi.fn(),
          query: vi.fn(),
          getByIds: getByIdsMock,
        },
        AI: { run: vi.fn(async () => ({ data: [Array.from({ length: 1024 }, () => 0.25)] })) },
      } as unknown as typeof env;

      const ctx = {
        env: serviceEnv,
        user: { id: "user-shared-a", name: "Shared A" },
        source: "test:service",
      };
      const doc = await addDocument(ctx, {
        title: "Doc for chunk vector sync",
        content: "first chunk content here for sync test second chunk content for test",
      });

      const db = createDb(env.DB);
      const chunks = await db
        .select({ id: documentChunks.id })
        .from(documentChunks)
        .where(eq(documentChunks.documentId, doc.id));
      expect(chunks.length).toBeGreaterThan(0);

      // Set document shared
      await setShared(ctx, {
        entity_kind: "document",
        entity_id: doc.id,
        shared: true,
      });

      // Verify getByIds was called for chunks
      const getByIdsCalls = getByIdsMock.mock.calls as unknown as Array<[string[]]>;
      const allGetIds = getByIdsCalls.flatMap((call) => call[0]);
      for (const chunk of chunks) {
        expect(allGetIds).toContain(chunk.id);
      }

      // Verify upsert was called with shared=true for chunks
      expect(upsertMock).toHaveBeenCalled();
      const upsertCalls = upsertMock.mock.calls as unknown as Array<
        [Array<{ id: string; values: number[]; metadata: Record<string, unknown> }>]
      >;

      for (const chunk of chunks) {
        const hasChunkWithShared = upsertCalls.some((call) => {
          const vector = call[0]?.[0];
          return vector?.id === chunk.id && vector?.metadata?.shared === true;
        });
        expect(hasChunkWithShared).toBe(true);
      }
    });
  });
});
