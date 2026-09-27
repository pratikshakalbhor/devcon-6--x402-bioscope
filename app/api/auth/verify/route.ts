import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { assertNonceUsable, burnNonce, challengeFromNonceRow, verifySiwx } from "@/lib/siwx";
import { SESSION_COOKIE, createSession, sessionCookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Note there is no `message` field here on purpose. The message is rebuilt from
 * the stored nonce row; accepting one from the client would let a caller sign
 * arbitrary text and have it checked against an arbitrary wallet. See the
 * SECURITY note in lib/siwx.ts.
 */
const BodySchema = z.object({
  address: z.string().refine(isAddress, "address must be a 20-byte hex address"),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "signature must be hex"),
  nonce: z.string().min(8).max(128),
});

const STATUS_BY_REASON = {
  "unknown-nonce": 400,
  "nonce-already-used": 401,
  "nonce-expired": 401,
  "address-mismatch": 401,
  "bad-signature": 401,
} as const;

/** Step 2 of SIWX: exchange a signed challenge for a session cookie. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "address, signature and nonce are all required." },
      { status: 400 },
    );
  }

  const { address, signature, nonce } = parsed.data;

  // 1. The nonce must exist, be unused, and not be expired. All three are
  //    enforced here rather than merely being stored.
  const check = assertNonceUsable(nonce);
  if (!check.ok) {
    return NextResponse.json(
      { error: "Sign-in failed.", reason: check.reason },
      { status: STATUS_BY_REASON[check.reason] },
    );
  }

  // 2. The nonce was issued for one specific wallet. Comparing here is not
  //    redundant with the signature check: verifyMessage proves the signature
  //    is by `address`, but it says nothing about which address the message
  //    names. Without this, a caller could mint a nonce for their own wallet
  //    and present it while claiming a different one.
  if (getAddress(check.row.address) !== getAddress(address)) {
    return NextResponse.json(
      { error: "Sign-in failed.", reason: "address-mismatch" },
      { status: STATUS_BY_REASON["address-mismatch"] },
    );
  }

  // 3. Rebuild the exact message from stored nonce/expiry/address and confirm
  //    the signature is over it.
  const message = challengeFromNonceRow(check.row);
  const signatureCheck = await verifySiwx({ address, signature: signature as `0x${string}`, message });
  if (!signatureCheck.ok) {
    return NextResponse.json(
      { error: "Sign-in failed.", reason: signatureCheck.reason },
      { status: STATUS_BY_REASON[signatureCheck.reason] },
    );
  }

  // 4. Burn the nonce, now that the signature is known good. A captured
  //    signature cannot be replayed against it. The compare-and-swap in
  //    consumeNonce means concurrent replays cannot both succeed.
  if (!burnNonce(nonce)) {
    return NextResponse.json(
      { error: "Sign-in failed.", reason: "nonce-already-used" },
      { status: STATUS_BY_REASON["nonce-already-used"] },
    );
  }

  // 5. Hand out a signed cookie. This is the only artefact later routes trust.
  const { sessionTtlSeconds } = getConfig();
  const { token, session } = createSession(signatureCheck.address);

  const response = NextResponse.json(
    { address: session.address, expiresAt: session.exp },
    { headers: { "cache-control": "no-store" } },
  );
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(sessionTtlSeconds));
  return response;
}
