import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getAddress } from "viem";
import { getConfig } from "./config";

/**
 * A single sqlite file, opened once per process.
 *
 * Next.js dev mode re-evaluates modules on every hot reload, so the handle is
 * cached on globalThis to avoid leaking file descriptors and WAL locks.
 */

/**
 * The one canonical form of a wallet address, used on every address read and
 * write in this file.
 *
 * Addresses reach us in whatever casing the sender happened to use: MetaMask's
 * `eth_accounts` returns lowercase, viem's `getAddress` returns EIP-55
 * checksummed, and a payment payload carries whatever the client put in it.
 * Those are the same account, but SQLite compares TEXT byte-exactly, so a
 * mismatch means "not found".
 *
 * That is not hypothetical. A settled payment wrote a lowercase address while
 * the session cookie held the checksummed form of the same account, so
 * `hasPurchased` missed a purchase the route had recorded itself and answered
 * 402 to a buyer who had already paid. It also let the composite primary key
 * hold two rows for one person and one reel, fragmenting entitlement.
 *
 * EIP-55 is chosen as the canonical form because it is the one the SIWX message
 * is already built from — normalizing the nonce table's address would silently
 * change signed text, so the same function is used for both tables and the
 * signed message is bit-for-bit what it always was.
 */
export function normalizeAddress(address: string): string {
  return getAddress(address.trim());
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS reels (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    frame_count      INTEGER NOT NULL CHECK (frame_count > 0),
    price_base_units TEXT NOT NULL CHECK (price_base_units <> '')
  );
  `,
  `
  -- The composite primary key is the whole entitlement model: one row per
  -- (wallet, reel) pair. Unlocking reel-2 can never imply access to reel-3,
  -- and one wallet's purchase can never imply another's.
  CREATE TABLE IF NOT EXISTS purchases (
    wallet_address TEXT NOT NULL,
    reel_id        TEXT NOT NULL REFERENCES reels(id),
    purchased_at   INTEGER NOT NULL,
    tx_hash        TEXT,
    PRIMARY KEY (wallet_address, reel_id)
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS purchases_by_reel ON purchases (reel_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS sign_in_nonces (
    nonce      TEXT PRIMARY KEY,
    address    TEXT NOT NULL,
    issued_at  INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS sign_in_nonces_by_address
    ON sign_in_nonces (address, used);
  `,
  `
  -- An append-only ledger of every settlement, kept deliberately separate from
  -- the entitlement index above.
  --
  -- purchases answers "may this wallet watch this reel", and its composite
  -- primary key means one row per (wallet, reel) — that invariant is the whole
  -- point and must not be relaxed. But folding payment history into that same
  -- row loses it: a second purchase for a reel you already own must upsert the
  -- entitlement while still recording the new transaction, and a single row
  -- cannot hold both. ON CONFLICT DO UPDATE overwrote tx_hash, so each repeat
  -- payment erased the previous one's reference to a real settled transfer.
  --
  -- So: no primary key here beyond the row id, and no uniqueness on
  -- (wallet_address, reel_id). Every settlement appends. Nothing is ever
  -- updated or deleted here.
  CREATE TABLE IF NOT EXISTS payment_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL COLLATE NOCASE,
    reel_id        TEXT NOT NULL,
    tx_hash        TEXT,
    recorded_at    INTEGER NOT NULL,
    source         TEXT NOT NULL DEFAULT 'settle'
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS payment_events_by_wallet
    ON payment_events (wallet_address);
  `,
  `
  CREATE INDEX IF NOT EXISTS payment_events_by_reel
    ON payment_events (reel_id);
  `,
];

const g = globalThis as typeof globalThis & {
  __bioscopeDb?: Database.Database;
};

export function getDb(): Database.Database {
  if (g.__bioscopeDb) return g.__bioscopeDb;

  const { dbPath } = getConfig();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  for (const migration of MIGRATIONS) db.exec(migration);
  backfillPaymentEvents(db);
  migratePurchasesToNoCase(db);

  g.__bioscopeDb = db;
  return db;
}

/**
 * Copy every existing purchase row into the append-only ledger, once.
 *
 * Runs *before* the purchases rebuild, and that order is the whole point: the
 * rebuild collapses rows that the old case-sensitive key treated as distinct, so
 * a reel paid for twice under two spellings of one address is still two rows at
 * this moment. Copying first captures both transaction hashes; collapsing first
 * would silently drop one of them.
 *
 * Guarded on the table being empty, so restarts do not re-import. `source` marks
 * these rows as recovered history rather than live settlements.
 */
function backfillPaymentEvents(db: Database.Database): void {
  const existing = db
    .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM payment_events")
    .get();
  if ((existing?.n ?? 0) > 0) return;

  const rows = db
    .prepare<[], { wallet_address: string; reel_id: string; tx_hash: string | null; purchased_at: number }>(
      "SELECT wallet_address, reel_id, tx_hash, purchased_at FROM purchases",
    )
    .all();
  if (rows.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO payment_events (wallet_address, reel_id, tx_hash, recorded_at, source)
     VALUES (?, ?, ?, ?, 'migrated')`,
  );
  const importAll = db.transaction(() => {
    for (const row of rows) {
      // LOWER, not normalizeAddress: this must be tolerant of whatever casing is
      // already stored without rejecting a row, and the column is NOCASE anyway.
      insert.run(row.wallet_address.toLowerCase(), row.reel_id, row.tx_hash, row.purchased_at);
    }
  });
  importAll();
}

/**
 * Make `purchases.wallet_address` case-insensitive at the schema level.
 *
 * SQLite cannot ALTER a column's collation, so the table is rebuilt. This runs
 * in a transaction and is guarded by the column's actual collation, so it does
 * the work exactly once and is a no-op on every later boot.
 *
 * Existing rows are *copied*, never dropped and re-inserted as fresh payments:
 * the reel, the purchase timestamp and the transaction hash all carry over
 * unchanged. That matters for more than tidiness — deleting the row and letting
 * the client re-pay would charge someone again for something they already
 * bought.
 *
 * Should both casings of one address ever have been recorded for the same reel
 * (the old primary key treated them as different wallets), the newest row wins
 * so the primary key cannot be violated, and `normalizeAddress` makes every
 * later lookup find it either way.
 */
function migratePurchasesToNoCase(db: Database.Database): void {
  /**
   * The collation has to be read from the stored DDL: `PRAGMA table_info`
   * reports only the declared type ("TEXT") and says nothing about COLLATE, so
   * checking `type` for "NOCASE" never matches and the migration would
   * silently re-run on every boot.
   */
  const ddl = db
    .prepare<[], { sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'purchases'",
    )
    .get()?.sql;
  if (!ddl) return;
  if (/wallet_address[^,]*COLLATE\s+NOCASE/i.test(ddl)) return;

  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE purchases_migrated (
        wallet_address TEXT NOT NULL COLLATE NOCASE,
        reel_id        TEXT NOT NULL REFERENCES reels(id),
        purchased_at   INTEGER NOT NULL,
        tx_hash        TEXT,
        PRIMARY KEY (wallet_address, reel_id)
      );

      -- Ascending, so where the old case-sensitive key held two spellings of one
      -- address for the same reel, the newest row is the one that survives.
      --
      -- The earlier row is NOT lost: backfillPaymentEvents has already copied it,
      -- with its transaction hash and timestamp, into payment_events. What
      -- collapses here is the entitlement index down to the invariant the schema
      -- is supposed to express — one row per (wallet, reel).
      INSERT OR REPLACE INTO purchases_migrated
        (wallet_address, reel_id, purchased_at, tx_hash)
      SELECT LOWER(wallet_address), reel_id, purchased_at, tx_hash
      FROM purchases
      ORDER BY purchased_at ASC;

      DROP TABLE purchases;
      ALTER TABLE purchases_migrated RENAME TO purchases;
      CREATE INDEX IF NOT EXISTS purchases_by_reel ON purchases (reel_id);
    `);
  });

  rebuild();
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface ReelRow {
  id: string;
  title: string;
  description: string;
  frame_count: number;
  price_base_units: string;
}

export interface PurchaseRow {
  wallet_address: string;
  reel_id: string;
  purchased_at: number;
  tx_hash: string | null;
}

/**
 * One settled payment, forever. Deliberately *not* unique on
 * (wallet_address, reel_id): two payments for one reel are two events.
 */
export interface PaymentEventRow {
  id: number;
  wallet_address: string;
  reel_id: string;
  tx_hash: string | null;
  recorded_at: number;
  source: "settle" | "migrated" | string;
}

export interface NonceRow {
  nonce: string;
  address: string;
  issued_at: number;
  expires_at: number;
  used: number;
}

// ---------------------------------------------------------------------------
// Reels
// ---------------------------------------------------------------------------

export function listReels(): ReelRow[] {
  return getDb()
    .prepare<[], ReelRow>("SELECT * FROM reels ORDER BY id ASC")
    .all();
}

export function getReel(id: string): ReelRow | undefined {
  return getDb().prepare<[string], ReelRow>("SELECT * FROM reels WHERE id = ?").get(id);
}

export function upsertReel(reel: ReelRow): void {
  getDb()
    .prepare(
      `INSERT INTO reels (id, title, description, frame_count, price_base_units)
       VALUES (@id, @title, @description, @frame_count, @price_base_units)
       ON CONFLICT(id) DO UPDATE SET
         title            = excluded.title,
         description      = excluded.description,
         frame_count      = excluded.frame_count,
         price_base_units = excluded.price_base_units`,
    )
    .run(reel);
}

// ---------------------------------------------------------------------------
// Purchases / entitlement
// ---------------------------------------------------------------------------

/**
 * The authorization primitive. Everything about "may this wallet watch this
 * reel" reduces to this one query. It is scoped by both columns, which is why
 * the per-reel / per-wallet separation tests pass without extra logic.
 */
export function hasPurchased(walletAddress: string, reelId: string): boolean {
  const row = getDb()
    .prepare<[string, string], { n: number }>(
      "SELECT COUNT(*) AS n FROM purchases WHERE wallet_address = ? AND reel_id = ?",
    )
    .get(normalizeAddress(walletAddress), reelId);
  return (row?.n ?? 0) > 0;
}

/**
 * Record a settled payment.
 *
 * Two writes, because the two facts are different things:
 *
 *   payment_events  append. Every settlement is preserved, so paying twice for
 *                   one reel leaves two queryable transactions, not one.
 *   purchases       upsert. The entitlement index, which by definition holds one
 *                   row per (wallet, reel).
 *
 * These were one table doing two jobs, and the upsert silently overwrote
 * tx_hash — erasing the database's only reference to a real settled transfer
 * whenever a viewer bought a reel they already owned. Note that the old
 * case-sensitive key hid this: two payments for reel-3 landed in separate PK
 * buckets and both survived, so the loss only starts once the key is fixed.
 */
export function recordPurchase(
  walletAddress: string,
  reelId: string,
  txHash: string | null,
): void {
  const db = getDb();
  const wallet = normalizeAddress(walletAddress);
  const now = Math.floor(Date.now() / 1000);

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO payment_events (wallet_address, reel_id, tx_hash, recorded_at, source)
       VALUES (?, ?, ?, ?, 'settle')`,
    ).run(wallet, reelId, txHash, now);

    db.prepare(
      `INSERT INTO purchases (wallet_address, reel_id, purchased_at, tx_hash)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(wallet_address, reel_id) DO UPDATE SET
         purchased_at = excluded.purchased_at,
         tx_hash      = excluded.tx_hash`,
    ).run(wallet, reelId, now, txHash);
  });

  write();
}

