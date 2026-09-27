import { z } from "zod";
import { getAddress } from "viem";
import { getConfig } from "./config";
import type { ReelRow } from "./db";

/**
 * The x402 gate.
 *
 * Two rules this module exists to enforce:
 *
 *   1. A price is a function of the reel id and nothing else. Every amount here
 *      is read from the server's own database row. No request field — not a
 *      header, not a query param, not the body — can influence what a client is
 *      asked to pay, and a payload authorizing a different amount fails
 *      verification at the facilitator.
 *
 *   2. Payment is worthless without an identity. verifyAndSettle returns the
 *      payer, and the caller records the entitlement for that address and
 *      separately checks it against the SIWX session.
 *
 * Why this talks to the facilitator over HTTP rather than through the `x402`
 * package: that package's `verify`/`settle` are for self-facilitation (they
 * verify locally against a signer you supply) and its remote-facilitator client
 * is not reachable through its export map. Hitting POST /verify and POST
 * /settle directly is what makes FACILITATOR_URL an actual setting.
 *
 * Dialect note: x402 v1 clients (x402-fetch) send the short network name
 * ("base-sepolia") and read `maxAmountRequired`; v2 clients use CAIP-2
 * ("eip155:84532") and read `amount`. Both are handled.
 */

/** v1 request/response header, still what x402-fetch sends. */
export const V1_PAYMENT_HEADER = "X-PAYMENT";
export const V1_RESPONSE_HEADER = "X-PAYMENT-RESPONSE";
/** v2 header names. */
export const V2_PAYMENT_HEADER = "PAYMENT-SIGNATURE";
export const V2_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const V2_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export type PaymentDialect = 1 | 2;

export const MIME_JPEG = "image/jpeg";

/** Networks the v1 wire format enumerates. Guards against a typo in NETWORK. */
const V1_NETWORKS = [
  "abstract",
  "abstract-testnet",
  "base-sepolia",
  "base",
  "avalanche-fuji",
  "avalanche",
  "iotex",
  "solana-devnet",
  "solana",
  "sei",
  "sei-testnet",
  "polygon",
  "polygon-amoy",
  "peaq",
  "story",
  "educhain",
  "skale-base-sepolia",
] as const;

const CAIP2_TO_V1_NETWORK: Record<string, (typeof V1_NETWORKS)[number]> = {
  "eip155:84532": "base-sepolia",
  "eip155:8453": "base",
  "eip155:43114": "avalanche",
  "eip155:43113": "avalanche-fuji",
  "eip155:137": "polygon",
  "eip155:80002": "polygon-amoy",
};

// ---------------------------------------------------------------------------
// Wire types (x402 v1 shape, with the v2 `amount` alias added where relevant)
// ---------------------------------------------------------------------------

const Address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "expected a 20-byte hex address");
const Uint256String = z.string().regex(/^\d+$/, "expected an unsigned integer as a string");
/**
 * EIP-3009 authorization nonce: a `bytes32`, which the x402 wire format carries
 * as 0x-prefixed hex.
 *
 * This was validated as a decimal integer, which is both the wrong wire format
 * (the facilitator reconstructs the digest from these exact bytes, so a decimal
 * string produces a different hash and every signature is rejected as
 * `invalid_exact_evm_signature`) and too permissive — a decimal string can
 * encode a value too large for 32 bytes. Requiring exactly 32 bytes is both
 * correct and stricter than what it replaces.
 */
const Bytes32Hex = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte hex nonce");

export const ExactEvmAuthorizationSchema = z.object({
  from: Address,
  to: Address,
  value: Uint256String,
  validAfter: Uint256String,
  validBefore: Uint256String,
  nonce: Bytes32Hex,
});

export type ExactEvmAuthorization = z.infer<typeof ExactEvmAuthorizationSchema>;

export const PaymentPayloadSchema = z.object({
  x402Version: z.number().int().min(1).max(2),
  scheme: z.literal("exact"),
  network: z.string().min(1),
  payload: z.object({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "expected a hex signature"),
    authorization: ExactEvmAuthorizationSchema,
  }),
});

export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  /** v1 amount field. Always populated. */
  maxAmountRequired: string;
  /** v2 amount field. Emitted alongside so a v2 client sees the same number. */
  amount?: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
}

export const VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

export const SettleResponseSchema = z.object({
  success: z.boolean(),
  transaction: z.string().optional(),
  network: z.string().optional(),
  payer: z.string().optional(),
  errorReason: z.string().optional(),
});
export type SettleResponse = z.infer<typeof SettleResponseSchema>;

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

export interface BuildRequirementsOptions {
  /**
   * Which frame of the reel is being paid for. A number the route has already
   * range-checked, not a raw string.
   *
   * The resource URL is derived from this plus the reel id and the configured
   * origin. It is deliberately not a parameter: a caller that could pass a URL
   * could bind a payment to something other than the frame being served.
   */
  frame: number;
  description?: string;
  dialect?: PaymentDialect;
  maxTimeoutSeconds?: number;
}

