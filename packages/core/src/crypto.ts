/**
 * At-rest encryption for SSH passwords and key passphrases.
 *
 * sparktop prefers key-based auth and never needs this, but password auth is
 * supported for nodes where installing a key is inconvenient. When it is used,
 * the secret is sealed with AES-256-GCM under a key derived from
 * SPARKTOP_SECRET so that the on-disk config is not plaintext credentials.
 *
 * This protects the config file, not the running process: anything that can
 * read the environment can decrypt. It is a meaningful improvement over
 * plaintext, not a substitute for using SSH keys.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm";
const PREFIX = "enc.v1:";
/** Fixed salt: the secret is already high-entropy, and a per-record salt would
 *  force a scrypt run per decrypt. Rotate SPARKTOP_SECRET to rotate keys. */
const SALT = Buffer.from("sparktop.credential.v1");

let cachedKey: Buffer | null = null;
let cachedSecret: string | null = null;

export class MissingSecretError extends Error {
  constructor() {
    super(
      "SPARKTOP_SECRET is not set. It is required to store or read encrypted " +
        "node passwords. Generate one with: openssl rand -hex 32"
    );
    this.name = "MissingSecretError";
  }
}

function deriveKey(): Buffer {
  const secret = process.env.SPARKTOP_SECRET;
  if (!secret) throw new MissingSecretError();
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedKey = scryptSync(secret, SALT, 32);
  cachedSecret = secret;
  return cachedKey;
}

export function hasSecret(): boolean {
  return typeof process.env.SPARKTOP_SECRET === "string" && process.env.SPARKTOP_SECRET.length > 0;
}

/** Seal a secret. Output is `enc.v1:<iv>:<tag>:<ciphertext>`, all base64. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** Open a sealed secret. Throws if the secret is wrong or the data was tampered with. */
export function decryptSecret(sealed: string): string {
  if (!sealed.startsWith(PREFIX)) {
    // Tolerate configs hand-written with a plaintext password.
    return sealed;
  }
  const parts = sealed.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Malformed encrypted credential");
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, deriveKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      "Failed to decrypt node credential. SPARKTOP_SECRET likely differs from the one used to store it."
    );
  }
}

export function isEncrypted(s: string): boolean {
  return s.startsWith(PREFIX);
}

/** Constant-time string comparison, for optional API token checks. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
