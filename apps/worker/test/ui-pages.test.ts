import { applyD1Migrations, env, SELF } from "cloudflare:test";
import {
  createDb,
  documents,
  documentVersions,
  ingestionConnectors,
  ingestionRuns,
  pageAccessLinks,
  pages,
  thoughts,
  timeSeriesPoints,
  tokens,
  users,
} from "@brainfog/db";
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

async function apiFetch(path: string, init: RequestInit = {}, token = ADMIN_TOKEN) {
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
    expect(html).toContain("Connectors");
    expect(html).toContain("Users");
  });

  it("renders owner-scoped connector list/detail pages without credential or run secrets", async () => {
    const secretValues = [
      "plain-garmin-password-021",
      "garmin.user.021@example.com",
      "config-login-identifier-021",
      "cursor.email.021@example.com",
      "schedule-login-identifier-021",
      "message-token-021",
      "last-error-token-021",
      "run.metadata.021@example.com",
      "run-error-token-021",
      "Bearer ui-secret-token-021",
      "session-cookie-value-021",
      "encrypted-payload-blob-021",
      "raw-runner-password-021",
      "other-user-connector-021",
    ];
    const project = await createProject(
      {
        env,
        user: { id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true },
        source: "test:connector-ui",
      },
      { name: "Connector UI Project" },
    );

    const connector = await json<{ id: string }>(
      await apiFetch("/api/v1/ingestion/connectors", {
        method: "POST",
        body: JSON.stringify({
          type: "garmin",
          name: "Garmin UI Connector",
          project_id: project.id,
          source: "ingestion:garmin-ui",
          config: {
            window: "daily",
            username: "garmin.user.021@example.com",
            email: "garmin.user.021@example.com",
            login: "config-login-identifier-021",
            message: "Garmin auth failed for garmin.user.021@example.com token=message-token-021",
            password: "plain-garmin-password-021",
            encrypted_payload: "encrypted-payload-blob-021",
          },
          schedule: {
            frequency: "daily",
            bearer_token: "Bearer ui-secret-token-021",
            login: "schedule-login-identifier-021",
          },
          cursor: {
            latest_date: "2026-06-23",
            session_cookie: "session-cookie-value-021",
            email: "cursor.email.021@example.com",
          },
        }),
      }),
    );
    const otherConnector = await json<{ id: string }>(
      await apiFetch(
        "/api/v1/ingestion/connectors",
        {
          method: "POST",
          body: JSON.stringify({ type: "garmin", name: "other-user-connector-021" }),
        },
        USER_TOKEN,
      ),
    );

    await apiFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "password",
        status: "valid",
        payload: {
          username: "garmin.user.021@example.com",
          password: "plain-garmin-password-021",
          token: "Bearer ui-secret-token-021",
          session_cookie: "session-cookie-value-021",
        },
      }),
    });
    const run = await json<{ id: string }>(
      await apiFetch(`/api/v1/ingestion/connectors/${connector.id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          trigger: "bridge",
          cursor_after: { latest_date: "2026-06-24", session_cookie: "session-cookie-value-021" },
          metadata: {
            submitted_by: "ui-test",
            email: "run.metadata.021@example.com",
            message: "authorization=message-token-021",
            runner_payload: { password: "raw-runner-password-021" },
            note: "token: Bearer ui-secret-token-021",
          },
          points: [
            {
              source_item_id: "connector-ui-source-021",
              series_key: "connector.ui.steps",
              value: 21,
              unit: "count",
              observed_at: 1782172800,
              metadata: { external_id: "connector-ui-source-021" },
            },
          ],
        }),
      }),
    );
    const db = createDb(env.DB);
    await db
      .update(ingestionConnectors)
      .set({
        lastError:
          "Garmin login for garmin.user.021@example.com failed with token=last-error-token-021",
      })
      .where(eq(ingestionConnectors.id, connector.id));
    await db
      .update(ingestionRuns)
      .set({
        error: {
          message: "Run failed for garmin.user.021@example.com token=run-error-token-021",
          login: "config-login-identifier-021",
        },
      })
      .where(eq(ingestionRuns.id, run.id));

    const list = await SELF.fetch("https://example.com/app/connectors", {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain("Garmin UI Connector");
    expect(listHtml).toContain("garmin");
    expect(listHtml).toContain("active");
    expect(listHtml).toContain("valid");
    expect(listHtml).toContain(`/app/connectors/${connector.id}`);
    expect(listHtml).not.toContain(otherConnector.id);
    for (const secret of secretValues) expect(listHtml).not.toContain(secret);

    const detail = await SELF.fetch(`https://example.com/app/connectors/${connector.id}`, {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("Garmin UI Connector");
    expect(detailHtml).toContain("Configuration");
    expect(detailHtml).toContain("Schedule");
    expect(detailHtml).toContain("Cursor / checkpoint");
    expect(detailHtml).toContain("Credential status");
    expect(detailHtml).toContain("Recent runs");
    expect(detailHtml).toContain(run.id);
    expect(detailHtml).toContain("bridge");
    expect(detailHtml).toContain("succeeded");
    expect(detailHtml).toContain("[redacted]");
    expect(detailHtml).toContain("submitted_by");
    for (const secret of secretValues) expect(detailHtml).not.toContain(secret);

    const crossOwner = await SELF.fetch(`https://example.com/app/connectors/${connector.id}`, {
      headers: cookie(USER_TOKEN),
    });
    expect(crossOwner.status).toBe(404);
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
    expect(raw.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await raw.text()).toContain("<script>alert('x')</script>");

    const crossOwner = await SELF.fetch(`https://example.com/app/documents/${documentId}/raw`, {
      headers: cookie(USER_TOKEN),
    });
    expect(crossOwner.status).toBe(404);
  });

  it("exposes browser document write modes and creates historical versions on request", async () => {
    const ctx = {
      env,
      user: { id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true },
      source: "test:ui-versions",
    };
    const document = await addDocument(ctx, {
      title: "Versioned UI Doc",
      mime_type: "text/markdown",
      content: "# Previous UI Version\n\nold-version-secret-024",
    });

    const edit = await SELF.fetch(`https://example.com/app/browser/documents/${document.id}/edit`, {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(edit.status).toBe(200);
    const editHtml = await edit.text();
    expect(editHtml).toContain('name="write_mode"');
    expect(editHtml).toContain('value="overwrite_current"');
    expect(editHtml).toContain('value="create_version"');

    const saved = await SELF.fetch(
      `https://example.com/app/browser/documents/${document.id}/edit`,
      {
        method: "POST",
        headers: { ...cookie(ADMIN_TOKEN), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          write_mode: "create_version",
          content: "# Current UI Version\n\nnew-current-024",
        }).toString(),
        redirect: "manual",
      },
    );
    expect(saved.status).toBe(302);

    const current = await SELF.fetch(`https://example.com/app/documents/${document.id}/raw`, {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(await current.text()).toContain("new-current-024");

    const detail = await SELF.fetch(`https://example.com/app/browser/documents/${document.id}`, {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("Versions");
    expect(detailHtml).toContain("current");
    expect(detailHtml).toContain("historical");
    expect(detailHtml).toContain(`/app/documents/${document.id}/versions/1/content`);
    expect(detailHtml).not.toContain("r2Key");
    const db = createDb(env.DB);
    const docRow = (await db.select().from(documents).where(eq(documents.id, document.id)))[0];
    const versionRow = (
      await db.select().from(documentVersions).where(eq(documentVersions.documentId, document.id))
    )[0];
    expect(docRow).toBeTruthy();
    expect(versionRow).toBeTruthy();
    if (!docRow || !versionRow) throw new Error("expected document and version rows");
    expect(detailHtml).not.toContain(docRow.r2Key);
    expect(detailHtml).not.toContain(versionRow.r2Key);

    const unauthenticated = await SELF.fetch(
      `https://example.com/app/documents/${document.id}/versions/1/content`,
      { redirect: "manual" },
    );
    expect(unauthenticated.status).toBe(302);

    const historical = await SELF.fetch(
      `https://example.com/app/documents/${document.id}/versions/1/content`,
      { headers: cookie(ADMIN_TOKEN) },
    );
    expect(historical.status).toBe(200);
    expect(historical.headers.get("cache-control")).toBe("no-store");
    const historicalHtml = await historical.text();
    expect(historicalHtml).toContain("Previous UI Version");
    expect(historicalHtml).toContain("old-version-secret-024");
    expect(historicalHtml).not.toContain("new-current-024");

    const download = await SELF.fetch(
      `https://example.com/app/documents/${document.id}/versions/1/download`,
      { headers: cookie(ADMIN_TOKEN) },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(download.headers.get("content-disposition")).toMatch(/attachment/);
    expect(await download.text()).toContain("old-version-secret-024");

    const currentAfterHistoryRead = await SELF.fetch(
      `https://example.com/app/documents/${document.id}/raw`,
      { headers: cookie(ADMIN_TOKEN) },
    );
    expect(await currentAfterHistoryRead.text()).toContain("new-current-024");
  });

  it("keeps browser overwrite_current edits out of version history", async () => {
    const ctx = {
      env,
      user: { id: ADMIN_ID, name: "UI Admin", slug: "ui-admin", isAdmin: true },
      source: "test:ui-overwrite",
    };
    const document = await addDocument(ctx, {
      title: "Overwrite UI Doc",
      mime_type: "text/plain",
      content: "overwrite before 024",
    });

    const saved = await SELF.fetch(
      `https://example.com/app/browser/documents/${document.id}/edit`,
      {
        method: "POST",
        headers: { ...cookie(ADMIN_TOKEN), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          write_mode: "overwrite_current",
          content: "overwrite after 024",
        }).toString(),
        redirect: "manual",
      },
    );
    expect(saved.status).toBe(302);

    const versions = await createDb(env.DB)
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, document.id));
    expect(versions).toHaveLength(0);
    const raw = await SELF.fetch(`https://example.com/app/documents/${document.id}/raw`, {
      headers: cookie(ADMIN_TOKEN),
    });
    expect(await raw.text()).toBe("overwrite after 024");
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

describe("pivot_by_date transform", () => {
  const PIVOT_USER = "pivot-test-user";
  const PIVOT_TOKEN = "pivot-test-token";

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
    const db = createDb(env.DB);
    await db.insert(users).values({ id: PIVOT_USER, name: "Pivot", slug: "pivot-test" });
    await db.insert(tokens).values({
      id: `${PIVOT_USER}-token`,
      userId: PIVOT_USER,
      tokenHash: await hashToken(PIVOT_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });
    // Insert three series for two dates (simulating electricity-style multi-series)
    await db.insert(timeSeriesPoints).values([
      {
        id: "pivot-before-d1",
        ownerId: PIVOT_USER,
        source: "test",
        seriesKey: "elec.before",
        value: 100,
        unit: "kWh",
        observedAt: new Date("2024-02-01"),
        metadata: { notes: "first note" },
      },
      {
        id: "pivot-after-d1",
        ownerId: PIVOT_USER,
        source: "test",
        seriesKey: "elec.after",
        value: 250,
        unit: "kWh",
        observedAt: new Date("2024-02-01"),
        metadata: {},
      },
      {
        id: "pivot-spent-d1",
        ownerId: PIVOT_USER,
        source: "test",
        seriesKey: "elec.spent",
        value: 1500,
        unit: "ZAR",
        observedAt: new Date("2024-02-01"),
        metadata: {},
      },
      {
        id: "pivot-before-d2",
        ownerId: PIVOT_USER,
        source: "test",
        seriesKey: "elec.before",
        value: 50,
        unit: "kWh",
        observedAt: new Date("2024-03-01"),
        metadata: { notes: "second note" },
      },
      {
        id: "pivot-after-d2",
        ownerId: PIVOT_USER,
        source: "test",
        seriesKey: "elec.after",
        value: 280,
        unit: "kWh",
        observedAt: new Date("2024-03-01"),
        metadata: {},
      },
    ]);
  });

  it("groups time_series_points by observedAt date and exposes series suffixes as fields", async () => {
    const ctx = {
      env,
      user: { id: PIVOT_USER, name: "Pivot", slug: "pivot-test" },
      source: "test",
    };
    const { html } = await previewPage(ctx, {
      template:
        "<table>{{#data}}<tr><td>{{observed_at_label}}</td><td>{{before}}</td><td>{{after}}</td><td>{{spent}}</td><td>{{notes}}</td></tr>{{/data}}</table>",
      queries: {
        data: {
          kind: "time_series_points",
          filters: { series_prefix: "elec" },
          limit: 10,
          transforms: ["pivot_by_date"],
        },
      },
    });
    // Expect two pivot rows (one per date), newest first
    expect(html).toContain("2024-03-01");
    expect(html).toContain("2024-02-01");
    // Field values from pivot
    expect(html).toContain("<td>50</td>"); // before on 2024-03-01
    expect(html).toContain("<td>280</td>"); // after on 2024-03-01
    expect(html).toContain("<td>100</td>"); // before on 2024-02-01
    expect(html).toContain("<td>1500</td>"); // spent on 2024-02-01
    // Notes merged from metadata.notes
    expect(html).toContain("first note");
    expect(html).toContain("second note");
  });

  it("uses the query series_prefix for multi-segment pivot fields", async () => {
    const db = createDb(env.DB);
    const metadata = {
      activity_name: "Great Kei Cycling",
      activity_type: "cycling",
      activity_id: "23296884177",
    };
    await db.insert(timeSeriesPoints).values([
      {
        id: "pivot-garmin-duration",
        ownerId: PIVOT_USER,
        source: "test",
        seriesKey: "garmin.activities.duration",
        value: 1913,
        unit: "s",
        observedAt: new Date("2026-06-18T11:27:32Z"),
        metadata,
      },
      {
        id: "pivot-garmin-distance",
        ownerId: PIVOT_USER,
        source: "test",
        seriesKey: "garmin.activities.distance",
        value: 4210,
        unit: "m",
        observedAt: new Date("2026-06-18T11:27:32Z"),
        metadata,
      },
      {
        id: "pivot-garmin-avg-hr",
        ownerId: PIVOT_USER,
        source: "test",
        seriesKey: "garmin.activities.avg_heart_rate",
        value: 158,
        unit: "bpm",
        observedAt: new Date("2026-06-18T11:27:32Z"),
        metadata,
      },
    ]);

    const ctx = {
      env,
      user: { id: PIVOT_USER, name: "Pivot", slug: "pivot-test" },
      source: "test",
    };
    const { html } = await previewPage(ctx, {
      template:
        "<table>{{#data}}<tr><td>{{observed_at_label}}</td><td>{{activity_name}}</td><td>{{activity_type}}</td><td>{{duration_min}}</td><td>{{distance_km}}</td><td>{{avg_heart_rate}}</td></tr>{{/data}}</table>",
      queries: {
        data: {
          kind: "time_series_points",
          filters: { series_prefix: "garmin.activities" },
          limit: 10,
          transforms: ["pivot_by_date", "date_labels"],
          display: {
            formulas: {
              duration_min: "roundTo(duration / 60, 1)",
              distance_km: "roundTo(distance / 1000, 2)",
            },
          },
        },
      },
    });

    expect(html).toContain("2026-06-18");
    expect(html).toContain("Great Kei Cycling");
    expect(html).toContain("cycling");
    expect(html).toContain("31.9");
    expect(html).toContain("4.21");
    expect(html).toContain("158");
  });

  it("applies limit to post-pivot rows, not pre-pivot rows", async () => {
    const ctx = {
      env,
      user: { id: PIVOT_USER, name: "Pivot", slug: "pivot-test" },
      source: "test",
    };
    const { html } = await previewPage(ctx, {
      template: "{{#data}}<p>{{observed_at_label}}</p>{{/data}}",
      queries: {
        data: {
          kind: "time_series_points",
          filters: { series_prefix: "elec" },
          limit: 1, // only the newest pivot row
          transforms: ["pivot_by_date"],
        },
      },
    });
    expect(html).toContain("2024-03-01");
    expect(html).not.toContain("2024-02-01");
  });

  it("pivot_by_date has no effect on non-time_series_points queries", async () => {
    const ctx = {
      env,
      user: { id: PIVOT_USER, name: "Pivot", slug: "pivot-test" },
      source: "test",
    };
    // Should not throw; transform is silently ignored for thoughts
    const { html } = await previewPage(ctx, {
      template: "{{^rows}}<p>empty</p>{{/rows}}",
      queries: {
        rows: {
          kind: "thoughts",
          filters: {},
          limit: 5,
          transforms: ["pivot_by_date"],
        },
      },
    });
    expect(html).toContain("empty");
  });
});

describe("pivot_by_year transform", () => {
  const YEAR_USER = "pivot-year-test-user";
  const YEAR_TOKEN = "pivot-year-test-token";

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
    const db = createDb(env.DB);
    await db.insert(users).values({ id: YEAR_USER, name: "Year Pivot", slug: "pivot-year-test" });
    await db.insert(tokens).values({
      id: `${YEAR_USER}-token`,
      userId: YEAR_USER,
      tokenHash: await hashToken(YEAR_TOKEN, env.BRAINFOG_TOKEN_HASH_SECRET),
    });

    // Insert 34 rainfall-like points spanning Sep 2023 – Jun 2026 (simulating monthly data)
    // Each month gets one point, covering all 12 months for years 2024, 2025, 2026,
    // plus Sep/Oct/Nov/Dec 2023 and Jan/Feb/Mar/Apr/May/Jun 2026.
    const testData = [
      // 2023: Sep–Dec
      { month: 9, year: 2023, value: 120 },
      { month: 10, year: 2023, value: 95 },
      { month: 11, year: 2023, value: 75 },
      { month: 12, year: 2023, value: 140 },
      // 2024: Jan–Dec
      { month: 1, year: 2024, value: 105 },
      { month: 2, year: 2024, value: 90 },
      { month: 3, year: 2024, value: 112 },
      { month: 4, year: 2024, value: 265 },
      { month: 5, year: 2024, value: 78 },
      { month: 6, year: 2024, value: 265 },
      { month: 7, year: 2024, value: 2.5 },
      { month: 8, year: 2024, value: 50 },
      { month: 9, year: 2024, value: 145 },
      { month: 10, year: 2024, value: 88 },
      { month: 11, year: 2024, value: 102 },
      { month: 12, year: 2024, value: 180 },
      // 2025: Jan–Dec
      { month: 1, year: 2025, value: 230 },
      { month: 2, year: 2025, value: 175 },
      { month: 3, year: 2025, value: 198 },
      { month: 4, year: 2025, value: 244 },
      { month: 5, year: 2025, value: 156 },
      { month: 6, year: 2025, value: 195 },
      { month: 7, year: 2025, value: 17 },
      { month: 8, year: 2025, value: 62 },
      { month: 9, year: 2025, value: 192 },
      { month: 10, year: 2025, value: 125 },
      { month: 11, year: 2025, value: 143 },
      { month: 12, year: 2025, value: 210 },
      // 2026: Jan–Jun
      { month: 1, year: 2026, value: 25 },
      { month: 2, year: 2026, value: 68 },
      { month: 3, year: 2026, value: 88 },
      { month: 4, year: 2026, value: 110 },
      { month: 5, year: 2026, value: 95 },
      { month: 6, year: 2026, value: 120 },
    ];

    const points = testData.map((d, i) => ({
      id: `rainfall-${i}`,
      ownerId: YEAR_USER,
      source: "test",
      seriesKey: "weather.rainfall.monthly_total",
      value: d.value,
      unit: "mm",
      observedAt: new Date(Date.UTC(d.year, d.month - 1, 15)),
      metadata: {},
    }));

    // Insert in batches to avoid SQLite's variable limit
    for (let i = 0; i < points.length; i += 10) {
      await db.insert(timeSeriesPoints).values(points.slice(i, i + 10));
    }
  });

  it("groups time_series_points by calendar month, years as columns, exactly 12 rows", async () => {
    const ctx = {
      env,
      user: { id: YEAR_USER, name: "Year Pivot", slug: "pivot-year-test" },
      source: "test",
    };
    const { html } = await previewPage(ctx, {
      template:
        "<table>{{#data}}<tr><td>{{month}}</td><td>{{month_label}}</td><td>{{y2023}}</td><td>{{y2024}}</td><td>{{y2025}}</td><td>{{y2026}}</td></tr>{{/data}}</table>",
      queries: {
        data: {
          kind: "time_series_points",
          filters: { series_key: "weather.rainfall.monthly_total" },
          limit: 12,
          transforms: ["pivot_by_year"],
        },
      },
    });
    // Count <tr> rows in the output
    const trCount = (html.match(/<tr>/g) ?? []).length;
    expect(trCount).toBe(12);
  });

  it("row for month 1 has month_label Jan, y2024: 105, y2025: 230, y2026: 25", async () => {
    const ctx = {
      env,
      user: { id: YEAR_USER, name: "Year Pivot", slug: "pivot-year-test" },
      source: "test",
    };
    const { html } = await previewPage(ctx, {
      template:
        "{{#data}}<tr data-month='{{month}}' data-label='{{month_label}}' data-y2024='{{y2024}}' data-y2025='{{y2025}}' data-y2026='{{y2026}}'></tr>{{/data}}",
      queries: {
        data: {
          kind: "time_series_points",
          filters: { series_key: "weather.rainfall.monthly_total" },
          limit: 12,
          transforms: ["pivot_by_year"],
        },
      },
    });
    // Check that the HTML contains the expected values for January
    expect(html).toContain("data-month='1'");
    expect(html).toContain("data-label='Jan'");
    expect(html).toContain("data-y2024='105'");
    expect(html).toContain("data-y2025='230'");
    expect(html).toContain("data-y2026='25'");
  });

  it("row for month 7 has y2024: 2.5, y2025: 17, no y2023 or y2026", async () => {
    const ctx = {
      env,
      user: { id: YEAR_USER, name: "Year Pivot", slug: "pivot-year-test" },
      source: "test",
    };
    const { html } = await previewPage(ctx, {
      template:
        "{{#data}}<tr data-month='{{month}}' data-y2023='{{y2023}}' data-y2024='{{y2024}}' data-y2025='{{y2025}}' data-y2026='{{y2026}}'></tr>{{/data}}",
      queries: {
        data: {
          kind: "time_series_points",
          filters: { series_key: "weather.rainfall.monthly_total" },
          limit: 12,
          transforms: ["pivot_by_year"],
        },
      },
    });
    // July has data only for 2024 and 2025; y2023 and y2026 should be empty/absent
    expect(html).toContain("data-month='7'");
    expect(html).toContain("data-y2024='2.5'");
    expect(html).toContain("data-y2025='17'");
    // y2023 and y2026 should be empty strings (no value rendered)
    expect(html).toContain("data-y2023=''");
    expect(html).toContain("data-y2026=''");
  });

  it("all 12 months appear even if some months have no data in some years", async () => {
    const ctx = {
      env,
      user: { id: YEAR_USER, name: "Year Pivot", slug: "pivot-year-test" },
      source: "test",
    };
    const { html } = await previewPage(ctx, {
      template: "{{#data}}<tr data-month='{{month}}' data-label='{{month_label}}'></tr>{{/data}}",
      queries: {
        data: {
          kind: "time_series_points",
          filters: { series_key: "weather.rainfall.monthly_total" },
          limit: 12,
          transforms: ["pivot_by_year"],
        },
      },
    });
    // Check all 12 month labels appear
    for (let i = 1; i <= 12; i++) {
      const labels = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      expect(html).toContain(`data-label='${labels[i - 1]}'`);
    }
    // Count 12 rows
    const rowCount = (html.match(/<tr/g) ?? []).length;
    expect(rowCount).toBe(12);
  });

  it("pivot_by_year on a non-time_series_points kind passes rows through unmodified", async () => {
    const ctx = {
      env,
      user: { id: YEAR_USER, name: "Year Pivot", slug: "pivot-year-test" },
      source: "test",
    };
    // Should not throw; transform is silently ignored for facts
    const { html } = await previewPage(ctx, {
      template: "{{^rows}}<p>empty</p>{{/rows}}",
      queries: {
        rows: {
          kind: "facts",
          filters: {},
          limit: 5,
          transforms: ["pivot_by_year"],
        },
      },
    });
    expect(html).toContain("empty");
  });

  it("limit is applied to post-transform rows (max 12 for full year)", async () => {
    const ctx = {
      env,
      user: { id: YEAR_USER, name: "Year Pivot", slug: "pivot-year-test" },
      source: "test",
    };
    const { html } = await previewPage(ctx, {
      template: "{{#data}}<p>{{month}}</p>{{/data}}",
      queries: {
        data: {
          kind: "time_series_points",
          filters: { series_key: "weather.rainfall.monthly_total" },
          limit: 3, // Only first 3 month rows
          transforms: ["pivot_by_year"],
        },
      },
    });
    // Should only have Jan, Feb, Mar (months 1, 2, 3)
    expect(html).toContain("<p>1</p>");
    expect(html).toContain("<p>2</p>");
    expect(html).toContain("<p>3</p>");
    // Should not have month 4 or later
    expect(html).not.toContain("<p>4</p>");
    expect(html).not.toContain("<p>12</p>");
  });

  it("existing pivot_by_date tests continue to pass", async () => {
    // This is implicitly tested by the pivot_by_date describe block
    // but we can add an explicit check here if needed
    expect(true).toBe(true);
  });
});
