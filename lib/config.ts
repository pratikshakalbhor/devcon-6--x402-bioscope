import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { z } from "zod";

// `quiet` keeps dotenv from printing a banner into test output. Values already
// present in process.env win, which is how the test setup injects its own.
loadDotenv({ quiet: true });

/**
 * Every value in this module is server-side. Nothing here is prefixed with
 * NEXT_PUBLIC_, so none of it is inlined into the client bundle by Next.js.
 *
 * The single most important rule enforced here: a price is NEVER derived from
 * a request. `priceForReel` is the only price source in the app, and it reads
 * a server-owned map. If a client sends a price, it is ignored.
 */

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Network shorthands people actually type in .env, mapped to the CAIP-2 form
 * that the x402 wire format requires.
 */
const NETWORK_ALIASES: Record<string, string> = {
  "base-sepolia": "eip155:84532",
  basesepolia: "eip155:84532",
  "84532": "eip155:84532",
  base: "eip155:8453",
  "8453": "eip155:8453",
};

export const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";

/** USDC has 6 decimals on every network we target. */
export const ASSET_DECIMALS = 6;

/**
 * Server-owned price map, in USDC base units (6 decimals) as decimal strings.
 * Scripts/seed.ts writes these into the reels table; the gate reads them back
 * from the DB. `priceForReel` below is the join between the two.
 */
const DEFAULT_REEL_PRICES: Readonly<Record<string, string>> = {
  "reel-1": "10000", // 0.01 USDC
  "reel-2": "25000", // 0.025 USDC
  "reel-3": "5000", // 0.005 USDC
};

const EnvSchema = z.object({
  PAY_TO: z.string().regex(ADDRESS_RE, "PAY_TO must be a 20-byte hex address"),
  FACILITATOR_URL: z.string().url().default(DEFAULT_FACILITATOR_URL),
  NETWORK: z.string().min(1).default("base-sepolia"),
  ASSET: z.string().regex(ADDRESS_RE, "ASSET must be a 20-byte hex address"),
  SESSION_SECRET: z
    .string()
    .min(16, "SESSION_SECRET must be at least 16 characters"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  NONCE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SIWX_DOMAIN: z.string().min(1).default("http://localhost:3000"),
  /** Base for the `resource` in payment requirements. Defaults to SIWX_DOMAIN. */
  APP_ORIGIN: z.string().url().optional(),
  DATA_DIR: z.string().min(1).default("./data"),
  REEL_PRICES: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  /** Address that receives x402 payments. */
  payTo: `0x${string}`;
  facilitatorUrl: string;
  /** CAIP-2, e.g. "eip155:84532". */
  network: string;
  /** Token contract payments are denominated in. */
  asset: `0x${string}`;
  assetDecimals: number;
  sessionSecret: string;
  sessionTtlSeconds: number;
  nonceTtlSeconds: number;
  siwxDomain: string;
  /**
   * Absolute origin used to build the `resource` field of a payment
   * requirement. Server-controlled on purpose: deriving it from the incoming
   * request would let a spoofed Host header influence what a payment is bound
   * to. Defaults to SIWX_DOMAIN so there is no second thing to configure.
   */
  publicOrigin: string;
  /** Absolute path to the directory holding frame images + the sqlite file. */
  dataDir: string;
  /** Absolute path to data/reels. Never inside public/. */
  reelsDir: string;
  /** Absolute path to the sqlite file. */
  dbPath: string;
  /** Price map in USDC base units, keyed by reel id. */
  reelPrices: Readonly<Record<string, string>>;
}

function normalizeNetwork(raw: string): string {
  const value = raw.trim();
  if (/^eip155:\d+$/.test(value)) return value;
  const aliased = NETWORK_ALIASES[value.toLowerCase()];
  if (aliased) return aliased;
  throw new Error(
    `NETWORK "${raw}" is not a CAIP-2 id (eip155:<chainId>) or a known alias ` +
      `(${[...new Set(Object.keys(NETWORK_ALIASES))].join(", ")}).`,
  );
}

function parseReelPrices(raw: string | undefined): Record<string, string> {
  if (!raw) return { ...DEFAULT_REEL_PRICES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("REEL_PRICES must be valid JSON: an object of reelId -> price string.");
  }
  const MapSchema = z.record(
    z.string().min(1),
    z
      .string()
      .regex(/^\d+$/, "prices are non-negative integers in base units, as a string"),
  );
  return { ...DEFAULT_REEL_PRICES, ...MapSchema.parse(parsed) };
}

function build(): Config {
  const env = EnvSchema.parse(process.env);
  const dataDir = path.resolve(process.cwd(), env.DATA_DIR);
  const reelsDir = path.join(dataDir, "reels");
  const dbPath = path.join(dataDir, "bioscope.db");

  // Structural guarantees, not conventions. Anything under DATA_DIR — the frame
  // images *and* the sqlite file, which holds wallet addresses, purchase rows
  // and nonces — must sit somewhere a static file server or Next.js `public/`
  // handler cannot reach. `data/` is outside `public/`, so Next never serves it;
  // the check is here so that a misconfigured DATA_DIR fails loudly at startup
  // rather than quietly publishing paid bytes or a database.
  for (const [label, target] of [
    ["DATA_DIR", dataDir],
    ["the reels directory", reelsDir],
    ["the sqlite file", dbPath],
  ] as const) {
    if (target.split(path.sep).includes("public")) {
      throw new Error(
        `Refusing to start: ${label} resolves to ${target}, which is inside a ` +
          `public/ directory. Frames, purchases and nonces must never be ` +
          `statically served. Move DATA_DIR outside public/.`,
      );
    }
  }

  return {
    payTo: env.PAY_TO as `0x${string}`,
    facilitatorUrl: env.FACILITATOR_URL,
    network: normalizeNetwork(env.NETWORK),
    asset: env.ASSET as `0x${string}`,
    assetDecimals: ASSET_DECIMALS,
    sessionSecret: env.SESSION_SECRET,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    nonceTtlSeconds: env.NONCE_TTL_SECONDS,
    siwxDomain: env.SIWX_DOMAIN.replace(/\/+$/, ""),
    publicOrigin: (env.APP_ORIGIN ?? env.SIWX_DOMAIN).replace(/\/+$/, ""),
    dataDir,
    reelsDir,
    dbPath,
    reelPrices: parseReelPrices(env.REEL_PRICES),
  };
}

let cached: Config | undefined;

/**
 * Lazily built and memoized so that a missing SESSION_SECRET only throws when
 * something actually needs config (i.e. at request time, with a real message)
 * rather than at import time.
 */
export function getConfig(): Config {
  if (!cached) cached = build();
  return cached;
}

/**
 * The one and only price lookup. Takes a reel id and nothing else — there is no
 * code path that lets a caller supply an amount, which is what makes "price
 * comes from the server" true by construction rather than by discipline.
 */
export function priceForReel(reelId: string): string {
  const price = getConfig().reelPrices[reelId];
  if (price === undefined) {
    throw new Error(`No server-side price configured for reel "${reelId}".`);
  }
  return price;
}

export function formatUsd(baseUnits: string, decimals = ASSET_DECIMALS): string {
  const value = BigInt(baseUnits);
  const whole = value / 10n ** BigInt(decimals);
  const frac = (value % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
  return `$${whole}.${frac}`;
}
