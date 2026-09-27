import jpeg from "jpeg-js";
import fs from "node:fs";
import path from "node:path";
import { getConfig, priceForReel } from "../lib/config";
import { pruneNonces, upsertReel } from "../lib/db";

/**
 * Generates the frame images and the reels table.
 *
 * The frames are synthesized rather than downloaded so the repo stays small and
 * `npm run seed` is deterministic and offline. Each reel gets a distinct colour
 * scheme and a visible frame counter, which makes it obvious when the player is
 * actually advancing through frames.
 */

const WIDTH = 640;
const HEIGHT = 360;
const QUALITY = 82;

interface ReelSeed {
  id: string;
  title: string;
  description: string;
  frameCount: number;
  /** Base hue in degrees; the scene rotates through it across the reel. */
  hue: number;
}

const REELS: ReelSeed[] = [
  {
    id: "reel-1",
    title: "Harbour at Low Tide",
    description: "Twelve seconds of a working harbour pulling back off the flats.",
    frameCount: 24,
    hue: 205,
  },
  {
    id: "reel-2",
    title: "Neon Underpass",
    description: "Rain on concrete, long exposure, one passing headlight.",
    frameCount: 36,
    hue: 285,
  },
  {
    id: "reel-3",
    title: "Dust and Static",
    description: "A film loop shot on expired stock. Grain included, obviously.",
    frameCount: 18,
    hue: 28,
  },
];

// ---------------------------------------------------------------------------
// Tiny RGB canvas
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

class Canvas {
  readonly data: Buffer;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = Buffer.alloc(width * height * 3);
  }

  set(x: number, y: number, [r, g, b]: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
  }

  rect(x0: number, y0: number, w: number, h: number, color: Rgb, alpha = 1): void {
    for (let y = Math.floor(y0); y < y0 + h; y++) {
      for (let x = Math.floor(x0); x < x0 + w; x++) {
        if (alpha >= 1) {
          this.set(x, y, color);
        } else {
          const i = (y * this.width + x) * 3;
          const existing: Rgb = [this.data[i]!, this.data[i + 1]!, this.data[i + 2]!];
          this.set(x, y, mix(existing, color, alpha));
        }
      }
    }
  }

  /** Deterministic value noise so the grain looks the same on every seed. */
  grain(amount: number, seed: number): void {
    let s = seed >>> 0;
    for (let i = 0; i < this.data.length; i += 3) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const n = ((s >>> 16) / 65535 - 0.5) * amount;
      this.data[i] = clamp(this.data[i]! + n);
      this.data[i + 1] = clamp(this.data[i + 1]! + n);
      this.data[i + 2] = clamp(this.data[i + 2]! + n);
    }
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [clamp(a[0] + (b[0] - a[0]) * t), clamp(a[1] + (b[1] - a[1]) * t), clamp(a[2] + (b[2] - a[2]) * t)];
}

/** h in [0,360), s and l in [0,1] -> rgb */
function hsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [clamp((r1 + m) * 255), clamp((g1 + m) * 255), clamp((b1 + m) * 255)];
}

// ---------------------------------------------------------------------------
// 7-segment digits, so the frame index is readable in the rendered image
// ---------------------------------------------------------------------------

const DIGIT_SEGMENTS: Record<number, number> = {
  0: 0b0111111,
  1: 0b0000110,
  2: 0b1011011,
  3: 0b1001111,
  4: 0b1100110,
  5: 0b1101101,
  6: 0b1111101,
  7: 0b0000111,
  8: 0b1111111,
  9: 0b1101111,
};

function drawDigit(c: Canvas, digit: number, x: number, y: number, size: number, color: Rgb): void {
  const on = DIGIT_SEGMENTS[digit] ?? 0;
  const t = Math.max(2, Math.round(size * 0.16));
  const w = size;
  const h = size * 2;
  const half = h / 2;

  if (on & 0b0000001) c.rect(x, y, w, t, color); // a
  if (on & 0b0000010) c.rect(x + w - t, y, t, half - t, color); // b
  if (on & 0b0000100) c.rect(x + w - t, y + half, t, half - t, color); // c
  if (on & 0b0001000) c.rect(x, y + h - t, w, t, color); // d
  if (on & 0b0010000) c.rect(x, y + half, t, half - t, color); // e
  if (on & 0b0100000) c.rect(x, y, t, half - t, color); // f
  if (on & 0b1000000) c.rect(x, y + half - t / 2, w, t, color); // g
}

