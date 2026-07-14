import { timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SEALED_STATE_VERSION = "v1";
const SEALED_STATE_CONTEXT = encoder.encode("cubus-oauth-state:v1");
const MAX_SEALED_STATE_LENGTH = 16_384;

type SealedEnvelope = {
  expiresAt: number;
  payload: unknown;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.expiresAt === "number" && Number.isSafeInteger(record.expiresAt) && "payload" in record;
}

async function stateKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("COOKIE_ENCRYPTION_KEY must be at least 32 characters");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealState(payload: unknown, secret: string, ttlSeconds = 600): Promise<string> {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error("ttlSeconds must be a positive integer");
  const envelope: SealedEnvelope = { expiresAt: Date.now() + ttlSeconds * 1_000, payload };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: SEALED_STATE_CONTEXT },
    await stateKey(secret),
    encoder.encode(JSON.stringify(envelope)),
  );
  const bytes = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(ciphertext), iv.byteLength);
  return `${SEALED_STATE_VERSION}.${bytesToBase64Url(bytes)}`;
}

export async function unsealState(token: string, secret: string, now = Date.now()): Promise<unknown> {
  if (token.length > MAX_SEALED_STATE_LENGTH) return null;
  const [version, encoded, extra] = token.split(".");
  if (version !== SEALED_STATE_VERSION || !encoded || extra !== undefined) return null;
  const bytes = base64UrlToBytes(encoded);
  if (!bytes || bytes.byteLength <= 28) return null;
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: SEALED_STATE_CONTEXT },
      await stateKey(secret),
      ciphertext,
    );
    const envelope: unknown = JSON.parse(decoder.decode(plaintext));
    if (!isSealedEnvelope(envelope) || envelope.expiresAt <= now) return null;
    return envelope.payload;
  } catch {
    return null;
  }
}

export async function secureEqual(provided: string, expected: string): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export function securityHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
