import type { Context } from "hono";
import { Hono } from "hono";
import {
  createOrReplaceConnectorCredentials,
  deleteConnectorCredentials,
  getCredentialStatus,
} from "../credentials";
import type { Env } from "../env";
import { recordGarminRunnerPayload } from "../garmin";
import {
  createIngestionConnector,
  listIngestionConnectors,
  listIngestionRuns,
  recordIngestionRun,
  updateIngestionConnector,
} from "../ingestion";
import {
  addDocument,
  createDependency,
  createDocumentFromBytes,
  createProject,
  createTask,
  deleteDependency,
  deleteDocument,
  deleteFact,
  deleteThought,
  documentWriteModes,
  getChunksForDocument,
  getDocumentBytes,
  getDocumentContent,
  getDocumentVersionBytes,
  getDocumentVersionContent,
  linkThought,
  listDependencies,
  listDocuments,
  listDocumentVersions,
  listFacts,
  listPeople,
  listProjects,
  listStale,
  listTasks,
  listThoughts,
  listTimeSeriesPoints,
  MemoryError,
  markStale,
  recall,
  recordFact,
  recordTimeSeriesPoint,
  recordTimeSeriesPoints,
  remember,
  setSelfPerson,
  setShared,
  updateDocument,
  updateDocumentFromBytes,
  updateFact,
  updateTask,
  upsertPerson,
  whoami,
} from "../memory";
import { type AuthVariables, authMiddleware } from "../middleware/auth";

