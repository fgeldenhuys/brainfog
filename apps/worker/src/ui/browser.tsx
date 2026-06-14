import { Hono } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../env";
import {
  addDocument,
  BROWSER_KINDS,
  type BrowseQuery,
  type BrowserKind,
  browseEntities,
  createProject,
  createTask,
  deleteDocument,
  deleteFact,
  deleteThought,
  getDocumentContent,
  getEntity,
  getEntityRelations,
  getSummary,
  graphKinds,
  isBrowserKind,
  labelForEntity,
  listProjects,
  MemoryError,
  recordFact,
  recordTimeSeriesPoint,
  remember,
  updateDocument,
  updateFact,
  updateTask,
  upsertPerson,
} from "../memory";
import {
  type AppContext,
  type AppVariables,
  fmtDate,
  Layout,
  memCtx,
  Pagination,
  Provenance,
  RelationsList,
} from "./layout";

export const browserRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const KIND_LABELS: Record<BrowserKind, string> = {
  projects: "Projects",
  people: "People",
  tasks: "Tasks",
  facts: "Facts",
  documents: "Documents",
  thoughts: "Thoughts",
  "time-series-points": "Time Series Points",
};

const KIND_SINGULAR: Record<BrowserKind, string> = {
  projects: "Project",
  people: "Person",
  tasks: "Task",
  facts: "Fact",
  documents: "Document",
  thoughts: "Thought",
  "time-series-points": "Time Series Point",
};

const COUNT_KEYS: Record<BrowserKind, string> = {
  projects: "projects",
  people: "people",
  tasks: "tasks",
  facts: "facts",
  documents: "documents",
  thoughts: "thoughts",
  "time-series-points": "time_series_points",
};

const EDITABLE_KINDS = new Set<BrowserKind>(["people", "tasks", "facts", "documents"]);
const DELETABLE_KINDS = new Set<BrowserKind>(["facts", "documents", "thoughts"]);

const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"];
const FACT_STATUSES = ["current", "superseded", "proven_wrong"];
const THOUGHT_TYPES = ["observation", "idea", "reference", "person_note"];

const COMMON_EXCLUDE = ["id", "ownerId", "source", "projectId", "createdAt", "updatedAt"];
const EXCLUDE_FIELDS: Record<BrowserKind, string[]> = {
  projects: [...COMMON_EXCLUDE, "name"],
  people: [...COMMON_EXCLUDE, "name"],
  tasks: [...COMMON_EXCLUDE, "title"],
  facts: [...COMMON_EXCLUDE, "statement", "supersedesFactId", "supersededByFactId"],
  documents: [...COMMON_EXCLUDE, "title", "r2Key"],
  thoughts: [...COMMON_EXCLUDE, "content"],
  "time-series-points": [...COMMON_EXCLUDE, "seriesKey"],
};

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function fieldLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return fmtDate(value);
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function truncate(text: string, max = 80): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function titleFor(kind: BrowserKind, row: Record<string, unknown>): string {
  switch (kind) {
    case "projects":
    case "people":
      return row.name as string;
    case "tasks":
      return row.title as string;
    case "facts":
      return row.statement as string;
    case "documents":
      return row.title as string;
    case "thoughts":
      return row.content as string;
    case "time-series-points":
      return row.seriesKey as string;
  }
}

function labelForDelete(kind: BrowserKind, row: Record<string, unknown>): string {
  switch (kind) {
    case "facts":
      return truncate(row.statement as string, 100);
    case "documents":
      return row.title as string;
    case "thoughts":
      return truncate(row.content as string, 100);
    default:
      return String(row.id);
  }
}

/** `<input type="date">` (YYYY-MM-DD) -> unix seconds. */
function dateInputToUnix(value?: string): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

function toUnixSecondsString(value?: string): string | undefined {
  const n = dateInputToUnix(value);
  return n === undefined ? undefined : String(n);
}

/** Unix-seconds Date -> `<input type="datetime-local">` value (YYYY-MM-DDTHH:mm). */
function dateToLocalInput(value?: Date | null): string {
  if (!value) return "";
  return value.toISOString().slice(0, 16);
}