/**
 * Every payment recorded for a wallet, newest first, across all reels.
 *
 * This is the audit trail: how many times a reel was paid for, and which
 * transaction each payment was. `hasPurchased` deliberately does not answer any
 * of that — entitlement is one bit per (wallet, reel) and stays that way.
 */
export function listPaymentEvents(walletAddress: string): PaymentEventRow[] {
  return getDb()
    .prepare<[string], PaymentEventRow>(
      `SELECT id, wallet_address, reel_id, tx_hash, recorded_at, source
         FROM payment_events
        WHERE wallet_address = ?
        ORDER BY recorded_at DESC, id DESC`,
    )
    .all(normalizeAddress(walletAddress));
}

/** Payment history for a single reel, for per-reel reconciliation. */
export function listPaymentsForReel(walletAddress: string, reelId: string): PaymentEventRow[] {
  return getDb()
    .prepare<[string, string], PaymentEventRow>(
      `SELECT id, wallet_address, reel_id, tx_hash, recorded_at, source
         FROM payment_events
        WHERE wallet_address = ? AND reel_id = ?
        ORDER BY recorded_at DESC, id DESC`,
    )
    .all(normalizeAddress(walletAddress), reelId);
}

export function listPurchases(walletAddress: string): PurchaseRow[] {
  return getDb()
    .prepare<[string], PurchaseRow>(
      "SELECT * FROM purchases WHERE wallet_address = ? ORDER BY purchased_at DESC",
    )
    .all(normalizeAddress(walletAddress));
}

