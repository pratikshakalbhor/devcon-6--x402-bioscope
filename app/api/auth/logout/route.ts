import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drop the SIWX session.
 *
 * The session cookie is HttpOnly, so page JavaScript cannot clear it — which is
 * exactly why disconnecting a wallet used to leave the app authenticated: the UI
 * went back to "Connect Wallet" but the cookie survived, and the next load read
 * it in /api/reels and restored the signed-in and unlocked state.
 *
 * This only ever removes a session. It grants nothing, verifies nothing and
 * touches no nonce, so replay and expiry protection are unchanged.
 */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  // Same name, path and attributes as the cookie that was set, with maxAge 0,
  // so the browser actually removes it rather than storing an empty twin.
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return response;
}