function drawNumber(c: Canvas, value: number, x: number, y: number, size: number, color: Rgb): void {
  const text = String(value).padStart(2, "0");
  const advance = size + Math.round(size * 0.35);
  for (const ch of text) {
    drawDigit(c, Number(ch), x, y, size, color);
    x += advance;
  }
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

function drawFrame(reel: ReelSeed, index: number, total: number): Buffer {
  const canvas = new Canvas(WIDTH, HEIGHT);
  const t = total <= 1 ? 0 : index / (total - 1);
  const hue = (reel.hue + t * 40) % 360;

  // Sky / backdrop gradient.
  for (let y = 0; y < HEIGHT; y++) {
    const v = y / HEIGHT;
    const color = hsl(hue, 0.55, 0.12 + v * 0.42);
    for (let x = 0; x < WIDTH; x++) canvas.set(x, y, color);
  }

  // A sweeping band, so consecutive frames are visibly different.
  const bandX = Math.round(t * (WIDTH - 120));
  canvas.rect(bandX, 0, 120, HEIGHT, hsl(hue + 180, 0.7, 0.55), 0.18);

  // Horizon.
  const horizon = Math.round(HEIGHT * 0.62);
  canvas.rect(0, horizon, WIDTH, HEIGHT - horizon, hsl(hue + 20, 0.35, 0.09));

  // Orbiting marker: a clear indicator of playback position.
  const angle = t * Math.PI * 2;
  const cx = WIDTH / 2 + Math.cos(angle) * (WIDTH * 0.3);
  const cy = HEIGHT / 2 + Math.sin(angle) * (HEIGHT * 0.22);
  canvas.rect(cx - 26, cy - 26, 52, 52, hsl(hue + 150, 0.85, 0.62));

  // Progress bar.
  canvas.rect(40, HEIGHT - 34, WIDTH - 80, 6, [255, 255, 255], 0.18);
  canvas.rect(40, HEIGHT - 34, Math.round((WIDTH - 80) * t), 6, hsl(hue + 150, 0.85, 0.7));

  // Frame counter + reel id, baked into the pixels.
  const ink = hsl(hue, 0.15, 0.95);
  drawNumber(canvas, index, 40, 36, 22, ink);
  canvas.rect(40, 96, 132, 4, ink);

  canvas.grain(reel.id === "reel-3" ? 46 : 16, index * 2654435761 + reel.hue);

  return jpeg.encode({ data: canvas.data, width: WIDTH, height: HEIGHT }, QUALITY).data;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

function main(): void {
  const config = getConfig();

  if (config.reelsDir.split(path.sep).includes("public")) {
    throw new Error(
      `Refusing to seed: ${config.reelsDir} is inside a public/ directory. ` +
        `Frames would become publicly fetchable without payment.`,
    );
  }

  for (const reel of REELS) {
    const dir = path.join(config.reelsDir, reel.id);
    fs.mkdirSync(dir, { recursive: true });

    for (let i = 0; i < reel.frameCount; i++) {
      const file = path.join(dir, `frame-${String(i).padStart(2, "0")}.jpg`);
      fs.writeFileSync(file, drawFrame(reel, i, reel.frameCount));
    }

    // The price column is written from the server-side price map, never from
    // anything a request could influence.
    upsertReel({
      id: reel.id,
      title: reel.title,
      description: reel.description,
      frame_count: reel.frameCount,
      price_base_units: priceForReel(reel.id),
    });

    console.log(
      `  ${reel.id}  ${String(reel.frameCount).padStart(3)} frames  ` +
        `${priceForReel(reel.id).padStart(7)} base units  -> ${path.relative(process.cwd(), dir)}`,
    );
  }

  const pruned = pruneNonces();
  console.log(`\nSeeded ${REELS.length} reels. Pruned ${pruned} expired nonce(s).`);
  console.log(`Database:  ${path.relative(process.cwd(), config.dbPath)}`);
  console.log(`Frames:    ${path.relative(process.cwd(), config.reelsDir)} (outside public/)`);
}

main();