/** The canonical URL of a paid frame. Server-computed, never client-supplied. */
export function resourceUrlFor(reelId: string, frame: number): string {
  const { publicOrigin } = getConfig();
  if (!Number.isInteger(frame) || frame < 1) {
    throw new Error(`Frame index ${frame} is not a paid frame (must be an integer >= 1).`);
  }
  return `${publicOrigin}/api/reels/${encodeURIComponent(reelId)}/frames/${frame}`;
}

/** Read the payment header, preferring the v1 name for x402-fetch. */
export function paymentHeaderFrom(request: Request): string | null {
  return request.headers.get(V1_PAYMENT_HEADER) ?? request.headers.get(V2_PAYMENT_HEADER);
}

/**
 * Build the payment requirements for a reel.
 *
 * Takes a DB row, not a request. That is the whole trick: a caller physically
 * cannot thread a client-supplied amount through this function.
 */
export function buildPaymentRequirements(
  reel: ReelRow,
  options: BuildRequirementsOptions,
): PaymentRequirements {
  const { payTo, asset, network } = getConfig();
  const dialect = options.dialect ?? 1;

  const wireNetwork =
    dialect === 1
      ? (CAIP2_TO_V1_NETWORK[network] ?? (() => {
          throw new Error(
            `NETWORK is ${network}, which the x402 v1 wire format has no name for. ` +
              `Use a v2 client, or pick a network from: ${V1_NETWORKS.join(", ")}.`,
          );
        })())
      : network;

  if (dialect === 1 && !V1_NETWORKS.includes(wireNetwork as (typeof V1_NETWORKS)[number])) {
    throw new Error(`Resolved network "${wireNetwork}" is not a valid x402 v1 network.`);
  }

  // price_base_units is a string on purpose: it is an exact count of the asset's
  // smallest unit and must never round-trip through a float.
  const amount = reel.price_base_units;
  if (!Uint256String.safeParse(amount).success) {
    throw new Error(
      `Reel "${reel.id}" has a malformed price_base_units (${JSON.stringify(amount)}). ` +
        `It must be a non-negative integer string.`,
    );
  }

  return {
    scheme: "exact",
    network: wireNetwork,
    maxAmountRequired: amount,
    ...(dialect === 2 ? { amount } : {}),
    resource: resourceUrlFor(reel.id, options.frame),
    description: options.description ?? `Unlock all frames of "${reel.title}"`,
    mimeType: MIME_JPEG,
    payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 300,
    asset,
    // Pins the EIP-712 domain the payer must sign over. Left implicit it would
    // be inferred from a chain-id table, and the facilitator and the wallet
    // could disagree about it.
    extra: { name: "USDC", version: "2" },
  };
}

/** The 402 challenge body. Shape is what x402-fetch reads off the wire. */
export function buildPaymentRequired(
  reel: ReelRow,
  options: BuildRequirementsOptions,
) {
  return {
    x402Version: 1,
    accepts: [buildPaymentRequirements(reel, options)],
    error: "Payment required to unlock this frame.",
  };
}

/**
 * Headers for a 402 (and for the 400 that follows a malformed payload, which
 * carries the same challenge so the client can retry without a fresh request).
 *
 * The requirements go in the body, which is what v1 clients read, and in the
 * `PAYMENT-REQUIRED` header, which is where v2 clients look for them. Both are
 * base64-encoded `buildPaymentRequired(...)` values, so a client can use either
 * without the app having to know which dialect it is talking to.
 */
export function paymentRequiredHeaders(
  body: ReturnType<typeof buildPaymentRequired>,
): Record<string, string> {
  const encoded = encodePayload(body);
  return {
    [V2_REQUIRED_HEADER]: encoded,
    "cache-control": "no-store",
    "Access-Control-Expose-Headers": V2_REQUIRED_HEADER,
  };
}

// ---------------------------------------------------------------------------
// Header encoding
// ---------------------------------------------------------------------------

export function decodePaymentHeader(header: string): {
  payload: PaymentPayload;
  dialect: PaymentDialect;
} {
  const json = Buffer.from(header, "base64").toString("utf8");
  const payload = PaymentPayloadSchema.parse(JSON.parse(json));
  return { payload, dialect: payload.x402Version === 2 ? 2 : 1 };
}

export function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

export const encodeSettleResponse = encodePayload;

/** Both header names on the response, so v1 and v2 clients both find it. */
export function settlementHeaders(headerValue: string): Record<string, string> {
  return {
    [V1_RESPONSE_HEADER]: headerValue,
    [V2_RESPONSE_HEADER]: headerValue,
    "Access-Control-Expose-Headers": `${V1_RESPONSE_HEADER}, ${V2_RESPONSE_HEADER}`,
  };
}

// ---------------------------------------------------------------------------
// Facilitator
// ---------------------------------------------------------------------------

const FACILITATOR_TIMEOUT_MS = 30_000;

