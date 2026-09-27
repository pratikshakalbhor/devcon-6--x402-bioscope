import path from "node:path";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

/**
 * The migration, rehearsed on the live row set.
 *
 * `getDb()` runs `backfillPaymentEvents` and then `migratePurchasesToNoCase`
 * against whatever the database already contains. This builds the four-row state
 * the live database is actually in — including the two reel-3 rows that differ
 * only in address casing — and asserts that the migration keeps all four
 * transaction hashes queryable while still reducing entitlements to one row per
 * (wallet, reel).
 *
 * The seed has to be written here, at module load, against the real db path.
 * `getConfig()` memoizes DATA_DIR on first read, so re-pointing
 * `process.env.DATA_DIR` after an import does nothing; and @/lib/db must not be
 * imported before the seed exists, or getDb() would migrate an empty database
 * and this file would be testing nothing. Hence the dynamic import below.
 */
const dbPath = path.join(process.env.DATA_DIR as string, "bioscope.db");

const BUYER = "0xa801a206B4C07Fb8d94444CD8ec3FFAE78C34b10";
const TX_1 = "0x" + "f5".repeat(32);
const TX_2 = "0x" + "55".repeat(32);
const TX_3A = "0xfa48a8f8f0fad6d326cd41d5e3baff5d0bb85c189f1e415027f50176d33e9e63";
const TX_3B = "0xff35bb7197e77894d4ec5caa353049108ee327567aa67c6f300712b1508d318d";
const ALL_HASHES = [TX_1, TX_2, TX_3A, TX_3B];

const seed = new Database(dbPath);
seed.pragma("journal_mode = WAL");
seed.exec(`
  CREATE TABLE reels (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    frame_count INTEGER NOT NULL, price_base_units TEXT NOT NULL);
  CREATE TABLE purchases (
    wallet_address TEXT NOT NULL, reel_id TEXT NOT NULL REFERENCES reels(id),
    purchased_at INTEGER NOT NULL, tx_hash TEXT,
    PRIMARY KEY (wallet_address, reel_id));
  CREATE INDEX purchases_by_reel ON purchases (reel_id);
  INSERT INTO reels VALUES
    ('reel-1','One','',4,'1000'), ('reel-2','Two','',4,'1000'), ('reel-3','Three','',4,'1000');
`);
const insert = seed.prepare(
  "INSERT INTO purchases (wallet_address, reel_id, purchased_at, tx_hash) VALUES (?,?,?,?)",
);
// Exactly the live rows: reel-1, reel-2, and reel-3 twice under two casings.
insert.run(BUYER, "reel-1", 1790524758, TX_1);
insert.run(BUYER, "reel-2", 1790524856, TX_2);
insert.run(BUYER.toLowerCase(), "reel-3", 1790522846, TX_3A);
insert.run(BUYER, "reel-3", 1790524435, TX_3B);
seed.close();

// Guard: the seed must be a case-sensitive schema, or this file proves nothing.
// Checked while lib/db is still unimported, since importing it migrates.
{
  const check = new Database(dbPath, { readonly: true });
  const ddl = check
    .prepare<[], { sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='purchases'",
    )
    .get()?.sql;
  const rows = check.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM purchases").get()?.n;
  check.close();
  if (/COLLATE\s+NOCASE/i.test(ddl ?? "")) {
    throw new Error("seed database was already migrated; this file would prove nothing");
  }
  if (rows !== 4) {
    throw new Error(`expected 4 seeded purchase rows, found ${rows}`);
  }
}

// Only now, with the pre-migration rows on disk.
const dbLib = await import("@/lib/db");
const migrated = dbLib.getDb();

