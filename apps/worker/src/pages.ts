import {
  createDb,
  documentChunks,
  documents,
  facts,
  pageAccessLinks,
  pages,
  people,
  projects,
  tasks,
  thoughts,
  timeSeriesPoints,
  users,
} from "@brainfog/db";
import { generateToken, hashToken } from "@brainfog/shared";
import { and, desc, eq, gt, gte, isNull, like, lte, type SQL } from "drizzle-orm";
import Mustache from "mustache";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";
import type { Env } from "./env";
import { applyFormulas, validateFormulas } from "./formula";
import { createId, MemoryError, type MemoryUser, validateSlug } from "./memory";

export type PageCtx = { env: Env; user: MemoryUser; source?: string };
type PageStatus = "draft" | "published" | "archived";
type QueryKind =
  | "thoughts"
  | "facts"
  | "tasks"
  | "people"
  | "projects"
  | "documents"
  | "document_chunks"
  | "time_series_points"
  | "recall";
type PageQueryDisplay = {
  formulas?: Record<string, string>;
};

type PageQuery = {
  name: string;
  kind: QueryKind;
  filters: Record<string, unknown>;
  limit: number;
  sort?: string;
  transforms: string[];
  display?: PageQueryDisplay;
};

const allowedKinds = new Set<QueryKind>([
  "thoughts",
  "facts",
  "tasks",
  "people",
  "projects",
  "documents",
  "document_chunks",
  "time_series_points",
  "recall",
]);
const allowedFilters = new Set([
  "project_id",
  "status",
  "type",
  "series_key",
  "subject_type",
  "subject_id",
  "from",
  "to",
  "q",
  "id",
]);
const allowedTransforms = new Set([
  "date_labels",
  "status_labels",
  "excerpts",
  "app_links",
  "count",
]);
const allowedTags = new Set([
  "section",
  "article",
  "header",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "p",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "dl",
  "dt",
  "dd",
  "blockquote",
  "code",
  "pre",
  "strong",
  "em",
  "small",
  "a",
  "time",
  "div",
  "span",
]);
const allowedAttrs = new Set(["class", "href", "title", "datetime"]);

function source(ctx: PageCtx) {
  return ctx.source ?? "page:service";
}

function asDate(value: unknown, fallback?: Date) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value * 1000);
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return new Date(n * 1000);
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t);
  }
  throw new MemoryError(400, "timestamp must be unix seconds or ISO date");
}

function iso(value: unknown) {
  const d = value instanceof Date ? value : value ? new Date(String(value)) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

function normalizeQueries(input: unknown): PageQuery[] {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const entries = Array.isArray(input)
    ? input.map((v, i) => [String((v as { name?: unknown })?.name ?? `dataset_${i + 1}`), v])
    : Object.entries(raw.datasets && typeof raw.datasets === "object" ? raw.datasets : raw);
  return entries.map(([name, value]) => {
    if (!/^[a-z][a-z0-9_]{0,48}$/.test(name))
      throw new MemoryError(400, `invalid dataset name: ${name}`);
    if (!value || typeof value !== "object")
      throw new MemoryError(400, `invalid query for ${name}`);
    const v = value as Record<string, unknown>;
    const kind = String(v.kind ?? "") as QueryKind;
    if (!allowedKinds.has(kind)) throw new MemoryError(400, `invalid query kind for ${name}`);
    const filters = (v.filters && typeof v.filters === "object" ? v.filters : {}) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(filters)) {
      if (!allowedFilters.has(key)) throw new MemoryError(400, `unsupported filter: ${key}`);
    }
    const limit = Math.min(100, Math.max(1, Number(v.limit ?? 25) || 25));
    const transforms = Array.isArray(v.transforms)
      ? v.transforms.map(String)
      : typeof v.transforms === "string"
        ? [v.transforms]
        : [];
    for (const transform of transforms) {
      if (!allowedTransforms.has(transform))
        throw new MemoryError(400, `unsupported transform: ${transform}`);
    }
    const display =
      v.display && typeof v.display === "object"
        ? (v.display as Record<string, unknown>)
        : undefined;
    const formulas =
      display?.formulas && typeof display.formulas === "object"
        ? (display.formulas as Record<string, string>)
        : undefined;

    // Validate formulas if present
    if (formulas) {
      const formulaErrors = validateFormulas(formulas);
      if (formulaErrors.length > 0) {
        const errorMsg = formulaErrors.map((e) => `${e.field}: ${e.message}`).join("; ");
        throw new MemoryError(400, `invalid formulas for ${name}: ${errorMsg}`);
      }
    }

    return {
      name,
      kind,
      filters,
      limit,
      sort: typeof v.sort === "string" ? v.sort : undefined,
      transforms,
      display: formulas ? { formulas } : undefined,
    };
  });
}