export const apiRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Unauthenticated health check (ARCHITECTURE.md regression guardrail: must
// stay reachable without a token). Registered before the auth middleware so
// it short-circuits without ever invoking it.
apiRoutes.get("/health", (c) => c.json({ status: "ok" }));

apiRoutes.use("*", authMiddleware);

apiRoutes.get("/whoami", async (c) => c.json(await whoami(ctx(c))));

type ApiContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

function ctx(c: ApiContext) {
  return { env: c.env, user: c.get("user"), source: "rest:api" };
}

async function body(c: ApiContext) {
  return (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
}

function handle(error: unknown) {
  if (error instanceof MemoryError)
    return { body: { error: error.message }, status: error.status as 400 | 401 | 403 | 404 };
  return { body: { error: "internal_error" }, status: 500 as const };
}

const route = (fn: (c: ApiContext) => Promise<Response>) => async (c: ApiContext) => {
  try {
    return await fn(c);
  } catch (error) {
    const result = handle(error);
    return c.json(result.body, result.status);
  }
};

const param = (c: ApiContext, name: string) => {
  const value = c.req.param(name);
  if (!value) throw new MemoryError(400, `missing ${name}`);
  return value;
};

function documentWriteModeFromPayload(payload: Record<string, unknown>) {
  if (!Object.hasOwn(payload, "write_mode") || payload.write_mode == null) return undefined;
  if (
    typeof payload.write_mode === "string" &&
    (documentWriteModes as readonly string[]).includes(payload.write_mode)
  ) {
    return payload.write_mode as Parameters<typeof updateDocument>[3];
  }
  throw new MemoryError(400, "invalid document write_mode");
}

apiRoutes.patch(
  "/whoami",
  route(async (c) => {
    const payload = await body(c);
    const personId = payload.self_person_id === null ? null : String(payload.self_person_id ?? "");
    if (personId !== null && !personId) throw new MemoryError(400, "missing self_person_id");
    return c.json(await setSelfPerson(ctx(c), personId));
  }),
);

apiRoutes.get(
  "/projects",
  route(async (c) => c.json(await listProjects(ctx(c)))),
);
apiRoutes.post(
  "/projects",
  route(async (c) => c.json(await createProject(ctx(c), (await body(c)) as { name: string }), 201)),
);

apiRoutes.get(
  "/people",
  route(async (c) => c.json(await listPeople(ctx(c)))),
);
apiRoutes.post(
  "/people",
  route(async (c) => c.json(await upsertPerson(ctx(c), (await body(c)) as { name: string }), 201)),
);

apiRoutes.get(
  "/tasks",
  route(async (c) =>
    c.json(
      await listTasks(ctx(c), {
        project_id: c.req.query("project_id"),
        status: c.req.query("status"),
      }),
    ),
  ),
);
apiRoutes.post(
  "/tasks",
  route(async (c) => c.json(await createTask(ctx(c), await body(c)), 201)),
);
apiRoutes.patch(
  "/tasks/:id",
  route(async (c) => c.json(await updateTask(ctx(c), param(c, "id"), await body(c)))),
);

apiRoutes.get(
  "/thoughts",
  route(async (c) => c.json(await listThoughts(ctx(c)))),
);
apiRoutes.post(
  "/thoughts",
  route(async (c) => c.json(await remember(ctx(c), (await body(c)) as { content: string }), 201)),
);
apiRoutes.post(
  "/thoughts/:id/links",
  route(async (c) => c.json(await linkThought(ctx(c), param(c, "id"), await body(c)))),
);
apiRoutes.delete(
  "/thoughts/:id",
  route(async (c) => c.json(await deleteThought(ctx(c), param(c, "id")))),
);

apiRoutes.get(
  "/facts",
  route(async (c) => c.json(await listFacts(ctx(c)))),
);
apiRoutes.post(
  "/facts",
  route(async (c) =>
    c.json(await recordFact(ctx(c), (await body(c)) as { statement: string }), 201),
  ),
);
apiRoutes.patch(
  "/facts/:id",
  route(async (c) => c.json(await updateFact(ctx(c), param(c, "id"), await body(c)))),
);
apiRoutes.delete(
  "/facts/:id",
  route(async (c) => c.json(await deleteFact(ctx(c), param(c, "id")))),
);

apiRoutes.get(
  "/documents",
  route(async (c) => c.json(await listDocuments(ctx(c)))),
);
apiRoutes.post(
  "/documents",
  route(async (c) =>
    c.json(await addDocument(ctx(c), (await body(c)) as { title: string; content: string }), 201),
  ),
);
apiRoutes.post(
  "/documents/direct-upload",
  route(async (c) => {
    const title = c.req.query("title") ?? c.req.header("x-brainfog-document-title") ?? "";
    const mimeType =
      c.req.query("mime_type") ??
      c.req.header("x-brainfog-mime-type") ??
      c.req.header("content-type");
    const projectId =
      c.req.query("project_id") ?? c.req.header("x-brainfog-project-id") ?? undefined;
    const filename = c.req.query("filename") ?? c.req.header("x-brainfog-filename") ?? undefined;
    const bytes = await c.req.arrayBuffer();
    return c.json(
      await createDocumentFromBytes(ctx(c), {
        title,
        bytes,
        project_id: projectId,
        mime_type: mimeType,
        filename,
      }),
      201,
    );
  }),
);
apiRoutes.patch(
  "/documents/:id/direct-upload",
  route(async (c) => {
    const title = c.req.query("title") ?? c.req.header("x-brainfog-document-title");
    const projectId = c.req.query("project_id") ?? c.req.header("x-brainfog-project-id");
    if (title !== null && title !== undefined)
      throw new MemoryError(400, "title is not accepted when updating an existing document");
    if (projectId !== null && projectId !== undefined)
      throw new MemoryError(400, "project_id is not accepted when updating an existing document");
    // Reject client-supplied provenance fields
    for (const field of ["owner_id", "source", "r2_key", "created_at", "updated_at"]) {
      const value = c.req.query(field) ?? c.req.header(`x-brainfog-${field}`);
      if (value !== null && value !== undefined)
        throw new MemoryError(400, `${field} is not accepted when updating an existing document`);
    }
    const mimeType =
      c.req.query("mime_type") ??
      c.req.header("x-brainfog-mime-type") ??
      c.req.header("content-type");
    const filename = c.req.query("filename") ?? c.req.header("x-brainfog-filename") ?? undefined;
    const rawWriteMode = c.req.query("write_mode") ?? c.req.header("x-brainfog-write-mode");
    const writeMode = rawWriteMode as Parameters<typeof updateDocumentFromBytes>[3] | undefined;
    if (writeMode !== undefined && !(documentWriteModes as readonly string[]).includes(writeMode)) {
      throw new MemoryError(400, "invalid document write_mode");
    }
    const bytes = await c.req.arrayBuffer();
    return c.json(
      await updateDocumentFromBytes(ctx(c), param(c, "id"), bytes, writeMode, mimeType, filename),
    );
  }),
);

apiRoutes.patch(
  "/documents/:id",
  route(async (c) => {
    const payload = await body(c);
    return c.json(
      await updateDocument(
        ctx(c),
        param(c, "id"),
        String(payload.content ?? ""),
        documentWriteModeFromPayload(payload),
        payload.derived_from as Parameters<typeof updateDocument>[4],
      ),
    );
  }),
);
apiRoutes.get(
  "/documents/:id/versions",
  route(async (c) => c.json(await listDocumentVersions(ctx(c), param(c, "id")))),
);
apiRoutes.get(
  "/documents/:id/versions/:version/content",
  route(async (c) => {
    const result = await getDocumentVersionContent(
      ctx(c),
      param(c, "id"),
      versionSelector(param(c, "version")),
    );
    return new Response(result.content, {
      headers: { "content-type": result.version.mimeType || "text/plain" },
    });
  }),
);
apiRoutes.get(
  "/documents/:id/versions/:version/download",
  route(async (c) => {
    const result = await getDocumentVersionBytes(
      ctx(c),
      param(c, "id"),
      versionSelector(param(c, "version")),
    );
    const filename = safeDownloadFilename(
      c.req.query("filename") ?? result.filename ?? "document-version",
    );
    return new Response(result.bytes, {
      headers: {
        "content-type": result.version.mimeType || "application/octet-stream",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(result.bytes.byteLength),
        "x-content-type-options": "nosniff",
      },
    });
  }),
);
apiRoutes.delete(
  "/documents/:id",
  route(async (c) => c.json(await deleteDocument(ctx(c), param(c, "id")))),
);
apiRoutes.get(
  "/documents/:id/chunks",
  route(async (c) => c.json(await getChunksForDocument(ctx(c), param(c, "id")))),
);
apiRoutes.get(
  "/documents/:id/content",
  route(async (c) => {
    const result = await getDocumentContent(ctx(c), param(c, "id"));
    return new Response(result.content, { headers: { "content-type": result.doc.mimeType } });
  }),
);
apiRoutes.get(
  "/documents/:id/download",
  route(async (c) => {
    const result = await getDocumentBytes(ctx(c), param(c, "id"));
    const filename = safeDownloadFilename(
      c.req.query("filename") ?? result.filename ?? result.doc.title,
    );
    return new Response(result.bytes, {
      headers: {
        "content-type": result.doc.mimeType || "application/octet-stream",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(result.bytes.byteLength),
        "x-content-type-options": "nosniff",
      },
    });
  }),
);

function safeDownloadFilename(value: string) {
  return value.replace(/[\\/\r\n\0"]/g, "_").trim() || "document";
}

function versionSelector(value: string) {
  if (/^\d+$/.test(value)) return { version_number: Number(value) };
  return { version_id: value };
}

apiRoutes.get(
  "/time-series-points",
  route(async (c) =>
    c.json(
      await listTimeSeriesPoints(ctx(c), {
        series_key: c.req.query("series_key"),
        series_prefix: c.req.query("series_prefix"),
        project_id: c.req.query("project_id"),
        subject_type: c.req.query("subject_type"),
        subject_id: c.req.query("subject_id"),
        from: c.req.query("from"),
        to: c.req.query("to"),
      }),
    ),
  ),
);
apiRoutes.post(
  "/time-series-points/batch",
  route(async (c) => c.json(await recordTimeSeriesPoints(ctx(c), await body(c)), 201)),
);
apiRoutes.post(
  "/time-series-points",
  route(async (c) => c.json(await recordTimeSeriesPoint(ctx(c), await body(c)), 201)),
);

apiRoutes.get(
  "/ingestion/connectors",
  route(async (c) => c.json(await listIngestionConnectors(ctx(c)))),
);
apiRoutes.post(
  "/ingestion/connectors",
  route(async (c) => c.json(await createIngestionConnector(ctx(c), await body(c)), 201)),
);
apiRoutes.patch(
  "/ingestion/connectors/:id",
  route(async (c) => c.json(await updateIngestionConnector(ctx(c), param(c, "id"), await body(c)))),
);
apiRoutes.get(
  "/ingestion/connectors/:id/runs",
  route(async (c) => c.json(await listIngestionRuns(ctx(c), param(c, "id")))),
);
apiRoutes.post(
  "/ingestion/connectors/:id/runs",
  route(async (c) => c.json(await recordIngestionRun(ctx(c), param(c, "id"), await body(c)), 201)),
);
apiRoutes.post(
  "/ingestion/connectors/:id/garmin-runs",
  route(async (c) => {
    const payload = await body(c);
    const dryRun = payload.dry_run === true;
    const runnerPayload =
      payload.runner_payload && typeof payload.runner_payload === "object"
        ? (payload.runner_payload as Record<string, unknown>)
        : payload;
    return c.json(
      await recordGarminRunnerPayload(ctx(c), param(c, "id"), runnerPayload, { dryRun }),
      dryRun ? 200 : 201,
    );
  }),
);

apiRoutes.put(
  "/ingestion/connectors/:id/credentials",
  route(async (c) => {
    const payload = await body(c);
    return c.json(
      await createOrReplaceConnectorCredentials(ctx(c), param(c, "id"), {
        auth_type: payload.auth_type as string | undefined,
        payload: (payload.payload as Record<string, unknown>) ?? {},
        status: payload.status as string | undefined,
        expires_at: payload.expires_at as number | undefined,
      }),
      200,
    );
  }),
);
apiRoutes.get(
  "/ingestion/connectors/:id/credentials",
  route(async (c) => c.json(await getCredentialStatus(ctx(c), param(c, "id")))),
);
apiRoutes.delete(
  "/ingestion/connectors/:id/credentials",
  route(async (c) => c.json(await deleteConnectorCredentials(ctx(c), param(c, "id")))),
);

apiRoutes.get(
  "/dependencies",
  route(async (c) =>
    c.json(
      await listDependencies(ctx(c), {
        entity_kind: String(c.req.query("entity_kind") ?? ""),
        entity_id: String(c.req.query("entity_id") ?? ""),
        direction: c.req.query("direction"),
        relationship: c.req.query("relationship"),
      }),
    ),
  ),
);
apiRoutes.post(
  "/dependencies",
  route(async (c) =>
    c.json(
      await createDependency(ctx(c), (await body(c)) as Parameters<typeof createDependency>[1]),
      201,
    ),
  ),
);
apiRoutes.delete(
  "/dependencies/:id",
  route(async (c) => c.json(await deleteDependency(ctx(c), param(c, "id")))),
);
apiRoutes.post(
  "/dependencies/stale",
  route(async (c) =>
    c.json(await markStale(ctx(c), (await body(c)) as Parameters<typeof markStale>[1])),
  ),
);
apiRoutes.get(
  "/dependencies/stale",
  route(async (c) =>
    c.json(
      await listStale(ctx(c), {
        kind: c.req.query("kind"),
        project_id: c.req.query("project_id"),
      }),
    ),
  ),
);

apiRoutes.post(
  "/shared",
  route(async (c) =>
    c.json(await setShared(ctx(c), (await body(c)) as Parameters<typeof setShared>[1])),
  ),
);

apiRoutes.get(
  "/recall",
  route(async (c) =>
    c.json(
      await recall(ctx(c), {
        query: c.req.query("q") ?? "",
        kinds: c.req.query("kinds")?.split(",").filter(Boolean),
        project_id: c.req.query("project_id"),
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      }),
    ),
  ),
);