describe("migrating the live four-payment state", () => {
  it("keeps every one of the four transaction hashes queryable", () => {
    const hashes = new Set(
      migrated
        .prepare<[], { tx_hash: string | null }>("SELECT tx_hash FROM payment_events")
        .all()
        .map((row) => row.tx_hash),
    );
    for (const hash of ALL_HASHES) {
      expect(hashes.has(hash), `missing ${hash}`).toBe(true);
    }
    expect(hashes.size).toBe(4);
  });

  it("keeps every timestamp, not just the hashes", () => {
    const times = migrated
      .prepare<[], { recorded_at: number }>("SELECT recorded_at FROM payment_events ORDER BY recorded_at")
      .all()
      .map((row) => row.recorded_at);
    expect(times).toEqual([1790522846, 1790524435, 1790524758, 1790524856]);
  });

  it("preserves both reel-3 payments as distinct events", () => {
    const reel3 = migrated
      .prepare<[], { tx_hash: string }>(
        "SELECT tx_hash FROM payment_events WHERE reel_id = 'reel-3' ORDER BY recorded_at",
      )
      .all();
    expect(reel3).toHaveLength(2);
    expect(new Set(reel3.map((row) => row.tx_hash))).toEqual(new Set([TX_3A, TX_3B]));
  });

  it("marks the recovered rows as migrated history", () => {
    const sources = new Set(
      migrated
        .prepare<[], { source: string }>("SELECT DISTINCT source FROM payment_events")
        .all()
        .map((row) => row.source),
    );
    expect([...sources]).toEqual(["migrated"]);
  });

  it("collapses entitlements to exactly one row per (wallet, reel)", () => {
    const ent = migrated
      .prepare<[], { reel_id: string; n: number }>(
        "SELECT reel_id, COUNT(*) AS n FROM purchases GROUP BY reel_id",
      )
      .all();
    expect(ent).toHaveLength(3);
    expect(ent.every((row) => row.n === 1)).toBe(true);
  });

  it("keeps all three entitlements true after migration", () => {
    expect(dbLib.hasPurchased(BUYER, "reel-1")).toBe(true);
    expect(dbLib.hasPurchased(BUYER, "reel-2")).toBe(true);
    expect(dbLib.hasPurchased(BUYER, "reel-3")).toBe(true);
    expect(dbLib.hasPurchased(BUYER, "reel-4")).toBe(false);
  });

  it("enforces case-insensitive wallet identity in the schema", () => {
    const ddl = migrated
      .prepare<[], { sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='purchases'",
      )
      .get()?.sql;
    expect(ddl).toMatch(/wallet_address[^,]*COLLATE\s+NOCASE/i);
    // Both spellings now resolve to the same account.
    for (const form of [BUYER, BUYER.toLowerCase(), BUYER.toUpperCase().replace("0X", "0x")]) {
      expect(dbLib.hasPurchased(form, "reel-3"), form).toBe(true);
    }
  });

  it("keeps the newest reel-3 row in the entitlement index", () => {
    const row = migrated
      .prepare<[string], { tx_hash: string | null; purchased_at: number }>(
        "SELECT tx_hash, purchased_at FROM purchases WHERE wallet_address = ? AND reel_id = 'reel-3'",
      )
      .get(BUYER);
    expect(row?.tx_hash).toBe(TX_3B);
    expect(row?.purchased_at).toBe(1790524435);
  });

  it("still exposes the dropped reel-3 row through the ledger", () => {
    // The row the rebuild discards is exactly the one that must remain auditable.
    const reel3 = dbLib.listPaymentsForReel(BUYER, "reel-3");
    expect(reel3.map((e) => e.tx_hash)).toContain(TX_3A);
    expect(reel3.map((e) => e.tx_hash)).toContain(TX_3B);
  });

  it("does not re-import history when the database is reopened", () => {
    const before = migrated.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM payment_events").get()?.n;
    delete (globalThis as { __bioscopeDb?: unknown }).__bioscopeDb;
    dbLib.getDb();
    const after = (globalThis as { __bioscopeDb?: Database.Database }).__bioscopeDb
      ?.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM payment_events")
      .get()?.n;
    expect(after).toBe(before);
    expect(after).toBe(4);
  });

  it("keeps the ledger free of any uniqueness on (wallet, reel)", () => {
    const indexes = migrated
      .prepare<[], { sql: string | null }>(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='payment_events'",
      )
      .all();
    expect(
      indexes.some(
        (i) => /UNIQUE/i.test(i.sql ?? "") && /wallet_address/i.test(i.sql ?? "") && /reel_id/i.test(i.sql ?? ""),
      ),
    ).toBe(false);
  });

  it("records a new payment after migration without losing the old ones", () => {
    const TX_NEW = "0x" + "77".repeat(32);
    dbLib.recordPurchase(BUYER, "reel-3", TX_NEW);

    // Three payments for reel-3 now, all still queryable.
    const reel3 = dbLib.listPaymentsForReel(BUYER, "reel-3").map((e) => e.tx_hash);
    expect(reel3).toContain(TX_NEW);
    expect(reel3).toContain(TX_3A);
    expect(reel3).toContain(TX_3B);
    // Still one entitlement row, and still owned.
    const rows = migrated
      .prepare<[string, string], { n: number }>(
        "SELECT COUNT(*) AS n FROM purchases WHERE wallet_address = ? AND reel_id = ?",
      )
      .get(BUYER, "reel-3")?.n;
    expect(rows).toBe(1);
    expect(dbLib.hasPurchased(BUYER, "reel-3")).toBe(true);
  });
});
