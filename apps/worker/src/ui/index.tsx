import { createDb, documents } from "@brainfog/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { raw } from "hono/html";
import type { FC } from "hono/jsx";
import { getCredentialStatus } from "../credentials";
import type { Env } from "../env";
import { getConnector, listIngestionConnectors, listIngestionRuns } from "../ingestion";
import { escapeHtml, markdownToHtml } from "../markdown";
import {
  createUser,
  createUserToken,
  getDocumentContent,
  getEntity,
  getEntityRelations,
  getMetrics,
  getSummary,
  listProjects,
  listUsers,
  listUserTokens,
  MemoryError,
  recall,
  revokeToken,
  updateUser,
} from "../memory";
import {
  createPage,
  createPageAccessLink,
  deletePage,
  exchangePageAccess,
  findPublishedPageByPath,
  getPage,
  listPageAccessLinks,
  listPages,
  previewPage,
  renderPage,
  revokePageAccessLink,
  updatePage,
  validatePageAccessCookie,
} from "../pages";
import { assetRoutes } from "./assets";
import { browserRoutes } from "./browser";
import {
  type AppContext,
  type AppVariables,
  findUserByToken,
  fmtDate,
  Layout,
  memCtx,
  Provenance,
  RelationsList,
  TOKEN_COOKIE,
  type UserRow,
} from "./layout";

export const uiRoutes = new Hono<{ Bindings: Env }>();

const TokenForm: FC<{ error?: string }> = ({ error }) => (
  <form method="post" action="/" hx-boost="false">
    {error ? <p class="error">{error}</p> : null}
    <label htmlFor="token">Bearer token</label>
    <input type="password" id="token" name="token" required />
    <button type="submit">Sign in</button>
  </form>
);

// GET / - Login page or redirect to /app
uiRoutes.get("/", async (c) => {
  const token = getCookie(c, TOKEN_COOKIE);
  if (token) {
    const user = await findUserByToken(c.env, token);
    if (user) {
      return c.redirect("/app");
    }
  }
  return c.html(
    <Layout currentPath="/">
      <TokenForm />
    </Layout>,
  );
});

// POST / - Token form submission
uiRoutes.post("/", async (c) => {
  const body = await c.req.parseBody();
  const token = typeof body.token === "string" ? body.token : "";
  const user = await findUserByToken(c.env, token);
  if (!user) {
    return c.html(
      <Layout currentPath="/">
        <TokenForm error="Invalid token." />
      </Layout>,
      401,
    );
  }

  setCookie(c, TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
  });

  return c.redirect("/app");
});

// Mount assets publicly (no auth required)
uiRoutes.route("/assets", assetRoutes);

// Middleware to check authenticated cookie
const appRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

appRoutes.use("*", async (c: AppContext, next) => {
  const token = getCookie(c, TOKEN_COOKIE);
  if (!token) {
    return c.redirect("/");
  }
  const user = await findUserByToken(c.env, token);
  if (!user) {
    return c.redirect("/");
  }
  c.set("user", user);
  await next();
});

function errorStatus(status: number): 400 | 403 | 404 | 409 {
  if (status === 403 || status === 404 || status === 409) return status;
  return 400;
}

// Helper for rendering error pages
const errorPageContent = (user: UserRow, title: string, message: string) => (
  <Layout user={user} currentPath="/app">
    <h2>{title}</h2>
    <p class="error">{message}</p>
  </Layout>
);

async function formBody(c: AppContext): Promise<Record<string, string>> {
  const parsed = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function asBool(value: string | undefined) {
  return value === "on" || value === "true" || value === "1";
}

function dateInputToUnix(value?: string): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : String(Math.floor(t / 1000));
}

function metricBar(count: number, max: number) {
  const width = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  return (
    <span
      style={{ display: "inline-block", width: `${width}%`, background: "#333", height: "0.6rem" }}
    />
  );
}

function isMarkdown(mimeType?: string | null) {
  const type = (mimeType ?? "").toLowerCase();
  return type.includes("markdown") || type === "text/md" || type === "text/x-markdown";
}

function isTextMime(mimeType?: string | null) {
  if (!mimeType) return true;
  const type = mimeType.toLowerCase();
  if (type.startsWith("text/")) return true;
  if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/"))
    return false;
  if (type.startsWith("application/")) {
    const sub = type.slice(12);
    if (
      ["json", "xml", "yaml", "javascript", "ecmascript", "typescript"].some(
        (t) => sub.includes(t) || sub === t,
      )
    )
      return true;
    return false;
  }
  return true;
}

async function usersWithTokens(ctx: ReturnType<typeof memCtx>) {
  const rows = await listUsers(ctx);
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      tokens: await listUserTokens(ctx, row.id),
    })),
  );
}

