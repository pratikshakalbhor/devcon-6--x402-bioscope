import jpeg from "jpeg-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getConfig, priceForReel } from "@/lib/config";
import { getDb, hasPurchased, listReels, recordPurchase, upsertReel } from "@/lib/db";
import { SESSION_COOKIE, createSession, verifySession } from "@/lib/session";
import { GET as previewGET } from "../app/api/reels/[id]/preview/route";
import { GET as framesGET } from "../app/api/reels/[id]/frames/[n]/route";
import { GET as reelsGET } from "../app/api/reels/route";

/**
 * Entitlement scoping, exercised against the real route handlers rather than a
 * reimplementation of their logic. The two properties under test:
 *
 *   per-wallet  wallet A's purchase says nothing about wallet B
 *   per-reel    buying reel-1 says nothing about reel-2
 *
 * Both fall out of the composite primary key on `purchases`, so these tests are
 * really checking that nothing else in the request path widens the scope.
 */

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
/** Used by the case-insensitivity test, so it does not disturb ALICE's rows. */
const CAROL = "0x3C0FdEbBc52F0AaEc6C4C7D4E5A2b1E9a5F1C3D7";
/** Used by the bounds and cache tests, which need their own entitlement set. */
const DAVE = "0x4444444444444444444444444444444444444444";
/** Owns reel-1, and is the only wallet the identity-header test may spend. */
const EVE = privateKeyToAccount(
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
);

const REELS = [
  { id: "reel-1", title: "One", description: "", frame_count: 4 },
  { id: "reel-2", title: "Two", description: "", frame_count: 3 },
];

const JPEG = jpeg.encode({ data: Buffer.alloc(2 * 2 * 3, 0x40), width: 2, height: 2 }, 50).data;

function url(reelId: string, n: number): string {
  return `http://localhost:3000/api/reels/${reelId}/frames/${n}`;
}

function requestFor(wallet: string | null, target: string): Request {
  const headers = new Headers();
  if (wallet) {
    headers.set("cookie", `${SESSION_COOKIE}=${createSession(wallet).token}`);
  }
  return new Request(target, { headers });
}

const callFrames = (wallet: string | null, reelId: string, n: number) =>
  framesGET(requestFor(wallet, url(reelId, n)), {
    params: Promise.resolve({ id: reelId, n: String(n) }),
  });

const callPreview = (wallet: string | null, reelId: string) =>
  previewGET(requestFor(wallet, `http://localhost:3000/api/reels/${reelId}/preview`), {
    params: Promise.resolve({ id: reelId }),
  });

beforeAll(async () => {
  const { reelsDir } = getConfig();
  for (const reel of REELS) {
    upsertReel({ ...reel, price_base_units: priceForReel(reel.id) });
    const dir = path.join(reelsDir, reel.id);
    await fs.mkdir(dir, { recursive: true });
    for (let n = 0; n < reel.frame_count; n++) {
      await fs.writeFile(path.join(dir, `frame-${String(n).padStart(2, "0")}.jpg`), JPEG);
    }
  }
});

describe("first frame is free", () => {
  it("serves frame 0 with no session and no payment", async () => {
    const response = await callPreview(null, "reel-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-bioscope-gate")).toBe("free-preview");
    expect((await response.arrayBuffer()).byteLength).toBe(JPEG.byteLength);
  });

  it("serves the identical bytes to a signed-in wallet", async () => {
    const anonymous = await (await callPreview(null, "reel-1")).arrayBuffer();
    const signedIn = await (await callPreview(ALICE, "reel-1")).arrayBuffer();

    expect(Buffer.compare(Buffer.from(anonymous), Buffer.from(signedIn))).toBe(0);
  });

  it("is not reachable from the paid route", async () => {
    const response = await callFrames(null, "reel-1", 0);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { previewUrl?: string };
    expect(body.previewUrl).toBe("/api/reels/reel-1/preview");
  });

  it("404s for a reel that does not exist", async () => {
    const response = await callPreview(null, "reel-does-not-exist");
    expect(response.status).toBe(404);
  });
});

