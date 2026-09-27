"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  connectWallet,
  connectedAccount,
  connectedAccounts,
  fetchPaid,
  hasInjectedWallet,
  signInWithX,
  watchWallet,
} from "@/lib/x402Client";
import { deriveSteps, type StepAction } from "./steps";
import { DISCONNECTED, phase, sameAccount, walletReducer } from "./state";

export const dynamic = "force-dynamic";

/**
 * The player.
 *
 * Four states, in order, and the UI will not let you skip ahead:
 *
 *   disconnected -> connect wallet        (window.ethereum)
 *   connected    -> sign in                (SIWX: nonce + personal_sign -> cookie)
 *   signed in    -> unlock                 (x402: 402 challenge -> EIP-3009 -> retry)
 *   unlocked     -> play                   (frames stream in, gated route, now free)
 *
 * The session cookie is what carries identity between the sign-in and the
 * unlock; without it the gated route answers 401 even if a payment were offered.
 */

interface ReelMeta {
  id: string;
  title: string;
  description: string;
  frameCount: number;
  price: string;
  priceUsd: string;
  asset: string;
  network: string;
}

const FPS = 12;

function frameUrl(id: string, n: number): string {
  return `/api/reels/${encodeURIComponent(id)}/frames/${n}`;
}

export default function PlayerPage({ params }: { params: Promise<{ id: string }> }) {
  // Client component: unwrap the route param with use() rather than making the
  // page async, so the wallet UI stays a plain client component.
  const { id: routeId } = use(params);

  const [reel, setReel] = useState<ReelMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * Wallet identity and everything derived from it, as one reducer.
   *
   * These were four independent `useState` calls, and nothing reset them
   * together: the wallet could stop authorizing the account in MetaMask and the
   * UI would keep rendering signed-in and unlocked. One reducer means a
   * disconnect is a single atomic transition to a state that is, by
   * construction, "no wallet, no session, no entitlement, nothing playing".
   */
  const [state, dispatch] = useReducer(walletReducer, DISCONNECTED);
  const { address, signedIn, unlocked, entitlement, checking, busy, frameCursor, playing } = state;
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "err"; text: string }>({
    kind: "idle",
    text: "Frame 0 is free. Connect a wallet to watch the rest.",
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stopRef = useRef(false);
  /** Set when playback should begin as soon as the reel is unlocked. */
  const autoPlayRef = useRef(false);
  /**
   * Latest identity, readable from the wallet event listener.
   *
   * The listener is installed once and must not re-subscribe on every render
   * (that drops events mid-flight), so it cannot close over `address` directly
   * and would act on mount-time values. This ref is written on every render, so
   * the handler always compares against what is true now.
   */
  const identityRef = useRef({ address, signedIn });
  useEffect(() => {
    identityRef.current = { address, signedIn };
  });
  /**
   * The reel this component is currently showing. A probe compares the reel it
   * was started for against this, so an answer that arrives after a navigation
   * is discarded instead of being applied to the wrong reel.
   */
  const reelIdRef = useRef(routeId);
  useEffect(() => {
    reelIdRef.current = routeId;
  });

  /**
   * Clear the previous reel's verdict the moment the route changes.
   *
   * `unlocked` and `entitlement` describe one reel. This component is reused
   * across `/reel/<id>` navigations, so without this the new reel would render
   * with the old reel's PAID state until its own probe came back. The reset is
   * local state only: it hides nothing, because the frame route re-checks
   * entitlement on every request regardless.
   */
  useEffect(() => {
    stopRef.current = true;
    autoPlayRef.current = false;
    dispatch({ type: "reelChanged" });
  }, [routeId]);

  /**
   * Ask the server whether this wallet already owns the reel, by asking for
   * frame 1 and reading the status code.
   *
   *   200 -> a purchase row exists, so this is a returning viewer. No payment
   *          is offered and none is needed.
   *   402 -> no purchase yet; the body is the challenge the Unlock button uses.
   *   401 -> the cookie is gone or expired; re-run sign-in.
   *
   * The browser is not told the answer and does not remember it: the probe is a
   * real request to the gate, and every later frame is re-checked the same way.
   *
   * Called from the two points where identity becomes known — a live cookie on
   * arrival, and a completed sign-in — rather than from an effect, so there is
   * exactly one probe per arrival and no re-probe loop.
   */
  const probeEntitlement = useCallback(async (reelId: string, wallet: string) => {
    dispatch({ type: "checking" });
    try {
      const response = await fetch(frameUrl(reelId, 1), { cache: "no-store" });

      /**
       * A probe's answer describes exactly one (wallet, reel) pair, and this
       * component outlives a navigation: the App Router reuses this instance when
       * the route changes from one reel id to another, so `unlocked` and
       * `entitlement` are still holding the previous reel's verdict.
       *
       * Both guards below are load-bearing. Without the reel check, a reel-1
       * probe that lands after navigating to reel-3 marks reel-3 paid — the UI
       * then shows PAID for a reel the server has never heard of, which is the
       * exact class of lie the frame route exists to prevent. Without the
       * account check, the same thing happens across accounts.
       *
       * The server is unaffected either way: it re-derives entitlement per
       * request. This only stops the client from displaying a verdict that
       * belongs to something else.
       */
      if (reelIdRef.current !== reelId) return;
      const current = await connectedAccount();
      if (!sameAccount(current, wallet)) return;

      if (response.status === 200) {
        dispatch({ type: "entitlement", entitlement: "owned" });
        setStatus({ kind: "ok", text: "Already unlocked for this wallet. Press play." });
        return;
      }
      if (response.status === 402) {
        dispatch({ type: "entitlement", entitlement: "unowned" });
        setStatus({ kind: "idle", text: "Not unlocked yet for this wallet." });
        return;
      }
      if (response.status === 401) {
        // The cookie is gone or expired: the viewer is no longer authenticated,
        // so drop the session rather than leave them looking signed in.
        dispatch({ type: "entitlement", entitlement: "unknown" });
        setStatus({ kind: "err", text: "Session expired. Sign in again." });
        return;
      }
      dispatch({ type: "entitlement", entitlement: "unknown" });
    } catch {
      dispatch({ type: "entitlement", entitlement: "unknown" });
    }
  }, []);


  // The catalogue is the only public metadata source; it carries no frame paths.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/reels", { cache: "no-store" });
        if (!response.ok) throw new Error(`Catalogue unavailable (${response.status}).`);
        const body = (await response.json()) as {
          reels: ReelMeta[];
          address: string | null;
        };
        const wanted =
          body.reels.find((candidate) => candidate.id === routeId) ?? null;
        if (cancelled) return;
        if (!wanted) {
          setLoadError(`No reel with id "${routeId}".`);
          return;
        }
        setReel(wanted);

        /**
         * The wallet decides whether we are connected; the cookie only decides
         * whether this *account* is signed in.
         *
         * Reading the cookie and calling that "connected" is the bug: a stale
         * cookie outlives a wallet disconnect, so the page would rehydrate a
         * signed-in, unlocked UI for an account the wallet had withdrawn. Now
         * an absent wallet stays disconnected no matter what the cookie says,
         * and a cookie for a different account is not treated as this
         * viewer's session.
         */
        const live = await connectedAccount();
        if (cancelled) return;
        if (!live) return;

        if (body.address && sameAccount(body.address, live)) {
          dispatch({ type: "resume", address: live, signedIn: true });
          void probeEntitlement(wanted.id, live);
        } else {
          // Connected, but not authenticated for this account. Either no session
          // at all, or a session left over from a different account; that one is
          // not ours to use.
          dispatch({ type: "resume", address: live, signedIn: false });
        }
      } catch (error) {
        if (!cancelled) setLoadError((error as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId, probeEntitlement]);

  const onConnect = useCallback(async () => {
    dispatch({ type: "busy", busy: "connect" });
    try {
      const account = await connectWallet();
      dispatch({ type: "connect", address: account });
      setStatus({ kind: "ok", text: "Wallet connected. Now sign in." });
    } catch (error) {
      dispatch({ type: "busy", busy: null });
      setStatus({ kind: "err", text: (error as Error).message });
    }
  }, []);

  /**
   * Forget everything, in the app and on the server.
   *
   * The reducer handles the client half. The server half matters just as much:
   * the session cookie is HttpOnly, so page JavaScript cannot clear it, and a
   * cookie left behind is exactly what rehydrates a signed-in, unlocked UI on
   * the next load. `POST /api/auth/logout` expires it with the same attributes
   * it was set with, so the browser really drops it.
   */
  const reset = useCallback(async (text: string) => {
    // Stop playback first: a frame loop must not outlive the identity it was
    // fetching under, or the next account sees the old reel's frames.
    stopRef.current = true;
    autoPlayRef.current = false;
    dispatch({ type: "disconnect" });
    setStatus({ kind: "idle", text });
    try {
      await fetch("/api/auth/logout", { method: "POST", cache: "no-store" });
    } catch {
      // A failed logout must not strand the UI. The client state is already
      // clear, and if the cookie survived, the next load re-checks it against
      // the wallet's actual account rather than trusting it.
    }
  }, []);

  const onDisconnect = useCallback(() => {
    void reset("Disconnected. Connect a wallet to start again.");
  }, [reset]);

  /**
   * Follow the wallet.
   *
   * This subscription is the missing link in the chain that produced the
   * 4100: MetaMask withdrew authorization, nothing listened, and the page went
   * on to sign with the retired account. Re-read the account list on every
   * `accountsChanged`/`chainChanged` and let the reducer decide what it means —
   * empty means disconnect, different means a different viewer.
   */
  useEffect(() => {
    const handle = async () => {
      const list = await connectedAccounts();

      if (list.length === 0) {
        // The wallet disconnected or locked. The cookie (if any) is stale by
        // definition, so drop it too, or a refresh would restore the session.
        await reset("Wallet disconnected. Connect again to continue.");
        return;
      }

      const next = list[0];
      const { address: current, signedIn: wasSignedIn } = identityRef.current;

      if (wasSignedIn && !sameAccount(current, next)) {
        // Switched to another account: nothing signed in survives, and the
        // cookie belongs to the old account, so it goes with it. Dispatch the
        // switch so the address updates, then drop the session.
        dispatch({ type: "accountsChanged", accounts: list });
        await reset("Account changed. Sign in with the new account.");
        return;
      }

      dispatch({ type: "accountsChanged", accounts: list });
      if (!current) {
        setStatus({ kind: "ok", text: "Wallet connected. Now sign in." });
      } else if (!sameAccount(current, next)) {
        setStatus({ kind: "idle", text: `Using ${next}. Sign in to continue.` });
      }
    };

    void handle();
    return watchWallet(() => {
      void handle();
    });
  }, [reset]);

  const onSignIn = useCallback(async () => {
    if (!address || !reel) return;
    dispatch({ type: "busy", busy: "signin" });
    // Sign the account the wallet currently authorizes, not a remembered one.
    // If they disagree the session would be bound to the wrong identity.
    const live = await connectedAccount();
    if (!sameAccount(live, address)) {
      dispatch({ type: "busy", busy: null });
      setStatus({ kind: "err", text: "Account changed. Reconnect and try again." });
      return;
    }
    try {
      await signInWithX(address);
      dispatch({ type: "signin" });
      setStatus({ kind: "ok", text: "Signed in. Checking what you already have…" });
      // Same question as the returning-viewer path: what does this wallet own?
      void probeEntitlement(reel.id, address);
    } catch (error) {
      dispatch({ type: "busy", busy: null });
      setStatus({ kind: "err", text: (error as Error).message });
    }
  }, [address, reel, probeEntitlement]);

  /**
   * Unlock by fetching frame 1. That single request runs the whole protocol:
   * 402 -> sign -> settle -> 200, and the server records the entitlement for
   * this wallet. Every later frame is then served without payment.
   */
  const onUnlock = useCallback(async () => {
    if (!address || !reel) return;
    dispatch({ type: "busy", busy: "unlock" });
    setStatus({ kind: "idle", text: "Waiting for payment confirmation…" });
    try {
      // fetchPaid re-checks the address against the wallet's live account
      // before it signs, so a switch during the flow fails loudly instead of
      // spending the wrong account's USDC.
      const { transaction } = await fetchPaid(frameUrl(reel.id, 1), address);
      dispatch({ type: "unlocked" });
      setStatus({
        kind: "ok",
        text: transaction
          ? `Unlocked. Settled in ${transaction.slice(0, 10)}…`
          : "Unlocked.",
      });
      // The retried request came back 200, so start playing straight away.
      autoPlayRef.current = true;
    } catch (error) {
      dispatch({ type: "busy", busy: null });
      setStatus({ kind: "err", text: (error as Error).message });
    }
  }, [address, reel]);

  /**
   * Playback walks the frame indices one at a time through the gated route.
   * Because the purchase is recorded, these are all plain 200s — but they still
   * go through the same handler, so a revoked or absent entitlement stops the
   * reel rather than silently serving bytes.
   */
  const onPlay = useCallback(async () => {
    if (!address || !reel) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    stopRef.current = false;
    dispatch({ type: "playing", playing: true });
    setStatus({ kind: "idle", text: "Playing…" });

    for (let n = 0; n < reel.frameCount; n++) {
      if (stopRef.current) break;
      try {
        const url = n === 0 ? `/api/reels/${reel.id}/preview` : frameUrl(reel.id, n);
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          setStatus({ kind: "err", text: `Frame ${n} unavailable (${response.status}).` });
          break;
        }
        const bitmap = await createImageBitmap(await response.blob());
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        dispatch({ type: "frame", cursor: n });
      } catch (error) {
        setStatus({ kind: "err", text: (error as Error).message });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 / FPS));
    }

    dispatch({ type: "playing", playing: false });
    setStatus((prev) =>
      prev.kind === "err" ? prev : { kind: "ok", text: "Reel finished." },
    );
  }, [address, reel]);

  const onStop = useCallback(() => {
    stopRef.current = true;
    dispatch({ type: "playing", playing: false });
  }, []);

  // A payment or a returning entitlement both land here; start playing either way.
  useEffect(() => {
    if (!unlocked || !autoPlayRef.current) return;
    autoPlayRef.current = false;
    void onPlay();
  }, [unlocked, onPlay]);

  if (loadError) {
    return (
      <>
        <Link className="back" href="/">
          &larr; all reels
        </Link>
        <p className="status err">{loadError}</p>
      </>
    );
  }

  if (!reel) {
    return (
      <>
        <Link className="back" href="/">
          &larr; all reels
        </Link>
        <p className="status idle">Loading…</p>
      </>
    );
  }

  const walletPresent = hasInjectedWallet();

  // Gating lives in ./steps so it can be tested without a DOM. The handlers and
  // this map are kept in step by index: 0 connect, 1 sign in, 2 unlock, 3 play.
  const [connect, signIn, unlock, play] = deriveSteps({
    address,
    signedIn,
    unlocked,
    entitlement,
    checking,
    busy,
    playing,
    walletPresent,
    priceUsd: reel.priceUsd,
  });

  // Keyed by each step's own action, so a step can never be rendered next to
  // the wrong handler. `stop` is the play step's other face.
  const handlers: Record<StepAction, () => void> = {
    connect: onConnect,
    signin: onSignIn,
    unlock: onUnlock,
    play: onPlay,
    stop: onStop,
  };

  return (
    <div className="player">
      <Link className="back" href="/">
        &larr; all reels
      </Link>

      <div className="screen">
        <canvas ref={canvasRef} width={640} height={360} />
        <span className="placeholder" style={{ display: playing ? "none" : undefined }}>
          {unlocked ? "Unlocked — press play." : "Frame 0 is the free preview. Press play to see it."}
        </span>
      </div>

      <div className="panel">
        <h1>{reel.title}</h1>
        <p className="meta">
          {reel.description} · {reel.frameCount} frames · {reel.priceUsd} on{" "}
          {reel.network}
        </p>

        <div className="steps">
          <button
            onClick={handlers[connect.action]}
            disabled={connect.disabled}
            className={connect.primary ? "primary" : undefined}
          >
            {connect.label}
          </button>
          <button
            onClick={handlers[signIn.action]}
            disabled={signIn.disabled}
            className={signIn.primary ? "primary" : undefined}
          >
            {signIn.label}
          </button>
          <button
            onClick={handlers[unlock.action]}
            disabled={unlock.disabled}
            className={unlock.primary ? "primary" : undefined}
          >
            {unlock.label}
          </button>
          <button
            onClick={handlers[play.action]}
            disabled={play.disabled}
            className={play.primary ? "primary" : undefined}
          >
            {play.label}
          </button>
        </div>

        <p className={`status ${status.kind}`}>{status.text}</p>

        {/*
          Present whenever a wallet is connected, so the user is never stuck in a
          state they cannot leave. The state reset happens in reset(); this only
          exposes it.
        */}
        {address && (
          <button onClick={onDisconnect} disabled={busy !== null} className="disconnect">
            Disconnect
          </button>
        )}

        {!walletPresent && (
          <p className="status err">
            No injected wallet detected. Install one, or drive the API directly with
            <code> x402-fetch</code>.
          </p>
        )}

        {address && (
          <p className="mono">
            {address}
            <span className="phase"> {phase(state)}</span>
            {frameCursor > 0 && unlocked ? ` · frame ${frameCursor}/${reel.frameCount - 1}` : null}
          </p>
        )}
      </div>
    </div>
  );
}
