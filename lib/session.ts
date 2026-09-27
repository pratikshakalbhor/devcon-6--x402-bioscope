import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress } from "viem";
import { z } from "zod";
import { getConfig } from "./config";

/**
 * Stateless session cookie: `base64url(payload).base64url(hmac)`.
 *
 * Deliberately not an encrypted JWT — the payload is only an address and two
 * timestamps, and keeping it inspectable makes debugging a signed-in session
 * straightforward. Integrity is what matters here, and that is the HMAC.
 *
 * This module is the *only* thing a gated route may consult to answer "which
 * wallet is this?". Never trust an address taken from a header, a query
 * parameter, or an unsigned cookie.
 */

export const SESSION_COOKIE = "bioscope_session";

/** Address-typed string, so a checksummed address survives the round trip. */
const AddressSchema = z.custom<`0x${string}`>(
  (value) => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value),
  { message: "expected a 20-byte hex address" },
);

export interface SessionPayload {
  /** Checksummed, so a case-mismatched wallet can't slip through. */
  address: `0x${string}`;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
}

const SessionSchema = z.object({
  address: AddressSchema,
  iat: z.number().int(),
  exp: z.number().int(),
});

export type Session = z.infer<typeof SessionSchema>;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** Constant-time compare that tolerates a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Sign a payload with SESSION_SECRET. Output is `payload.signature`.
 */
export function sign(payload: SessionPayload): string {
  const { sessionSecret } = getConfig();
  const body = b64url(JSON.stringify(payload));
  return `${body}.${hmac(body, sessionSecret)}`;
}

/**
 * Verify a cookie value and return the session, or null.
 *
 * Both conditions are required, and neither alone is sufficient:
 *   - the HMAC must match, or the payload is attacker-controlled
 *   - exp must be in the future, or the session is stale
 */
export function verify(token: string | undefined | null): Session | null {
  if (!token) return null;
  const { sessionSecret } = getConfig();

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  if (!safeEqual(hmac(body, sessionSecret), providedSig)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const parsed = SessionSchema.safeParse(decoded);
  if (!parsed.success) return null;
  if (parsed.data.exp <= Math.floor(Date.now() / 1000)) return null;

  return { ...parsed.data, address: getAddress(parsed.data.address) };
}

export function createSession(
  address: string,
  ttlSeconds?: number,
): { token: string; session: Session } {
  const { sessionTtlSeconds } = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const session: Session = {
    address: getAddress(address),
    iat: now,
    exp: now + (ttlSeconds ?? sessionTtlSeconds),
  };
  return { token: sign(session), session };
}

/** Alias kept for readability at call sites. */
export const verifySession = verify;

/**
 * Read the session out of a raw Request. Route handlers take the cookie header
 * themselves rather than reaching for next/headers, which keeps them callable
 * from a test with nothing more than a `Request`.
 */
export function readSession(request: Request): Session | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    return verify(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return null;
}

export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
