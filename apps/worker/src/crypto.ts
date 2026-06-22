/**
 * WebCrypto AES-256-GCM encryption/decryption for connector credentials.
 *
 * The BRAINFOG_CONNECTOR_ENCRYPTION_KEY is a base64-encoded 32-byte key
 * (256 bits) used as the root encryption key for all connector credential
 * payloads. Each write generates a unique random 12-byte IV. Key versioning
 * is stored in encryption_metadata so a future PBI can support rotation.
 */

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

export type EncryptionResult = {
  encryptedPayload: string; // base64 of ciphertext
  encryptionMetadata: { algorithm: string; iv: string; keyVersion: number };
};

function decodeBase64Key(keyMaterial: string): Uint8Array {
  if (!keyMaterial) {
    throw new EncryptionError("BRAINFOG_CONNECTOR_ENCRYPTION_KEY is missing or empty");
  }
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(atob(keyMaterial), (c) => c.charCodeAt(0));
  } catch {
    throw new EncryptionError("BRAINFOG_CONNECTOR_ENCRYPTION_KEY is not valid base64");
  }
  if (raw.byteLength !== 32) {
    throw new EncryptionError(
      `BRAINFOG_CONNECTOR_ENCRYPTION_KEY must be 32 bytes (256 bits), got ${raw.byteLength} bytes`,
    );
  }
  return raw;
}

async function importKey(keyMaterial: string): Promise<CryptoKey> {
  const raw = decodeBase64Key(keyMaterial);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function base64Encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function base64Decode(str: string): Uint8Array {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

/**
 * Encrypt a JSON-serializable payload using AES-256-GCM.
 * Returns the base64-encoded ciphertext and encryption metadata.
 */
export async function encryptCredentials(
  keyMaterial: string,
  payload: object,
): Promise<EncryptionResult> {
  const key = await importKey(keyMaterial);

  // Generate a random 12-byte IV
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Encode the payload as JSON bytes
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  // Encrypt with AES-GCM
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  return {
    encryptedPayload: base64Encode(new Uint8Array(ciphertext)),
    encryptionMetadata: {
      algorithm: "AES-256-GCM",
      iv: base64Encode(iv),
      keyVersion: 1,
    },
  };
}

/**
 * Decrypt a payload previously encrypted with `encryptCredentials`.
 * Returns the original JSON object.
 */
export async function decryptCredentials(
  keyMaterial: string,
  encryptedPayload: string,
  encryptionMetadata: { algorithm: string; iv: string; keyVersion: number },
): Promise<object> {
  const key = await importKey(keyMaterial);

  const iv = base64Decode(encryptionMetadata.iv);
  const ciphertext = base64Decode(encryptedPayload);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    throw new EncryptionError(
      "failed to decrypt credential payload — key may have changed or data is corrupt",
    );
  }

  const decoded = new TextDecoder().decode(plaintext);
  try {
    return JSON.parse(decoded) as object;
  } catch {
    throw new EncryptionError("decrypted credential payload is not valid JSON");
  }
}
