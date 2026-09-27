import jpeg from "jpeg-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { getConfig, priceForReel } from "@/lib/config";
import { getDb, hasPurchased, normalizeAddress, recordPurchase, upsertReel } from "@/lib/db";
import { SESSION_COOKIE, createSession } from "@/lib/session";
import { GET as framesGET } from "../app/api/reels/[id]/frames/[n]/route";

/**
 * Entitlement identity: (wallet, reel). And the casing bug that broke it.
 *
 * The live incident: a settled payment was recorded with a lowercase wallet
 * address, because `authorization.from` is the string the client supplied and
 * MetaMask's `eth_accounts` returns lowercase. The session cookie holds the
 * EIP-55 checksummed form of the same account, because `createSession` runs
 * `getAddress`. `purchases.wallet_address` was a plain TEXT column, so SQLite
 * compared the two byte-exactly, `hasPurchased` found nothing, and the frame
 * route answered 402 to a buyer who had already paid. The UI was right: it had
 * seen the 200 from the settled request.
 *
 * The test that should have caught this, in test/entitlement.test.ts, used
 * `0x3333...` — all digits, so `toLowerCase()` was a no-op and the assertion
 * passed without ever varying the casing. Hence an address with real letters
 * below, and a check on the stored bytes rather than only on a return value.
 */

/**
 * A distinct wallet per test. The database is shared across a file, so tests
 * that asserted on "all rows for this reel" would see each other's writes and
 * pass or fail depending on execution order.
 */
const WALLET = "0xa801a206B4C07Fb8d94444CD8ec3FFAE78C34b10";
/** The same account as MetaMask reports it. */
const WALLET_LOWER = WALLET.toLowerCase();
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/** EIP-55 checksummed, so SOLO !== SOLO_LOWER and the mismatch is real. */
const SOLO = "0x1c7c4F1f0E2a3b4C5D6E7F8091a2b3C4D5e6F708";
const SOLO_LOWER = SOLO.toLowerCase();
const SOLO_UPPER = SOLO_LOWER.toUpperCase().replace("0X", "0x");

const REELS = [
  { id: "reel-1", title: "One", description: "", frame_count: 4 },
  { id: "reel-2", title: "Two", description: "", frame_count: 4 },
  { id: "reel-3", title: "Three", description: "", frame_count: 4 },
];

const JPEG = jpeg.encode({ data: Buffer.alloc(2 * 2 * 3, 0x40), width: 2, height: 2 }, 50).data;

function url(reelId: string, n: number): string {
  return `http://localhost:3000/api/reels/${reelId}/frames/${n}`;
}

/** A request carrying a real session cookie, minted the way the app mints one. */
function requestFor(wallet: string, target: string): Request {
  return new Request(target, {
    headers: { cookie: `${SESSION_COOKIE}=${createSession(wallet).token}` },
  });
}

const callFrames = (wallet: string, reelId: string, n = 1) =>
  framesGET(requestFor(wallet, url(reelId, n)), {
    params: Promise.resolve({ id: reelId, n: String(n) }),
  });

/** The raw stored bytes for one wallet, so a test can assert on the column. */
function storedAddresses(wallet: string, reelId: string): string[] {
  return (
    getDb()
      .prepare<[string, string], { wallet_address: string }>(
        "SELECT wallet_address FROM purchases WHERE wallet_address = ? AND reel_id = ?",
      )
      .all(wallet, reelId)
      .map((row) => row.wallet_address)
  );
}

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

describe("a purchase unlocks only the reel that was bought", () => {
  it("wallet paid for reel-1 gets reel-1 frames, while reel-2 and reel-3 stay locked", async () => {
    recordPurchase(WALLET, "reel-1", "0x1111111111111111111111111111111111111111111111111111111111111111");

    expect((await callFrames(WALLET, "reel-1")).status).toBe(200);
    expect((await callFrames(WALLET, "reel-2")).status).toBe(402);
    expect((await callFrames(WALLET, "reel-3")).status).toBe(402);

    expect(hasPurchased(WALLET, "reel-1")).toBe(true);
    expect(hasPurchased(WALLET, "reel-2")).toBe(false);
    expect(hasPurchased(WALLET, "reel-3")).toBe(false);
  });

  it("another wallet's purchase does not unlock anything for this one", async () => {
    recordPurchase(OTHER, "reel-3", "0x2222222222222222222222222222222222222222222222222222222222222222");

    expect(hasPurchased(WALLET, "reel-3")).toBe(false);
    expect((await callFrames(WALLET, "reel-3")).status).toBe(402);
  });
});