async function usersPage(c: AppContext, issuedToken?: string) {
  const user = c.get("user");
  if (!user.isAdmin) {
    return c.html(
      <Layout user={user} currentPath="/app/users">
        <h2>Forbidden</h2>
        <p>You do not have permission to manage users.</p>
      </Layout>,
      403,
    );
  }
  const users = await usersWithTokens(memCtx(c));
  return c.html(
    <Layout user={user} currentPath="/app/users">
      <h2>User Management</h2>
      {issuedToken ? (
        <div class="card success">
          <h3>Token issued</h3>
          <p>This plaintext token is shown once. It is not stored and will not appear again.</p>
          <pre>{issuedToken}</pre>
        </div>
      ) : null}
      <div class="card">
        <h3>Create user</h3>
        <form method="post" action="/app/users">
          <label htmlFor="name">Name</label>
          <input id="name" name="name" required />
          <label htmlFor="slug">Slug</label>
          <input id="slug" name="slug" pattern="[a-z0-9-]+" />
          <label>
            <input type="checkbox" name="is_admin" value="on" style={{ width: "auto" }} /> Admin
          </label>
          <button type="submit">Create user</button>
        </form>
      </div>
      <div class="card">
        <h3>Known users</h3>
        <table>
          <thead>
            <tr>
              <th>Edit</th>
              <th>Slug</th>
              <th>Role</th>
              <th>Tokens</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row) => (
              <tr key={row.id}>
                <td>
                  <form method="post" action={`/app/users/${row.id}`}>
                    <input name="name" value={row.name} aria-label={`Name for ${row.name}`} />
                    <input name="slug" value={row.slug ?? ""} aria-label={`Slug for ${row.name}`} />
                    <label>
                      <input
                        type="checkbox"
                        name="is_admin"
                        value="on"
                        checked={row.isAdmin}
                        style={{ width: "auto" }}
                      />{" "}
                      admin
                    </label>
                    <button type="submit">Save</button>
                  </form>
                </td>
                <td>{row.slug ?? "—"}</td>
                <td>{row.isAdmin ? "admin" : "user"}</td>
                <td>
                  {row.tokens.length ? (
                    <ul>
                      {row.tokens.map((token) => (
                        <li key={token.id}>
                          <code>{token.id}</code> created {fmtDate(token.createdAt)}, last used{" "}
                          {fmtDate(token.lastUsedAt)}
                          <form
                            method="post"
                            action={`/app/tokens/${token.id}/delete`}
                            class="inline"
                          >
                            <button type="submit" class="danger">
                              Revoke
                            </button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "none"
                  )}
                </td>
                <td>
                  <form method="post" action={`/app/users/${row.id}/tokens`} class="inline">
                    <button type="submit">Issue token</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
}

function adminOnly(c: AppContext) {
  if (c.get("user").isAdmin) return null;
  return c.html(
    <Layout user={c.get("user")} currentPath="/app/users">
      <h2>Forbidden</h2>
      <p>You do not have permission to manage users.</p>
    </Layout>,
    403,
  );
}

function param(c: AppContext, name: string) {
  const value = c.req.param(name);
  if (!value) throw new MemoryError(400, `missing ${name}`);
  return value;
}

function parseQueries(value: string | undefined) {
  if (!value?.trim()) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new MemoryError(400, "Queries must be valid JSON.");
  }
}

const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|token|secret|cookie|session|credential|authorization|bearer|encrypted|encryption|iv|payload|username|user[_-]?name|email|e[_-]?mail|login|account|garmin[_-]?(user|login|email)|oauth|refresh|access[_-]?token)/i;
const SENSITIVE_VALUE_PATTERN =
  /([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|bearer\s+[a-z0-9._~+/-]+=*|password\s*[:=]|passwd\s*[:=]|pwd\s*[:=]|token\s*[:=]|session\s*[:=]|cookie\s*[:=]|secret\s*[:=]|credential\s*[:=]|authorization\s*[:=]|login\s*[:=]|username\s*[:=]|email\s*[:=]|sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_]{12,}|xox[baprs]-[a-z0-9-]{12,}|eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)/i;

function safeDisplayJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => safeDisplayJson(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out["[redacted]"] = "[redacted]";
      } else {
        out[key] = safeDisplayJson(item);
      }
    }
    return out;
  }
  if (typeof value === "string" && SENSITIVE_VALUE_PATTERN.test(value)) return "[redacted]";
  return value;
}

function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>—</span>;
  return <pre>{JSON.stringify(safeDisplayJson(value), null, 2)}</pre>;
}

function CredentialStatus({ status }: { status: Record<string, unknown> | null }) {
  if (!status) return <p>No credential status is stored for this connector.</p>;
  return (
    <div class="metadata">
      <div>Status: {String(status.status ?? "—")}</div>
      <div>Auth type: {String(status.auth_type ?? "—")}</div>
      <div>
        Expires:{" "}
        {typeof status.expires_at === "number" ? fmtDate(new Date(status.expires_at * 1000)) : "—"}
      </div>
      <div>
        Last verified:{" "}
        {typeof status.last_verified_at === "number"
          ? fmtDate(new Date(status.last_verified_at * 1000))
          : "—"}
      </div>
      <div>
        Updated:{" "}
        {typeof status.updated_at === "number" ? fmtDate(new Date(status.updated_at * 1000)) : "—"}
      </div>
    </div>
  );
}

async function optionalCredentialStatus(c: AppContext, connectorId: string) {
  try {
    return await getCredentialStatus(memCtx(c), connectorId);
  } catch (error) {
    if (error instanceof MemoryError && error.status === 404) return null;
    throw error;
  }
}

function connectorProject(
  projects: Awaited<ReturnType<typeof listProjects>>,
  projectId?: string | null,
) {
  return projectId ? projects.find((project) => project.id === projectId) : null;
}

