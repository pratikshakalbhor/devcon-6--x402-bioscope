import { getAddress, isAddress, verifyMessage } from "viem";
import { getConfig } from "./config";
import { consumeNonce, createNonce, getNonce, type NonceRow } from "./db";

/**
 * Sign-In With X (SIWX) — EIP-4361 style, adapted for Base.
 *
 * Three separable pieces, deliberately kept apart:
 *
 *   issueChallenge(address)              mint + store a nonce, return the text
 *   assertNonceUsable(nonce, now)        the nonce lifecycle rules (check #8)
 *   verifySiwx({address, signature, message})  pure signature check
 *
 * The caller stitches them together. Keeping verifySiwx free of database
 * access means the "who signed this?" question has exactly one answer, and the
 * caller cannot accidentally skip the nonce checks by going through it.
 *
 * SECURITY: the `message` handed to verifySiwx must be rebuilt from the stored
 * nonce row, never taken from the request. If a client can choose the text it
 * signs, it can sign something harmless and replay it. app/api/auth/verify
 * builds it with challengeFromNonceRow; the tests assert the body is ignored.
 */

export const SIWX_VERSION = "1";
export const SIWX_STATEMENT = "Sign in to bioscope.";

function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function chainIdFromCaip2(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match?.[1]) {
    throw new Error(`Cannot derive a chain id from NETWORK "${network}".`);
  }
  return Number(match[1]);
}

/**
 * The exact text the wallet signs: app, address, nonce, and an explicit
 * expiry. Every field is server-supplied.
 */
export function buildChallengeMessage(input: {
  address: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  domain?: string;
  chainId?: number;
  statement?: string;
}): string {
  const domain = input.domain ?? getConfig().siwxDomain;
  const chainId = input.chainId ?? chainIdFromCaip2(getConfig().network);
  const statement = input.statement ?? SIWX_STATEMENT;

  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    input.address,
    "",
    statement,
    "",
    `URI: ${domain}`,
    `Version: ${SIWX_VERSION}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${toIso(input.issuedAt)}`,
    `Expiration Time: ${toIso(input.expiresAt)}`,
  ].join("\n");
}

/**
 * Rebuild the canonical message from a stored nonce row.
 *
 * This is the only sanctioned way to produce the text for verification. It
 * reads issued_at / expires_at / address out of the database, so none of them
 * can be chosen by the client.
 */
export function challengeFromNonceRow(row: NonceRow): string {
  return buildChallengeMessage({
    address: row.address,
    nonce: row.nonce,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    domain: getConfig().siwxDomain,
  });
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Challenge {
  nonce: string;
  message: string;
  issuedAt: number;
  expiresAt: number;
}

/** Mint and store a nonce bound to `address`, with used=0. */
export function issueChallenge(address: string): Challenge {
  const { nonceTtlSeconds } = getConfig();
  if (!isAddress(address)) throw new Error("address must be a 20-byte hex address");

  const checksummed = getAddress(address);
  // Read the row back rather than trusting createNonce's return values, so the
  // message is built from what was actually persisted.
  const { nonce } = createNonce(randomNonce(), checksummed, nonceTtlSeconds);
  const row = getNonce(nonce);
  if (!row) throw new Error("Failed to persist the sign-in nonce.");

  return {
    nonce,
    message: challengeFromNonceRow(row),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Nonce lifecycle (check #8)
// ---------------------------------------------------------------------------

export type NonceRejection = "unknown-nonce" | "nonce-already-used" | "nonce-expired";

export type NonceCheck =
  | { ok: true; row: NonceRow }
  | { ok: false; reason: NonceRejection };

/**
 * All three conditions are enforced here, not merely stored:
 *   - the row must exist
 *   - used must still be 0
 *   - now must be before expires_at
 *
 * CLOCK_SKEW_SECONDS is tolerance for the wallet's clock, not slack on the
 * nonce itself: an hour-old nonce is still rejected.
 */
const CLOCK_SKEW_SECONDS = 30;

export function assertNonceUsable(nonce: string, now?: number): NonceCheck {
  const at = now ?? Math.floor(Date.now() / 1000);
  const row = getNonce(nonce);

  if (!row) return { ok: false, reason: "unknown-nonce" };
  if (row.used === 1) return { ok: false, reason: "nonce-already-used" };
  if (row.expires_at + CLOCK_SKEW_SECONDS < at) return { ok: false, reason: "nonce-expired" };

  return { ok: true, row };
}

/**
 * Burn the nonce. Returns true only for the call that flipped used 0 -> 1, so
 * a replayed signature gets false. The WHERE clause performs the
 * compare-and-swap inside one statement, so two concurrent replays cannot both
 * win.
 */
export function burnNonce(nonce: string): boolean {
  return consumeNonce(nonce);
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export type SignatureCheck = { ok: true; address: `0x${string}` } | { ok: false; reason: "bad-signature" };

/**
 * Confirm the signature was produced by `address` over exactly `message`.
 *
 * `message` must come from challengeFromNonceRow, never from the request body.
 */
export async function verifySiwx(input: {
  address: string;
  signature: `0x${string}`;
  message: string;
}): Promise<SignatureCheck> {
  if (!isAddress(input.address)) return { ok: false, reason: "bad-signature" };

  let valid: boolean;
  try {
    valid = await verifyMessage({
      address: input.address,
      message: input.message,
      signature: input.signature,
    });
  } catch {
    return { ok: false, reason: "bad-signature" };
  }

  if (!valid) return { ok: false, reason: "bad-signature" };
  return { ok: true, address: getAddress(input.address) };
}

/**
 * The full exchange in one call, for callers that want it. The route handler
 * spells the steps out instead so each rejection maps to its own status code.
 */
export type SiwxResult =
  | { ok: true; address: `0x${string}` }
  | { ok: false; reason: NonceRejection | "bad-signature" };

export async function completeSiwx(input: {
  address: string;
  signature: `0x${string}`;
  nonce: string;
  now?: number;
}): Promise<SiwxResult> {
  const check = assertNonceUsable(input.nonce, input.now);
  if (!check.ok) return check;

  const message = challengeFromNonceRow(check.row);
  const signatureCheck = await verifySiwx({
    address: input.address,
    signature: input.signature,
    message,
  });
  if (!signatureCheck.ok) return signatureCheck;

  // The signature is over a message naming check.row.address, so the signer is
  // necessarily that address. Burn only after the signature is known good.
  if (!burnNonce(input.nonce)) return { ok: false, reason: "nonce-already-used" };

  return { ok: true, address: signatureCheck.address };
}
