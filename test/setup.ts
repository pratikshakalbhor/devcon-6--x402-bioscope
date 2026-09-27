import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runs before every test file, in that file's own module registry.
 *
 * Pointing DATA_DIR at a fresh temp directory gives each file a private sqlite
 * database and a private reels/ directory, so tests cannot see each other's
 * rows. Env has to be set here rather than in a `test.env` block because
 * lib/config.ts memoizes on first read.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bioscope-test-"));

process.env.DATA_DIR = dataDir;
process.env.PAY_TO = "0x1111111111111111111111111111111111111111";
process.env.ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
process.env.NETWORK = "base-sepolia";
process.env.FACILITATOR_URL = "https://x402.org/facilitator";
process.env.SESSION_SECRET = "test-only-secret-not-used-anywhere-else";
process.env.SESSION_TTL_SECONDS = "3600";
process.env.NONCE_TTL_SECONDS = "300";
process.env.SIWX_DOMAIN = "http://localhost:3000";

// Keep REEL_PRICES pinned so a developer's local .env cannot change test
// expectations.
delete process.env.REEL_PRICES;

export const TEST_DATA_DIR = dataDir;