/**
 * Resolve one of the facilitator's endpoints against the configured base.
 *
 * `new URL("/verify", "https://x402.org/facilitator")` is the trap this module
 * fell into: a reference beginning with `/` is absolute, so the base's path is
 * discarded and every call quietly became `https://x402.org/verify` — the
 * marketing site, not the facilitator, which answers 404 with an HTML page.
 *
 * So treat the base as a directory instead: drop any trailing slashes, append
 * the endpoint, and let the URL constructor validate the result. A base
 * configured with or without a trailing slash then produces the same URL, and
 * anything that would still mangle the endpoint is rejected loudly.
 */
export function facilitatorEndpoint(base: string, path: "/verify" | "/settle"): URL {
  const trimmed = base.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${trimmed}${path}`);
  } catch {
    throw new Error(`FACILITATOR_URL "${base}" is not a usable base URL.`);
  }
  // ".../facilitator?x=1" + "/verify" would leave the endpoint inside the
  // query string, which looks like a working request and is not one.
  if (url.search || url.hash) {
    throw new Error(
      `FACILITATOR_URL "${base}" must be a plain base URL, with no query string or fragment.`,
    );
  }
  return url;
}

async function postToFacilitator<T>(
  path: "/verify" | "/settle",
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const { facilitatorUrl } = getConfig();
  const url = facilitatorEndpoint(facilitatorUrl, path);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // An HTML body means the request never reached a JSON API at all — a wrong
    // path, or a proxy/login page. Saying so is far more actionable than
    // quoting 200 characters of markup.
    const looksHtml = /^\s*(<!doctype|<html)/i.test(text);
    throw new Error(
      `Facilitator POST ${url.href} returned ${response.status}` +
        (looksHtml ? " with an HTML body, not JSON — the URL did not reach the facilitator" : "") +
        (text ? `: ${text.slice(0, 200)}` : ""),
    );
  }

  return schema.parse(await response.json());
}

export function verifyWithFacilitator(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<VerifyResponse> {
  return postToFacilitator(
    "/verify",
    {
      x402Version: payload.x402Version,
      paymentPayload: payload,
      paymentRequirements: requirements,
    },
    VerifyResponseSchema,
  );
}

export function settleWithFacilitator(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<SettleResponse> {
  return postToFacilitator(
    "/settle",
    {
      x402Version: payload.x402Version,
      paymentPayload: payload,
      paymentRequirements: requirements,
    },
    SettleResponseSchema,
  );
}

export type GateResult =
  | {
      status: "paid";
      payer: `0x${string}`;
      settle: SettleResponse;
      payload: PaymentPayload;
    }
  | { status: "invalid"; reason: string }
  | { status: "error"; reason: string; transaction?: string };

/**
 * Verify then settle.
 *
 * Order matters: verify first so a malformed or underpaid payload never reaches
 * the chain, and settle only once the facilitator has confirmed the signature
 * and the amount.
 */
export async function verifyAndSettle(
  header: string,
  requirements: PaymentRequirements,
): Promise<GateResult> {
  let payload: PaymentPayload;
  try {
    ({ payload } = decodePaymentHeader(header));
  } catch {
    return { status: "invalid", reason: "Malformed payment payload." };
  }

  const payerFromPayload = payload.payload.authorization.from as `0x${string}`;

  let verifyResult: VerifyResponse;
  try {
    verifyResult = await verifyWithFacilitator(payload, requirements);
  } catch (error) {
    return {
      status: "error",
      reason: `Facilitator verify failed: ${(error as Error).message}`,
    };
  }
  if (!verifyResult.isValid) {
    return { status: "invalid", reason: verifyResult.invalidReason ?? "Payment rejected." };
  }

  let settleResult: SettleResponse;
  try {
    settleResult = await settleWithFacilitator(payload, requirements);
  } catch (error) {
    return {
      status: "error",
      reason: `Facilitator settle failed: ${(error as Error).message}`,
    };
  }
  if (!settleResult.success) {
    return {
      status: "error",
      reason: settleResult.errorReason ?? "Settlement failed.",
      transaction: settleResult.transaction,
    };
  }

  /**
   * Credit the account the facilitator recovered, not the one the client asked
   * for.
   *
   * `authorization.from` is client-supplied text — the wallet's `eth_accounts`
   * casing, in whatever form the frontend happened to hold it. Preferring it
   * meant the entitlement was written in one convention and looked up in
   * another, which is how a settled purchase ended up answering 402 to its own
   * buyer. The facilitator already recovered the signer while verifying, so that
   * is the address to credit; the payload value is a last resort for a
   * facilitator that omits it.
   *
   * This narrows what is trusted rather than widening it: the recovered address
   * is by construction the one whose signature verified. `getAddress` only
   * canonicalizes the casing, not the account.
   */
  const payer = getAddress(
    verifyResult.payer ?? settleResult.payer ?? payerFromPayload,
  );

  return { status: "paid", payer, settle: settleResult, payload };
}