function errorStatus(status: number): 400 | 403 | 404 | 409 {
  if (status === 403 || status === 404 || status === 409) return status;
  return 400;
}

/** Wraps a handler, rendering `MemoryError`s as an in-layout error page. */
const page = (fn: (c: AppContext) => Promise<Response>) => async (c: AppContext) => {
  try {
    return await fn(c);
  } catch (error) {
    if (error instanceof MemoryError) {
      return c.html(
        <Layout user={c.get("user")} currentPath={c.req.path}>
          <h2>Error</h2>
          <p class="error">{error.message}</p>
          <p>
            <a href="/app/browser">Back to Browser</a>
          </p>
        </Layout>,
        errorStatus(error.status),
      );
    }
    throw error;
  }
};

async function formBody(c: AppContext): Promise<Record<string, string>> {
  const parsed = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function req(form: Record<string, string>, key: string): string {
  const value = form[key];
  if (!value) throw new MemoryError(400, `missing ${key}`);
  return value;
}

function str(form: Record<string, string>, key: string): string | undefined {
  const value = form[key]?.trim();
  return value ? value : undefined;
}

function num(form: Record<string, string>, key: string): number | undefined {
  const value = str(form, key);
  return value === undefined ? undefined : Number(value);
}

function list(form: Record<string, string>, key: string): string[] | undefined {
  const value = form[key];
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

const ProjectSelect: FC<{
  projects: { id: string; name: string }[];
  value?: string | null;
}> = ({ projects, value }) => (
  <select name="project_id" id="project_id">
    <option value="">(none)</option>
    {projects.map((p) => (
      <option value={p.id} selected={p.id === value} key={p.id}>
        {p.name}
      </option>
    ))}
  </select>
);

const FieldList: FC<{ row: Record<string, unknown>; exclude: string[] }> = ({ row, exclude }) => (
  <div class="metadata">
    {Object.entries(row)
      .filter(([key]) => !exclude.includes(key))
      .map(([key, value]) => (
        <div key={key}>
          <strong>{fieldLabel(key)}:</strong> {renderValue(value)}
        </div>
      ))}
  </div>
);

type FilterQuery = { q?: string; project_id?: string; status?: string; from?: string; to?: string };

const FilterForm: FC<{
  kind: BrowserKind;
  query: FilterQuery;
  projects: { id: string; name: string }[];
}> = ({ kind, query, projects }) => {
  const hasProject = kind !== "projects" && kind !== "people";
  const statusOptions = kind === "tasks" ? TASK_STATUSES : kind === "facts" ? FACT_STATUSES : [];
  const hasDateRange = kind === "time-series-points";
  return (
    <form class="filters" method="get" action={`/app/browser/${kind}`}>
      <div>
        <label htmlFor="q">Search</label>
        <input type="text" name="q" id="q" value={query.q ?? ""} />
      </div>
      {hasProject ? (
        <div>
          <label htmlFor="project_id">Project</label>
          <ProjectSelect projects={projects} value={query.project_id} />
        </div>
      ) : null}
      {statusOptions.length ? (
        <div>
          <label htmlFor="status">Status</label>
          <select name="status" id="status">
            <option value="">(all)</option>
            {statusOptions.map((s) => (
              <option value={s} selected={s === query.status} key={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {hasDateRange ? (
        <>
          <div>
            <label htmlFor="from">From</label>
            <input type="date" name="from" id="from" value={query.from ?? ""} />
          </div>
          <div>
            <label htmlFor="to">To</label>
            <input type="date" name="to" id="to" value={query.to ?? ""} />
          </div>
        </>
      ) : null}
      <div>
        <button type="submit">Filter</button>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// List tables
// ---------------------------------------------------------------------------

function renderTable(
  kind: BrowserKind,
  rows: Record<string, unknown>[],
  projectMap: Map<string, string>,
) {
  const projectLink = (row: Record<string, unknown>) => {
    const id = row.projectId as string | null;
    if (!id) return "—";
    return <a href={`/app/browser/projects/${id}`}>{projectMap.get(id) ?? id}</a>;
  };

  switch (kind) {
    case "projects":
      return (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id as string}>
                <td>
                  <a href={`/app/browser/projects/${row.id}`}>{row.name as string}</a>
                </td>
                <td>{(row.description as string | null) ?? "—"}</td>
                <td>{fmtDate(row.createdAt as Date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "people":
      return (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Aliases</th>
              <th>Notes</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id as string}>
                <td>
                  <a href={`/app/browser/people/${row.id}`}>{row.name as string}</a>
                </td>
                <td>{((row.aliases as string[] | null) ?? []).join(", ") || "—"}</td>
                <td>{truncate((row.notes as string | null) ?? "", 60) || "—"}</td>
                <td>{fmtDate(row.createdAt as Date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "tasks":
      return (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Project</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id as string}>
                <td>
                  <a href={`/app/browser/tasks/${row.id}`}>{row.title as string}</a>
                </td>
                <td>{row.status as string}</td>
                <td>{row.priority as number}</td>
                <td>{projectLink(row)}</td>
                <td>{fmtDate(row.dueAt as Date | null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "facts":
      return (
        <table>
          <thead>
            <tr>
              <th>Statement</th>
              <th>Status</th>
              <th>Confidence</th>
              <th>Project</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id as string}>
                <td>
                  <a href={`/app/browser/facts/${row.id}`}>
                    {truncate(row.statement as string, 90)}
                  </a>
                </td>
                <td>{row.status as string}</td>
                <td>{row.confidence as number}</td>
                <td>{projectLink(row)}</td>
                <td>{fmtDate(row.createdAt as Date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "documents":
      return (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Type</th>
              <th>Chunks</th>
              <th>Project</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id as string}>
                <td>
                  <a href={`/app/documents/${row.id}`}>{row.title as string}</a>{" "}
                  <a href={`/app/browser/documents/${row.id}`}>(details)</a>
                </td>
                <td>{row.mimeType as string}</td>
                <td>{row.chunkCount as number}</td>
                <td>{projectLink(row)}</td>
                <td>{fmtDate(row.createdAt as Date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "thoughts":
      return (
        <table>
          <thead>
            <tr>
              <th>Content</th>
              <th>Type</th>
              <th>Project</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id as string}>
                <td>
                  <a href={`/app/browser/thoughts/${row.id}`}>
                    {truncate(row.content as string, 90)}
                  </a>
                </td>
                <td>{row.type as string}</td>
                <td>{projectLink(row)}</td>
                <td>{fmtDate(row.createdAt as Date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "time-series-points":
      return (
        <table>
          <thead>
            <tr>
              <th>Series</th>
              <th>Value</th>
              <th>Unit</th>
              <th>Project</th>
              <th>Observed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id as string}>
                <td>
                  <a href={`/app/browser/time-series-points/${row.id}`}>
                    {row.seriesKey as string}
                  </a>
                </td>
                <td>{renderValue(row.value)}</td>
                <td>{(row.unit as string | null) ?? "—"}</td>
                <td>{projectLink(row)}</td>
                <td>{fmtDate(row.observedAt as Date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

// ---------------------------------------------------------------------------
// Create forms
// ---------------------------------------------------------------------------

function renderCreateForm(kind: BrowserKind, projects: { id: string; name: string }[]) {
  const action = `/app/browser/${kind}/new`;
  switch (kind) {
    case "projects":
      return (
        <form method="post" action={action}>
          <label htmlFor="name">Name</label>
          <input type="text" name="name" id="name" required />
          <label htmlFor="description">Description</label>
          <textarea name="description" id="description" />
          <button type="submit">Create</button>
        </form>
      );
    case "people":
      return (
        <form method="post" action={action}>
          <label htmlFor="name">Name</label>
          <input type="text" name="name" id="name" required />
          <label htmlFor="aliases">Aliases (comma-separated)</label>
          <input type="text" name="aliases" id="aliases" />
          <label htmlFor="notes">Notes</label>
          <textarea name="notes" id="notes" />
          <button type="submit">Create</button>
        </form>
      );
    case "tasks":
      return (
        <form method="post" action={action}>
          <label htmlFor="title">Title</label>
          <input type="text" name="title" id="title" required />
          <label htmlFor="description">Description</label>
          <textarea name="description" id="description" />
          <label htmlFor="project_id">Project</label>
          <ProjectSelect projects={projects} />
          <label htmlFor="status">Status</label>
          <select name="status" id="status">
            {TASK_STATUSES.map((s) => (
              <option value={s} selected={s === "open"} key={s}>
                {s}
              </option>
            ))}
          </select>
          <label htmlFor="priority">Priority (0-1)</label>
          <input
            type="number"
            name="priority"
            id="priority"
            step="0.05"
            min="0"
            max="1"
            value="0.5"
          />
          <label htmlFor="due_at">Due</label>
          <input type="datetime-local" name="due_at" id="due_at" />
          <button type="submit">Create</button>
        </form>
      );
    case "facts":
      return (
        <form method="post" action={action}>
          <label htmlFor="statement">Statement</label>
          <textarea name="statement" id="statement" required />
          <label htmlFor="project_id">Project</label>
          <ProjectSelect projects={projects} />
          <label htmlFor="confidence">Confidence (0-1)</label>
          <input
            type="number"
            name="confidence"
            id="confidence"
            step="0.05"
            min="0"
            max="1"
            value="0.5"
          />
          <label htmlFor="citations">Citations (comma-separated)</label>
          <input type="text" name="citations" id="citations" />
          <label htmlFor="topics">Topics (comma-separated)</label>
          <input type="text" name="topics" id="topics" />
          <button type="submit">Create</button>
        </form>
      );
    case "documents":
      return (
        <form method="post" action={action}>
          <label htmlFor="title">Title</label>
          <input type="text" name="title" id="title" required />
          <label htmlFor="project_id">Project</label>
          <ProjectSelect projects={projects} />
          <label htmlFor="mime_type">Type</label>
          <select name="mime_type" id="mime_type">
            <option value="text/markdown" selected>
              Markdown
            </option>
            <option value="text/plain">Plain text</option>
          </select>
          <label htmlFor="content">Content</label>
          <textarea name="content" id="content" required />
          <button type="submit">Create</button>
        </form>
      );
    case "thoughts":
      return (
        <form method="post" action={action}>
          <label htmlFor="content">Content</label>
          <textarea name="content" id="content" required />
          <label htmlFor="type">Type</label>
          <select name="type" id="type">
            {THOUGHT_TYPES.map((t) => (
              <option value={t} selected={t === "observation"} key={t}>
                {t}
              </option>
            ))}
          </select>
          <label htmlFor="project_id">Project</label>
          <ProjectSelect projects={projects} />
          <button type="submit">Create</button>
        </form>
      );
    case "time-series-points":
      return (
        <form method="post" action={action}>
          <label htmlFor="series_key">Series Key</label>
          <input type="text" name="series_key" id="series_key" required />
          <label htmlFor="value">Value</label>
          <input type="number" name="value" id="value" step="any" />
          <label htmlFor="unit">Unit</label>
          <input type="text" name="unit" id="unit" />
          <label htmlFor="observed_at">Observed At</label>
          <input type="datetime-local" name="observed_at" id="observed_at" />
          <label htmlFor="project_id">Project</label>
          <ProjectSelect projects={projects} />
          <label htmlFor="subject_type">Subject Type</label>
          <select name="subject_type" id="subject_type">
            <option value="">(none)</option>
            {graphKinds.map((k) => (
              <option value={k} key={k}>
                {k}
              </option>
            ))}
          </select>
          <label htmlFor="subject_id">Subject ID</label>
          <input type="text" name="subject_id" id="subject_id" />
          <button type="submit">Create</button>
        </form>
      );
  }
}

// ---------------------------------------------------------------------------
// Edit forms (people, tasks, facts, documents)
// ---------------------------------------------------------------------------

function renderEditForm(
  kind: BrowserKind,
  id: string,
  row: Record<string, unknown>,
  projects: { id: string; name: string }[],
  documentContent?: string,
) {
  const action = `/app/browser/${kind}/${id}/edit`;
  switch (kind) {
    case "people":
      return (
        <form method="post" action={action}>
          <label htmlFor="name">Name</label>
          <input type="text" name="name" id="name" required value={row.name as string} />
          <label htmlFor="aliases">Aliases (comma-separated)</label>
          <input
            type="text"
            name="aliases"
            id="aliases"
            value={((row.aliases as string[] | null) ?? []).join(", ")}
          />
          <label htmlFor="notes">Notes</label>
          <textarea name="notes" id="notes">
            {(row.notes as string | null) ?? ""}
          </textarea>
          <button type="submit">Save</button>
        </form>
      );
    case "tasks":
      return (
        <form method="post" action={action}>
          <label htmlFor="title">Title</label>
          <input type="text" name="title" id="title" required value={row.title as string} />
          <label htmlFor="description">Description</label>
          <textarea name="description" id="description">
            {(row.description as string | null) ?? ""}
          </textarea>
          <label htmlFor="project_id">Project</label>
          <ProjectSelect projects={projects} value={row.projectId as string | null} />
          <label htmlFor="status">Status</label>
          <select name="status" id="status">
            {TASK_STATUSES.map((s) => (
              <option value={s} selected={s === row.status} key={s}>
                {s}
              </option>
            ))}
          </select>
          <label htmlFor="priority">Priority (0-1)</label>
          <input
            type="number"
            name="priority"
            id="priority"
            step="0.05"
            min="0"
            max="1"
            value={row.priority as number}
          />
          <label htmlFor="due_at">Due</label>
          <input
            type="datetime-local"
            name="due_at"
            id="due_at"
            value={dateToLocalInput(row.dueAt as Date | null)}
          />
          <button type="submit">Save</button>
        </form>
      );
    case "facts": {
      const topics =
        ((row.metadata as Record<string, unknown> | null)?.topics as string[] | undefined) ?? [];
      return (
        <form method="post" action={action}>
          <label htmlFor="statement">Statement</label>
          <textarea name="statement" id="statement" required>
            {row.statement as string}
          </textarea>
          <label htmlFor="status">Status</label>
          <select name="status" id="status">
            {FACT_STATUSES.map((s) => (
              <option value={s} selected={s === row.status} key={s}>
                {s}
              </option>
            ))}
          </select>
          <label htmlFor="confidence">Confidence (0-1)</label>
          <input
            type="number"
            name="confidence"
            id="confidence"
            step="0.05"
            min="0"
            max="1"
            value={row.confidence as number}
          />
          <label htmlFor="citations">Citations (comma-separated)</label>
          <input
            type="text"
            name="citations"
            id="citations"
            value={((row.citations as string[] | null) ?? []).join(", ")}
          />
          <label htmlFor="topics">Topics (comma-separated)</label>
          <input type="text" name="topics" id="topics" value={topics.join(", ")} />
          <button type="submit">Save</button>
        </form>
      );
    }
    case "documents":
      return (
        <form method="post" action={action}>
          <label htmlFor="content">Content</label>
          <textarea name="content" id="content" required>
            {documentContent ?? ""}
          </textarea>
          <button type="submit">Save</button>
        </form>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /app/browser - index of kinds with counts
browserRoutes.get(
  "/",
  page(async (c) => {
    const ctx = memCtx(c);
    const summary = await getSummary(ctx);
    const counts = summary.counts as unknown as Record<string, number>;
    return c.html(
      <Layout user={c.get("user")} currentPath={c.req.path}>
        <h2>Data Browser</h2>
        <div class="grid">
          {BROWSER_KINDS.map((kind) => (
            <div class="card" key={kind}>
              <h3>
                <a href={`/app/browser/${kind}`}>{KIND_LABELS[kind]}</a>
              </h3>
              <p>{counts[COUNT_KEYS[kind]] ?? 0}</p>
              <div class="button-group">
                <a href={`/app/browser/${kind}/new`}>New {KIND_SINGULAR[kind]}</a>
              </div>
            </div>
          ))}
        </div>
      </Layout>,
    );
  }),
);

// GET /app/browser/:kind/new - create form
browserRoutes.get(
  "/:kind/new",
  page(async (c) => {
    const kind = c.req.param("kind");
    if (!kind || !isBrowserKind(kind)) return c.notFound();
    const ctx = memCtx(c);
    const projects = await listProjects(ctx);
    return c.html(
      <Layout user={c.get("user")} currentPath={c.req.path}>
        <h2>New {KIND_SINGULAR[kind]}</h2>
        {renderCreateForm(kind, projects)}
        <p>
          <a href={`/app/browser/${kind}`}>Cancel</a>
        </p>
      </Layout>,
    );
  }),
);

// POST /app/browser/:kind/new - create action
browserRoutes.post(
  "/:kind/new",
  page(async (c) => {
    const kind = c.req.param("kind");
    if (!kind || !isBrowserKind(kind)) return c.notFound();
    const ctx = memCtx(c);
    const form = await formBody(c);
    let id: string;
    switch (kind) {
      case "projects": {
        const row = await createProject(ctx, {
          name: req(form, "name"),
          description: str(form, "description") ?? null,
        });
        id = row.id;
        break;
      }
      case "people": {
        const row = await upsertPerson(ctx, {
          name: req(form, "name"),
          aliases: list(form, "aliases"),
          notes: str(form, "notes") ?? null,
        });
        id = row.id;
        break;
      }
      case "tasks": {
        const row = await createTask(ctx, {
          title: req(form, "title"),
          description: str(form, "description"),
          project_id: str(form, "project_id"),
          status: str(form, "status"),
          priority: num(form, "priority"),
          due_at: dateInputToUnix(form.due_at),
        });
        id = row.id;
        break;
      }
      case "facts": {
        const row = await recordFact(ctx, {
          statement: req(form, "statement"),
          project_id: str(form, "project_id"),
          confidence: num(form, "confidence"),
          citations: list(form, "citations"),
          topics: list(form, "topics"),
        });
        id = row.id;
        break;
      }
      case "documents": {
        const row = await addDocument(ctx, {
          title: req(form, "title"),
          content: req(form, "content"),
          project_id: str(form, "project_id"),
          mime_type: str(form, "mime_type"),
        });
        id = row.id;
        break;
      }
      case "thoughts": {
        const row = await remember(ctx, {
          content: req(form, "content"),
          type: str(form, "type"),
          project_id: str(form, "project_id"),
        });
        id = row.id;
        break;
      }
      case "time-series-points": {
        const row = await recordTimeSeriesPoint(ctx, {
          series_key: req(form, "series_key"),
          value: str(form, "value"),
          unit: str(form, "unit"),
          observed_at: dateInputToUnix(form.observed_at),
          project_id: str(form, "project_id"),
          subject_type: str(form, "subject_type"),
          subject_id: str(form, "subject_id"),
        });
        id = row.id;
        break;
      }
    }
    return c.redirect(`/app/browser/${kind}/${id}`);
  }),
);

// GET /app/browser/:kind/:id/edit - edit form (people/tasks/facts/documents)
browserRoutes.get(
  "/:kind/:id/edit",
  page(async (c) => {
    const kind = c.req.param("kind");
    const id = c.req.param("id");
    if (!kind || !isBrowserKind(kind) || !id || !EDITABLE_KINDS.has(kind)) return c.notFound();
    const ctx = memCtx(c);
    const row = await getEntity(ctx, kind, id);
    const projects = await listProjects(ctx);
    let documentContent: string | undefined;
    if (kind === "documents") {
      documentContent = (await getDocumentContent(ctx, id)).content;
    }
    return c.html(
      <Layout user={c.get("user")} currentPath={c.req.path}>
        <h2>Edit {KIND_SINGULAR[kind]}</h2>
        {renderEditForm(kind, id, row, projects, documentContent)}
        <p>
          <a href={`/app/browser/${kind}/${id}`}>Cancel</a>
        </p>
      </Layout>,
    );
  }),
);

// POST /app/browser/:kind/:id/edit - update action
browserRoutes.post(
  "/:kind/:id/edit",
  page(async (c) => {
    const kind = c.req.param("kind");
    const id = c.req.param("id");
    if (!kind || !isBrowserKind(kind) || !id || !EDITABLE_KINDS.has(kind)) return c.notFound();
    const ctx = memCtx(c);
    const form = await formBody(c);
    switch (kind) {
      case "people":
        await upsertPerson(ctx, {
          id,
          name: req(form, "name"),
          aliases: list(form, "aliases"),
          notes: str(form, "notes") ?? null,
        });
        break;
      case "tasks":
        await updateTask(ctx, id, {
          title: req(form, "title"),
          description: str(form, "description") ?? null,
          project_id: str(form, "project_id") ?? null,
          status: str(form, "status"),
          priority: num(form, "priority"),
          due_at: dateInputToUnix(form.due_at),
        });
        break;
      case "facts":
        await updateFact(ctx, id, {
          statement: req(form, "statement"),
          status: str(form, "status"),
          confidence: num(form, "confidence"),
          citations: list(form, "citations"),
          topics: list(form, "topics"),
        });
        break;
      case "documents":
        await updateDocument(ctx, id, req(form, "content"));
        break;
    }
    return c.redirect(`/app/browser/${kind}/${id}`);
  }),
);

// GET /app/browser/:kind/:id/delete - delete confirmation (facts/documents/thoughts)
browserRoutes.get(
  "/:kind/:id/delete",
  page(async (c) => {
    const kind = c.req.param("kind");
    const id = c.req.param("id");
    if (!kind || !isBrowserKind(kind) || !id || !DELETABLE_KINDS.has(kind)) return c.notFound();
    const ctx = memCtx(c);
    const row = await getEntity(ctx, kind, id);
    return c.html(
      <Layout user={c.get("user")} currentPath={c.req.path}>
        <h2>Delete {KIND_SINGULAR[kind]}</h2>
        <p>
          Are you sure you want to delete <strong>{labelForDelete(kind, row)}</strong>? This cannot
          be undone.
        </p>
        <form method="post" action={`/app/browser/${kind}/${id}/delete`} class="inline">
          <button type="submit" class="danger">
            Delete
          </button>{" "}
          <a href={`/app/browser/${kind}/${id}`}>Cancel</a>
        </form>
      </Layout>,
    );
  }),
);

// POST /app/browser/:kind/:id/delete - delete action
browserRoutes.post(
  "/:kind/:id/delete",
  page(async (c) => {
    const kind = c.req.param("kind");
    const id = c.req.param("id");
    if (!kind || !isBrowserKind(kind) || !id || !DELETABLE_KINDS.has(kind)) return c.notFound();
    const ctx = memCtx(c);
    switch (kind) {
      case "facts":
        await deleteFact(ctx, id);
        break;
      case "documents":
        await deleteDocument(ctx, id);
        break;
      case "thoughts":
        await deleteThought(ctx, id);
        break;
    }
    return c.redirect(`/app/browser/${kind}`);
  }),
);

// GET /app/browser/:kind - filtered, paginated list
browserRoutes.get(
  "/:kind",
  page(async (c) => {
    const kind = c.req.param("kind");
    if (!kind || !isBrowserKind(kind)) return c.notFound();
    const ctx = memCtx(c);
    const rawQuery: FilterQuery = {
      q: c.req.query("q") || undefined,
      project_id: c.req.query("project_id") || undefined,
      status: c.req.query("status") || undefined,
      from: c.req.query("from") || undefined,
      to: c.req.query("to") || undefined,
    };
    const page_ = c.req.query("page");
    const perPage = c.req.query("per_page");
    const browseQuery: BrowseQuery = {
      page: page_ ? Number(page_) : undefined,
      per_page: perPage ? Number(perPage) : undefined,
      q: rawQuery.q,
      project_id: rawQuery.project_id,
      status: rawQuery.status,
      from: toUnixSecondsString(rawQuery.from),
      to: toUnixSecondsString(rawQuery.to),
    };
    const [result, projects] = await Promise.all([
      browseEntities(ctx, kind, browseQuery),
      listProjects(ctx),
    ]);
    const projectMap = new Map(projects.map((p) => [p.id, p.name]));
    return c.html(
      <Layout user={c.get("user")} currentPath={c.req.path}>
        <p>
          <a href="/app/browser">← Back to Browser</a>
        </p>
        <h2>{KIND_LABELS[kind]}</h2>
        <div class="button-group">
          <a href={`/app/browser/${kind}/new`}>New {KIND_SINGULAR[kind]}</a>
        </div>
        <FilterForm kind={kind} query={rawQuery} projects={projects} />
        <div class="table-wrap">{renderTable(kind, result.rows, projectMap)}</div>
        <Pagination
          basePath={`/app/browser/${kind}`}
          page={result.page}
          perPage={result.per_page}
          total={result.total}
          extraQuery={rawQuery}
        />
      </Layout>,
    );
  }),
);

// GET /app/browser/:kind/:id - detail page
browserRoutes.get(
  "/:kind/:id",
  page(async (c) => {
    const kind = c.req.param("kind");
    const id = c.req.param("id");
    if (!kind || !isBrowserKind(kind) || !id) return c.notFound();
    const ctx = memCtx(c);
    const [row, relations, projects] = await Promise.all([
      getEntity(ctx, kind, id),
      getEntityRelations(ctx, kind, id),
      listProjects(ctx),
    ]);
    const projectMap = new Map(projects.map((p) => [p.id, p.name]));
    const projectId = (row.projectId as string | null) ?? null;

    let supersedesLabel: string | null = null;
    let supersededByLabel: string | null = null;
    if (kind === "facts") {
      if (row.supersedesFactId)
        supersedesLabel = await labelForEntity(ctx, "fact", row.supersedesFactId as string);
      if (row.supersededByFactId)
        supersededByLabel = await labelForEntity(ctx, "fact", row.supersededByFactId as string);
    }

    return c.html(
      <Layout user={c.get("user")} currentPath={c.req.path}>
        <p>
          <a href={`/app/browser/${kind}`}>← Back to {KIND_LABELS[kind]}</a>
        </p>
        <h2>{titleFor(kind, row)}</h2>
        <FieldList row={row} exclude={EXCLUDE_FIELDS[kind]} />
        {kind === "facts" ? (
          <div class="metadata">
            <div>
              Supersedes:{" "}
              {row.supersedesFactId ? (
                <a href={`/app/browser/facts/${row.supersedesFactId}`}>{supersedesLabel}</a>
              ) : (
                "none"
              )}
            </div>
            <div>
              Superseded by:{" "}
              {row.supersededByFactId ? (
                <a href={`/app/browser/facts/${row.supersededByFactId}`}>{supersededByLabel}</a>
              ) : (
                "none"
              )}
            </div>
          </div>
        ) : null}
        <Provenance
          source={row.source as string | null}
          projectId={projectId}
          projectLabel={projectId ? (projectMap.get(projectId) ?? projectId) : null}
          createdAt={row.createdAt as Date | undefined}
          updatedAt={row.updatedAt as Date | undefined}
        />
        <h3>Related</h3>
        <RelationsList relations={relations} />
        <div class="button-group">
          {EDITABLE_KINDS.has(kind) ? <a href={`/app/browser/${kind}/${id}/edit`}>Edit</a> : null}
          {DELETABLE_KINDS.has(kind) ? (
            <a href={`/app/browser/${kind}/${id}/delete`} class="danger">
              Delete
            </a>
          ) : null}
          {kind === "documents" ? (
            <>
              <a href={`/app/documents/${id}`}>Open Reader</a>
              <a href={`/app/documents/${id}/raw`}>Raw</a>
            </>
          ) : null}
        </div>
      </Layout>,
    );
  }),
);
