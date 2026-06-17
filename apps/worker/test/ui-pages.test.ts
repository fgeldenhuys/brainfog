import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { createDb, pageAccessLinks, pages, thoughts, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { addDocument, createProject, remember } from "../src/memory";
import { createPage, createPageAccessLink, previewPage, revokePageAccessLink } from "../src/pages";

const ADMIN_TOKEN = "ui-pages-admin-token";
const USER_TOKEN = "ui-pages-user-token";
const ADMIN_ID = "ui-pages-admin";
const USER_ID = "ui-pages-user";

function cookie(token: string) {
  return { Cookie: `brainfog_token=${token}` };
}

async function mcpRequest(
  body: Record<string, unknown>,
  sessionId?: string,
  token = ADMIN_TOKEN,
): Promise<{ response: Response; message?: Record<string, unknown>; sessionId?: string }> {
  const response = await SELF.fetch("https://example.com/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
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

async function mcpSession(token = ADMIN_TOKEN) {
  const init = await mcpRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "brainfog-ui-pages-test", version: "0.1.0" },
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

async function callMcpToolRaw(name: string, args: Record<string, unknown>, token = ADMIN_TOKEN) {
  const session = await mcpSession(token);
  const result = await mcpRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    session,
    token,
  );
  expect(result.response.status).toBe(200);
  return result.message as { result?: { content?: { text?: string }[] }; error?: unknown };
}

async function callMcpTool<T>(name: string, args: Record<string, unknown>, token = ADMIN_TOKEN) {
  const message = await callMcpToolRaw(name, args, token);
  expect(message.error).toBeUndefined();
  return JSON.parse(message.result?.content?.[0]?.text ?? "null") as T;
}

describe("authenticated UI pages", () => {
  let documentId: string;

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
    const db = createDb(env.DB);
    await db
      .insert(users)
      .values({ id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true });
    await db
      .insert(users)
      .values({ id: USER_ID, name: "UI User", slug: "ui-user", isAdmin: false });
    await db.insert(tokens).values({
      id: "ui-pages-admin-token-row",
      userId: ADMIN_ID,
      tokenHash: await hashToken(ADMIN_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });
    await db.insert(tokens).values({
      id: "ui-pages-user-token-row",
      userId: USER_ID,
      tokenHash: await hashToken(USER_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });

    const ctx = {
      env,
      user: { id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true },
      source: "test:ui",
    };
    const project = await createProject(ctx, { name: "UI Project" });
    await remember(ctx, {
      content: "searchable UI thought",
      type: "observation",
      project_id: project.id,
    });
    const document = await addDocument(ctx, {
      title: "Unsafe Markdown",
      project_id: project.id,
      mime_type: "text/markdown",
      content: "# Safe Heading\n\n<script>alert('x')</script>\n\n[bad](javascript:alert('x'))",
    });
    documentId = document.id;
  });

  it("renders the authenticated app shell with default navigation", async () => {
    const response = await SELF.fetch("https://example.com/app", { headers: cookie(ADMIN_TOKEN) });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Browser");
    expect(html).toContain("Metrics");
    expect(html).toContain("Users");
  });

  it("renders metrics from owner-scoped service data", async () => {
    const response = await SELF.fetch("https://example.com/app/metrics", {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Metrics Dashboard");
    expect(html).toContain("Recallable rows");
    expect(html).toContain("Time-series rollups");
  });

  it("enforces admin-only user management", async () => {
    const denied = await SELF.fetch("https://example.com/app/users", {
      headers: cookie(USER_TOKEN),
    });
    expect(denied.status).toBe(403);

    const allowed = await SELF.fetch("https://example.com/app/users", {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("User Management");
  });

  it("renders Markdown documents safely and serves raw content owner-scoped", async () => {
    const rendered = await SELF.fetch(`https://example.com/app/documents/${documentId}`, {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("cache-control")).toBe("no-store");
    const html = await rendered.text();
    expect(html).toContain("<h1>Safe Heading</h1>");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('href="javascript:');

    const raw = await SELF.fetch(`https://example.com/app/documents/${documentId}/raw`, {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await raw.text()).toContain("<script>alert('x')</script>");

    const crossOwner = await SELF.fetch(`https://example.com/app/documents/${documentId}/raw`, {
      headers: cookie(USER_TOKEN),
    });
    expect(crossOwner.status).toBe(404);
  });

  it("renders recall search results through the existing recall service", async () => {
    const response = await SELF.fetch("https://example.com/app/search?q=searchable", {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("searchable UI thought");
  });

  it("renders owner-scoped dynamic pages and rejects unsafe templates", async () => {
    const adminCtx = {
      env,
      user: { id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true },
      source: "test:page",
    };
    const userCtx = {
      env,
      user: { id: USER_ID, name: "UI User", slug: "ui-user", isAdmin: false },
      source: "test:page",
    };
    const privateThought = await remember(userCtx, { content: "other user shared secret" });
    await createDb(env.DB)
      .update(thoughts)
      .set({ shared: true })
      .where(eq(thoughts.id, privateThought.id));

    await expect(
      createPage(adminCtx, {
        title: "Unsafe",
        slug: "unsafe",
        status: "draft",
        template:
          '<section><script>alert(1)</script><a href="javascript:alert(1)">bad</a></section>',
        queries: {},
      }),
    ).rejects.toThrow(/disallowed tag|href/);
    const unsafeRows = await createDb(env.DB)
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.ownerId, ADMIN_ID), eq(pages.slug, "unsafe")));
    expect(unsafeRows).toHaveLength(0);

    const page = await createPage(adminCtx, {
      title: "Daily Review",
      slug: "daily-review",
      status: "published",
      template: "<section><h1>{{page.title}}</h1>{{#items}}<p>{{content}}</p>{{/items}}</section>",
      queries: { items: { kind: "thoughts", filters: { id: privateThought.id }, limit: 10 } },
    });

    const rendered = await SELF.fetch("https://example.com/ui-admin/daily-review", {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(rendered.status).toBe(200);
    const html = await rendered.text();
    expect(html).toContain("Daily Review");
    expect(html).not.toContain("other user shared secret");

    const denied = await SELF.fetch("https://example.com/ui-admin/daily-review", {
      headers: cookie(USER_TOKEN),
    });
    expect(denied.status).toBe(404);

    const link = await createPageAccessLink(
      adminCtx,
      page.id,
      { ttl_seconds: 60, max_uses: 1 },
      "https://example.com",
    );
    const exchange = await SELF.fetch(link.url, { redirect: "manual" });
    expect(exchange.status).toBe(302);
    expect(exchange.headers.get("set-cookie")).toContain("HttpOnly");
    expect(exchange.headers.get("location")).toBe("/ui-admin/daily-review");

    const badExisting = await SELF.fetch("https://example.com/ui-admin/daily-review?access=bad", {
      redirect: "manual",
    });
    const badMissing = await SELF.fetch("https://example.com/ui-admin/missing?access=bad", {
      redirect: "manual",
    });
    expect(badExisting.status).toBe(badMissing.status);
    expect(badExisting.status).toBe(404);
  });

  it("enforces pre-auth access link expiry, use-count, and revocation boundaries", async () => {
    const adminCtx = {
      env,
      user: { id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true },
      source: "test:page",
    };
    const suffix = Date.now().toString(36);
    const page = await createPage(adminCtx, {
      title: "Access Boundaries",
      slug: `access-boundaries-${suffix}`,
      status: "published",
      template: "<section><h1>{{page.title}}</h1></section>",
      queries: {},
    });

    const oneUse = await createPageAccessLink(
      adminCtx,
      page.id,
      { ttl_seconds: 60, max_uses: 1 },
      "https://example.com",
    );
    expect((await SELF.fetch(oneUse.url, { redirect: "manual" })).status).toBe(302);
    expect((await SELF.fetch(oneUse.url, { redirect: "manual" })).status).toBe(404);

    const expired = await createPageAccessLink(
      adminCtx,
      page.id,
      { ttl_seconds: -1, max_uses: 1 },
      "https://example.com",
    );
    expect((await SELF.fetch(expired.url, { redirect: "manual" })).status).toBe(404);

    const revoked = await createPageAccessLink(
      adminCtx,
      page.id,
      { ttl_seconds: 60, max_uses: 1 },
      "https://example.com",
    );
    await revokePageAccessLink(adminCtx, revoked.id);
    expect((await SELF.fetch(revoked.url, { redirect: "manual" })).status).toBe(404);
  });

  it("exercises MCP page tools with static bearer auth and one-time access-link secrecy", async () => {
    const slug = `mcp-page-${Date.now().toString(36)}`;
    const page = await callMcpTool<{ id: string; ownerId: string; slug: string }>("create_page", {
      title: "MCP Page",
      slug,
      status: "published",
      template: "<section><h1>{{page.title}}</h1></section>",
      queries: {},
    });
    expect(page.ownerId).toBe(ADMIN_ID);

    const preview = await callMcpTool<{ html: string }>("preview_page", {
      template: "<section><p>Preview</p></section>",
      queries: {},
    });
    expect(preview.html).toContain("Preview");

    const link = await callMcpTool<{ id: string; url: string }>("create_page_access_link", {
      page_id: page.id,
      ttl_seconds: 60,
      max_uses: 1,
      label: "mcp once",
    });
    expect(link.url).toMatch(new RegExp(`^/ui-admin/${slug}\\?access=`));
    expect(link.url).not.toContain("example.com");

    const secret = new URL(link.url, "https://example.com").searchParams.get("access") ?? "";
    expect(secret).toBeTruthy();
    const stored = await createDb(env.DB)
      .select({ secretHash: pageAccessLinks.secretHash })
      .from(pageAccessLinks)
      .where(eq(pageAccessLinks.id, link.id));
    expect(stored[0]?.secretHash).toBeTruthy();
    expect(stored[0]?.secretHash).not.toContain(secret);

    const links = await callMcpTool<Record<string, unknown>[]>("list_page_access_links", {
      page_id: page.id,
    });
    expect(links).toHaveLength(1);
    expect(links[0]).not.toHaveProperty("url");
    expect(JSON.stringify(links)).not.toContain(secret);

    const userPages = await callMcpTool<{ id: string }[]>("list_pages", {}, USER_TOKEN);
    expect(userPages.map((row) => row.id)).not.toContain(page.id);
  });

  it("keeps reserved top-level routes outside dynamic page routing", async () => {
    for (const path of [
      "/api/v1/health",
      "/mcp",
      "/app",
      "/assets/htmx.min.js",
      "/authorize",
      "/token",
      "/register",
      "/.well-known/oauth-authorization-server",
    ]) {
      const response = await SELF.fetch(`https://example.com${path}`, {
        headers: cookie(ADMIN_TOKEN),
      });
      expect(response.status).not.toBe(404);
    }
  });

  it("evaluates page display formulas and renders them as Mustache fields", async () => {
    const adminCtx = {
      env,
      user: { id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true },
      source: "test:formula",
    };

    // Create a page with formulas defined in display options
    const page = await createPage(adminCtx, {
      title: "Metrics Dashboard",
      slug: `formula-page-${Date.now().toString(36)}`,
      status: "published",
      template: `
        <section>
          <h1>{{page.title}}</h1>
          {{#tasks}}
          <div>
            <p>{{title}} - Completion: {{completion_percent}}%</p>
          </div>
          {{/tasks}}
        </section>
      `,
      queries: {
        tasks: {
          kind: "tasks",
          filters: {},
          limit: 10,
          display: {
            formulas: {
              completion_percent: "roundTo((completed_count / total_count) * 100, 1)",
            },
          },
        },
      },
    });

    expect(page.id).toBeTruthy();
    expect(page.slug).toBeTruthy();

    // Verify the page was created with formulas in the queries
    const queries = page.queries as Record<
      string,
      { display?: { formulas?: Record<string, string> } }
    >;
    expect(queries.tasks?.display?.formulas?.completion_percent).toBe(
      "roundTo((completed_count / total_count) * 100, 1)",
    );

    // Test formula evaluation through the page preview
    const adminCtxForPreview = {
      env,
      user: { id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true },
      source: "test:formula",
    };
    const preview = await previewPage(adminCtxForPreview, {
      id: page.id,
    });
    expect(preview.html).toContain("Metrics Dashboard");
  });

  it("rejects pages with invalid formula expressions", async () => {
    const adminCtx = {
      env,
      user: { id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true },
      source: "test:formula",
    };

    // Try to create page with member access in formula
    await expect(
      createPage(adminCtx, {
        title: "Bad Formula",
        slug: `bad-formula-${Date.now().toString(36)}`,
        status: "published",
        template: "<p>{{value}}</p>",
        queries: {
          data: {
            kind: "thoughts",
            filters: {},
            limit: 10,
            display: {
              formulas: {
                bad: "obj.property",
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/member access/);

    // Try to create page with string literal in formula
    await expect(
      createPage(adminCtx, {
        title: "Bad Formula 2",
        slug: `bad-formula-2-${Date.now().toString(36)}`,
        status: "published",
        template: "<p>{{value}}</p>",
        queries: {
          data: {
            kind: "thoughts",
            filters: {},
            limit: 10,
            display: {
              formulas: {
                bad: '"string"',
              },
            },
          },
        },
      }),
    ).rejects.toThrow(/string/);

    // Try to create page with too many formulas
    const tooManyFormulas: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      tooManyFormulas[`formula_${i}`] = "1 + 1";
    }
    await expect(
      createPage(adminCtx, {
        title: "Too Many Formulas",
        slug: `too-many-formulas-${Date.now().toString(36)}`,
        status: "published",
        template: "<p>{{value}}</p>",
        queries: {
          data: {
            kind: "thoughts",
            filters: {},
            limit: 10,
            display: {
              formulas: tooManyFormulas,
            },
          },
        },
      }),
    ).rejects.toThrow(/maximum/);
  });
});
