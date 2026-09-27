/**
 * The player state machine, as one pure reducer.
 *
 * The bug this exists to fix: identity lived in four independent pieces of
 * `useState` — `address`, `signedIn`, `unlocked`, `entitlement` — and only some
 * of them were ever cleared. Disconnecting the wallet in MetaMask fired no
 * event the page was listening for, so a signed-in, unlocked-looking UI survived
 * a disconnect, a refresh rehydrated it from the session cookie, and the next
 * signature request was made with an account the wallet had stopped
 * authorizing (EIP-1193 4100). Several states were set independently, so any
 * path that cleared some but not all left a combination that should have been
 * impossible.
 *
 * A reducer fixes the class of bug rather than the instance: a transition is one
 * function, and a transition either produces a consistent state or does not
 * exist. Notably, "the wallet's account changed" and "the user disconnected" are
 * the *same* transition here, because from the app's point of truth they are.
 *
 * Note on `unlocked`: it is a cache of a server answer (the gated route
 * returned 200, or a purchase row was found), not an authority. Every paid frame
 * is still re-checked by the server, so believing this flag only affects which
 * button is highlighted, never whether bytes are served.
 */

import type { Busy, Entitlement } from "./steps";

export interface WalletState {
  /** A hex address. Kept typed so it cannot be passed where a signer is expected. */
  address: `0x${string}` | null;
  signedIn: boolean;
  unlocked: boolean;
  entitlement: Entitlement;
  checking: boolean;
  busy: Busy;
  playing: boolean;
  frameCursor: number;
}

/** The only state reachable with no wallet. Everything else builds on a connection. */
export const DISCONNECTED: WalletState = {
  address: null,
  signedIn: false,
  unlocked: false,
  entitlement: "unknown",
  checking: false,
  busy: null,
  playing: false,
  frameCursor: 0,
};

export type WalletEvent =
  /** A wallet was connected and the user approved the prompt. */
  | { type: "connect"; address: `0x${string}` }
  /** A probe of the gated route started. */
  | { type: "checking" }
  /** The gate answered: owned, not owned, or 401 (session gone). */
  | { type: "entitlement"; entitlement: Entitlement }
  /** SIWX completed and the server issued a session cookie. */
  | { type: "signin" }
  /** Payment settled, or a purchase row was found for this wallet. */
  | { type: "unlocked" }
  /** A request started or finished. */
  | { type: "busy"; busy: Busy }
  | { type: "playing"; playing: boolean }
  | { type: "frame"; cursor: number }
  /** The user disconnected on purpose, in the app. */
  | { type: "disconnect" }
  /**
   * The route moved to a different reel. Entitlement and payment state describe
   * one (wallet, reel) pair, so a new reel starts with none of the old reel's
   * verdict. The address and session are per-wallet, not per-reel, and survive.
   */
  | { type: "reelChanged" }
  /**
   * MetaMask told us the authorized account list changed — on disconnect, on
   * lock, or on switching to a different account. All three are handled here so
   * the page cannot be left asserting an identity the wallet has withdrawn.
   */
  | { type: "accountsChanged"; accounts: `0x${string}`[] }
  /**
   * Arrived with a wallet already connected and a live session. Only applied
   * when the session's address is the wallet's current account; a session for a
   * different account is not this viewer's session.
   */
  | { type: "resume"; address: `0x${string}`; signedIn: boolean };

/**
 * True when two addresses are the same account, ignoring EIP-55 casing.
 *
 * Accepts undefined so callers can pass a possibly-absent entry straight out of
 * an index access rather than widening their own types to accommodate it.
 */
export function sameAccount(
  a: `0x${string}` | string | null | undefined,
  b: `0x${string}` | string | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Everything that is *not* the address, cleared. The address is set by the
 * caller afterwards (or left null to disconnect entirely).
 *
 * Used by every identity-changing transition so there is one definition of
 * "forget what we knew" — a second one is how the flags drift apart again.
 */
function forgetViewer(state: WalletState, address: `0x${string}` | null): WalletState {
  return {
    ...DISCONNECTED,
    address,
    // A probe belonging to the old account must not land on the new one.
    checking: false,
  };
}

export function walletReducer(state: WalletState, event: WalletEvent): WalletState {
  switch (event.type) {
    case "connect": {
      // Connecting the *same* account again is not a new identity.
      if (sameAccount(state.address, event.address)) {
        return { ...state, address: event.address, busy: null };
      }
      return forgetViewer(state, event.address);
    }

    case "accountsChanged": {
      const next: `0x${string}` | null = event.accounts[0] ?? null;
      if (next === null) return DISCONNECTED;
      // Same account (e.g. a chain change): keep the session and entitlement,
      // they are still this account's.
      if (sameAccount(state.address, next)) return { ...state, address: next };
      // A different account: this viewer owns nothing that was just established.
      // Force a fresh SIWX sign-in, which will be bound to the new account.
      return forgetViewer(state, next);
    }

    case "disconnect":
      return DISCONNECTED;

    case "reelChanged":
      // A purchase is scoped to (wallet, reel). Keep the viewer, drop the
      // verdict: the new reel's own probe decides, never the old reel's answer.
      // stopping playback here stops a frame loop that was fetching the previous
      // reel's bytes under the same canvas.
      return {
        ...state,
        unlocked: false,
        entitlement: "unknown",
        checking: false,
        playing: false,
        frameCursor: 0,
      };

    case "signin":
      return { ...state, signedIn: true, busy: null };

    case "checking":
      // Clear `unlocked` too. Until the gate answers, ownership is unknown, and
      // leaving a stale "owned" behind made a re-probe of a paid reel flash PAID
      // before the real verdict arrived.
      return { ...state, checking: true, entitlement: "unknown", unlocked: false };

    case "entitlement": {
      if (event.entitlement === "owned") {
        return { ...state, entitlement: "owned", unlocked: true, checking: false };
      }
      if (event.entitlement === "unowned") {
        return { ...state, entitlement: "unowned", unlocked: false, checking: false };
      }
      // "unknown" is what a 401 yields: the session is gone, so the viewer is
      // no longer authenticated. Do not leave them looking signed in.
      return { ...state, entitlement: "unknown", unlocked: false, checking: false, signedIn: false };
    }

    case "unlocked":
      return { ...state, unlocked: true, entitlement: "owned", busy: null };

    case "busy":
      return { ...state, busy: event.busy };

    case "playing":
      return { ...state, playing: event.playing };

    case "frame":
      return { ...state, frameCursor: event.cursor };

    case "resume": {
      // Only a session belonging to the connected account counts as ours.
      if (!event.signedIn) return { ...state, address: event.address, signedIn: false };
      return {
        ...state,
        address: event.address,
        signedIn: true,
        entitlement: "unknown",
        unlocked: false,
        checking: false,
      };
    }

    default:
      return state;
  }
}

/** The ladder, defined once in ./steps and re-exported so both agree by construction. */
export { phase } from "./steps";
