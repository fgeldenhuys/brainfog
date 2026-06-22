import { createDb, ingestionConnectorCredentials } from "@brainfog/db";
import { and, eq } from "drizzle-orm";
import { decryptCredentials, EncryptionError, encryptCredentials } from "./crypto";
import { getConnector } from "./ingestion";
import { createId, type MemoryCtx, MemoryError } from "./memory";

function now() {
  return new Date();
}

function unixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/**
 * Generate a redacted summary from a plaintext credential payload.
 *
 * Rules:
 * - If payload contains `username` or `email`: first 3 chars + "***"
 * - If payload contains `token` or `password`: first 6 chars + "..."
 * - If payload contains `domain` or `url`: extract hostname
 */
function generateRedactedSummary(payload: Record<string, unknown>): {
  username?: string;
  token_prefix?: string;
  domain?: string;
} {
  const summary: { username?: string; token_prefix?: string; domain?: string } = {};

  const rawUsername = payload.username ?? payload.email;
  if (typeof rawUsername === "string" && rawUsername.length > 0) {
    summary.username =
      rawUsername.length > 3 ? `${rawUsername.slice(0, 3)}***` : `${rawUsername}***`;
  }

  const rawToken = payload.token ?? payload.password;
  if (typeof rawToken === "string" && rawToken.length > 0) {
    summary.token_prefix = rawToken.length > 6 ? `${rawToken.slice(0, 6)}...` : "***";
  }

  const rawUrl = payload.url ?? payload.domain;
  if (typeof rawUrl === "string" && rawUrl.length > 0) {
    try {
      summary.domain = new URL(rawUrl).hostname;
    } catch {
      // If not a valid URL, use the raw value as-is
      summary.domain = rawUrl;
    }
  }

  return summary;
}

export async function createOrReplaceConnectorCredentials(
  ctx: MemoryCtx,
  connectorId: string,
  input: {
    auth_type?: string;
    payload: Record<string, unknown>;
    status?: string;
    expires_at?: number;
  },
): Promise<Record<string, unknown>> {
  // Verify connector exists and is owned by caller
  await getConnector(ctx, connectorId);

  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
    throw new MemoryError(400, "payload must be a JSON object");
  }

  const keyMaterial = ctx.env.BRAINFOG_CONNECTOR_ENCRYPTION_KEY;
  if (!keyMaterial) {
    throw new MemoryError(500, "connector encryption key is not configured");
  }

  // Encrypt the payload
  let encrypted: {
    encryptedPayload: string;
    encryptionMetadata: { algorithm: string; iv: string; keyVersion: number };
  };
  try {
    encrypted = await encryptCredentials(keyMaterial, input.payload);
  } catch (error) {
    const message = error instanceof EncryptionError ? error.message : "encryption failed";
    throw new MemoryError(500, message);
  }

  // Generate redacted summary
  const redactedSummary = generateRedactedSummary(input.payload);

  const validStatuses = [
    "missing",
    "valid",
    "needs_setup",
    "mfa_required",
    "expired",
    "revoked",
    "error",
  ];
  const status = input.status && validStatuses.includes(input.status) ? input.status : "valid";

  const timestamp = now();
  const row = {
    id: createId("ingestionConnectorCredential"),
    ownerId: ctx.user.id,
    connectorId,
    source: ctx.source ?? "rest:api",
    authType: input.auth_type ?? "password",
    status,
    encryptedPayload: encrypted.encryptedPayload,
    encryptionMetadata: encrypted.encryptionMetadata,
    redactedSummary,
    expiresAt: input.expires_at ? new Date(input.expires_at * 1000) : null,
    lastVerifiedAt: null as Date | null,
    shared: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const db = createDb(ctx.env.DB);

  // Use INSERT OR REPLACE via the unique constraint (owner_id, connector_id)
  // First check if a row exists
  const existing = (
    await db
      .select({ id: ingestionConnectorCredentials.id })
      .from(ingestionConnectorCredentials)
      .where(
        and(
          eq(ingestionConnectorCredentials.ownerId, ctx.user.id),
          eq(ingestionConnectorCredentials.connectorId, connectorId),
        ),
      )
      .limit(1)
  )[0];

  if (existing) {
    await db
      .update(ingestionConnectorCredentials)
      .set({
        authType: row.authType,
        status: row.status,
        encryptedPayload: row.encryptedPayload,
        encryptionMetadata: row.encryptionMetadata,
        redactedSummary: row.redactedSummary,
        expiresAt: row.expiresAt,
        updatedAt: timestamp,
      })
      .where(eq(ingestionConnectorCredentials.id, existing.id));
    row.id = existing.id;
  } else {
    await db.insert(ingestionConnectorCredentials).values(row);
  }

  // Return safe metadata (no encrypted payload)
  return {
    id: row.id,
    owner_id: row.ownerId,
    connector_id: row.connectorId,
    source: row.source,
    auth_type: row.authType,
    status: row.status,
    redacted_summary: row.redactedSummary,
    expires_at: row.expiresAt ? unixSeconds(row.expiresAt) : null,
    last_verified_at: null,
    shared: row.shared,
    created_at: unixSeconds(row.createdAt),
    updated_at: unixSeconds(row.updatedAt),
  };
}