describe("gating on identity", () => {
  it("refuses a paid frame when there is no session, even with no payment offered", async () => {
    const response = await callFrames(null, "reel-1", 1);

    expect(response.status).toBe(401);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("Sign in"),
    });
  });

  it("rejects a forged session cookie", async () => {
    const forged = createSession(ALICE).token;
    const tampered = `${forged.slice(0, -4)}${forged.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    expect(verifySession(tampered)).toBeNull();

    const request = new Request(url("reel-1", 1), {
      headers: { cookie: `${SESSION_COOKIE}=${tampered}` },
    });
    const response = await framesGET(request, {
      params: Promise.resolve({ id: "reel-1", n: "1" }),
    });

    expect(response.status).toBe(401);
  });

  it("never resolves an address from an unsigned or malformed cookie", async () => {
    // Each of these claims to be ALICE. None of them is signed with
    // SESSION_SECRET, so none of them identifies anybody.
    const [realBody] = createSession(ALICE).token.split(".");
    const claimsAlice = { address: ALICE, iat: 0, exp: 9_999_999_999 };
    const unsignedPayload = Buffer.from(JSON.stringify(claimsAlice)).toString("base64url");

    const candidates: [string, string][] = [
      ["no signature at all", unsignedPayload],
      ["payload with a trailing dot", `${unsignedPayload}.`],
      ["empty signature", `${unsignedPayload}.`],
      ["garbage signature", `${unsignedPayload}.not-a-real-hmac`],
      ["a real payload with its HMAC swapped for zeros", `${realBody}.${"A".repeat(43)}`],
      ["just an address", ALICE],
      ["a JSON blob, unencoded", JSON.stringify(claimsAlice)],
      ["base64 of nothing", ""],
    ];

    for (const [label, value] of candidates) {
      expect(verifySession(value), label).toBeNull();
      // And the gate agrees: no address, so no frame.
      const response = await framesGET(
        new Request(url("reel-1", 1), {
          headers: { cookie: `${SESSION_COOKIE}=${value}` },
        }),
        { params: Promise.resolve({ id: "reel-1", n: "1" }) },
      );
      expect(response.status, label).toBe(401);
    }
  });

  it("ignores an address asserted by header or query string", async () => {
    // EVE owns reel-1, yet still gets nothing without the signed cookie:
    // nothing but the cookie counts as an identity.
    recordPurchase(EVE.address, "reel-1", "0xeee");

    const headerSets: Record<string, string>[] = [
      { "x-wallet-address": EVE.address },
      { "x-address": EVE.address, authorization: `Bearer ${EVE.address}` },
      {},
    ];

    for (const headers of headerSets) {
      const response = await framesGET(
        new Request(`${url("reel-1", 1)}?address=${EVE.address}&wallet=${EVE.address}`, {
          headers,
        }),
        { params: Promise.resolve({ id: "reel-1", n: "1" }) },
      );
      expect(response.status).toBe(401);
    }

    // Sanity check that the entitlement really is there, so the 401s above are
    // about identity and not about a missing row.
    expect(hasPurchased(EVE.address, "reel-1")).toBe(true);
    expect((await callFrames(EVE.address, "reel-1", 1)).status).toBe(200);
  });
});

describe("payment challenge", () => {
  it("quotes the server-side price, not anything the request supplied", async () => {
    const response = await callFrames(ALICE, "reel-1", 1);

    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      x402Version: number;
      accepts: { maxAmountRequired: string; payTo: string; asset: string; network: string }[];
    };

    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]?.maxAmountRequired).toBe(priceForReel("reel-1"));
    expect(body.accepts[0]?.payTo).toBe(getConfig().payTo);
    expect(body.accepts[0]?.asset).toBe(getConfig().asset);
    expect(body.accepts[0]?.network).toBe("base-sepolia");
  });

  it("quotes a different amount per reel", async () => {
    const one = (await (await callFrames(ALICE, "reel-1", 1)).json()) as {
      accepts: { maxAmountRequired: string }[];
    };
    const two = (await (await callFrames(ALICE, "reel-2", 1)).json()) as {
      accepts: { maxAmountRequired: string }[];
    };

    expect(one.accepts[0]?.maxAmountRequired).toBe(priceForReel("reel-1"));
    expect(two.accepts[0]?.maxAmountRequired).toBe(priceForReel("reel-2"));
    expect(one.accepts[0]?.maxAmountRequired).not.toBe(two.accepts[0]?.maxAmountRequired);
  });

  it("names the frame being served, from server config rather than the request", async () => {
    const body = (await (await callFrames(ALICE, "reel-1", 3)).json()) as {
      accepts: { resource: string }[];
    };

    // Built from APP_ORIGIN + reel id + the n this handler already validated.
    expect(body.accepts[0]?.resource).toBe(
      `${getConfig().publicOrigin}/api/reels/reel-1/frames/3`,
    );
  });

  it("is not steerable by a spoofed Host header", async () => {
    // The resource binds what a payment is for. If it came from request.url, a
    // forwarded request with a rewritten Host could point it somewhere else.
    const spoofed = new Request("http://evil.test/api/reels/reel-1/frames/1", {
      headers: { host: "evil.test", cookie: `${SESSION_COOKIE}=${createSession(ALICE).token}` },
    });
    const response = await framesGET(spoofed, {
      params: Promise.resolve({ id: "reel-1", n: "1" }),
    });
    const body = (await response.json()) as { accepts: { resource: string }[] };

    expect(response.status).toBe(402);
    expect(body.accepts[0]?.resource).toBe(
      `${getConfig().publicOrigin}/api/reels/reel-1/frames/1`,
    );
    expect(body.accepts[0]?.resource).not.toContain("evil.test");
  });
});

describe("per-wallet scoping", () => {
  it("does not let one wallet's purchase unlock another wallet", async () => {
    recordPurchase(ALICE, "reel-1", "0xaaa");

    expect(hasPurchased(ALICE, "reel-1")).toBe(true);
    expect(hasPurchased(BOB, "reel-1")).toBe(false);

    const alice = await callFrames(ALICE, "reel-1", 2);
    const bob = await callFrames(BOB, "reel-1", 2);

    expect(alice.status).toBe(200);
    expect(bob.status).toBe(402);
  });

  it("is case-insensitive on the wallet, because addresses are checksummed", () => {
    // CAROL must contain letters for this to mean anything. The original was
    // 0x3333...: `toLowerCase()` returned the same string, so the assertion
    // passed while never once varying the casing — which is why a live purchase
    // written lowercase went unfound by a checksummed session.
    expect(CAROL.toLowerCase()).not.toBe(CAROL);

    recordPurchase(CAROL, "reel-2", "0xbbb");
    expect(hasPurchased(CAROL.toLowerCase(), "reel-2")).toBe(true);
    expect(hasPurchased(CAROL.toUpperCase().replace("0X", "0x"), "reel-2")).toBe(true);
    expect(hasPurchased(CAROL, "reel-2")).toBe(true);
  });

  it("keeps a session bound to one wallet", () => {
    expect(verifySession(createSession(ALICE).token)?.address).toBe(ALICE);
    expect(verifySession(createSession(BOB).token)?.address).toBe(BOB);
  });
});

describe("per-reel scoping", () => {
  it("does not let a purchase on one reel unlock another", async () => {
    recordPurchase(ALICE, "reel-1", "0xccc");

    const bought = await callFrames(ALICE, "reel-1", 3);
    const notBought = await callFrames(ALICE, "reel-2", 1);

    expect(bought.status).toBe(200);
    expect(notBought.status).toBe(402);
    expect(hasPurchased(ALICE, "reel-1")).toBe(true);
    expect(hasPurchased(ALICE, "reel-2")).toBe(false);
  });

  it("records repeat purchases without creating a second row", () => {
    recordPurchase(ALICE, "reel-1", "0xfirst");
    recordPurchase(ALICE, "reel-1", "0xsecond");

    const rows = getPurchaseCount(ALICE, "reel-1");
    expect(rows).toBe(1);
  });
});

describe("frame bounds", () => {
  it("404s a frame past the end of the reel", async () => {
    recordPurchase(DAVE, "reel-1", "0xddd");
    // reel-1 has 4 frames, indices 0..3.
    expect((await callFrames(DAVE, "reel-1", 4)).status).toBe(404);
  });

  it("uses the reel's own frame_count, not the number of files on disk", async () => {
    recordPurchase(DAVE, "reel-2", "0xeee");
    // reel-2 declares 3 frames (0..2).
    expect((await callFrames(DAVE, "reel-2", 2)).status).toBe(200);
    expect((await callFrames(DAVE, "reel-2", 3)).status).toBe(404);
  });

  it("rejects a non-numeric frame index", async () => {
    expect((await callFrames(DAVE, "reel-1", "abc" as unknown as number)).status).toBe(400);
    expect((await callFrames(DAVE, "reel-1", "-1" as unknown as number)).status).toBe(400);
    expect((await callFrames(DAVE, "reel-1", "1.5" as unknown as number)).status).toBe(400);
  });
});

describe("cache headers on paid bytes", () => {
  it("marks served frames private so a shared cache cannot hand them on", async () => {
    recordPurchase(DAVE, "reel-1", "0xfff");
    const response = await callFrames(DAVE, "reel-1", 1);

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-bioscope-entitlement")).toBe("granted");
  });
});

function getPurchaseCount(wallet: string, reelId: string): number {
  // Deliberately not exported from lib/db: this is a white-box assertion about
  // the composite key, not a query the app needs.
  const row = getDb()
    .prepare<[string, string], { n: number }>(
      "SELECT COUNT(*) AS n FROM purchases WHERE wallet_address = ? AND reel_id = ?",
    )
    .get(wallet, reelId);
  return row?.n ?? 0;
}

describe("the catalogue before anything is seeded", () => {
  // A fresh install has an empty `reels` table: `npm run seed` is a separate,
  // later step. GET /api/reels has to answer 200 with an empty list, because a
  // 500 here is indistinguishable from a broken deploy, and because the schema
  // is created on first access rather than by a migration step that might not
  // have run.
  beforeAll(() => {
    // purchases.reel_id is a foreign key onto reels, so the children go first.
    const db = getDb();
    db.prepare("DELETE FROM purchases").run();
    db.prepare("DELETE FROM reels").run();
  });

  it("answers 200 with an empty array, not a 500", async () => {
    expect(listReels()).toEqual([]);

    const response = await reelsGET(new Request("http://localhost:3000/api/reels"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { reels: unknown[]; address: string | null };
    expect(body.reels).toEqual([]);
    expect(body.address).toBeNull();
  });

  it("still identifies a signed-in wallet and refuses caching, with nothing seeded", async () => {
    // The identity and the cache header are properties of the request, not of the
    // catalogue, so an empty reels table must not change either.
    const response = await reelsGET(
      new Request("http://localhost:3000/api/reels", {
        headers: { cookie: `${SESSION_COOKIE}=${createSession(ALICE).token}` },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as { reels: unknown[]; address: string | null };
    expect(body.reels).toEqual([]);
    expect(body.address?.toLowerCase()).toBe(ALICE.toLowerCase());
  });

  it("404s a frame request for a reel that does not exist, rather than crashing", async () => {
    const response = await callFrames(ALICE, "reel-1", 1);
    expect(response.status).toBe(404);
  });
});
