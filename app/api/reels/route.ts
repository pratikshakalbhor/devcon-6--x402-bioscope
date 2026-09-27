import { NextResponse } from "next/server";
import { ASSET_DECIMALS, formatUsd, getConfig } from "@/lib/config";
import { hasPurchased, listReels } from "@/lib/db";
import { readSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Catalogue endpoint.
 *
 * Returns metadata only. There is deliberately no frame URL, no frame count
 * path, no directory name, and nothing else that a client could turn into a
 * static fetch. The only image a client can name from this response is the
 * ungated preview route, which is a separate, publicly-intended resource.
 */
export async function GET(request: Request): Promise<Response> {
  const { asset, network } = getConfig();
  const session = readSession(request);

  const reels = listReels().map((reel) => ({
    id: reel.id,
    title: reel.title,
    description: reel.description,
    frameCount: reel.frame_count,
    /** USDC base units, exact integer string. */
    price: reel.price_base_units,
    priceUsd: formatUsd(reel.price_base_units, ASSET_DECIMALS),
    asset,
    network,
    /** The only frame URL this API will ever hand out, and it is ungated. */
    previewUrl: `/api/reels/${encodeURIComponent(reel.id)}/preview`,
    /** Entitlement for the signed-in wallet, if any. */
    owned: session ? hasPurchased(session.address, reel.id) : false,
  }));

  return NextResponse.json(
    { reels, address: session?.address ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}
