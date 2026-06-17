import { createDb, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { FC } from "hono/jsx";
import type { Env } from "../env";
import type { EnrichedDependency, MemoryUser } from "../memory";

export const TOKEN_COOKIE = "brainfog_token";

export type UserRow = {
  id: string;
  name: string;
  slug: string | null;
  isAdmin: boolean;
};

export async function findUserByToken(env: Env, token: string): Promise<UserRow | undefined> {
  const tokenHash = await hashToken(token, env.BRAINFOG_TOKEN_HASH_SECRET);
  const db = createDb(env.DB);
  const rows = await db
    .select({ id: users.id, name: users.name, slug: users.slug, isAdmin: users.isAdmin })
    .from(tokens)
    .innerJoin(users, eq(tokens.userId, users.id))
    .where(eq(tokens.tokenHash, tokenHash))
    .limit(1);
  return rows[0];
}

export type AppVariables = { user: UserRow };
export type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

/** Builds the `Ctx` shape expected by memory.ts service functions from the authenticated app session. */
export function memCtx(c: AppContext): { env: Env; user: MemoryUser; source: string } {
  const user = c.get("user");
  return {
    env: c.env,
    user: { id: user.id, name: user.name, slug: user.slug, isAdmin: user.isAdmin },
    source: "ui:app",
  };
}

export function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

/** Builds a `?a=b&c=d` query string, skipping empty/undefined values. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const navLink = (href: string, label: string, currentPath?: string) => {
  const isActive =
    href === "/app"
      ? currentPath === href
      : currentPath === href || currentPath?.startsWith(`${href}/`);
  return (
    <a
      href={href}
      style={{
        padding: "0.5rem 1rem",
        textDecoration: "none",
        borderBottom: isActive ? "2px solid #333" : "none",
        fontWeight: isActive ? "bold" : "normal",
      }}
    >
      {label}
    </a>
  );
};

export const Layout: FC<{
  user?: UserRow | null;
  currentPath?: string;
  children: unknown;
}> = (props) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>brainfog</title>
        <script src="/assets/htmx.min.js" defer></script>
        <style>{`
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: #f5f5f5; }
          header { background: white; border-bottom: 1px solid #ddd; display: flex; align-items: stretch; padding: 0; }
          header img.header-logo { display: block; height: 5rem; width: auto; flex-shrink: 0; }
          header .header-content { padding: 1rem; display: flex; flex-direction: column; justify-content: center; gap: 0.5rem; }
          header h1 { font-size: 1.5rem; }
          header h1 a { color: inherit; text-decoration: none; }
          nav { display: flex; gap: 0; border-top: 1px solid #eee; }
          main { max-width: 1200px; margin: 0 auto; padding: 2rem 1rem; }
          form { background: white; padding: 2rem; border-radius: 4px; max-width: 480px; }
          form.filters { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: end; max-width: none; padding: 1rem; margin-bottom: 1rem; }
          form.filters > div { display: flex; flex-direction: column; gap: 0.25rem; }
          form.filters label { font-size: 0.8rem; color: #666; }
          form.inline { display: inline; background: none; padding: 0; max-width: none; }
          label { display: block; margin-top: 0.5rem; font-weight: bold; font-size: 0.9rem; }
          input, select, textarea { width: 100%; padding: 0.75rem; margin: 0.5rem 0; border: 1px solid #ddd; border-radius: 4px; font-family: inherit; }
          textarea { min-height: 10rem; font-family: monospace; }
          button { padding: 0.75rem 1.5rem; background: #333; color: white; border: none; border-radius: 4px; cursor: pointer; }
          button:hover { background: #555; }
          button.danger { background: #b00020; }
          button.danger:hover { background: #d32f2f; }
          .error { color: #b00020; padding: 1rem; background: #ffe6e6; border-radius: 4px; margin-bottom: 1rem; }
          table { width: 100%; border-collapse: collapse; background: white; }
          th, td { padding: 0.75rem; text-align: left; border-bottom: 1px solid #ddd; }
          th { background: #f5f5f5; font-weight: bold; }
          a { color: #0066cc; text-decoration: none; }
          a:hover { text-decoration: underline; }
          code { background: #f5f5f5; padding: 0.2rem 0.4rem; border-radius: 2px; font-family: monospace; }
          pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow-x: auto; }
          blockquote { border-left: 4px solid #ddd; padding-left: 1rem; margin: 1rem 0; color: #666; }
          .metadata { background: white; padding: 1rem; margin: 1rem 0; border-radius: 4px; font-size: 0.9rem; color: #666; }
          .metadata div { margin: 0.25rem 0; }
          .content { background: white; padding: 2rem; border-radius: 4px; line-height: 1.6; }
          .content table { margin: 1rem 0; }
          .content hr { margin: 1.5rem 0; }
          .card { background: white; padding: 1.5rem; margin: 1rem 0; border-radius: 4px; border: 1px solid #eee; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
          .button-group { display: flex; gap: 0.5rem; margin-top: 1rem; align-items: center; }
          .button-group a { padding: 0.5rem 1rem; background: #333; color: white; border-radius: 4px; text-decoration: none; }
          .button-group a:hover { background: #555; text-decoration: none; }
          .button-group a.danger { background: #b00020; }
          .button-group a.danger:hover { background: #d32f2f; }
          .warning { color: #ff6600; }
          .success { color: #008000; }
          .tag { display: inline-block; background: #eee; border-radius: 3px; padding: 0.1rem 0.4rem; font-size: 0.8rem; margin-right: 0.5rem; }
          .pagination { display: flex; gap: 1rem; align-items: center; margin: 1rem 0; }
          .table-wrap { background: white; border-radius: 4px; overflow-x: auto; }
          .sparkline { display: block; }
          .nowrap { white-space: nowrap; }
          h2 { margin-bottom: 1rem; }
          h3 { margin-bottom: 0.5rem; }
        `}</style>
      </head>
      <body hx-boost="true">
        <header>
          <img class="header-logo" src="/thinker.png" alt="" />
          <div class="header-content">
            <h1><a href="/app">brainfog</a></h1>
            {props.user ? (
              <div style={{ fontSize: "0.9rem", color: "#666" }}>
                Signed in as <strong>{props.user.name}</strong>
                {props.user.isAdmin ? <span class="tag">admin</span> : null}
              </div>
            ) : null}
          </div>
        </header>
        {props.user ? (
          <nav>
            {navLink("/app", "Home", props.currentPath)}
            {navLink("/app/browser", "Browser", props.currentPath)}
            {navLink("/app/search", "Search", props.currentPath)}
            {navLink("/app/metrics", "Metrics", props.currentPath)}
            {navLink("/app/pages", "Pages", props.currentPath)}
            {props.user.isAdmin ? navLink("/app/users", "Users", props.currentPath) : null}
          </nav>
        ) : null}
        <main>{props.children}</main>
      </body>
    </html>
  );
};

/** Prev/next pagination controls preserving the current filters via `extraQuery`. */
export const Pagination: FC<{
  basePath: string;
  page: number;
  perPage: number;
  total: number;
  extraQuery?: Record<string, string | number | undefined | null>;
}> = ({ basePath, page, perPage, total, extraQuery }) => {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const hrefFor = (p: number) => `${basePath}${qs({ ...extraQuery, page: p, per_page: perPage })}`;
  return (
    <div class="pagination">
      <span>
        Page {page} of {totalPages} ({total} total)
      </span>
      {page > 1 ? <a href={hrefFor(page - 1)}>Previous</a> : <span class="warning">Previous</span>}
      {page < totalPages ? <a href={hrefFor(page + 1)}>Next</a> : <span class="warning">Next</span>}
    </div>
  );
};

/** Renders dependency-graph edges for a detail page, with staleness indicators. */
export const RelationsList: FC<{ relations: EnrichedDependency[] }> = ({ relations }) => {
  if (relations.length === 0) return <p>No related records.</p>;
  return (
    <ul>
      {relations.map((r) => (
        <li key={r.id} style={{ marginBottom: "0.5rem" }}>
          <span class="tag">
            {r.direction === "out" ? "→" : "←"} {r.relationship}
          </span>
          {r.otherHref ? <a href={r.otherHref}>{r.otherLabel}</a> : <span>{r.otherLabel}</span>}{" "}
          <code>{r.otherKind}</code>
          {r.staleAt ? (
            <span class="warning">
              {" "}
              stale{r.staleReason ? `: ${r.staleReason}` : ""} (since {fmtDate(r.staleAt)})
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
};

/** Provenance block shown on every detail page (source, project, timestamps). */
export const Provenance: FC<{
  source?: string | null;
  projectId?: string | null;
  projectLabel?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}> = (props) => (
  <div class="metadata">
    {props.source ? (
      <div>
        Source: <code>{props.source}</code>
      </div>
    ) : null}
    {props.projectId ? (
      <div>
        Project:{" "}
        {props.projectLabel ? (
          <a href={`/app/browser/projects/${props.projectId}`}>{props.projectLabel}</a>
        ) : (
          <code>{props.projectId}</code>
        )}
      </div>
    ) : (
      <div>Project: none</div>
    )}
    {props.createdAt ? <div>Created: {fmtDate(props.createdAt)}</div> : null}
    {props.updatedAt ? <div>Updated: {fmtDate(props.updatedAt)}</div> : null}
  </div>
);