export async function getCredentialStatus(
  ctx: MemoryCtx,
  connectorId: string,
): Promise<Record<string, unknown>> {
  // Verify connector exists and is owned by caller
  await getConnector(ctx, connectorId);

  const db = createDb(ctx.env.DB);
  const row = (
    await db
      .select()
      .from(ingestionConnectorCredentials)
      .where(
        and(
          eq(ingestionConnectorCredentials.ownerId, ctx.user.id),
          eq(ingestionConnectorCredentials.connectorId, connectorId),
        ),
      )
      .limit(1)
  )[0];

  if (!row) {
    throw new MemoryError(404, "connector credentials not found");
  }

  // Return safe metadata only — NEVER return encrypted_payload or encryption_metadata
  return {
    id: row.id,
    owner_id: row.ownerId,
    connector_id: row.connectorId,
    source: row.source,
    auth_type: row.authType,
    status: row.status,
    redacted_summary: row.redactedSummary,
    expires_at: row.expiresAt ? unixSeconds(row.expiresAt) : null,
    last_verified_at: row.lastVerifiedAt ? unixSeconds(row.lastVerifiedAt) : null,
    shared: row.shared,
    created_at: unixSeconds(row.createdAt),
    updated_at: unixSeconds(row.updatedAt),
  };
}

export async function deleteConnectorCredentials(
  ctx: MemoryCtx,
  connectorId: string,
): Promise<Record<string, unknown>> {
  // Verify connector exists and is owned by caller
  await getConnector(ctx, connectorId);

  const db = createDb(ctx.env.DB);
  const row = (
    await db
      .select()
      .from(ingestionConnectorCredentials)
      .where(
        and(
          eq(ingestionConnectorCredentials.ownerId, ctx.user.id),
          eq(ingestionConnectorCredentials.connectorId, connectorId),
        ),
      )
      .limit(1)
  )[0];

  if (!row) {
    throw new MemoryError(404, "connector credentials not found");
  }

  // Revoke: set status to revoked, clear encrypted payload and metadata
  const timestamp = now();
  await db
    .update(ingestionConnectorCredentials)
    .set({
      status: "revoked",
      encryptedPayload: "",
      encryptionMetadata: {} as { algorithm: string; iv: string; keyVersion: number },
      redactedSummary: {} as { username?: string; token_prefix?: string; domain?: string },
      updatedAt: timestamp,
    })
    .where(eq(ingestionConnectorCredentials.id, row.id));

  return {
    id: row.id,
    connector_id: row.connectorId,
    status: "revoked",
    updated_at: unixSeconds(timestamp),
  };
}

/**
 * Decrypt connector credentials for use during a connector run.
 * This function should only be called from connector runner code,
 * never from API response handlers.
 */
export async function decryptConnectorCredentials(
  ctx: MemoryCtx,
  connectorId: string,
): Promise<{ payload: object; credentialId: string }> {
  // Verify connector ownership
  await getConnector(ctx, connectorId);

  const db = createDb(ctx.env.DB);
  const row = (
    await db
      .select()
      .from(ingestionConnectorCredentials)
      .where(
        and(
          eq(ingestionConnectorCredentials.ownerId, ctx.user.id),
          eq(ingestionConnectorCredentials.connectorId, connectorId),
        ),
      )
      .limit(1)
  )[0];

  if (!row) {
    throw new MemoryError(404, "connector credentials not found");
  }

  if (row.status !== "valid") {
    throw new MemoryError(400, `connector credentials status is "${row.status}", not "valid"`);
  }

  if (!row.encryptedPayload || !row.encryptionMetadata) {
    throw new MemoryError(400, "connector credentials have no encrypted payload");
  }

  const keyMaterial = ctx.env.BRAINFOG_CONNECTOR_ENCRYPTION_KEY;
  if (!keyMaterial) {
    throw new MemoryError(500, "connector encryption key is not configured");
  }

  let payload: object;
  try {
    payload = await decryptCredentials(
      keyMaterial,
      row.encryptedPayload,
      row.encryptionMetadata as { algorithm: string; iv: string; keyVersion: number },
    );
  } catch (error) {
    const message = error instanceof EncryptionError ? error.message : "decryption failed";
    throw new MemoryError(500, message);
  }

  return { payload, credentialId: row.id };
}
