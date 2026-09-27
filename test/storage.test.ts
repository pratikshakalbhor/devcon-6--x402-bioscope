import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { encode as jpegEncode } from "jpeg-js";
import { describe, expect, it, vi } from "vitest";
import { getConfig } from "@/lib/config";

/**
 * Requirement: paid frame bytes must not be reachable by any route other than
 * the ones that decided to serve them.
 *
 * Comments and intentions do not enforce that, so this file re-checks it. If
 * someone later drops a `data/reels` symlink into public/, or adds an
 * express.static, or imports a frame as a module, this goes red.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCE_DIRS = ["app", "lib", "scripts"];
const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|mp4|webm)$/i;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", ".git", "data"].includes(entry.name)) continue;
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function sourceFiles(): Promise<string[]> {
  const all: string[] = [];
  for (const dir of SOURCE_DIRS) {
    all.push(...(await walk(path.join(ROOT, dir))));
  }
  return all;
}

/**
 * Is `child` inside `parent`?
 *
 * The obvious `path.relative(parent, child).startsWith("..")` is wrong in both
 * directions, and on Windows it fails on a perfectly good layout:
 *
 *   - It returns an *absolute* path when the two are on different drives, so a
 *     repo on `D:` with `os.tmpdir()` on `C:` yields
 *     `C:\Users\...\reels` — not `..`-prefixed — and the check reports "inside"
 *     for a path that is nowhere near public/. `test/setup.ts` points DATA_DIR at
 *     a temp dir, so that is the default test layout on Windows.
 *   - `startsWith("..")` also matches a sibling literally named `..foo`, which is
 *     inside, not outside.
 *
 * So decide it structurally: relativize, and treat "cannot be expressed
 * relatively" as *outside*, which is what a different drive actually means.
 *
 * `pathToCheck` lets this be exercised against `path.win32` on any host, so the
 * Windows case is covered by a Linux CI run too.
 */
function isInside(
  parent: string,
  child: string,
  pathToCheck: path.PlatformPath = path,
): boolean {
  const relative = pathToCheck.relative(
    pathToCheck.resolve(parent),
    pathToCheck.resolve(child),
  );
  if (relative === "") return true; // the same path
  if (pathToCheck.isAbsolute(relative)) return false; // different drive/root
  if (relative === "..") return false; // the direct parent
  return !relative.startsWith(`..${pathToCheck.sep}`);
}

/** Asserts `child` is genuinely unreachable from `parent`. Fails loudly. */
function expectOutside(parent: string, child: string, label: string): void {
  expect(
    isInside(parent, child),
    `${label} (${child}) is inside ${parent} — it would be statically served`,
  ).toBe(false);
}

describe("the outside-public/ check itself", () => {
  // These pin isInside() against the two bugs that made the real assertions
  // wrong, including the Windows drive case that a Linux run would otherwise
  // never exercise.
  const win = path.win32;
  const W_PUBLIC = "D:\\bioscope dev 6\\public";

  it("treats a different drive as outside, which is the case that broke", () => {
    // What test/setup.ts + lib/config.ts actually produce on a Windows dev box:
    // the repo is on D:, os.tmpdir() is on C:.
    const temp = "C:\\Users\\dev\\AppData\\Local\\Temp\\bioscope-test-ab12cd";
    expect(isInside(W_PUBLIC, `${temp}\\reels`, win)).toBe(false);
    expect(isInside(W_PUBLIC, `${temp}\\bioscope.db`, win)).toBe(false);
  });

  it("treats the same drive, elsewhere on it, as outside", () => {
    expect(isInside(W_PUBLIC, "D:\\Temp\\bioscope-test-abc\\reels", win)).toBe(false);
  });

  it("treats a drive-letter case difference as inside, not as outside", () => {
    expect(isInside("d:\\bioscope dev 6\\public", "D:\\bioscope dev 6\\public\\x", win)).toBe(
      true,
    );
  });

  it("still detects a path that really is inside public/", () => {
    // The positive control. Without this the suite could pass with a check that
    // always answers "outside", which would be worse than no check at all.
    expect(isInside(W_PUBLIC, `${W_PUBLIC}\\reels\\reel-1\\frame-00.jpg`, win)).toBe(true);
    expect(isInside(W_PUBLIC, W_PUBLIC, win)).toBe(true);
  });

  it("is not fooled by a child segment that merely starts with dots", () => {
    // The relative form here is literally `..foo`. A naive
    // `.startsWith("..")` calls that "outside"; it is inside. This is the mirror
    // image of the drive bug — the old check was wrong in both directions.
    expect(isInside("D:\\app", "D:\\app\\..foo\\reels", win)).toBe(true);
    // And the genuinely-outside sibling of public/, which *does* start with "..",
    // must still be outside.
    expect(isInside(W_PUBLIC, "D:\\bioscope dev 6\\..public", win)).toBe(false);
  });

  it("anchors on the given parent, not on any public/ segment in the path", () => {
    // A public/ dir on an unrelated branch says nothing about this one.
    expect(isInside(W_PUBLIC, "D:\\public\\app\\public\\reels", win)).toBe(false);
    expect(isInside(W_PUBLIC, "C:\\public\\reels", win)).toBe(false);
  });

  it("works the same way on this platform's own path rules", () => {
    const pub = path.join(ROOT, "public");
    expectOutside(pub, getConfig().reelsDir, "reelsDir");
    expectOutside(pub, getConfig().dbPath, "dbPath");
    // ...and the control, natively this time.
    expect(isInside(pub, path.join(pub, "reels", "reel-1", "frame-00.jpg"))).toBe(true);
  });
});

