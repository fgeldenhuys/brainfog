import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "../env";
import {
  consumeCapability,
  createDocumentFromBytes,
  getDocumentBytes,
  type IndexingMode,
  MemoryError,
  resolveCapability,
  updateDocumentFromBytes,
} from "../memory";

/** Fields returned in capability create/update JSON responses. */
const PUBLIC_DOCUMENT_FIELDS = [
  "id",
  "title",
  "projectId",
  "mimeType",
  "sizeBytes",
  "createdAt",
  "updatedAt",
  "currentVersionNumber",
  "shared",
  "cascaded",
] as const;

function sanitizeDocumentResponse(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of PUBLIC_DOCUMENT_FIELDS) {
    if (key in doc) {
      result[key] = doc[key];
    }
  }
  return result;
}

/** Normalize a MIME type for comparison: lowercase, strip parameters. */
function normalizeMimeType(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * Capability-authenticated document transfer routes (PBI-031).
 *
 * These routes are mounted BEFORE the bearer-token auth middleware so that
 * upload/download commands returned by MCP tools work with only the
 * short-lived capability token, not the user's long-lived bearer token.
 *
 * The capability token is passed in the URL path. The server hashes it to
 * look up the capability record in D1, then enforces operation, owner scope,
 * bound metadata, expiry, single-use, and max-size constraints before
 * delegating to the existing document service functions.
 */

export const documentTransferRoutes = new Hono<{ Bindings: Env }>();

type TransferCtx = Context<{ Bindings: Env }>;

function transferCtx(c: TransferCtx, ownerId: string) {
  // Build a synthetic ctx matching MemoryCtx from the capability's owner.
  // We store minimal user info (id, name, selfPersonId, isAdmin) but the
  // capability-authenticated path only needs ownerId for owner-scoped ops.
  return {
    env: c.env,
    user: {
      id: ownerId,
      name: "capability-owner",
      selfPersonId: null as string | null,
      slug: null as string | null,
      isAdmin: false,
    },
    source: "rest:document-transfer" as const,
  };
}

function safeCapabilityError() {
  return new MemoryError(401, "transfer capability expired or invalid");
}

/**
 * Resolve a capability from the URL secret, performing all safety checks
 * (exists, not expired, not consumed, operation matches method).
 * Throws MemoryError (which becomes a JSON 401/403) on failure.
 */
async function verifyCapability(
  c: TransferCtx,
  pathSecret: string,
  expectedOperation: "create" | "update" | "download",
) {
  const capability = await resolveCapability(c.env, pathSecret);
  if (!capability) throw safeCapabilityError();
  if (capability.operation !== expectedOperation) {
    throw safeCapabilityError();
  }
  return capability;
}

// POST /api/v1/document-transfers/:secret — create upload
documentTransferRoutes.post("/document-transfers/:secret", async (c) => {
  try {
    const secret = c.req.param("secret");
    const capability = await verifyCapability(c, secret, "create");

    // Enforce bound MIME type before any mutation
    const requestMime = normalizeMimeType(c.req.header("content-type") ?? "");
    if (capability.mimeType && requestMime !== normalizeMimeType(capability.mimeType)) {
      throw new MemoryError(400, "content-type does not match capability mime type");
    }

    const bytes = await c.req.arrayBuffer();
    if (capability.maxSizeBytes !== null && bytes.byteLength > capability.maxSizeBytes) {
      throw new MemoryError(400, "upload exceeds maximum size");
    }

    const title = capability.title ?? "";
    if (!title.trim()) throw new MemoryError(400, "missing title");

    // Claim BEFORE mutation: ensures single-winner concurrency
    const claimed = await consumeCapability(c.env, capability.id);
    if (!claimed) throw safeCapabilityError();

    const result = await createDocumentFromBytes(transferCtx(c, capability.ownerId), {
      title,
      bytes,
      project_id: capability.projectId,
      mime_type: capability.mimeType,
      filename: capability.filename,
      indexing_mode: (capability.indexingMode as IndexingMode) ?? undefined,
    });

    return c.json(sanitizeDocumentResponse(result as Record<string, unknown>), 201);
  } catch (error) {
    if (error instanceof MemoryError)
      return c.json({ error: error.message }, error.status as 400 | 401 | 403 | 404 | 409);
    return c.json({ error: "internal_error" }, 500);
  }
});

// PATCH /api/v1/document-transfers/:secret — update upload
documentTransferRoutes.patch("/document-transfers/:secret", async (c) => {
  try {
    const secret = c.req.param("secret");
    const capability = await verifyCapability(c, secret, "update");

    // Enforce bound MIME type before any mutation
    const requestMime = normalizeMimeType(c.req.header("content-type") ?? "");
    if (capability.mimeType && requestMime !== normalizeMimeType(capability.mimeType)) {
      throw new MemoryError(400, "content-type does not match capability mime type");
    }

    const bytes = await c.req.arrayBuffer();
    if (capability.maxSizeBytes !== null && bytes.byteLength > capability.maxSizeBytes) {
      throw new MemoryError(400, "upload exceeds maximum size");
    }

    if (!capability.documentId) {
      throw new MemoryError(400, "document_id is required for update capability");
    }

    // Claim BEFORE mutation: ensures single-winner concurrency
    const claimed = await consumeCapability(c.env, capability.id);
    if (!claimed) throw safeCapabilityError();

    const result = await updateDocumentFromBytes(
      transferCtx(c, capability.ownerId),
      capability.documentId,
      bytes,
      (capability.writeMode as "overwrite_current" | "create_version" | undefined) ?? undefined,
      capability.mimeType ?? undefined,
      capability.filename ?? undefined,
      (capability.indexingMode as IndexingMode) ?? undefined,
    );

    return c.json(sanitizeDocumentResponse(result as Record<string, unknown>));
  } catch (error) {
    if (error instanceof MemoryError)
      return c.json({ error: error.message }, error.status as 400 | 401 | 403 | 404 | 409);
    return c.json({ error: "internal_error" }, 500);
  }
});

// GET /api/v1/document-transfers/:secret — download
documentTransferRoutes.get("/document-transfers/:secret", async (c) => {
  try {
    const secret = c.req.param("secret");
    const capability = await verifyCapability(c, secret, "download");

    if (!capability.documentId) {
      throw new MemoryError(400, "document_id is required for download capability");
    }

    // Claim BEFORE mutation: ensures single-winner concurrency
    const claimed = await consumeCapability(c.env, capability.id);
    if (!claimed) throw safeCapabilityError();

    const result = await getDocumentBytes(
      transferCtx(c, capability.ownerId),
      capability.documentId,
    );

    // PBI-031: use only the bound filename, never a query-string override
    const filename = safeDownloadFilename(
      capability.filename ?? result.filename ?? result.doc.title,
    );
    return new Response(result.bytes, {
      headers: {
        "content-type": result.doc.mimeType || "application/octet-stream",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(result.bytes.byteLength),
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof MemoryError)
      return c.json({ error: error.message }, error.status as 400 | 401 | 403 | 404 | 409);
    return c.json({ error: "internal_error" }, 500);
  }
});

function safeDownloadFilename(value: string) {
  return value.replace(/[\\/\r\n\0"]/g, "_").trim() || "document";
}