function validateTemplate(template: string, datasetNames: string[]) {
  const errors: string[] = [];
  if (template.includes("{{{") || /{{\s*&/.test(template))
    errors.push("raw interpolation is not allowed");
  try {
    Mustache.parse(template);
  } catch (error) {
    errors.push(`invalid mustache template: ${(error as Error).message}`);
  }
  for (const match of template.matchAll(/{{[#^]\s*([\w.]+)\s*}}/g)) {
    const name = (match[1] ?? "").split(".")[0] ?? "";
    if (!datasetNames.includes(name) && !["page", "owner"].includes(name)) {
      errors.push(`template references unknown section: ${name}`);
    }
  }
  const fragment = parseFragment(template);
  const visit = (node: DefaultTreeAdapterMap["node"]) => {
    if ("tagName" in node) {
      const tag = node.tagName.toLowerCase();
      if (!allowedTags.has(tag)) errors.push(`disallowed tag: ${tag}`);
      for (const attr of node.attrs ?? []) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "style" || name.startsWith("hx-")) {
          errors.push(`disallowed attribute: ${name}`);
        } else if (!allowedAttrs.has(name) && !name.startsWith("data-")) {
          errors.push(`disallowed attribute: ${name}`);
        }
        if (name === "href") {
          const value = attr.value.trim();
          if (
            !(value.startsWith("/") && !value.startsWith("//")) &&
            !value.startsWith("https://")
          ) {
            errors.push("href must be same-origin or https");
          }
        }
      }
    }
    for (const child of "childNodes" in node ? node.childNodes : []) visit(child);
  };
  for (const child of fragment.childNodes) visit(child);
  return errors;
}

export function validatePageDefinition(template: string, queries: unknown) {
  const normalized = normalizeQueries(queries);
  const errors = validateTemplate(
    template,
    normalized.map((q) => q.name),
  );
  if (errors.length) throw new MemoryError(400, errors.join("; "));
  return { normalized, errors };
}

function textFilter(column: Parameters<typeof like>[0], q: unknown): SQL<unknown> | undefined {
  return typeof q === "string" && q.trim() ? like(column, `%${q.trim()}%`) : undefined;
}

function dateFilter(column: Parameters<typeof gte>[0], filters: Record<string, unknown>) {
  const out: SQL<unknown>[] = [];
  const from = asDate(filters.from);
  const to = asDate(filters.to);
  if (from) out.push(gte(column, from));
  if (to) out.push(lte(column, to));
  return out;
}

function mapRows(
  kind: QueryKind,
  rows: Record<string, unknown>[],
  transforms: string[],
  formulas?: Record<string, string>,
) {
  const withRows = rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    const createdAt = r.createdAt ?? r.created_at;
    const updatedAt = r.updatedAt ?? r.updated_at;
    if (transforms.includes("date_labels")) {
      out.created_at_label = iso(createdAt)?.slice(0, 10) ?? "";
      out.updated_at_label = iso(updatedAt)?.slice(0, 10) ?? "";
      if (r.dueAt) out.due_at_label = iso(r.dueAt)?.slice(0, 10) ?? "";
      if (r.observedAt) out.observed_at_label = iso(r.observedAt)?.slice(0, 10) ?? "";
    }
    if (transforms.includes("status_labels") && typeof r.status === "string")
      out.status_label = r.status.replace(/_/g, " ");
    if (transforms.includes("excerpts")) {
      const text = String(r.content ?? r.statement ?? r.description ?? r.title ?? "");
      out.excerpt = text.length > 140 ? `${text.slice(0, 137)}...` : text;
    }
    if (transforms.includes("app_links") && typeof r.id === "string") {
      const path =
        kind === "documents"
          ? `/app/documents/${r.id}`
          : `/app/browser/${kind.replaceAll("_", "-")}/${r.id}`;
      out.url = path;
    }
    if (formulas) {
      Object.assign(out, applyFormulas(formulas, out));
    }
    return out;
  });
  return transforms.includes("count") ? { rows: withRows, count: withRows.length } : withRows;
}

async function executeQuery(ctx: PageCtx, q: PageQuery) {
  const db = createDb(ctx.env.DB);
  const f = q.filters;
  const owner = ctx.user.id;
  const common = (conditions: (SQL<unknown> | undefined)[]) =>
    and(...(conditions.filter(Boolean) as SQL<unknown>[]));
  const rows = await (async () => {
    switch (q.kind) {
      case "thoughts":
      case "recall":
        return db
          .select()
          .from(thoughts)
          .where(
            common([
              eq(thoughts.ownerId, owner),
              typeof f.project_id === "string" ? eq(thoughts.projectId, f.project_id) : undefined,
              typeof f.type === "string" ? eq(thoughts.type, f.type) : undefined,
              typeof f.id === "string" ? eq(thoughts.id, f.id) : undefined,
              textFilter(thoughts.content, f.q),
              ...dateFilter(thoughts.createdAt, f),
            ]),
          )
          .orderBy(desc(thoughts.createdAt))
          .limit(q.limit);
      case "facts":
        return db
          .select()
          .from(facts)
          .where(
            common([
              eq(facts.ownerId, owner),
              typeof f.project_id === "string" ? eq(facts.projectId, f.project_id) : undefined,
              typeof f.status === "string" ? eq(facts.status, f.status) : undefined,
              typeof f.id === "string" ? eq(facts.id, f.id) : undefined,
              textFilter(facts.statement, f.q),
              ...dateFilter(facts.createdAt, f),
            ]),
          )
          .orderBy(desc(facts.createdAt))
          .limit(q.limit);
      case "tasks":
        return db
          .select()
          .from(tasks)
          .where(
            common([
              eq(tasks.ownerId, owner),
              typeof f.project_id === "string" ? eq(tasks.projectId, f.project_id) : undefined,
              typeof f.status === "string" ? eq(tasks.status, f.status) : undefined,
              typeof f.id === "string" ? eq(tasks.id, f.id) : undefined,
              textFilter(tasks.title, f.q),
              ...dateFilter(tasks.createdAt, f),
            ]),
          )
          .orderBy(desc(tasks.createdAt))
          .limit(q.limit);
      case "people":
        return db
          .select()
          .from(people)
          .where(
            common([
              eq(people.ownerId, owner),
              typeof f.id === "string" ? eq(people.id, f.id) : undefined,
              textFilter(people.name, f.q),
            ]),
          )
          .orderBy(desc(people.createdAt))
          .limit(q.limit);
      case "projects":
        return db
          .select()
          .from(projects)
          .where(
            common([
              eq(projects.ownerId, owner),
              typeof f.id === "string" ? eq(projects.id, f.id) : undefined,
              textFilter(projects.name, f.q),
            ]),
          )
          .orderBy(desc(projects.createdAt))
          .limit(q.limit);
      case "documents":
        return db
          .select()
          .from(documents)
          .where(
            common([
              eq(documents.ownerId, owner),
              typeof f.project_id === "string" ? eq(documents.projectId, f.project_id) : undefined,
              typeof f.id === "string" ? eq(documents.id, f.id) : undefined,
              textFilter(documents.title, f.q),
            ]),
          )
          .orderBy(desc(documents.createdAt))
          .limit(q.limit);
      case "document_chunks":
        return db
          .select({
            id: documentChunks.id,
            documentId: documentChunks.documentId,
            content: documentChunks.content,
            chunkIndex: documentChunks.chunkIndex,
            createdAt: documentChunks.createdAt,
          })
          .from(documentChunks)
          .innerJoin(documents, eq(documentChunks.documentId, documents.id))
          .where(
            common([
              eq(documents.ownerId, owner),
              typeof f.id === "string" ? eq(documentChunks.id, f.id) : undefined,
              textFilter(documentChunks.content, f.q),
            ]),
          )
          .orderBy(desc(documentChunks.createdAt))
          .limit(q.limit);
      case "time_series_points":
        return db
          .select()
          .from(timeSeriesPoints)
          .where(
            common([
              eq(timeSeriesPoints.ownerId, owner),
              typeof f.project_id === "string"
                ? eq(timeSeriesPoints.projectId, f.project_id)
                : undefined,
              typeof f.series_key === "string"
                ? eq(timeSeriesPoints.seriesKey, f.series_key)
                : undefined,
              ...dateFilter(timeSeriesPoints.observedAt, f),
            ]),
          )
          .orderBy(desc(timeSeriesPoints.observedAt))
          .limit(q.limit);
    }
  })();
  return mapRows(q.kind, rows as Record<string, unknown>[], q.transforms, q.display?.formulas);
}

export async function buildPageViewModel(
  ctx: PageCtx,
  page: { title: string; slug: string; queries: unknown },
) {
  const normalized = normalizeQueries(page.queries);
  const datasets: Record<string, unknown> = {};
  for (const query of normalized) datasets[query.name] = await executeQuery(ctx, query);
  return {
    ...datasets,
    page: { title: page.title, slug: page.slug },
    owner: { slug: ctx.user.slug, name: ctx.user.name },
  };
}

export async function renderPage(
  ctx: PageCtx,
  page: { title: string; slug: string; template: string; queries: unknown },
) {
  validatePageDefinition(page.template, page.queries);
  return Mustache.render(page.template, await buildPageViewModel(ctx, page));
}

function serialize(row: typeof pages.$inferSelect) {
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

async function getOwnedPage(ctx: PageCtx, id: string) {
  const row = (
    await createDb(ctx.env.DB)
      .select()
      .from(pages)
      .where(and(eq(pages.id, id), eq(pages.ownerId, ctx.user.id)))
      .limit(1)
  )[0];
  if (!row) throw new MemoryError(404, "page not found");
  return row;
}

export async function listPages(ctx: PageCtx, args: { status?: string } = {}) {
  const where = args.status
    ? and(eq(pages.ownerId, ctx.user.id), eq(pages.status, args.status))
    : eq(pages.ownerId, ctx.user.id);
  return (
    await createDb(ctx.env.DB).select().from(pages).where(where).orderBy(desc(pages.updatedAt))
  ).map(serialize);
}

export async function getPage(ctx: PageCtx, id: string) {
  return serialize(await getOwnedPage(ctx, id));
}

export async function createPage(
  ctx: PageCtx,
  input: {
    title: string;
    slug: string;
    template: string;
    queries: unknown;
    description?: string | null;
    status?: PageStatus;
  },
) {
  const slug = validateSlug(input.slug);
  if (!slug) throw new MemoryError(400, "slug required");
  const status = input.status ?? "draft";
  if (!["draft", "published", "archived"].includes(status))
    throw new MemoryError(400, "invalid status");
  validatePageDefinition(input.template, input.queries);
  const row = {
    id: createId("page"),
    ownerId: ctx.user.id,
    source: source(ctx),
    title: input.title,
    slug,
    description: input.description ?? null,
    status,
    template: input.template,
    queries: (input.queries && typeof input.queries === "object" ? input.queries : {}) as Record<
      string,
      unknown
    >,
    validationErrors: [],
  };
  await createDb(ctx.env.DB).insert(pages).values(row);
  return getPage(ctx, row.id);
}

export async function updatePage(
  ctx: PageCtx,
  id: string,
  input: {
    title?: string;
    slug?: string;
    template?: string;
    queries?: unknown;
    description?: string | null;
    status?: PageStatus;
  },
) {
  const row = await getOwnedPage(ctx, id);
  const next = {
    title: input.title ?? row.title,
    slug: input.slug ? validateSlug(input.slug) : row.slug,
    template: input.template ?? row.template,
    queries: input.queries ?? row.queries,
    description: Object.hasOwn(input, "description")
      ? (input.description ?? null)
      : row.description,
    status: input.status ?? row.status,
  };
  if (!next.slug) throw new MemoryError(400, "slug required");
  if (!["draft", "published", "archived"].includes(next.status))
    throw new MemoryError(400, "invalid status");
  validatePageDefinition(next.template, next.queries);
  await createDb(ctx.env.DB)
    .update(pages)
    .set({
      ...next,
      queries: next.queries as Record<string, unknown>,
      slug: next.slug,
      validationErrors: [],
      updatedAt: new Date(),
    })
    .where(and(eq(pages.id, id), eq(pages.ownerId, ctx.user.id)));
  return getPage(ctx, id);
}

export async function deletePage(ctx: PageCtx, id: string) {
  await getOwnedPage(ctx, id);
  await createDb(ctx.env.DB)
    .delete(pages)
    .where(and(eq(pages.id, id), eq(pages.ownerId, ctx.user.id)));
  return { ok: true };
}

export async function previewPage(
  ctx: PageCtx,
  input: { id?: string; template?: string; queries?: unknown },
) {
  const page = input.id
    ? await getOwnedPage(ctx, input.id)
    : {
        title: "Preview",
        slug: "preview",
        template: input.template ?? "",
        queries: input.queries ?? {},
      };
  return {
    html: await renderPage(ctx, {
      ...page,
      template: input.template ?? page.template,
      queries: input.queries ?? page.queries,
    }),
  };
}

function linkMetadata(row: typeof pageAccessLinks.$inferSelect) {
  return {
    id: row.id,
    pageId: row.pageId,
    label: row.label,
    expiresAt: iso(row.expiresAt),
    maxUses: row.maxUses,
    useCount: row.useCount,
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export async function createPageAccessLink(
  ctx: PageCtx,
  pageId: string,
  input: {
    expires_at?: unknown;
    ttl_seconds?: number;
    max_uses?: number | null;
    label?: string | null;
  },
  origin = "",
) {
  const page = await getOwnedPage(ctx, pageId);
  const expiresAt = asDate(
    input.expires_at,
    new Date(Date.now() + (input.ttl_seconds ?? 24 * 3600) * 1000),
  );
  if (!expiresAt) throw new MemoryError(400, "expires_at required");
  const secret = generateToken();
  const row = {
    id: createId("pageAccessLink"),
    ownerId: ctx.user.id,
    pageId,
    source: source(ctx),
    label: input.label ?? null,
    secretHash: await hashToken(secret, ctx.env.BRAINFOG_TOKEN_HASH_SECRET),
    expiresAt,
    maxUses: input.max_uses ?? 1,
  };
  await createDb(ctx.env.DB).insert(pageAccessLinks).values(row);
  return {
    ...linkMetadata({
      ...row,
      useCount: 0,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    url: `${origin}/${ctx.user.slug}/${page.slug}?access=${secret}`,
  };
}

export async function listPageAccessLinks(ctx: PageCtx, pageId: string) {
  await getOwnedPage(ctx, pageId);
  return (
    await createDb(ctx.env.DB)
      .select()
      .from(pageAccessLinks)
      .where(and(eq(pageAccessLinks.ownerId, ctx.user.id), eq(pageAccessLinks.pageId, pageId)))
      .orderBy(desc(pageAccessLinks.createdAt))
  ).map(linkMetadata);
}

export async function revokePageAccessLink(ctx: PageCtx, id: string) {
  await createDb(ctx.env.DB)
    .update(pageAccessLinks)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(pageAccessLinks.id, id), eq(pageAccessLinks.ownerId, ctx.user.id)));
  return { ok: true };
}

export async function findPublishedPageByPath(env: Env, userSlug: string, pageSlug: string) {
  const row = (
    await createDb(env.DB)
      .select({ page: pages, user: users })
      .from(pages)
      .innerJoin(users, eq(pages.ownerId, users.id))
      .where(and(eq(users.slug, userSlug), eq(pages.slug, pageSlug), eq(pages.status, "published")))
      .limit(1)
  )[0];
  return row ? { page: row.page, user: row.user } : null;
}

export async function exchangePageAccess(env: Env, pageId: string, secret: string) {
  const secretHash = await hashToken(secret, env.BRAINFOG_TOKEN_HASH_SECRET);
  const db = createDb(env.DB);
  const row = (
    await db
      .select()
      .from(pageAccessLinks)
      .where(
        and(
          eq(pageAccessLinks.pageId, pageId),
          eq(pageAccessLinks.secretHash, secretHash),
          isNull(pageAccessLinks.revokedAt),
          gt(pageAccessLinks.expiresAt, new Date()),
        ),
      )
      .limit(1)
  )[0];
  if (!row || (row.maxUses !== null && row.useCount >= row.maxUses)) return null;
  await db
    .update(pageAccessLinks)
    .set({ useCount: row.useCount + 1, lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(pageAccessLinks.id, row.id));
  return { expiresAt: row.expiresAt };
}

export async function validatePageAccessCookie(env: Env, pageId: string, token: string) {
  const secretHash = await hashToken(token, env.BRAINFOG_TOKEN_HASH_SECRET);
  const row = (
    await createDb(env.DB)
      .select({ id: pageAccessLinks.id })
      .from(pageAccessLinks)
      .where(
        and(
          eq(pageAccessLinks.pageId, pageId),
          eq(pageAccessLinks.secretHash, secretHash),
          isNull(pageAccessLinks.revokedAt),
          gt(pageAccessLinks.expiresAt, new Date()),
        ),
      )
      .limit(1)
  )[0];
  return Boolean(row);
}