describe("frame storage", () => {
  it("resolves data/reels outside of public/", () => {
    const { reelsDir } = getConfig();

    expect(reelsDir.split(path.sep)).not.toContain("public");
    expectOutside(path.join(ROOT, "public"), reelsDir, "reelsDir");
  });

  it("keeps public/ free of any media file", async () => {
    const entries = await walk(path.join(ROOT, "public")).catch(() => []);

    expect(entries.filter((file) => IMAGE_RE.test(file))).toEqual([]);
  });

  it("mounts no static file server over the reels directory", async () => {
    const files = await sourceFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const text = await fs.readFile(file, "utf8");
      // express.static / serve-static, and any import of a frame from data/.
      if (/express\s*\.\s*static|serveStatic|serve-static/.test(text)) {
        offenders.push(`${path.relative(ROOT, file)}: static middleware`);
      }
      if (/from\s+["'][^"']*\/data\/reels\//.test(text)) {
        offenders.push(`${path.relative(ROOT, file)}: imports a frame from data/reels`);
      }
      if (/publicPath|outputFileTracingIncludes/.test(text)) {
        offenders.push(`${path.relative(ROOT, file)}: rewrites public path resolution`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("lets only lib/frames.ts read frame bytes off disk", async () => {
    const files = await sourceFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const relative = path.relative(ROOT, file);
      if (!/\.tsx?$/.test(relative)) continue;
      // lib/frames.ts is the one module allowed to touch the frame files.
      if (relative === path.join("lib", "frames.ts")) continue;
      // The seeder legitimately creates frames; tests create fixtures.
      if (relative.startsWith(`scripts${path.sep}`)) continue;
      if (relative.startsWith(`test${path.sep}`)) continue;

      const text = await fs.readFile(file, "utf8");
      // Calling the sanctioned helpers is fine. Reading the files directly,
      // or building a path by hand, is what this guards against.
      if (/createReadStream|readFileSync|fs\.readFile|readFile\(|readdir/.test(text)) {
        offenders.push(relative);
      }
      if (/frameFileName\s*\(/.test(text)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("route surface", () => {
  it("exposes frame bytes from exactly two routes", async () => {
    const files = await walk(path.join(ROOT, "app"));
    const frameRoutes = files
      .filter((file) => /app[\\/]api[\\/]reels[\\/].*[\\/]route\.ts$/.test(file))
      .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
      .sort();

    expect(frameRoutes).toEqual([
      "app/api/reels/[id]/frames/[n]/route.ts",
      "app/api/reels/[id]/preview/route.ts",
    ]);
  });
});

/**
 * Entitlement lives on the server, in `purchases`. The browser is not a
 * place an unlocked reel may be remembered: localStorage survives logout, is
 * readable by any script on the origin, and is trivially edited. If something
 * ever cached "this wallet owns reel-2" client-side, clearing the DB row would
 * stop working while the UI still claimed access.
 */
describe("the browser does not remember what was paid for", () => {
  it("never touches localStorage, sessionStorage, or IndexedDB", async () => {
    const files = await sourceFiles();
    const offenders: string[] = [];

    for (const file of files) {
      if (!/\.tsx?$/.test(file)) continue;
      const relative = path.relative(ROOT, file);
      // This test names them in order to forbid them.
      if (relative.startsWith(`test${path.sep}`)) continue;

      const text = await fs.readFile(file, "utf8");
      if (/\b(localStorage|sessionStorage)\s*[.[]/.test(text)) {
        offenders.push(`${relative}: Web Storage`);
      }
      if (/\bindexedDB\b/.test(text)) {
        offenders.push(`${relative}: IndexedDB`);
      }
      if (/document\s*\.\s*cookie\s*=/.test(text)) {
        offenders.push(`${relative}: writes document.cookie`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("fetches every frame over the network with no-store", async () => {
    const clientFiles = [
      path.join(ROOT, "app", "reel", "[id]", "page.tsx"),
      path.join(ROOT, "lib", "x402Client.ts"),
    ];

    // Any fetch that could carry frame bytes, the session cookie, or a payment
    // header must opt out of the HTTP cache, so a shared cache or the bfcache
    // can never hold a copy that outlives the entitlement behind it.
    const mustBeNoStore = /\bfetch\((?:[^()]|\([^()]*\))*\)/g;
    const offenders: string[] = [];
    let checked = 0;

    for (const file of clientFiles) {
      const text = await fs.readFile(file, "utf8");
      for (const call of text.match(mustBeNoStore) ?? []) {
        // A POST carries its own no-replay semantics, and the /verify response
        // sets a cookie; neither is cacheable in the first place.
        if (/method:\s*"POST"/.test(call)) continue;
        checked++;
        if (!/no-store/.test(call)) {
          offenders.push(`${path.relative(ROOT, file)}: ${call.replace(/\s+/g, " ").slice(0, 70)}`);
        }
      }
    }

    // Guard against the regex quietly matching nothing.
    expect(checked).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});

/**
 * The final sweep, as executable assertions.
 *
 * Each of these is a claim that is easy to believe and easy to break by accident
 * when someone adds a directory, copies a file, or sets an env var.
 */
describe("deployment safety sweep", () => {
  it("keeps the sqlite file out of anything a static server would serve", () => {
    const { dbPath, dataDir, reelsDir } = getConfig();
    const publicDir = path.join(ROOT, "public");

    // The database holds wallet addresses, purchase rows and sign-in nonces.
    expectOutside(publicDir, dbPath, "dbPath");
    expect(dbPath.split(path.sep)).not.toContain("public");
    // ...and it lives beside the frames, which are themselves outside public/.
    expect(path.dirname(dbPath)).toBe(dataDir);
    expectOutside(publicDir, dataDir, "dataDir");
    expectOutside(publicDir, reelsDir, "reelsDir");
  });

  it("has no frame bytes duplicated anywhere under public/", async () => {
    const { reelsDir } = getConfig();

    // Put a real frame where the app keeps them, so "no copy in public/" is a
    // claim about actual bytes rather than about two empty directories.
    const dir = path.join(reelsDir, "sweep");
    await fs.mkdir(dir, { recursive: true });
    const jpeg = jpegEncode(
      { data: Buffer.alloc(8 * 8 * 3, 0x5a), width: 8, height: 8 },
      60,
    ).data;
    const frame = path.join(dir, "frame-00.jpg");
    await fs.writeFile(frame, jpeg);

    const frameHash = createHash("sha256").update(jpeg).digest("hex");
    const frameFiles = (await walk(reelsDir)).filter((file) => IMAGE_RE.test(file));
    expect(frameFiles).toContain(frame);

    // Compare by content, not by name: a renamed or re-encoded copy is still a
    // copy of something the gate is supposed to be protecting.
    const publicFiles = await walk(path.join(ROOT, "public")).catch(() => []);
    const leaked: string[] = [];
    for (const file of publicFiles) {
      const hash = createHash("sha256").update(await fs.readFile(file)).digest("hex");
      if (hash === frameHash) leaked.push(path.relative(ROOT, file));
    }

    expect(leaked).toEqual([]);
  });

  it("refuses to start when DATA_DIR is inside public/", async () => {
    // The guard is a startup failure, not a lint rule, so it has to be
    // reachable by misconfiguration. Imported dynamically against a reset
    // module registry because getConfig() memoizes on first read.
    const previous = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = "./public/frames";
      vi.resetModules();
      const { getConfig: fresh } = await import("@/lib/config");
      expect(() => fresh()).toThrow(/public/);
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previous;
      vi.resetModules();
    }
  });

  it("reads SESSION_SECRET and PAY_TO only from the environment", async () => {
    const files = (await sourceFiles()).filter((file) => /\.(ts|tsx|mjs)$/.test(file));

    for (const file of files) {
      const relative = path.relative(ROOT, file);
      if (relative.startsWith(`test${path.sep}`)) continue;
      const contents = await fs.readFile(file, "utf8");

      // A literal value is the thing to catch. Reading the variable is fine.
      expect(contents, `hardcoded PAY_TO in ${relative}`).not.toMatch(
        /PAY_TO\s*=\s*["'`]0x[a-fA-F0-9]{40}/,
      );
      expect(contents, `hardcoded SESSION_SECRET in ${relative}`).not.toMatch(
        /SESSION_SECRET\s*=\s*["'`][^"'`]+["'`]/,
      );
      // No fallback defaults: a missing secret must throw, not silently become "".
      expect(contents, `default for SESSION_SECRET in ${relative}`).not.toMatch(
        /SESSION_SECRET\s*\|\|\s*["'`]/,
      );
    }
  });

  it("never prefixes a server secret with NEXT_PUBLIC_", async () => {
    const files = await sourceFiles();
    const serverOnly = [
      "PAY_TO",
      "SESSION_SECRET",
      "FACILITATOR_URL",
      "NETWORK",
      "ASSET",
      "REEL_PRICES",
      "DATA_DIR",
    ];

    for (const file of files) {
      if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
      const contents = await fs.readFile(file, "utf8");
      for (const name of serverOnly) {
        expect(contents, `${name} in ${path.relative(ROOT, file)}`).not.toContain(
          `NEXT_PUBLIC_${name}`,
        );
      }
    }
  });
});
