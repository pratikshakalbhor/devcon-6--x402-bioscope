"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The reel grid.
 *
 * Fetches /api/reels rather than receiving props from the server, so the page
 * renders exactly what the public endpoint publishes. If the endpoint drops a
 * field or changes a shape, the catalogue changes with it rather than drifting
 * into a second, server-only source of truth.
 *
 * Nothing here is persisted. No localStorage, no sessionStorage: `owned` is
 * re-read from the server on every visit, and the session itself lives in an
 * httpOnly cookie this code cannot see.
 */

export interface ReelMeta {
  id: string;
  title: string;
  description: string;
  frameCount: number;
  /** USDC base units, exact integer string. */
  price: string;
  priceUsd: string;
  asset: string;
  network: string;
  /** The ungated frame 0. The only frame URL the API ever emits. */
  previewUrl: string;
  /** True when the session cookie's wallet has already paid for this reel. */
  owned: boolean;
}

export default function Catalogue() {
  const [reels, setReels] = useState<ReelMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/reels", { cache: "no-store" });
        if (!response.ok) throw new Error(`Catalogue unavailable (${response.status}).`);
        const body = (await response.json()) as { reels: ReelMeta[] };
        if (!cancelled) setReels(body.reels);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="status err">{error}</p>;
  if (reels === null) return <p className="status idle">Loading reels…</p>;
  if (reels.length === 0) {
    return (
      <p className="tagline">
        No reels yet. Run <code>npm run seed</code> to generate some.
      </p>
    );
  }

  return (
    <div className="grid">
      {reels.map((reel) => (
        <article key={reel.id} className="card">
          <figure>
            {/* Public teaser. The preview route is frame 0 and is never gated. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={reel.previewUrl} alt={`First frame of ${reel.title}`} loading="lazy" />
            <span className="badge">frame 0 · free</span>
          </figure>
          <div className="body">
            <h2>{reel.title}</h2>
            <p>{reel.description}</p>
            <div className="price">
              <b>{reel.priceUsd}</b> <span>· {reel.frameCount} frames</span>
              {reel.owned ? <span className="badge">unlocked</span> : null}
            </div>
            <Link className="watch" href={`/reel/${encodeURIComponent(reel.id)}`}>
              Watch
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}
