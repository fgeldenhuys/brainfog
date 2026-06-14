import { Hono } from "hono";
import type { Env } from "../env";
import htmxSource from "./assets/htmx.min.txt";

/**
 * Vendored static assets for `/app` (htmx 2.x, progressive enhancement only;
 * see specs/frontend/spec.md). Served from a `.txt` source so Wrangler's
 * default "Text" module rule bundles it without npm or wrangler.jsonc changes.
 */
export const assetRoutes = new Hono<{ Bindings: Env }>();

assetRoutes.get("/htmx.min.js", (c) =>
  c.text(htmxSource, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
  }),
);