describe("entitlement is keyed on wallet + reel in the database", () => {
  it("a purchase on reel-1 cannot make reel-3 answer as paid", async () => {
    recordPurchase(WALLET, "reel-1", "0x3333333333333333333333333333333333333333333333333333333333333333");

    // The exact confusion reported in the browser: a paid reel next to a locked
    // one, same wallet, same session.
    expect(storedAddresses(WALLET, "reel-1")).toEqual([normalizeAddress(WALLET)]);
    expect(storedAddresses(WALLET, "reel-3")).toEqual([]);

    expect((await callFrames(WALLET, "reel-1")).status).toBe(200);
    expect((await callFrames(WALLET, "reel-3")).status).toBe(402);
  });

  it("stays one row per (wallet, reel) no matter how the address is cased", () => {
    recordPurchase(WALLET, "reel-1", "0xaaaa");
    recordPurchase(WALLET_LOWER, "reel-1", "0xbbbb");
    recordPurchase(WALLET.toUpperCase().replace("0X", "0x"), "reel-1", "0xcccc");

    const rows = getDb()
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM purchases WHERE wallet_address = ? COLLATE NOCASE AND reel_id = ?",
      )
      .get(WALLET, "reel-1");
    expect(rows?.n).toBe(1);
  });
});

describe("the casing defect that 402'd a paying buyer", () => {
  it("finds a purchase recorded in lowercase using the checksummed session address", () => {
    // The fixture must be casing-sensitive or this test proves nothing.
    expect(SOLO).not.toBe(SOLO_LOWER);
    expect(SOLO).not.toBe(SOLO_UPPER);
    // Reproduces the live row exactly: written lowercase, read checksummed.
    getDb()
      .prepare(
        "INSERT INTO purchases (wallet_address, reel_id, purchased_at, tx_hash) VALUES (?, ?, ?, ?)",
      )
      .run(SOLO_LOWER, "reel-3", 1790522846, "0xdeadbeef");

    expect(storedAddresses(SOLO_LOWER, "reel-3")).toEqual([SOLO_LOWER]);
    expect(hasPurchased(SOLO, "reel-3")).toBe(true);
    expect(hasPurchased(SOLO_LOWER, "reel-3")).toBe(true);
  });

  it("records and finds the same account across every casing", () => {
    recordPurchase(SOLO_LOWER, "reel-2", "0xeeee");

    expect(normalizeAddress(SOLO_LOWER)).toBe(getAddress(SOLO_LOWER));
    expect(normalizeAddress(SOLO_LOWER)).toBe(normalizeAddress(SOLO));
    expect(hasPurchased(SOLO, "reel-2")).toBe(true);
    expect(hasPurchased(SOLO_LOWER, "reel-2")).toBe(true);
    expect(hasPurchased(SOLO_UPPER, "reel-2")).toBe(true);
  });

  it("declares the column NOCASE so the key cannot depend on a call site", () => {
    // Read from the DDL: PRAGMA table_info reports "TEXT" and omits the
    // collation entirely, which is exactly the mistake the migration guard made.
    const ddl = getDb()
      .prepare<[], { sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'purchases'",
      )
      .get()?.sql;
    expect(ddl).toMatch(/wallet_address[^,]*COLLATE\s+NOCASE/i);
  });

  it("gives the frame route 200 for a paid reel regardless of address casing", async () => {
    // The browser symptom, at the route boundary.
    expect((await callFrames(SOLO, "reel-3")).status).toBe(200);
    expect((await callFrames(SOLO_LOWER, "reel-3")).status).toBe(200);
  });
});

describe("a 402 from the frame route cannot be overridden by client state", () => {
  it("still answers 402 for a reel with no row, whatever the address is", async () => {
    // A client holding `unlocked` for reel-1 changes nothing here: this handler
    // never reads client state, only the (session.address, reel.id) pair.
    recordPurchase(WALLET, "reel-1", "0x5555555555555555555555555555555555555555555555555555555555555555");
    expect((await callFrames(WALLET, "reel-1")).status).toBe(200);

    // Same wallet, other reels: locked, in every casing, so no spelling of the
    // address can talk the route into serving bytes.
    for (const address of [WALLET, WALLET_LOWER, WALLET.toUpperCase().replace("0X", "0x")]) {
      expect((await callFrames(address, "reel-2")).status).toBe(402);
      expect((await callFrames(address, "reel-3")).status).toBe(402);
    }
  });

  it("ignores an identity header entirely, with no session at all", async () => {
    recordPurchase(WALLET, "reel-1", "0x6666666666666666666666666666666666666666666666666666666666666666");

    const spoofed = new Request(url("reel-1", 1), {
      headers: {
        "x-bioscope-address": WALLET,
        "x-bioscope-wallet": WALLET,
        "x-bioscope-entitlement": "granted",
        "x-bioscope-gate": "paid",
      },
    });
    const response = await framesGET(spoofed, {
      params: Promise.resolve({ id: "reel-1", n: "1" }),
    });

    expect(response.status).toBe(401);
  });
});
