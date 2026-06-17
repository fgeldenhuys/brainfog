import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "../env";
import {
  createUser,
  createUserToken,
  getMetrics,
  getSummary,
  listUsers,
  listUserTokens,
  MemoryError,
  revokeToken,
  updateUser,
} from "../memory";
import { type AuthVariables, authMiddleware } from "../middleware/auth";
import {
  createPage,
  createPageAccessLink,
  deletePage,
  getPage,
  listPageAccessLinks,
  listPages,
  previewPage,
  revokePageAccessLink,
  updatePage,
} from "../pages";

export const uiApiRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

uiApiRoutes.use("*", authMiddleware);

type ApiContext = Context<{ Bindings: Env; Variables: AuthVariables }>;

function ctx(c: ApiContext) {
  return { env: c.env, user: c.get("user"), source: "rest:ui-api" };
}

async function body(c: ApiContext) {
  return (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
}

function errorStatus(status: number): 400 | 401 | 403 | 404 | 409 | 500 {
  if (status === 400 || status === 403 || status === 404 || status === 409) return status;
  if (status === 401) return 401;
  return 500;
}

function handle(error: unknown) {
  if (error instanceof MemoryError)
    return { body: { error: error.message }, status: errorStatus(error.status) };
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

uiApiRoutes.get(
  "/summary",
  route(async (c) => c.json(await getSummary(ctx(c)))),
);

uiApiRoutes.get(
  "/metrics",
  route(async (c) =>
    c.json(
      await getMetrics(ctx(c), {
        project_id: c.req.query("project_id"),
        from: c.req.query("from"),
        to: c.req.query("to"),
      }),
    ),
  ),
);

uiApiRoutes.get(
  "/pages",
  route(async (c) => c.json(await listPages(ctx(c), { status: c.req.query("status") }))),
);

uiApiRoutes.post(
  "/pages",
  route(async (c) =>
    c.json(await createPage(ctx(c), (await body(c)) as Parameters<typeof createPage>[1]), 201),
  ),
);

uiApiRoutes.get(
  "/pages/:id",
  route(async (c) => c.json(await getPage(ctx(c), param(c, "id")))),
);

uiApiRoutes.patch(
  "/pages/:id",
  route(async (c) => c.json(await updatePage(ctx(c), param(c, "id"), await body(c)))),
);

uiApiRoutes.delete(
  "/pages/:id",
  route(async (c) => c.json(await deletePage(ctx(c), param(c, "id")))),
);

uiApiRoutes.post(
  "/pages/:id/preview",
  route(async (c) => c.json(await previewPage(ctx(c), { id: param(c, "id"), ...(await body(c)) }))),
);

uiApiRoutes.post(
  "/pages/:id/access-links",
  route(async (c) =>
    c.json(
      await createPageAccessLink(ctx(c), param(c, "id"), await body(c), new URL(c.req.url).origin),
      201,
    ),
  ),
);

uiApiRoutes.get(
  "/pages/:id/access-links",
  route(async (c) => c.json(await listPageAccessLinks(ctx(c), param(c, "id")))),
);

uiApiRoutes.delete(
  "/page-access-links/:id",
  route(async (c) => c.json(await revokePageAccessLink(ctx(c), param(c, "id")))),
);

uiApiRoutes.get(
  "/users",
  route(async (c) => c.json(await listUsers(ctx(c)))),
);

uiApiRoutes.post(
  "/users",
  route(async (c) =>
    c.json(
      await createUser(
        ctx(c),
        (await body(c)) as { name: string; slug?: string | null; is_admin?: boolean },
      ),
      201,
    ),
  ),
);

uiApiRoutes.patch(
  "/users/:id",
  route(async (c) =>
    c.json(
      await updateUser(
        ctx(c),
        param(c, "id"),
        (await body(c)) as { name?: string; slug?: string | null; is_admin?: boolean },
      ),
    ),
  ),
);

uiApiRoutes.post(
  "/users/:id/tokens",
  route(async (c) => c.json(await createUserToken(ctx(c), param(c, "id")), 201)),
);

uiApiRoutes.get(
  "/users/:id/tokens",
  route(async (c) => c.json(await listUserTokens(ctx(c), param(c, "id")))),
);

uiApiRoutes.delete(
  "/tokens/:id",
  route(async (c) => c.json(await revokeToken(ctx(c), param(c, "id")))),
);
