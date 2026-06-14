import { createDb, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { FC } from "hono/jsx";
import type { Env } from "../env";
import { escapeHtml } from "../markdown";

const TOKEN_COOKIE = "brainfog_token";

export const uiRoutes = new Hono<{ Bindings: Env }>();

type UserRow = {
  id: string;
  name: string;
  slug: string | null;
  isAdmin: boolean;
};

async function findUserByToken(env: Env, token: string): Promise<UserRow | undefined> {
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

const Layout: FC<{
  user?: UserRow | null;
  currentPath?: string;
  children: unknown;
}> = (props) => {
  const navLink = (href: string, label: string) => {
    const isActive = props.currentPath?.startsWith(href);
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

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>brainfog</title>
        <style>{`
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, sans-serif; background: #f5f5f5; }
          header { background: white; border-bottom: 1px solid #ddd; padding: 1rem; }
          header h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
          nav { display: flex; gap: 0; border-top: 1px solid #eee; }
          main { max-width: 1200px; margin: 0 auto; padding: 2rem 1rem; }
          form { background: white; padding: 2rem; border-radius: 4px; max-width: 400px; }
          input { width: 100%; padding: 0.75rem; margin: 0.5rem 0; border: 1px solid #ddd; border-radius: 4px; }
          button { padding: 0.75rem 1.5rem; background: #333; color: white; border: none; border-radius: 4px; cursor: pointer; }
          button:hover { background: #555; }
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
          .content { background: white; padding: 2rem; border-radius: 4px; line-height: 1.6; }
          .content table { margin: 1rem 0; }
          .content hr { margin: 1.5rem 0; }
          .card { background: white; padding: 1.5rem; margin: 1rem 0; border-radius: 4px; border: 1px solid #eee; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
          .button-group { display: flex; gap: 0.5rem; margin-top: 1rem; }
          .warning { color: #ff6600; }
          .success { color: #008000; }
        `}</style>
      </head>
      <body>
        <header>
          <h1>brainfog</h1>
          {props.user ? (
            <div style={{ fontSize: "0.9rem", color: "#666" }}>
              Signed in as <strong>{props.user.name}</strong>
            </div>
          ) : null}
        </header>
        {props.user ? (
          <nav>
            {navLink("/app", "Home")}
            {navLink("/app/browser", "Browser")}
            {navLink("/app/metrics", "Metrics")}
            {props.user.isAdmin ? navLink("/app/users", "Users") : null}
          </nav>
        ) : null}
        <main>{props.children}</main>
      </body>
    </html>
  );
};

const TokenForm: FC<{ error?: string }> = ({ error }) => (
  <form method="post" action="/">
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

// Middleware to check authenticated cookie
const appRoutes = new Hono<{ Bindings: Env; Variables: { user: UserRow } }>();

type AppContext = Context<{ Bindings: Env; Variables: { user: UserRow } }>;

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

// GET /app - App shell
appRoutes.get("/", async (c: AppContext) => {
  const user = c.get("user") as UserRow;
  return c.html(
    <Layout user={user} currentPath="/app">
      <h2>Welcome, {user.name}</h2>
      <p>Use the navigation above to browse data, view metrics, or manage users.</p>
    </Layout>,
  );
});

// GET /app/browser - Browser index
appRoutes.get("/browser", async (c: AppContext) => {
  const user = c.get("user") as UserRow;
  const kinds = [
    "projects",
    "thoughts",
    "facts",
    "tasks",
    "people",
    "documents",
    "time-series-points",
  ];
  return c.html(
    <Layout user={user} currentPath="/app/browser">
      <h2>Data Browser</h2>
      <div class="grid">
        {kinds.map((kind) => (
          <div class="card">
            <h3>
              <a href={`/app/browser/${kind}`}>{kind}</a>
            </h3>
            <p>Browse {kind}</p>
          </div>
        ))}
      </div>
    </Layout>,
  );
});

// GET /app/browser/:kind - List view for a kind
appRoutes.get("/browser/:kind", async (c: AppContext) => {
  const user = c.get("user") as UserRow;
  const kind = c.req.param("kind");
  if (!kind) {
    return c.notFound();
  }
  const validKinds = [
    "projects",
    "thoughts",
    "facts",
    "tasks",
    "people",
    "documents",
    "time-series-points",
  ];
  if (!validKinds.includes(kind)) {
    return c.html(
      <Layout user={user} currentPath="/app/browser">
        <h2>Not Found</h2>
        <p>Unknown kind: {escapeHtml(kind)}</p>
      </Layout>,
      404,
    );
  }

  return c.html(
    <Layout user={user} currentPath={`/app/browser/${kind}`}>
      <h2>{kind}</h2>
      <p>List of {kind} (pagination and filtering would go here)</p>
      <a href={`/app/browser`}>Back to Browser</a>
    </Layout>,
  );
});

// GET /app/metrics - Metrics dashboard
appRoutes.get("/metrics", async (c: AppContext) => {
  const user = c.get("user") as UserRow;
  return c.html(
    <Layout user={user} currentPath="/app/metrics">
      <h2>Metrics Dashboard</h2>
      <p>Dashboard content would display here</p>
    </Layout>,
  );
});

// GET /app/users - User management (admin only)
appRoutes.get("/users", async (c: AppContext) => {
  const user = c.get("user") as UserRow;
  if (!user.isAdmin) {
    return c.html(
      <Layout user={user} currentPath="/app/users">
        <h2>Forbidden</h2>
        <p>You do not have permission to manage users.</p>
      </Layout>,
      403,
    );
  }
  return c.html(
    <Layout user={user} currentPath="/app/users">
      <h2>User Management</h2>
      <p>User management interface would go here</p>
    </Layout>,
  );
});

// GET /app/documents/:id - Document reader
appRoutes.get("/documents/:id", async (c: AppContext) => {
  const user = c.get("user") as UserRow;
  const docId = c.req.param("id");
  if (!docId) {
    return c.notFound();
  }
  return c.html(
    <Layout user={user} currentPath="/app/documents">
      <h2>Document</h2>
      <p>Document ID: {escapeHtml(docId)}</p>
      <p>Document reader would display here</p>
    </Layout>,
  );
});

// GET /app/documents/:id/raw - Raw document content
appRoutes.get("/documents/:id/raw", async (c: AppContext) => {
  return c.text("Raw content would be served here", 200, {
    "Cache-Control": "no-store",
  });
});

uiRoutes.route("/app", appRoutes);