function PageForm(props: {
  page?: Awaited<ReturnType<typeof getPage>>;
  action: string;
  error?: string;
}) {
  const page = props.page;
  return (
    <form method="post" action={props.action} style={{ maxWidth: "none" }}>
      {props.error ? <p class="error">{props.error}</p> : null}
      <label htmlFor="title">Title</label>
      <input id="title" name="title" value={page?.title ?? ""} required />
      <label htmlFor="slug">Slug</label>
      <input id="slug" name="slug" value={page?.slug ?? ""} pattern="[a-z0-9-]+" required />
      <label htmlFor="description">Description</label>
      <input id="description" name="description" value={page?.description ?? ""} />
      <label htmlFor="status">Status</label>
      <select id="status" name="status">
        {(["draft", "published", "archived"] as const).map((status) => (
          <option value={status} selected={(page?.status ?? "draft") === status}>
            {status}
          </option>
        ))}
      </select>
      <label htmlFor="template">Template</label>
      <textarea id="template" name="template" required>
        {page?.template ??
          "<section><h1>{{page.title}}</h1>{{#items}}<p>{{content}}</p>{{/items}}</section>"}
      </textarea>
      <label htmlFor="queries">Queries JSON</label>
      <textarea id="queries" name="queries" required>
        {JSON.stringify(
          page?.queries ?? {
            items: { kind: "thoughts", limit: 10, transforms: ["date_labels", "excerpts"] },
          },
          null,
          2,
        )}
      </textarea>
      <div class="button-group">
        <button type="submit">Save</button>
        {page ? (
          <button type="submit" formaction={`/app/pages/${page.id}/preview`}>
            Preview
          </button>
        ) : null}
      </div>
    </form>
  );
}

type RecallResult = { kind: string; score: number; row: Record<string, unknown> };