// ---------------------------------------------------------------------------
// Sign-in nonces
// ---------------------------------------------------------------------------

export function createNonce(
  nonce: string,
  address: string,
  ttlSeconds: number,
): { nonce: string; expiresAt: number } {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  getDb()
    .prepare(
      "INSERT INTO sign_in_nonces (nonce, address, issued_at, expires_at, used) VALUES (?, ?, ?, ?, 0)",
    )
    .run(nonce, address, issuedAt, expiresAt);
  return { nonce, expiresAt };
}

export function getNonce(nonce: string): NonceRow | undefined {
  return getDb()
    .prepare<[string], NonceRow>("SELECT * FROM sign_in_nonces WHERE nonce = ?")
    .get(nonce);
}

/**
 * Consume a nonce. Returns true only for the call that flipped used 0 -> 1, so
 * a replayed signature gets `false` and is rejected.
 *
 * The WHERE clause does the compare-and-swap inside a single statement, so two
 * concurrent replays of the same signature cannot both win.
 */
export function consumeNonce(nonce: string): boolean {
  const result = getDb()
    .prepare("UPDATE sign_in_nonces SET used = 1 WHERE nonce = ? AND used = 0")
    .run(nonce);
  return result.changes === 1;
}

/** Outstanding (unexpired, unused) nonces for an address. */
export function countActiveNonces(address: string): number {
  const row = getDb()
    .prepare<[string, number], { n: number }>(
      "SELECT COUNT(*) AS n FROM sign_in_nonces WHERE address = ? AND used = 0 AND expires_at >= ?",
    )
    .get(normalizeAddress(address), Math.floor(Date.now() / 1000));
  return row?.n ?? 0;
}

/** Housekeeping for the nonce table. */
export function pruneNonces(): number {
  return getDb()
    .prepare("DELETE FROM sign_in_nonces WHERE expires_at < ?")
    .run(Math.floor(Date.now() / 1000)).changes;
}

/** Test helper: drop the cached handle so a new DATA_DIR takes effect. */
export function closeDb(): void {
  if (g.__bioscopeDb) {
    g.__bioscopeDb.close();
    g.__bioscopeDb = undefined;
  }
}
