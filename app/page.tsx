import Catalogue from "./Catalogue";

export const dynamic = "force-dynamic";

/**
 * Catalogue shell. The masthead and framing are server-rendered; the grid is a
 * client component that reads /api/reels.
 *
 * Going through the public endpoint rather than querying the database here is
 * the point: the page can only ever show what the API publishes, so the
 * metadata contract and the UI cannot drift apart.
 */
export default function HomePage() {
  return (
    <>
      <div className="masthead">
        <h1>bioscope</h1>
        <span>short reels, sold one at a time</span>
      </div>
      <p className="tagline">
        The first frame is free. The rest are yours once you have paid for them, once, for that
        wallet, for that reel.
      </p>
      <Catalogue />
    </>
  );
}
