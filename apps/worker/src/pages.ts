import {
  createDb,
  dependencyEdges,
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
import { and, desc, eq, gt, gte, inArray, isNull, like, lte, type SQL } from "drizzle-orm";
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
  "series_prefix",
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
  "pivot_by_date",
  "pivot_by_year",
  "pivot_by_activity",
  "activity_notes",
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

function parseQueriesInput(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      throw new MemoryError(400, "queries must be a valid JSON object or array");
    }
  }
  return input;
}

function normalizeQueries(input: unknown): PageQuery[] {
  input = parseQueriesInput(input);
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
    const limit = Math.min(500, Math.max(1, Number(v.limit ?? 25) || 25));
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
  const sectionStack: string[] = [];
  for (const match of template.matchAll(/{{\s*([#^/])\s*([\w.]+)\s*}}/g)) {
    const marker = match[1];
    const section = match[2] ?? "";
    if (marker === "/") {
      sectionStack.pop();
      continue;
    }
    const name = section.split(".")[0] ?? "";
    if (
      sectionStack.length === 0 &&
      !datasetNames.includes(name) &&
      !["page", "owner"].includes(name)
    ) {
      errors.push(`template references unknown section: ${name}`);
    }
    sectionStack.push(section);
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
  const out: (SQL | undefined)[] = [];
  const from = asDate(filters.from);
  const to = asDate(filters.to);
  if (from) out.push(gte(column, from));
  if (to) out.push(lte(column, to));
  return out;
}

function pivotByDate(
  rows: Record<string, unknown>[],
  seriesPrefix?: string,
): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const dt = row.observedAt;
    const dateKey =
      dt instanceof Date
        ? dt.toISOString().slice(0, 10)
        : typeof dt === "string"
          ? dt.slice(0, 10)
          : "";
    if (!dateKey) continue;
    if (!groups.has(dateKey)) {
      groups.set(dateKey, { observedAt: dt, observed_at_label: dateKey });
    }
    const group = groups.get(dateKey) ?? {};
    const seriesKey = String(row.seriesKey ?? "");
    const prefix = seriesPrefix ? `${seriesPrefix}.` : "";
    const dotIdx = seriesKey.indexOf(".");
    const suffix =
      prefix && seriesKey.startsWith(prefix)
        ? seriesKey.slice(prefix.length)
        : dotIdx >= 0
          ? seriesKey.slice(dotIdx + 1)
          : seriesKey;
    if (typeof row.value === "number" && Number.isFinite(row.value)) group[suffix] = row.value;
    const meta = row.metadata as Record<string, unknown> | undefined;
    if (meta) {
      for (const [key, value] of Object.entries(meta)) {
        if (
          group[key] === undefined &&
          (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        ) {
          group[key] = value;
        }
      }
    }
  }
  return Array.from(groups.values());
}

function pivotByYear(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const MONTH_LABELS = [
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

  // Initialize 12 buckets keyed by month number (1–12)
  const buckets: Map<number, Record<string, unknown>> = new Map();
  for (let m = 1; m <= 12; m++) {
    buckets.set(m, { month: m, month_label: MONTH_LABELS[m - 1] });
  }

  for (const row of rows) {
    const dt =
      row.observedAt instanceof Date
        ? row.observedAt
        : row.observedAt
          ? new Date(String(row.observedAt))
          : null;
    if (!dt || Number.isNaN(dt.getTime())) continue;
    const month = dt.getUTCMonth() + 1; // 1–12
    const year = dt.getUTCFullYear();
    const colKey = `y${year}`;
    if (typeof row.value === "number" && Number.isFinite(row.value)) {
      const bucket = buckets.get(month);
      if (bucket) {
        bucket[colKey] = row.value;
      }
    }
  }

  return Array.from(buckets.values()); // already ordered Jan→Dec
}

function pivotByActivity(
  rows: Record<string, unknown>[],
  seriesPrefix?: string,
): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const meta = row.metadata as Record<string, unknown> | undefined;

    // Determine group key: metadata.activity_id > metadata.external_activity_id > observedAt ISO
    let activityKey: string | undefined;
    if (meta && typeof meta.activity_id === "string" && meta.activity_id) {
      activityKey = meta.activity_id;
    } else if (meta && typeof meta.external_activity_id === "string" && meta.external_activity_id) {
      activityKey = meta.external_activity_id;
    } else {
      const dt = row.observedAt;
      activityKey =
        dt instanceof Date ? dt.toISOString() : typeof dt === "string" ? (iso(dt) ?? dt) : "";
    }

    if (!activityKey) continue;

    if (!groups.has(activityKey)) {
      groups.set(activityKey, { observedAt: row.observedAt, activity_sort_key: activityKey });
    }

    const group = groups.get(activityKey) ?? {};

    // Determine suffix for numeric field names (same logic as pivotByDate)
    const seriesKey = String(row.seriesKey ?? "");
    const prefix = seriesPrefix ? `${seriesPrefix}.` : "";
    const dotIdx = seriesKey.indexOf(".");
    const suffix =
      prefix && seriesKey.startsWith(prefix)
        ? seriesKey.slice(prefix.length)
        : dotIdx >= 0
          ? seriesKey.slice(dotIdx + 1)
          : seriesKey;

    // Numeric value
    if (typeof row.value === "number" && Number.isFinite(row.value)) {
      group[suffix] = row.value;
    }

    // Copy primitive metadata fields (first non-empty wins)
    if (meta) {
      for (const [key, value] of Object.entries(meta)) {
        if (
          group[key] === undefined &&
          (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        ) {
          group[key] = value;
        }
      }
    }

    // Canonical point id: prefer the duration metric, which represents the activity occurrence.
    if (suffix === "duration" || seriesKey.endsWith(".duration")) {
      group.canonical_time_series_point_id = row.id;
    }
    if (!group.canonical_time_series_point_id) {
      group.canonical_time_series_point_id = row.id;
    }
  }

  // Sort by observedAt descending (newest first) for stable output
  const result = Array.from(groups.values());
  result.sort((a, b) => {
    const aIso = iso(a.observedAt);
    const bIso = iso(b.observedAt);
    const aTime = aIso ? Date.parse(aIso) : 0;
    const bTime = bIso ? Date.parse(bIso) : 0;
    if (aTime !== bTime) return bTime - aTime;
    return String(a.activity_sort_key ?? "").localeCompare(String(b.activity_sort_key ?? ""));
  });

  // Set observed_at_label on each group
  for (const group of result) {
    const dt = group.observedAt;
    const dateKey =
      dt instanceof Date
        ? dt.toISOString().slice(0, 10)
        : typeof dt === "string"
          ? dt.slice(0, 10)
          : "";
    group.observed_at_label = dateKey;
    delete group.activity_sort_key;
  }

  return result;
}

async function attachActivityNotes(
  db: ReturnType<typeof createDb>,
  ctx: PageCtx,
  rows: Record<string, unknown>[],
): Promise<void> {
  const pointIds: string[] = [];
  for (const row of rows) {
    const id = row.canonical_time_series_point_id;
    if (typeof id === "string" && id) pointIds.push(id);
  }
  if (pointIds.length === 0) {
    for (const row of rows) row.notes = [];
    return;
  }

  // Fetch dependency edges: thought depends on our point via "references"
  const edges = await db
    .select()
    .from(dependencyEdges)
    .where(
      and(
        eq(dependencyEdges.ownerId, ctx.user.id),
        eq(dependencyEdges.dependencyKind, "time_series_point"),
        inArray(dependencyEdges.dependencyId, pointIds),
        eq(dependencyEdges.dependentKind, "thought"),
        eq(dependencyEdges.relationship, "references"),
      ),
    );

  if (edges.length === 0) {
    for (const row of rows) row.notes = [];
    return;
  }

  // Fetch unique owner-scoped thought rows
  const thoughtIds = [...new Set(edges.map((e) => e.dependentId))];
  const thoughtRows = await db
    .select()
    .from(thoughts)
    .where(and(eq(thoughts.ownerId, ctx.user.id), inArray(thoughts.id, thoughtIds)));

  const thoughtMap = new Map<string, Record<string, unknown>>();
  for (const t of thoughtRows) {
    thoughtMap.set(t.id, {
      id: t.id,
      content: t.content,
      type: t.type,
      createdAt: t.createdAt,
      created_at_label: t.createdAt ? (iso(t.createdAt)?.slice(0, 10) ?? "") : "",
    });
  }

  // Build notes map from point id to thought list
  const notesByPointId = new Map<string, Record<string, unknown>[]>();
  for (const edge of edges) {
    const thought = thoughtMap.get(edge.dependentId);
    if (thought) {
      const list = notesByPointId.get(edge.dependencyId) ?? [];
      list.push(thought);
      notesByPointId.set(edge.dependencyId, list);
    }
  }

  // Assign notes to each row
  for (const row of rows) {
    const id = row.canonical_time_series_point_id;
    row.notes = typeof id === "string" ? (notesByPointId.get(id) ?? []) : [];
  }
}

function mapRows(
  kind: QueryKind,
  rows: Record<string, unknown>[],
  transforms: string[],
  formulas?: Record<string, string>,
  limit?: number,
  filters?: Record<string, unknown>,
) {
  const seriesPrefix =
    filters && typeof filters.series_prefix === "string" ? filters.series_prefix : undefined;
  const inputRows =
    transforms.includes("pivot_by_year") && kind === "time_series_points"
      ? pivotByYear(rows).slice(0, limit)
      : transforms.includes("pivot_by_activity") && kind === "time_series_points"
        ? pivotByActivity(rows, seriesPrefix).slice(0, limit)
        : transforms.includes("pivot_by_date") && kind === "time_series_points"
          ? pivotByDate(rows, seriesPrefix).slice(0, limit)
          : rows;
  const withRows = inputRows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    const createdAt = out.createdAt ?? out.created_at;
    const updatedAt = out.updatedAt ?? out.updated_at;
    if (transforms.includes("date_labels")) {
      out.created_at_label = iso(createdAt)?.slice(0, 10) ?? "";
      out.updated_at_label = iso(updatedAt)?.slice(0, 10) ?? "";
      if (out.dueAt) out.due_at_label = iso(out.dueAt)?.slice(0, 10) ?? "";
      if (out.observedAt) out.observed_at_label = iso(out.observedAt)?.slice(0, 10) ?? "";
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
    and(...(conditions.filter(Boolean) as (SQL | undefined)[]));
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
        if (typeof f.series_key === "string" && typeof f.series_prefix === "string")
          throw new MemoryError(400, "series_key and series_prefix are mutually exclusive");
        return (
          db
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
                typeof f.series_prefix === "string"
                  ? like(timeSeriesPoints.seriesKey, `${f.series_prefix}.%`)
                  : undefined,
                ...dateFilter(timeSeriesPoints.observedAt, f),
              ]),
            )
            .orderBy(desc(timeSeriesPoints.observedAt))
            // When pivot_by_year/pivot_by_activity/pivot_by_date is active fetch enough pre-pivot
            // rows; pivot_by_year needs ≤50 rows, pivot_by_activity/date need ≤20 per activity/date.
            // mapRows slices to q.limit after pivoting.
            .limit(
              q.transforms.includes("pivot_by_year")
                ? Math.min(q.limit * 50, 500)
                : q.transforms.includes("pivot_by_activity")
                  ? Math.min(q.limit * 20, 500)
                  : q.transforms.includes("pivot_by_date")
                    ? Math.min(q.limit * 20, 500)
                    : q.limit,
            )
        );
    }
  })();
  const mapped = mapRows(
    q.kind,
    rows as Record<string, unknown>[],
    q.transforms,
    q.display?.formulas,
    q.limit,
    q.filters,
  );

  // Apply activity_notes enrichment for time_series_points after pivoting
  if (q.kind === "time_series_points" && q.transforms.includes("activity_notes")) {
    const resultRows = Array.isArray(mapped)
      ? mapped
      : ((mapped as { rows: Record<string, unknown>[] }).rows ?? []);
    if (resultRows.length > 0) {
      await attachActivityNotes(db, ctx, resultRows);
    }
  }

  return mapped;
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
  const parsedQueries = parseQueriesInput(input.queries);
  validatePageDefinition(input.template, parsedQueries);
  const row = {
    id: createId("page"),
    ownerId: ctx.user.id,
    source: source(ctx),
    title: input.title,
    slug,
    description: input.description ?? null,
    status,
    template: input.template,
    queries: (parsedQueries && typeof parsedQueries === "object" ? parsedQueries : {}) as Record<
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
  const parsedQueries = input.queries !== undefined ? parseQueriesInput(input.queries) : undefined;
  const next = {
    title: input.title ?? row.title,
    slug: input.slug ? validateSlug(input.slug) : row.slug,
    template: input.template ?? row.template,
    queries: parsedQueries ?? row.queries,
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
