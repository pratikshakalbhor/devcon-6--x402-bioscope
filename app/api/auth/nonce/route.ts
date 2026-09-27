import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { countActiveNonces, pruneNonces } from "@/lib/db";
import { issueChallenge } from "@/lib/siwx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  address: z.string().refine(isAddress, "address must be a 20-byte hex address"),
});

/** Cap on unexpired nonces per address, so this endpoint cannot grow the table. */
const MAX_ACTIVE_NONCES = 5;

/**
 * Step 1 of SIWX.
 *
 * The nonce is generated and stored server-side, bound to the requesting
 * address. The client gets back the nonce, its expiry, and the exact text to
 * sign. Handing over the message is safe: the signature is still checked
 * against the stored row, and the client cannot influence issued-at,
 * expiration-time, or domain.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({ address: url.searchParams.get("address") ?? "" });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "A valid ?address=0x… is required." },
      { status: 400 },
    );
  }

  pruneNonces();

  if (countActiveNonces(getAddress(parsed.data.address)) >= MAX_ACTIVE_NONCES) {
    return NextResponse.json(
      { error: "Too many outstanding sign-in challenges. Try again shortly." },
      { status: 429 },
    );
  }

  const challenge = issueChallenge(parsed.data.address);

  return NextResponse.json(
    {
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      // Issued for the client to sign verbatim.
      message: challenge.message,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