// GET /app - Home page with summary dashboard
appRoutes.get("/", async (c: AppContext) => {
  const user = c.get("user");
  try {
    const [summary, tokens] = await Promise.all([
      getSummary(memCtx(c)),
      listUserTokens(memCtx(c), user.id),
    ]);

    return c.html(
      <Layout user={user} currentPath="/app">
        <h2>Welcome, {user.name}</h2>

        {/* Your account card */}
        <div class="card">
          <h3>Your account</h3>
          <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: "0.5rem" }}>
            <strong>Name:</strong>
            <span>{user.name}</span>
            <strong>Handle:</strong>
            <span>{user.slug ?? "—"}</span>
            <strong>Role:</strong>
            <span>{user.isAdmin ? "Admin" : "User"}</span>
          </div>
        </div>

        {/* Your tokens section */}
        <div class="card">
          <h3>Your tokens</h3>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f5f5f5" }}>
                  <th
                    style={{
                      padding: "0.75rem",
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                    }}
                  >
                    Token ID
                  </th>
                  <th
                    style={{
                      padding: "0.75rem",
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                    }}
                  >
                    Created
                  </th>
                  <th
                    style={{
                      padding: "0.75rem",
                      textAlign: "left",
                      borderBottom: "1px solid #ddd",
                    }}
                  >
                    Last Used
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens && tokens.length > 0 ? (
                  tokens.map((token) => (
                    <tr key={token.id} style={{ borderBottom: "1px solid #ddd" }}>
                      <td style={{ padding: "0.75rem" }}>
                        <code style={{ fontSize: "0.85rem" }}>{token.id.slice(0, 8)}...</code>
                      </td>
                      <td style={{ padding: "0.75rem" }}>{fmtDate(token.createdAt)}</td>
                      <td style={{ padding: "0.75rem" }}>
                        {token.lastUsedAt ? fmtDate(token.lastUsedAt) : "never"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} style={{ padding: "1rem", textAlign: "center", color: "#999" }}>
                      No tokens yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Summary dashboard - entity counts */}
        <h3 style={{ marginTop: "2rem", marginBottom: "1rem" }}>Summary</h3>
        <div class="grid">
          {[
            { kind: "projects", label: "Projects" },
            { kind: "people", label: "People" },
            { kind: "tasks", label: "Tasks" },
            { kind: "facts", label: "Facts" },
            { kind: "documents", label: "Documents" },
            { kind: "thoughts", label: "Thoughts" },
            { kind: "time_series_points", label: "Time Series Points" },
          ].map((item) => {
            const count = (summary.counts as Record<string, number | undefined>)[item.kind] ?? 0;
            const kindPath = item.kind === "time_series_points" ? "time-series-points" : item.kind;
            return (
              <div class="card" key={item.kind}>
                <h4 style={{ marginBottom: "0.5rem" }}>
                  <a href={`/app/browser/${kindPath}`}>{item.label}</a>
                </h4>
                <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{count}</div>
              </div>
            );
          })}
        </div>

        {/* Task and fact status breakdown */}
        <div class="grid" style={{ marginTop: "1rem" }}>
          <div class="card">
            <h4>Task status</h4>
            {Object.entries(summary.task_status as Record<string, number>).map(
              ([status, count]) => (
                <div key={status} style={{ marginBottom: "0.25rem" }}>
                  <span class="tag">{status}</span>
                  <span>{count}</span>
                </div>
              ),
            )}
          </div>
          <div class="card">
            <h4>Fact status</h4>
            {Object.entries(summary.fact_status as Record<string, number>).map(
              ([status, count]) => (
                <div key={status} style={{ marginBottom: "0.25rem" }}>
                  <span class="tag">{status}</span>
                  <span>{count}</span>
                </div>
              ),
            )}
          </div>
          <div class="card">
            <h4>Recall index</h4>
            <div style={{ marginBottom: "0.5rem" }}>
              <strong>Chunks:</strong> {summary.chunks}
            </div>
            <div>
              <strong>Recallable:</strong> {summary.recallable}
            </div>
          </div>
        </div>

        {/* Recent activity */}
        <h3 style={{ marginTop: "2rem", marginBottom: "1rem" }}>Recent activity</h3>
        {summary.recent && summary.recent.length > 0 ? (
          <ul style={{ listStyleType: "none", padding: 0 }}>
            {summary.recent.slice(0, 10).map((item) => (
              <li key={item.id} style={{ marginBottom: "0.5rem", padding: "0.5rem 0" }}>
                {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}{" "}
                <span style={{ color: "#999", fontSize: "0.9rem" }}>
                  {fmtDate(item.created_at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ color: "#999" }}>No recent activity</p>
        )}

        {/* Quick navigation */}
        <div class="button-group" style={{ marginTop: "2rem" }}>
          <a
            href="/app/browser"
            style={{
              padding: "0.75rem 1.5rem",
              background: "#333",
              color: "white",
              borderRadius: "4px",
              textDecoration: "none",
            }}
          >
            Browse data
          </a>
          <a
            href="/app/search"
            style={{
              padding: "0.75rem 1.5rem",
              background: "#333",
              color: "white",
              borderRadius: "4px",
              textDecoration: "none",
            }}
          >
            Search
          </a>
          <a
            href="/app/metrics"
            style={{
              padding: "0.75rem 1.5rem",
              background: "#333",
              color: "white",
              borderRadius: "4px",
              textDecoration: "none",
            }}
          >
            Metrics
          </a>
          <a
            href="/app/connectors"
            style={{
              padding: "0.75rem 1.5rem",
              background: "#333",
              color: "white",
              borderRadius: "4px",
              textDecoration: "none",
            }}
          >
            Connectors
          </a>
          {user.isAdmin ? (
            <a
              href="/app/users"
              style={{
                padding: "0.75rem 1.5rem",
                background: "#333",
                color: "white",
                borderRadius: "4px",
                textDecoration: "none",
              }}
            >
              Users
            </a>
          ) : null}
        </div>
      </Layout>,
    );
  } catch (err) {
    if (err instanceof MemoryError) {
      return c.html(errorPageContent(user, "Error", err.message), errorStatus(err.status));
    }
    throw err;
  }
});

// Mount browserRoutes at /browser
appRoutes.route("/browser", browserRoutes);

// GET /app/search - Recall search
appRoutes.get("/search", async (c: AppContext) => {
  const user = c.get("user");
  const query = c.req.query("q")?.trim() ?? "";
  const projectId = c.req.query("project_id") || undefined;
  const ctx = memCtx(c);
  const [projects, results] = await Promise.all([
    listProjects(ctx),
    query
      ? (recall(ctx, { query, project_id: projectId, limit: 20 }) as Promise<RecallResult[]>)
      : Promise.resolve([] as RecallResult[]),
  ]);
  return c.html(
    <Layout user={user} currentPath="/app/search">
      <h2>Recall search</h2>
      <form method="get" action="/app/search" class="filters">
        <div>
          <label htmlFor="q">Query</label>
          <input type="search" id="q" name="q" value={query} required />
        </div>
        <div>
          <label htmlFor="project_id">Project</label>
          <select id="project_id" name="project_id">
            <option value="">All projects</option>
            {projects.map((project) => (
              <option value={project.id} selected={project.id === projectId} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit">Search</button>
      </form>
      {query ? (
        <div class="card">
          <h3>Results</h3>
          {results.length ? (
            <ul>
              {results.map((result) => {
                const row = result.row as Record<string, unknown>;
                const label =
                  result.kind === "fact"
                    ? String(row.statement)
                    : result.kind === "thought"
                      ? String(row.content)
                      : String(row.content ?? row.id);
                const href =
                  result.kind === "fact"
                    ? `/app/browser/facts/${row.id}`
                    : result.kind === "thought"
                      ? `/app/browser/thoughts/${row.id}`
                      : `/app/documents/${(row.document as { id?: string } | undefined)?.id}`;
                return (
                  <li key={`${result.kind}:${row.id}`}>
                    <span class="tag">{result.kind}</span> <a href={href}>{label}</a>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No recall results.</p>
          )}
        </div>
      ) : null}
    </Layout>,
  );
});

// GET /app/metrics - Metrics dashboard
appRoutes.get("/metrics", async (c: AppContext) => {
  const user = c.get("user");
  const projectId = c.req.query("project_id") || undefined;
  const fromInput = c.req.query("from") || undefined;
  const toInput = c.req.query("to") || undefined;
  const ctx = memCtx(c);
  const [projects, metrics] = await Promise.all([
    listProjects(ctx),
    getMetrics(ctx, {
      project_id: projectId,
      from: dateInputToUnix(fromInput),
      to: dateInputToUnix(toInput),
    }),
  ]);
  const taskMax = Math.max(1, ...Object.values(metrics.task_status as Record<string, number>));
  const factMax = Math.max(1, ...Object.values(metrics.fact_status as Record<string, number>));
  return c.html(
    <Layout user={user} currentPath="/app/metrics">
      <h2>Metrics Dashboard</h2>
      <form method="get" action="/app/metrics" class="filters">
        <div>
          <label htmlFor="project_id">Project</label>
          <select id="project_id" name="project_id">
            <option value="">All projects</option>
            {projects.map((project) => (
              <option value={project.id} selected={project.id === projectId} key={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="from">From</label>
          <input type="date" id="from" name="from" value={fromInput ?? ""} />
        </div>
        <div>
          <label htmlFor="to">To</label>
          <input type="date" id="to" name="to" value={toInput ?? ""} />
        </div>
        <button type="submit">Filter</button>
      </form>
      <div class="grid">
        {Object.entries(metrics.counts as Record<string, number>).map(([kind, count]) => (
          <div class="card" key={kind}>
            <h3>{kind.replace(/_/g, " ")}</h3>
            <p style={{ fontSize: "1.75rem", fontWeight: "bold" }}>{count}</p>
          </div>
        ))}
        <div class="card">
          <h3>Document chunks</h3>
          <p style={{ fontSize: "1.75rem", fontWeight: "bold" }}>{metrics.chunks}</p>
        </div>
        <div class="card">
          <h3>Recallable rows</h3>
          <p style={{ fontSize: "1.75rem", fontWeight: "bold" }}>{metrics.recallable}</p>
        </div>
      </div>
      <div class="grid">
        <div class="card">
          <h3>Task status counts</h3>
          {Object.entries(metrics.task_status as Record<string, number>).map(([status, count]) => (
            <p key={status}>
              <span class="tag">{status}</span> {count} {metricBar(count, taskMax)}
            </p>
          ))}
        </div>
        <div class="card">
          <h3>Fact status counts</h3>
          {Object.entries(metrics.fact_status as Record<string, number>).map(([status, count]) => (
            <p key={status}>
              <span class="tag">{status}</span> {count} {metricBar(count, factMax)}
            </p>
          ))}
        </div>
      </div>
      <div class="card">
        <h3>Time-series rollups</h3>
        {metrics.time_series.length ? (
          <table>
            <thead>
              <tr>
                <th>Series</th>
                <th>Count</th>
                <th>Latest</th>
                <th>Min</th>
                <th>Max</th>
                <th>Avg</th>
              </tr>
            </thead>
            <tbody>
              {metrics.time_series.map((series) => (
                <tr key={series.series_key}>
                  <td>{series.series_key}</td>
                  <td>{series.count}</td>
                  <td>{series.latest_value ?? "—"}</td>
                  <td>{series.min ?? "—"}</td>
                  <td>{series.max ?? "—"}</td>
                  <td>{series.avg === null ? "—" : series.avg.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No time-series points in this range.</p>
        )}
      </div>
      <div class="card">
        <h3>Recent activity</h3>
        {metrics.recent.length ? (
          <ul>
            {metrics.recent.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                {item.href ? <a href={item.href}>{item.label}</a> : <span>{item.label}</span>}{" "}
                <span class="tag">{item.kind}</span> {fmtDate(item.created_at)}
              </li>
            ))}
          </ul>
        ) : (
          <p>No recent activity.</p>
        )}
      </div>
    </Layout>,
  );
});

// GET /app/connectors - Owner-scoped ingestion connector list
appRoutes.get("/connectors", async (c: AppContext) => {
  const user = c.get("user");
  const ctx = memCtx(c);
  const [connectors, projects] = await Promise.all([
    listIngestionConnectors(ctx),
    listProjects(ctx),
  ]);
  const credentialStatuses = await Promise.all(
    connectors.map(async (connector) => ({
      connectorId: connector.id,
      status: await optionalCredentialStatus(c, connector.id),
    })),
  );
  const credentialStatusByConnector = new Map(
    credentialStatuses.map((row) => [row.connectorId, row.status?.status ?? null]),
  );

  return c.html(
    <Layout user={user} currentPath="/app/connectors">
      <h2>Ingestion Connectors</h2>
      <div class="card">
        <p>
          Review connector definitions, operational status, and recent run state. Credential
          payloads are never shown here.
        </p>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th>Source</th>
              <th>Project</th>
              <th>Last run</th>
              <th>Last success</th>
              <th>Last error</th>
              <th>Credential status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {connectors.length ? (
              connectors.map((connector) => {
                const project = connectorProject(projects, connector.projectId);
                return (
                  <tr key={connector.id}>
                    <td>{connector.name}</td>
                    <td>{connector.type}</td>
                    <td>{connector.status}</td>
                    <td>{connector.source}</td>
                    <td>
                      {connector.projectId ? (
                        project ? (
                          <a href={`/app/browser/projects/${connector.projectId}`}>
                            {project.name}
                          </a>
                        ) : (
                          <code>{connector.projectId}</code>
                        )
                      ) : (
                        "none"
                      )}
                    </td>
                    <td>{fmtDate(connector.lastRunAt)}</td>
                    <td>{fmtDate(connector.lastSuccessAt)}</td>
                    <td>
                      {connector.lastError ? String(safeDisplayJson(connector.lastError)) : "—"}
                    </td>
                    <td>{String(credentialStatusByConnector.get(connector.id) ?? "missing")}</td>
                    <td>
                      <a href={`/app/connectors/${connector.id}`}>View</a>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={10}>No connectors found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
});

// GET /app/connectors/:id - Owner-scoped ingestion connector detail and run history
appRoutes.get("/connectors/:id", async (c: AppContext) => {
  const user = c.get("user");
  try {
    const connectorId = param(c, "id");
    const ctx = memCtx(c);
    const [connector, runs, projects, credentialStatus] = await Promise.all([
      getConnector(ctx, connectorId),
      listIngestionRuns(ctx, connectorId),
      listProjects(ctx),
      optionalCredentialStatus(c, connectorId),
    ]);
    const project = connectorProject(projects, connector.projectId);
    const recentRuns = runs.slice(0, 25);
    c.header("Cache-Control", "no-store");
    return c.html(
      <Layout user={user} currentPath="/app/connectors">
        <p>
          <a href="/app/connectors">← Back to Connectors</a>
        </p>
        <h2>{connector.name}</h2>
        <div class="metadata">
          <div>
            ID: <code>{connector.id}</code>
          </div>
          <div>Type: {connector.type}</div>
          <div>Source: {connector.source}</div>
          <div>Status: {connector.status}</div>
          <div>
            Project:{" "}
            {connector.projectId ? (
              project ? (
                <a href={`/app/browser/projects/${connector.projectId}`}>{project.name}</a>
              ) : (
                <code>{connector.projectId}</code>
              )
            ) : (
              "none"
            )}
          </div>
          <div>Created: {fmtDate(connector.createdAt)}</div>
          <div>Updated: {fmtDate(connector.updatedAt)}</div>
          <div>Last run: {fmtDate(connector.lastRunAt)}</div>
          <div>Last success: {fmtDate(connector.lastSuccessAt)}</div>
          <div>
            Last error: {connector.lastError ? String(safeDisplayJson(connector.lastError)) : "—"}
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <h3>Configuration</h3>
            <JsonBlock value={connector.config} />
          </div>
          <div class="card">
            <h3>Schedule</h3>
            <JsonBlock value={connector.schedule} />
          </div>
          <div class="card">
            <h3>Cursor / checkpoint</h3>
            <JsonBlock value={connector.cursor} />
          </div>
        </div>

        <div class="card">
          <h3>Credential status</h3>
          <CredentialStatus status={credentialStatus} />
        </div>

        <div class="card">
          <h3>Recent runs</h3>
          {recentRuns.length ? (
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Run id</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Finished</th>
                    <th>Inserted</th>
                    <th>Skipped</th>
                    <th>Failed</th>
                    <th>Cursor before</th>
                    <th>Cursor after</th>
                    <th>Error</th>
                    <th>Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <code>{run.id}</code>
                      </td>
                      <td>{run.trigger}</td>
                      <td>{run.status}</td>
                      <td>{fmtDate(run.startedAt)}</td>
                      <td>{fmtDate(run.finishedAt)}</td>
                      <td>{run.insertedCount}</td>
                      <td>{run.skippedCount}</td>
                      <td>{run.failedCount}</td>
                      <td>
                        <JsonBlock value={run.cursorBefore} />
                      </td>
                      <td>
                        <JsonBlock value={run.cursorAfter} />
                      </td>
                      <td>
                        <JsonBlock value={run.error} />
                      </td>
                      <td>
                        <JsonBlock value={run.metadata} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No ingestion runs recorded.</p>
          )}
        </div>
      </Layout>,
    );
  } catch (error) {
    if (error instanceof MemoryError) {
      return c.html(errorPageContent(user, "Error", error.message), errorStatus(error.status));
    }
    throw error;
  }
});

// GET /app/pages - Basic page management surface
appRoutes.get("/pages", async (c: AppContext) => {
  const user = c.get("user");
  const rows = await listPages(memCtx(c));
  return c.html(
    <Layout user={user} currentPath="/app/pages">
      <h2>User Pages</h2>
      <div class="button-group">
        <a href="/app/pages/new">New page</a>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Slug</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((page) => (
              <tr key={page.id}>
                <td>
                  {user.slug && page.status === "published" ? (
                    <a href={`/${user.slug}/${page.slug}`}>{page.title}</a>
                  ) : (
                    page.title
                  )}
                </td>
                <td>
                  <code>{page.slug}</code>
                </td>
                <td>{page.status}</td>
                <td>
                  <form method="get" action={`/app/pages/${page.id}`} class="inline">
                    <button type="submit">Edit</button>
                  </form>
                  <form
                    method="post"
                    action={`/app/pages/${page.id}/delete`}
                    class="inline"
                    onsubmit="return confirm('Delete this page?')"
                  >
                    <button type="submit" class="danger">
                      Delete
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Layout>,
  );
});

appRoutes.get("/pages/new", async (c: AppContext) =>
  c.html(
    <Layout user={c.get("user")} currentPath="/app/pages">
      <h2>New Page</h2>
      <PageForm action="/app/pages" />
    </Layout>,
  ),
);

appRoutes.post("/pages", async (c: AppContext) => {
  const form = await formBody(c);
  const page = await createPage(memCtx(c), {
    title: form.title ?? "",
    slug: form.slug ?? "",
    description: form.description || null,
    status: form.status as "draft" | "published" | "archived",
    template: form.template ?? "",
    queries: parseQueries(form.queries),
  });
  return c.redirect(`/app/pages/${page.id}`);
});

appRoutes.get("/pages/:id", async (c: AppContext) => {
  const page = await getPage(memCtx(c), param(c, "id"));
  const links = await listPageAccessLinks(memCtx(c), page.id);
  return c.html(
    <Layout user={c.get("user")} currentPath="/app/pages">
      <h2>Edit Page</h2>
      {page.validationErrors.length ? (
        <p class="error">{page.validationErrors.join("; ")}</p>
      ) : null}
      <PageForm page={page} action={`/app/pages/${page.id}`} />
      <div class="card">
        <h3>Access links</h3>
        <form method="post" action={`/app/pages/${page.id}/access-links`}>
          <label>
            Label
            <input name="label" />
          </label>
          <label>
            TTL seconds
            <input name="ttl_seconds" value="86400" />
          </label>
          <label>
            Max uses
            <input name="max_uses" value="1" />
          </label>
          <button type="submit">Create access link</button>
        </form>
        <ul>
          {links.map((link) => (
            <li key={link.id}>
              {link.label ?? link.id}: uses {link.useCount}/{link.maxUses ?? "∞"}, expires{" "}
              {fmtDate(link.expiresAt)} {link.revokedAt ? "revoked" : ""}{" "}
              <form
                method="post"
                action={`/app/page-access-links/${link.id}/revoke`}
                class="inline"
              >
                <button type="submit">Revoke</button>
              </form>
            </li>
          ))}
        </ul>
      </div>
    </Layout>,
  );
});

appRoutes.post("/pages/:id", async (c: AppContext) => {
  const form = await formBody(c);
  const id = param(c, "id");
  await updatePage(memCtx(c), id, {
    title: form.title,
    slug: form.slug,
    description: form.description || null,
    status: form.status as "draft" | "published" | "archived",
    template: form.template,
    queries: parseQueries(form.queries),
  });
  return c.redirect(`/app/pages/${id}`);
});

appRoutes.post("/pages/:id/preview", async (c: AppContext) => {
  const form = await formBody(c);
  const result = await previewPage(memCtx(c), {
    template: form.template,
    queries: parseQueries(form.queries),
  });
  return c.html(
    <Layout user={c.get("user")} currentPath="/app/pages">
      <h2>Page Preview</h2>
      <div class="content">{raw(result.html)}</div>
      <p>
        <a href={`/app/pages/${param(c, "id")}`}>Back to editor</a>
      </p>
    </Layout>,
  );
});

appRoutes.post("/pages/:id/delete", async (c: AppContext) => {
  await deletePage(memCtx(c), param(c, "id"));
  return c.redirect("/app/pages");
});

appRoutes.post("/pages/:id/access-links", async (c: AppContext) => {
  const form = await formBody(c);
  const id = param(c, "id");
  const link = await createPageAccessLink(
    memCtx(c),
    id,
    {
      label: form.label || null,
      ttl_seconds: Number(form.ttl_seconds) || undefined,
      max_uses: Number(form.max_uses) || 1,
    },
    new URL(c.req.url).origin,
  );
  return c.html(
    <Layout user={c.get("user")} currentPath="/app/pages">
      <h2>Access link created</h2>
      <p>This plaintext URL is shown once.</p>
      <pre>{link.url}</pre>
      <p>
        <a href={`/app/pages/${id}`}>Back to page</a>
      </p>
    </Layout>,
  );
});

appRoutes.post("/page-access-links/:id/revoke", async (c: AppContext) => {
  await revokePageAccessLink(memCtx(c), param(c, "id"));
  return c.redirect("/app/pages");
});

// GET /app/users - User management (admin only)
appRoutes.get("/users", async (c: AppContext) => {
  return usersPage(c);
});

appRoutes.post("/users", async (c: AppContext) => {
  const denied = adminOnly(c);
  if (denied) return denied;
  const form = await formBody(c);
  await createUser(memCtx(c), {
    name: form.name ?? "",
    slug: form.slug || null,
    is_admin: asBool(form.is_admin),
  });
  return c.redirect("/app/users");
});

appRoutes.post("/users/:id", async (c: AppContext) => {
  const denied = adminOnly(c);
  if (denied) return denied;
  const form = await formBody(c);
  await updateUser(memCtx(c), param(c, "id"), {
    name: form.name,
    slug: form.slug || null,
    is_admin: asBool(form.is_admin),
  });
  return c.redirect("/app/users");
});

appRoutes.post("/users/:id/tokens", async (c: AppContext) => {
  const denied = adminOnly(c);
  if (denied) return denied;
  const token = await createUserToken(memCtx(c), param(c, "id"));
  return usersPage(c, token.token);
});

appRoutes.post("/tokens/:id/delete", async (c: AppContext) => {
  const denied = adminOnly(c);
  if (denied) return denied;
  await revokeToken(memCtx(c), param(c, "id"));
  return c.redirect("/app/users");
});

// GET /app/documents - redirect to browser
appRoutes.get("/documents", async (c: AppContext) => {
  return c.redirect("/app/browser/documents");
});

// GET /app/documents/:id - Document reader
appRoutes.get("/documents/:id", async (c: AppContext) => {
  const user = c.get("user");
  try {
    const docId = param(c, "id");
    const ctx = memCtx(c);
    const textBody = isTextMime(
      ((await getEntity(ctx, "documents", docId)).mimeType as string | null) ?? undefined,
    );
    const [document, content, relations, projects] = await Promise.all([
      getEntity(ctx, "documents", docId),
      textBody ? getDocumentContent(ctx, docId) : { content: "" },
      getEntityRelations(ctx, "documents", docId),
      listProjects(ctx),
    ]);
    const projectId = (document.projectId as string | null) ?? null;
    const project = projectId ? projects.find((p) => p.id === projectId) : null;
    c.header("Cache-Control", "no-store");
    return c.html(
      <Layout user={user} currentPath="/app/documents">
        <p>
          <a href="/app/browser/documents">← Back to Documents</a>
        </p>
        <h2>{document.title as string}</h2>
        <Provenance
          source={document.source as string | null}
          projectId={projectId}
          projectLabel={project?.name ?? null}
          createdAt={document.createdAt as Date | undefined}
          updatedAt={document.updatedAt as Date | undefined}
        />
        <div class="metadata">
          <div>MIME type: {document.mimeType as string}</div>
          <div>Size: {document.sizeBytes as number} bytes</div>
          <div>Chunks: {document.chunkCount as number}</div>
          <div>
            <a href={`/app/documents/${docId}/raw`}>Raw content</a>
          </div>
        </div>
        <h3>Dependencies</h3>
        <RelationsList relations={relations} />
        <h3>Content</h3>
        {textBody ? (
          isMarkdown(document.mimeType as string | null) ? (
            <article class="content">{raw(markdownToHtml(content.content))}</article>
          ) : (
            <pre>{escapeHtml(content.content)}</pre>
          )
        ) : (
          <p>
            Binary content — <a href={`/app/documents/${docId}/raw`}>download raw</a> to view.
          </p>
        )}
      </Layout>,
    );
  } catch (error) {
    if (error instanceof MemoryError) {
      return c.html(errorPageContent(user, "Error", error.message), errorStatus(error.status));
    }
    throw error;
  }
});

// GET /app/documents/:id/raw - Raw document content
appRoutes.get("/documents/:id/raw", async (c: AppContext) => {
  try {
    const ctx = memCtx(c);
    const docId = param(c, "id");
    const doc = (
      await createDb(ctx.env.DB)
        .select()
        .from(documents)
        .where(and(eq(documents.id, docId), eq(documents.ownerId, ctx.user.id)))
        .limit(1)
    )[0];
    if (!doc) throw new MemoryError(404, "document not found");
    const mime = (doc.mimeType ?? "application/octet-stream") as string;
    const textBody = isTextMime(mime);
    const object = await ctx.env.DOCUMENTS.get(doc.r2Key);
    if (!object) throw new MemoryError(404, "document content not found");
    if (textBody) {
      return c.text(await object.text(), 200, {
        "Cache-Control": "no-store",
        "Content-Type": `${mime}; charset=utf-8`,
      });
    }
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="${doc.id}"`,
    };
    if (object.size) headers["Content-Length"] = String(object.size);
    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    if (error instanceof MemoryError) return c.text(error.message, errorStatus(error.status));
    throw error;
  }
});

// Mount appRoutes at /app
uiRoutes.route("/app", appRoutes);

uiRoutes.get("/:user_slug/", async (c) => {
  const token = getCookie(c, TOKEN_COOKIE);
  const signedIn = token ? await findUserByToken(c.env, token) : undefined;
  const userSlug = c.req.param("user_slug");
  if (!signedIn || signedIn.slug !== userSlug) return c.text("Not found", 404);
  const rows = await listPages(
    { env: c.env, user: signedIn, source: "ui:dynamic-page" },
    { status: "published" },
  );
  c.header("Cache-Control", "no-store");
  return c.html(
    <Layout user={signedIn} currentPath={`/${userSlug}/`}>
      <h2>{signedIn.name}'s pages</h2>
      <ul>
        {rows.map((page) => (
          <li key={page.id}>
            <a href={`/${userSlug}/${page.slug}`}>{page.title}</a>
          </li>
        ))}
      </ul>
    </Layout>,
  );
});

uiRoutes.get("/:user_slug/:page_slug", async (c) => {
  const userSlug = c.req.param("user_slug");
  const pageSlug = c.req.param("page_slug");
  const found = await findPublishedPageByPath(c.env, userSlug, pageSlug);
  if (!found) return c.text("Not found", 404);

  const url = new URL(c.req.url);
  const access = url.searchParams.get("access");
  const cookieName = `bf_page_${found.page.id}`;
  const token = getCookie(c, TOKEN_COOKIE);
  const signedIn = token ? await findUserByToken(c.env, token) : undefined;
  if (access) {
    const exchanged = await exchangePageAccess(c.env, found.page.id, access);
    if (!exchanged && signedIn?.id !== found.user.id) return c.text("Not found", 404);
    if (!exchanged) return c.redirect(`/${userSlug}/${pageSlug}`);
    setCookie(c, cookieName, access, {
      httpOnly: true,
      sameSite: "Strict",
      path: `/${userSlug}/${pageSlug}`,
      expires: exchanged.expiresAt,
    });
    return c.redirect(`/${userSlug}/${pageSlug}`);
  }

  const pageCookie = getCookie(c, cookieName);
  const allowed =
    signedIn?.id === found.user.id ||
    (pageCookie ? await validatePageAccessCookie(c.env, found.page.id, pageCookie) : false);
  if (!allowed) return c.text("Not found", 404);
  const owner = {
    id: found.user.id,
    name: found.user.name,
    slug: found.user.slug,
    isAdmin: found.user.isAdmin,
  };
  const html = await renderPage({ env: c.env, user: owner, source: "ui:dynamic-page" }, found.page);
  c.header("Cache-Control", "no-store");
  return c.html(
    <Layout user={signedIn ?? null} currentPath={`/${userSlug}/${pageSlug}`}>
      <article class="content">{raw(html)}</article>
    </Layout>,
  );
});
