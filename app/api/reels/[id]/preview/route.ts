import { NextResponse } from "next/server";
import { FrameError, openFrameStream, statFrame } from "@/lib/frames";
import { getReel } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The free first frame.
 *
 * This handler contains no session check and no payment check, and that is the
 * design rather than an omission: "first frame free" is enforced structurally
 * by the fact that this route is a different URL from the paid frames route and
 * hardcodes index 0. There is no `n` parameter here to walk forward from, so
 * there is nothing here to gate.
 *
 * See app/api/reels/[id]/frames/[n]/route.ts for the paid path.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  try {
    // An unknown reel id should 404 before we touch the filesystem.
    if (!getReel(id)) {
      return NextResponse.json({ error: "Reel not found." }, { status: 404 });
    }

    const { stream, meta } = await openFrameStream(id, 0);

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": meta.contentType,
        "content-length": String(meta.size),
        "last-modified": new Date(meta.lastModified * 1000).toUTCString(),
        etag: `W/"preview-${id}-0-${meta.size}"`,
        // Public and immutable: this endpoint never changes behaviour based on
        // who is asking, so it is safe to cache hard at the edge.
        "cache-control": "public, max-age=3600, immutable",
        "x-bioscope-gate": "free-preview",
      },
    });
  } catch (error) {
    if (error instanceof FrameError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/** Cheap existence probe without transferring the image. */
export async function HEAD(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  try {
    if (!getReel(id)) return new Response(null, { status: 404 });
    const meta = await statFrame(id, 0);
    return new Response(null, {
      status: 200,
      headers: { "content-type": meta.contentType, "content-length": String(meta.size) },
    });
  } catch (error) {
    if (error instanceof FrameError) return new Response(null, { status: error.status });
    throw error;
  }
}
