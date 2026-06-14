import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { createDb, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { addDocument, createProject, remember } from "../src/memory";

const ADMIN_TOKEN = "ui-pages-admin-token";
const USER_TOKEN = "ui-pages-user-token";
const ADMIN_ID = "ui-pages-admin";
const USER_ID = "ui-pages-user";

function cookie(token: string) {
  return { Cookie: `brainfog_token=${token}` };
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
});
