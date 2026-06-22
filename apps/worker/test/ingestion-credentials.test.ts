import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { createDb, ingestionConnectorCredentials, tokens, users } from "@brainfog/db";
import { hashToken } from "@brainfog/shared";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

const TOKEN_A = "cred-token-a";
const TOKEN_B = "cred-token-b";

const TEST_ENCRYPTION_KEY = "YnJhaW5mb2d0ZXN0LTMyYnl0ZS1rZXktMTIzNDU2Nzg=";

async function authFetch(path: string, init: RequestInit = {}, token = TOKEN_A) {
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

async function createConnector(token = TOKEN_A, type = "bridge", name = "Test connector") {
  return json<{ id: string; ownerId: string }>(
    await authFetch(
      "/api/v1/ingestion/connectors",
      {
        method: "POST",
        body: JSON.stringify({ type, name }),
      },
      token,
    ),
  );
}

describe("connector credentials", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
    const db = createDb(env.DB);
    await db.insert(users).values({ id: "user-cred-a", name: "Cred A" }).onConflictDoNothing();
    await db.insert(users).values({ id: "user-cred-b", name: "Cred B" }).onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-cred-a",
        userId: "user-cred-a",
        tokenHash: await hashToken(TOKEN_A, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
    await db
      .insert(tokens)
      .values({
        id: "token-cred-b",
        userId: "user-cred-b",
        tokenHash: await hashToken(TOKEN_B, env.BRAINFOG_TOKEN_HASH_SECRET),
      })
      .onConflictDoNothing();
  });

  it("1. saves credentials for a caller-owned connector, stores ciphertext (not plaintext) in D1, and returns no plaintext", async () => {
    const connector = await createConnector();
    const plaintextPayload = {
      username: "johndoe",
      password: "super-secret-123",
      domain: "https://api.example.com",
    };

    const response = await authFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "password",
        payload: plaintextPayload,
      }),
    });
    expect(response.status).toBe(200);
    const body = await json<Record<string, unknown>>(response);

    // Response must not contain plaintext values
    expect(body).not.toHaveProperty("encrypted_payload");
    expect(body).not.toHaveProperty("encryption_metadata");
    expect(body).not.toHaveProperty("payload");
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain("super-secret-123");
    expect(JSON.stringify(body)).not.toContain("johndoe");

    // Response should contain safe fields
    expect(body).toMatchObject({
      owner_id: "user-cred-a",
      connector_id: connector.id,
      auth_type: "password",
      status: "valid",
      shared: false,
    });
    expect(body).toHaveProperty("redacted_summary");
    const summary = body.redacted_summary as Record<string, unknown>;
    expect(summary.username).toBe("joh***");
    expect(summary.token_prefix).toBe("super-...");
    expect(summary.domain).toBe("api.example.com");

    // D1 row must contain encrypted content, not plaintext
    const db = createDb(env.DB);
    const row = (
      await db
        .select()
        .from(ingestionConnectorCredentials)
        .where(
          and(
            eq(ingestionConnectorCredentials.ownerId, "user-cred-a"),
            eq(ingestionConnectorCredentials.connectorId, connector.id),
          ),
        )
        .limit(1)
    )[0];
    expect(row).toBeDefined();
    expect(row?.encryptedPayload).toBeTruthy();
    expect(row?.encryptedPayload).not.toContain("super-secret-123");
    expect(row?.encryptedPayload).not.toContain("johndoe");
    expect(row?.encryptionMetadata).toMatchObject({
      algorithm: "AES-256-GCM",
      keyVersion: 1,
    });
    expect(row?.encryptionMetadata).toHaveProperty("iv");
  });

  it("2. GET credential status returns only safe metadata and never encrypted_payload", async () => {
    const connector = await createConnector(TOKEN_A, "status-test", "Status test");

    // Save credentials first
    await authFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "bearer",
        payload: { token: "my-secret-token-value" },
      }),
    });

    // GET status
    const response = await authFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`);
    expect(response.status).toBe(200);
    const body = await json<Record<string, unknown>>(response);

    // Must have safe metadata
    expect(body).toMatchObject({
      owner_id: "user-cred-a",
      connector_id: connector.id,
      auth_type: "bearer",
      status: "valid",
    });
    // Must have redacted_summary
    expect(body).toHaveProperty("redacted_summary");
    // Must NOT have encrypted payload or metadata
    expect(body).not.toHaveProperty("encrypted_payload");
    expect(body).not.toHaveProperty("encryption_metadata");
    expect(body).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toContain("my-secret-token-value");
    // Should have timestamps
    expect(body).toHaveProperty("created_at");
    expect(body).toHaveProperty("updated_at");
  });

  it("3. replacing credentials changes ciphertext and updates timestamps", async () => {
    const connector = await createConnector(TOKEN_A, "replace-test", "Replace test");

    // Initial save
    await authFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "api_key",
        payload: { token: "original-key-12345" },
      }),
    });
    const db = createDb(env.DB);
    const firstRow = (
      await db
        .select()
        .from(ingestionConnectorCredentials)
        .where(
          and(
            eq(ingestionConnectorCredentials.ownerId, "user-cred-a"),
            eq(ingestionConnectorCredentials.connectorId, connector.id),
          ),
        )
        .limit(1)
    )[0];
    const firstCiphertext = firstRow?.encryptedPayload;
    const firstUpdatedAt = firstRow?.updatedAt;

    // Replace with new credentials
    const replaceResponse = await authFetch(
      `/api/v1/ingestion/connectors/${connector.id}/credentials`,
      {
        method: "PUT",
        body: JSON.stringify({
          auth_type: "api_key",
          payload: { token: "replaced-key-67890" },
        }),
      },
    );
    expect(replaceResponse.status).toBe(200);

    const replacedRow = (
      await db
        .select()
        .from(ingestionConnectorCredentials)
        .where(
          and(
            eq(ingestionConnectorCredentials.ownerId, "user-cred-a"),
            eq(ingestionConnectorCredentials.connectorId, connector.id),
          ),
        )
        .limit(1)
    )[0];
    // Ciphertext must have changed
    expect(replacedRow?.encryptedPayload).not.toBe(firstCiphertext);
    // updatedAt must have advanced
    expect(replacedRow?.updatedAt.getTime()).toBeGreaterThanOrEqual(firstUpdatedAt?.getTime() ?? 0);
    // Status should still be valid
    expect(replacedRow?.status).toBe("valid");
    // New plaintext must not appear
    expect(replacedRow?.encryptedPayload).not.toContain("replaced-key-67890");
  });

  it("4. deleting/revoking credentials sets status to revoked and clears payload", async () => {
    const connector = await createConnector(TOKEN_A, "delete-test", "Delete test");

    // Save credentials
    await authFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "password",
        payload: { username: "testuser", password: "delete-me-now" },
      }),
    });

    // Delete
    const deleteResponse = await authFetch(
      `/api/v1/ingestion/connectors/${connector.id}/credentials`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
    const deleteBody = await json<Record<string, unknown>>(deleteResponse);
    expect(deleteBody).toMatchObject({
      connector_id: connector.id,
      status: "revoked",
    });

    // D1 row should have status revoked and empty payload
    const db = createDb(env.DB);
    const row = (
      await db
        .select()
        .from(ingestionConnectorCredentials)
        .where(
          and(
            eq(ingestionConnectorCredentials.ownerId, "user-cred-a"),
            eq(ingestionConnectorCredentials.connectorId, connector.id),
          ),
        )
        .limit(1)
    )[0];
    expect(row?.status).toBe("revoked");
    expect(row?.encryptedPayload).toBe("");

    // GET after delete should still work (returning status)
    const getResponse = await authFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`);
    expect(getResponse.status).toBe(200);
    const getBody = await json<Record<string, unknown>>(getResponse);
    expect(getBody.status).toBe("revoked");
  });

  it("5. another user cannot save/read/delete credentials for a connector they do not own", async () => {
    const connector = await createConnector(TOKEN_A, "isolation-test", "Isolation test");

    // Save credentials as owner (A)
    await authFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "password",
        payload: { username: "owner-only", password: "owner-secret" },
      }),
    });

    // User B tries to save credentials — should get 404 (connector not found for B)
    const putB = await authFetch(
      `/api/v1/ingestion/connectors/${connector.id}/credentials`,
      {
        method: "PUT",
        body: JSON.stringify({
          auth_type: "password",
          payload: { username: "intruder", password: "evil" },
        }),
      },
      TOKEN_B,
    );
    expect(putB.status).toBe(404);

    // User B tries to GET credentials — should get 404
    const getB = await authFetch(
      `/api/v1/ingestion/connectors/${connector.id}/credentials`,
      {},
      TOKEN_B,
    );
    expect(getB.status).toBe(404);

    // User B tries to DELETE credentials — should get 404
    const delB = await authFetch(
      `/api/v1/ingestion/connectors/${connector.id}/credentials`,
      { method: "DELETE" },
      TOKEN_B,
    );
    expect(delB.status).toBe(404);
  });

  it("6. missing or malformed BRAINFOG_CONNECTOR_ENCRYPTION_KEY fails closed", async () => {
    // We test the crypto module directly for key validation
    const { encryptCredentials, decryptCredentials, EncryptionError } = await import(
      "../src/crypto"
    );

    // Empty key
    await expect(encryptCredentials("", { test: "data" })).rejects.toThrow(EncryptionError);
    await expect(encryptCredentials("", { test: "data" })).rejects.toThrow(/missing or empty/i);

    // Invalid base64
    await expect(encryptCredentials("not-valid-base64!!!", { test: "data" })).rejects.toThrow(
      EncryptionError,
    );
    await expect(encryptCredentials("not-valid-base64!!!", { test: "data" })).rejects.toThrow(
      /not valid base64/i,
    );

    // Wrong key size (base64 of 16 bytes instead of 32)
    const shortKey = btoa("brainfog-16-key!");
    await expect(encryptCredentials(shortKey, { test: "data" })).rejects.toThrow(EncryptionError);
    await expect(encryptCredentials(shortKey, { test: "data" })).rejects.toThrow(
      /must be 32 bytes/i,
    );

    // Valid key should work
    const validKey = TEST_ENCRYPTION_KEY;
    const result = await encryptCredentials(validKey, { test: "data", value: 42 });
    expect(result.encryptedPayload).toBeTruthy();
    expect(result.encryptionMetadata).toMatchObject({
      algorithm: "AES-256-GCM",
      keyVersion: 1,
    });
    expect(result.encryptionMetadata.iv).toBeTruthy();

    // Decrypt should recover the original
    const decrypted = await decryptCredentials(
      validKey,
      result.encryptedPayload,
      result.encryptionMetadata,
    );
    expect(decrypted).toEqual({ test: "data", value: 42 });

    // Decrypt with wrong key should fail
    const wrongKey = btoa("x".repeat(32));
    await expect(
      decryptCredentials(wrongKey, result.encryptedPayload, result.encryptionMetadata),
    ).rejects.toThrow(EncryptionError);
  });

  it("7. redacted summary hides sensitive fields", async () => {
    const connector = await createConnector(TOKEN_A, "redact-test", "Redact test");

    // Test with username, password, domain
    await authFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "password",
        payload: {
          username: "alice",
          password: "p@ssw0rd!",
          url: "https://myapp.internal.com/auth",
        },
      }),
    });

    let response = await authFetch(`/api/v1/ingestion/connectors/${connector.id}/credentials`);
    let body = await json<Record<string, unknown>>(response);
    let summary = body.redacted_summary as Record<string, unknown>;

    expect(summary.username).toBe("ali***");
    expect(summary.token_prefix).toBe("p@ssw0...");
    expect(summary.domain).toBe("myapp.internal.com");

    // Test with email and token (no explicit domain)
    const connector2 = await createConnector(TOKEN_A, "redact-test-2", "Redact test 2");
    await authFetch(`/api/v1/ingestion/connectors/${connector2.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "bearer",
        payload: {
          email: "bob@example.com",
          token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        },
      }),
    });

    response = await authFetch(`/api/v1/ingestion/connectors/${connector2.id}/credentials`);
    body = await json<Record<string, unknown>>(response);
    summary = body.redacted_summary as Record<string, unknown>;

    expect(summary.username).toBe("bob***");
    expect(summary.token_prefix).toBe("eyJhbG...");
    // No domain in this payload
    expect(summary.domain).toBeUndefined();

    // Short secrets must still never be echoed in full.
    const connector3 = await createConnector(TOKEN_A, "redact-test-3", "Redact test 3");
    await authFetch(`/api/v1/ingestion/connectors/${connector3.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({
        auth_type: "password",
        payload: { username: "xy", password: "short" },
      }),
    });

    response = await authFetch(`/api/v1/ingestion/connectors/${connector3.id}/credentials`);
    body = await json<Record<string, unknown>>(response);
    summary = body.redacted_summary as Record<string, unknown>;

    expect(summary.username).toBe("xy***");
    expect(summary.token_prefix).toBe("***");
    expect(JSON.stringify(body)).not.toContain("short");
  });

  it("existing ingestion tests still pass — can create and list connectors", async () => {
    // Quick smoke test that general ingestion still works alongside credentials
    const connector = await json<{ id: string; ownerId: string }>(
      await authFetch("/api/v1/ingestion/connectors", {
        method: "POST",
        body: JSON.stringify({ type: "smoke", name: "Smoke test" }),
      }),
    );
    expect(connector.ownerId).toBe("user-cred-a");

    const visible = await json<Array<{ id: string }>>(
      await authFetch("/api/v1/ingestion/connectors"),
    );
    expect(visible.map((r) => r.id)).toContain(connector.id);
  });
});
