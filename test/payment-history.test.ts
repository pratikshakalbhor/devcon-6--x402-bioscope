import { beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  getDb,
  hasPurchased,
  listPaymentEvents,
  listPaymentsForReel,
  normalizeAddress,
  recordPurchase,
  upsertReel,
} from "@/lib/db";

/**
 * Payment history versus entitlement.
 *
 * The live database held four real settled payments: reel-1, reel-2, and reel-3
 * twice. The two reel-3 rows only both existed because their `wallet_address`
 * strings differed in case, so the old case-sensitive primary key filed them
 * separately. The moment the key is fixed and the rows collapse, one transaction
 * hash loses its only reference in the database — even though the payment is
 * real, and `recordPurchase` had been overwriting `tx_hash` on every repeat
 * purchase anyway.
 *
 * So entitlement and payment history are now different things with different
 * shapes:
 *
 *   purchases        one row per (wallet, reel) — "may I watch this"
 *   payment_events   append-only, no such key   — "what did I pay, and when"
 *
 * These pin both halves: the entitlement invariant must still hold exactly, and
 * no settled payment may be dropped to keep it.
 */

const BUYER = "0xa801a206B4C07Fb8d94444CD8ec3FFAE78C34b10";
const BUYER_LOWER = BUYER.toLowerCase();
const TX_A = "0xfa48a8f8f0fad6d326cd41d5e3baff5d0bb85c189f1e415027f50176d33e9e63";
const TX_B = "0xff35bb7197e77894d4ec5caa353049108ee327567aa67c6f300712b1508d318d";

// purchases.reel_id is a foreign key, so the reels have to exist first.
beforeAll(() => {
  for (const [id, frames] of [["reel-1", 4], ["reel-2", 3], ["reel-3", 4], ["reel-4", 2]] as const) {
    upsertReel({ id, title: id, description: "", frame_count: frames, price_base_units: "1000" });
  }
});

function entitlementRows(wallet: string, reel: string): number {
  return (
    getDb()
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM purchases WHERE wallet_address = ? AND reel_id = ?",
      )
      .get(wallet, reel)?.n ?? 0
  );
}

describe("paying twice for one reel keeps both payments", () => {
  it("appends to the ledger and still holds one entitlement row", () => {
    recordPurchase(BUYER, "reel-3", TX_A);
    recordPurchase(BUYER, "reel-3", TX_B);

    // The invariant: one entitlement per (wallet, reel), not two.
    expect(entitlementRows(BUYER, "reel-3")).toBe(1);
    expect(hasPurchased(BUYER, "reel-3")).toBe(true);

    // The history: two settled payments, both queryable, neither overwritten.
    const events = listPaymentsForReel(BUYER, "reel-3").filter((event) =>
      event.tx_hash === TX_A || event.tx_hash === TX_B,
    );
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.tx_hash))).toEqual(new Set([TX_A, TX_B]));
  });

  it("a third payment adds a third event and still not a second entitlement", () => {
    const TX_C = "0x" + "ab".repeat(32);
    recordPurchase(BUYER, "reel-3", TX_C);

    expect(entitlementRows(BUYER, "reel-3")).toBe(1);
    const hashes = listPaymentsForReel(BUYER, "reel-3").map((event) => event.tx_hash);
    expect(hashes).toContain(TX_C);
    expect(hashes).toContain(TX_A);
    expect(hashes).toContain(TX_B);
  });

  it("keeps history across different reels separately queryable", () => {
    const TX_D = "0x" + "cd".repeat(32);
    recordPurchase(BUYER, "reel-1", TX_D);

    expect(listPaymentsForReel(BUYER, "reel-1").map((e) => e.tx_hash)).toContain(TX_D);
    expect(listPaymentsForReel(BUYER, "reel-3").map((e) => e.tx_hash)).not.toContain(TX_D);
    // All of them, across reels, for one wallet.
    const all = listPaymentEvents(BUYER);
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(new Set(all.map((e) => e.reel_id))).toContain("reel-3");
  });

  it("marks live settlements distinctly from recovered history", () => {
    recordPurchase(BUYER, "reel-2", "0x" + "ef".repeat(32));
    const event = listPaymentsForReel(BUYER, "reel-2").at(0);
    expect(event?.source).toBe("settle");
  });
});

describe("the ledger is append-only", () => {
  it("declares no uniqueness on (wallet, reel)", () => {
    // The absence of a constraint is the design: nothing may stop a second
    // payment from being recorded for a reel the wallet already owns.
    const indexes = getDb()
      .prepare<[], { name: string; sql: string | null }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'payment_events'",
      )
      .all();
    const uniqueOnWalletAndReel = indexes.some(
      (index) => /UNIQUE/i.test(index.sql ?? "") && /wallet_address/i.test(index.sql ?? "") && /reel_id/i.test(index.sql ?? ""),
    );
    expect(uniqueOnWalletAndReel).toBe(false);
  });

  it("orders history newest first", () => {
    const events = listPaymentsForReel(BUYER, "reel-3");
    const times = events.map((event) => event.recorded_at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("finds history by any spelling of the wallet address", () => {
    for (const address of [BUYER, BUYER_LOWER, BUYER.toUpperCase().replace("0X", "0x")]) {
      expect(listPaymentEvents(address).length).toBeGreaterThan(0);
    }
  });
});

describe("entitlement stays wallet + reel scoped", () => {
  it("one reel's payments never unlock another reel", () => {
    recordPurchase(BUYER, "reel-1", "0x" + "11".repeat(32));

    expect(hasPurchased(BUYER, "reel-1")).toBe(true);
    expect(hasPurchased(BUYER, "reel-3")).toBe(true); // paid earlier in this file
    // Nothing this wallet bought for reel-1 or reel-3 unlocked reel-4, which
    // exists but was never paid for.
    expect(hasPurchased(BUYER, "reel-4")).toBe(false);
  });

  it("one wallet's payments never unlock another wallet's reel", () => {
    const stranger = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    expect(hasPurchased(stranger, "reel-3")).toBe(false);
    expect(listPaymentsForReel(stranger, "reel-3")).toEqual([]);
  });

  it("paying again does not change whether a reel is owned", () => {
    recordPurchase(BUYER, "reel-2", "0x" + "22".repeat(32));
    const first = hasPurchased(BUYER, "reel-2");
    recordPurchase(BUYER, "reel-2", "0x" + "33".repeat(32));
    expect(hasPurchased(BUYER, "reel-2")).toBe(first);
    expect(entitlementRows(BUYER, "reel-2")).toBe(1);
  });
});

describe("normalizeAddress is the single wallet identity", () => {
  it("collapses every spelling to one value", () => {
    const forms = [BUYER, BUYER_LOWER, BUYER.toUpperCase().replace("0X", "0x")];
    const normalized = new Set(forms.map(normalizeAddress));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe(getAddress(BUYER_LOWER));
  });

  it("does not conflate different accounts", () => {
    expect(normalizeAddress(BUYER)).not.toBe(
      normalizeAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
    );
  });
});
