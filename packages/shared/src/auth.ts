/**
 * Per-user bearer token helpers (ADR-004). Tokens are never stored in
 * plaintext: D1 holds only `hashToken(token, secret)`. Both the auth
 * middleware and the local dev seed script use these so the hashing
 * scheme stays in one place.
 */

const TOKEN_BYTES = 32;

export interface AuthenticatedUser {
  id: string;
  name: string;
}

export async function hashToken(token: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return toHex(new Uint8Array(signature));
}

export function generateToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
