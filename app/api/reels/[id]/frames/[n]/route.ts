import { NextResponse } from "next/server";
import { isAddressEqual } from "viem";
import { getReel, hasPurchased, recordPurchase } from "@/lib/db";
import { FrameError, MAX_FRAMES, openFrameStream, statFrame } from "@/lib/frames";
import { readSession } from "@/lib/session";
import {
  buildPaymentRequired,
  paymentRequiredHeaders,
  encodeSettleResponse,
  paymentHeaderFrom,
  settlementHeaders,
  verifyAndSettle,
  buildPaymentRequirements,
  decodePaymentHeader,
  MIME_JPEG,
} from "@/lib/x402Gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The paid frames. Frame 0 is not reachable from here — it belongs to the
 * ungated preview route — so this handler covers n >= 1 and every request to it
 * passes through an authorization decision.
 *
 * Order of checks, and why:
 *   1. shape        cheap rejection of junk before any I/O
 *   2. reel exists  so a 402 is never issued for a reel that does not exist
 *   3. in range     n must be a real frame of *this* reel
 *   4. session      no session, no bytes: a payment proves a wallet, not a user
 *   5. entitlement  an existing purchase short-circuits, no facilitator round
 *                   trip, so re-watching a reel you own costs nothing
 *   6. payment      the 402 challenge / verify / settle path
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; n: string }> },
): Promise<Response> {
  const { id, n: rawN } = await context.params;

  // 1. shape
  if (!/^\d{1,5}$/.test(rawN)) {
    return NextResponse.json({ error: "Malformed frame index." }, { status: 400 });
  }
  const n = Number(rawN);
  if (n >= MAX_FRAMES) {
    return NextResponse.json({ error: "Frame index out of range." }, { status: 400 });
  }
  if (n === 0) {
    // Free by design, but not from here: one URL, one policy.
    return NextResponse.json(
      {
        error: "Frame 0 is free and is served from the preview route.",
        previewUrl: `/api/reels/${encodeURIComponent(id)}/preview`,
      },
      { status: 400 },
    );
  }

  // 2. reel
  const reel = getReel(id);
  if (!reel) return NextResponse.json({ error: "Reel not found." }, { status: 404 });

  // 3. range — bounds come from the reel's own row, not from the request
  if (n >= reel.frame_count) {
    return NextResponse.json(
      { error: `Frame ${n} is out of range for this reel.` },
      { status: 404 },
    );
  }

  // 4. session
  const session = readSession(request);
  if (!session) {
    return NextResponse.json(
      { error: "Sign in required.", signInUrl: "/api/auth/nonce" },
      { status: 401 },
    );
  }

  // 5. already entitled — check #6. No facilitator round trip, so re-watching a
  //    reel you own costs nothing and cannot be charged twice.
  if (hasPurchased(session.address, reel.id)) {
    return serveFrame(id, n, { entitled: true, source: "purchase" });
  }

  // 6. payment. `n` is the number this handler already range-checked, and the
  //    resource URL is derived from it server-side — never from request.url, so
  //    a spoofed Host header cannot change what a payment is bound to.
  const header = paymentHeaderFrom(request);
  if (!header) {
    const required = buildPaymentRequired(reel, { frame: n });
    return NextResponse.json(required, {
      status: 402,
      headers: paymentRequiredHeaders(required),
    });
  }

  // Rebuild the requirements in the dialect the client actually used, so the
  // facilitator is comparing like with like.
  let dialect: 1 | 2 = 1;
  try {
    dialect = decodePaymentHeader(header).dialect;
  } catch {
    const required = buildPaymentRequired(reel, { frame: n });
    return NextResponse.json(
      { ...required, error: "Malformed payment payload." },
      { status: 400, headers: paymentRequiredHeaders(required) },
    );
  }

  const requirements = buildPaymentRequirements(reel, { frame: n, dialect });
  const result = await verifyAndSettle(header, requirements);

  if (result.status === "invalid") {
    // Re-send the challenge: a rejected payment means "sign again", and making
    // the client re-request just to get the requirements back is a wasted round
    // trip on a path that is already an error.
    const required = buildPaymentRequired(reel, { frame: n, dialect });
    return NextResponse.json(
      { ...required, error: "Payment rejected.", reason: result.reason },
      { status: 402, headers: paymentRequiredHeaders(required) },
    );
  }

  if (result.status === "error") {
    return NextResponse.json(
      { error: "Payment could not be settled.", reason: result.reason },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }

  // Settled. The money has moved, so the entitlement belongs to the payer
  // regardless of who they were browsing as — credit them, then decide whether
  // this particular request may proceed.
  recordPurchase(result.payer, reel.id, result.settle.transaction ?? null);

  if (!isAddressEqual(result.payer, session.address)) {
    return NextResponse.json(
      {
        error:
          "Payment was made by a different wallet than the signed-in one. " +
          "The purchase is recorded against the paying wallet.",
      },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  return serveFrame(id, n, {
    entitled: true,
    source: "purchase",
    settlement: settlementHeaders(encodeSettleResponse(result.settle)),
  });
}

/**
 * Stream the frame.
 *
 * `private, no-store` is load-bearing: paid bytes must never be written to a
 * shared cache, or one buyer could be handed another buyer's frames.
 */
async function serveFrame(
  reelId: string,
  n: number,
  extras: {
    entitled: boolean;
    source: "purchase";
    settlement?: Record<string, string>;
  },
): Promise<Response> {
  try {
    const { stream, meta } = await openFrameStream(reelId, n);
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": meta.contentType || MIME_JPEG,
        "content-length": String(meta.size),
        "cache-control": "private, no-store",
        "x-bioscope-gate": "paid",
        "x-bioscope-entitlement": extras.entitled ? "granted" : "denied",
        "x-bioscope-source": extras.source,
        ...(extras.settlement ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof FrameError) {
      // The reel is in the database but its image is missing on disk.
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/** Lets a client check whether it already has access before attempting a frame. */
export async function HEAD(
  request: Request,
  context: { params: Promise<{ id: string; n: string }> },
): Promise<Response> {
  const { id, n: rawN } = await context.params;
  if (!/^\d{1,5}$/.test(rawN)) return new Response(null, { status: 400 });
  const n = Number(rawN);
  if (n === 0 || n >= MAX_FRAMES) return new Response(null, { status: 400 });

  const reel = getReel(id);
  if (!reel || n >= reel.frame_count) return new Response(null, { status: 404 });

  const session = readSession(request);
  const entitled = session ? hasPurchased(session.address, reel.id) : false;
  if (!entitled) return new Response(null, { status: 402 });

  try {
    const meta = await statFrame(id, n);
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": meta.contentType,
        "content-length": String(meta.size),
        "cache-control": "private, no-store",
        "x-bioscope-entitlement": "granted",
      },
    });
  } catch (error) {
    if (error instanceof FrameError) return new Response(null, { status: error.status });
    throw error;
  }
}
