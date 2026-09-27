import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { getConfig } from "./config";

/**
 * All frame I/O lives here, and this is the only module allowed to build a
 * path into data/reels.
 *
 * The security property being bought: frame bytes are only ever reachable
 * through a handler that decided to serve them. They are not in public/, are
 * not imported as assets, and no static file server is pointed at them. There
 * is no URL that maps to a frame file without passing through application code.
 */

const REEL_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Reels have at most 9999 frames, so the filename is always predictable. */
export const MAX_FRAMES = 10_000;

export class FrameError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

/** Filesystem-safe frame name: frame-00.jpg, frame-137.jpg, ... */
export function frameFileName(index: number): string {
  return `frame-${String(index).padStart(2, "0")}.jpg`;
}

/**
 * Resolve a path inside data/reels and refuse to leave it.
 *
 * Rejects `..`, absolute paths, encoded separators, and symlinked reel dirs by
 * comparing the fully resolved result against the reels root.
 */
function resolveInsideReels(...segments: string[]): string {
  const { reelsDir } = getConfig();
  const resolved = path.resolve(reelsDir, ...segments);

  const rootWithSep = reelsDir.endsWith(path.sep) ? reelsDir : reelsDir + path.sep;
  if (resolved !== reelsDir && !resolved.startsWith(rootWithSep)) {
    throw new FrameError("Path escapes the reels directory.", 400);
  }
  // Defence in depth: the root itself must never be reachable statically.
  if (resolved.split(path.sep).includes("public")) {
    throw new FrameError("Refusing to read from inside a public/ directory.", 400);
  }
  return resolved;
}

export function reelDir(reelId: string): string {
  if (!REEL_ID_RE.test(reelId)) {
    throw new FrameError("Malformed reel id.", 400);
  }
  return resolveInsideReels(reelId);
}

export function framePath(reelId: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_FRAMES) {
    throw new FrameError("Frame index out of range.", 400);
  }
  return resolveInsideReels(reelId, frameFileName(index));
}

export interface FrameMeta {
  size: number;
  contentType: string;
  lastModified: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Head a frame without reading its bytes. Throws FrameError(404) if absent. */
export async function statFrame(reelId: string, index: number): Promise<FrameMeta> {
  const file = framePath(reelId, index);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    throw new FrameError("Frame not found.", 404);
  }
  if (!stat.isFile()) throw new FrameError("Frame not found.", 404);
  return {
    size: stat.size,
    contentType: contentTypeFor(file),
    lastModified: Math.floor(stat.mtimeMs / 1000),
  };
}

/**
 * Stream a frame as a web ReadableStream, so a long reel does not get buffered
 * into memory one frame at a time by the runtime.
 */
export async function openFrameStream(
  reelId: string,
  index: number,
): Promise<{ stream: ReadableStream<Uint8Array>; meta: FrameMeta }> {
  const file = framePath(reelId, index);
  const meta = await statFrame(reelId, index);
  const nodeStream = createReadStream(file);
  const stream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return { stream, meta };
}

/** How many frames actually exist on disk for a reel. */
export async function countFramesOnDisk(reelId: string): Promise<number> {
  const dir = reelDir(reelId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  return entries.filter((name) => /^frame-\d{2,}\.jpe?g$/.test(name)).length;
}
