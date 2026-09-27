import { describe, expect, it } from "vitest";
import {
  DISCONNECTED,
  phase,
  sameAccount,
  walletReducer,
  type WalletEvent,
  type WalletState,
} from "@/app/reel/[id]/state";

/**
 * Wallet identity as a reducer.
 *
 * The bug these pin down: identity lived in four independent `useState` values
 * and nothing reset them together. Disconnecting in MetaMask emitted an
 * `accountsChanged` event that no listener was subscribed to, so the page kept
 * rendering a signed-in, unlocked player for an account the wallet had stopped
 * authorizing. Refreshing rehydrated it from the still-valid session cookie, and
 * the next signature request died with EIP-1193 4100 ("not authorized by the
 * user") — a symptom of the app asserting an identity the wallet had withdrawn.
 *
 * The address in the report, 0xa801a206B4C07Fb8d94444CD8ec3FFAE78C34b10, is
 * kept as ACCOUNT_A so the stale-address case reads like the real thing.
 */

const ACCOUNT_A = "0xa801a206B4C07Fb8d94444CD8ec3FFAE78C34b10" as const;
const ACCOUNT_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

function run(events: WalletEvent[], from: WalletState = DISCONNECTED): WalletState {
  return events.reduce(walletReducer, from);
}

/** The full happy path: connect, sign in, probe finds nothing, pay. */
function paidBy(account: `0x${string}`): WalletState {
  return run([
    { type: "connect", address: account },
    { type: "signin" },
    { type: "entitlement", entitlement: "unowned" },
    { type: "unlocked" },
  ]);
}

describe("disconnect returns the player to Connect Wallet", () => {
  it("clears wallet, session and entitlement from a fully paid state", () => {
    const before = paidBy(ACCOUNT_A);
    expect(phase(before)).toBe("PAID");

    const after = walletReducer(before, { type: "disconnect" });

    expect(after).toEqual(DISCONNECTED);
    expect(after.address).toBeNull();
    expect(after.signedIn).toBe(false);
    expect(after.unlocked).toBe(false);
    expect(after.entitlement).toBe("unknown");
    expect(phase(after)).toBe("DISCONNECTED");
  });

  it("treats a wallet-side disconnect as the same transition as the button", () => {
    const before = paidBy(ACCOUNT_A);
    const fromEvent = walletReducer(before, { type: "accountsChanged", accounts: [] });
    const fromButton = walletReducer(before, { type: "disconnect" });

    expect(fromEvent).toEqual(fromButton);
    expect(fromEvent).toEqual(DISCONNECTED);
  });

  it("stops playback and rewinds the frame cursor, so no paid frames linger", () => {
    const playing = run([
      { type: "connect", address: ACCOUNT_A },
      { type: "signin" },
      { type: "entitlement", entitlement: "owned" },
      { type: "playing", playing: true },
      { type: "frame", cursor: 42 },
    ]);

    expect(playing.playing).toBe(true);
    expect(playing.frameCursor).toBe(42);

    const after = walletReducer(playing, { type: "disconnect" });
    expect(after.playing).toBe(false);
    expect(after.frameCursor).toBe(0);
  });

  it("clears an in-flight probe so it cannot land on the next viewer", () => {
    const checking = run([
      { type: "connect", address: ACCOUNT_A },
      { type: "signin" },
      { type: "checking" },
    ]);
    expect(checking.checking).toBe(true);

    const after = walletReducer(checking, { type: "disconnect" });
    expect(after.checking).toBe(false);
  });
});

describe("switching accounts uses the new address", () => {
  it("replaces the address and drops the old account's session and entitlement", () => {
    const before = paidBy(ACCOUNT_A);

    const after = walletReducer(before, {
      type: "accountsChanged",
      accounts: [ACCOUNT_B],
    });

    expect(after.address).toBe(ACCOUNT_B);
    expect(after.signedIn).toBe(false);
    expect(after.unlocked).toBe(false);
    expect(after.entitlement).toBe("unknown");
    expect(phase(after)).toBe("CONNECTED");
  });

  it("keeps the session and entitlement when the same account is re-announced", () => {
    const before = paidBy(ACCOUNT_A);

    // A chain change re-emits the same account. Nothing was learned that would
    // invalidate the session, so throwing it away would be a spurious sign-out.
    const after = walletReducer(before, {
      type: "accountsChanged",
      accounts: [ACCOUNT_A],
    });

    expect(after).toEqual(before);
    expect(phase(after)).toBe("PAID");
  });

  it("treats a differently-cased but equal address as the same account", () => {
    const before = paidBy(ACCOUNT_A);
    const lowercased = ACCOUNT_A.toLowerCase() as `0x${string}`;

    expect(sameAccount(ACCOUNT_A, lowercased)).toBe(true);

    // Same account, so the session and entitlement stand. The displayed casing
    // follows what the wallet last reported, which is cosmetic and not a reset.
    const after = walletReducer(before, {
      type: "accountsChanged",
      accounts: [lowercased],
    });
    expect(sameAccount(after.address, ACCOUNT_A)).toBe(true);
    expect(after.signedIn).toBe(true);
    expect(after.unlocked).toBe(true);
    expect(phase(after)).toBe("PAID");
  });

  it("reconnecting the same account does not re-authenticate or lose progress", () => {
    const before = paidBy(ACCOUNT_A);
    const after = run([{ type: "connect", address: ACCOUNT_A }], before);

    expect(after).toEqual(before);
    expect(after.unlocked).toBe(true);
  });
});

describe("stale authenticated state is not reused", () => {
  it("does not adopt a session belonging to a different account", () => {
    // The load path: wallet is on B, cookie was minted for A. Treating the
    // cookie's presence as "signed in" is what leaked the old identity across.
    const after = walletReducer(DISCONNECTED, {
      type: "resume",
      address: ACCOUNT_B,
      signedIn: false,
    });

    expect(after.address).toBe(ACCOUNT_B);
    expect(after.signedIn).toBe(false);
    expect(phase(after)).toBe("CONNECTED");
  });

  it("adopts a session that genuinely belongs to the connected account", () => {
    const after = walletReducer(DISCONNECTED, {
      type: "resume",
      address: ACCOUNT_A,
      signedIn: true,
    });

    expect(after.address).toBe(ACCOUNT_A);
    expect(after.signedIn).toBe(true);
    expect(phase(after)).toBe("AUTHENTICATED");
  });

  it("never resumes into an unlocked state without asking the gate", () => {
    const after = walletReducer(DISCONNECTED, {
      type: "resume",
      address: ACCOUNT_A,
      signedIn: true,
    });

    // A cookie proves identity, never ownership. The reel is not unlocked until
    // the gated route says so.
    expect(after.unlocked).toBe(false);
    expect(after.entitlement).toBe("unknown");
    expect(phase(after)).toBe("AUTHENTICATED");
  });

  it("drops the session when the gate answers 401", () => {
    const signedIn = run([
      { type: "connect", address: ACCOUNT_A },
      { type: "signin" },
    ]);

    const after = walletReducer(signedIn, {
      type: "entitlement",
      entitlement: "unknown",
    });

    expect(after.signedIn).toBe(false);
    expect(after.unlocked).toBe(false);
    expect(phase(after)).toBe("CONNECTED");
  });
});

describe("stale entitlement and payment state is not reused", () => {
  it("does not carry a purchase from one account to the next", () => {
    const after = walletReducer(paidBy(ACCOUNT_A), {
      type: "accountsChanged",
      accounts: [ACCOUNT_B],
    });

    expect(after.entitlement).not.toBe("owned");
    expect(after.unlocked).toBe(false);
    // The new account must not be shown a price until the gate offers one.
    expect(after.entitlement).toBe("unknown");
  });

  it("resets the entitlement verdict when re-probing", () => {
    const after = walletReducer(paidBy(ACCOUNT_A), { type: "checking" });

    expect(after.checking).toBe(true);
    expect(after.entitlement).toBe("unknown");
    // A probe in flight must not still look paid.
    expect(after.unlocked).toBe(false);
  });

  it("only marks owned when the gate says owned", () => {
    const after = walletReducer(paidBy(ACCOUNT_A), {
      type: "entitlement",
      entitlement: "unowned",
    });

    expect(after.entitlement).toBe("unowned");
    expect(after.unlocked).toBe(false);
    expect(phase(after)).toBe("UNPAID");
  });
});

describe("the ladder itself", () => {
  it("walks the documented states in order", () => {
    const seen: string[] = [];
    let state = DISCONNECTED;
    seen.push(phase(state));

    state = walletReducer(state, { type: "connect", address: ACCOUNT_A });
    seen.push(phase(state));

    state = walletReducer(state, { type: "signin" });
    seen.push(phase(state));

    state = walletReducer(state, { type: "entitlement", entitlement: "unowned" });
    seen.push(phase(state));

    state = walletReducer(state, { type: "unlocked" });
    seen.push(phase(state));

    expect(seen).toEqual([
      "DISCONNECTED",
      "CONNECTED",
      "AUTHENTICATED",
      "UNPAID",
      "PAID",
    ]);
  });

  it("collapses every flag to DISCONNECTED when there is no wallet", () => {
    // The core invariant: no wallet means no viewer, whatever the flags claim.
    // This combination is exactly the state the bug left on screen.
    const lying: WalletState = {
      address: null,
      signedIn: true,
      unlocked: true,
      entitlement: "owned",
      checking: false,
      busy: "unlock",
      playing: true,
      frameCursor: 17,
    };

    expect(phase(lying)).toBe("DISCONNECTED");
  });

  it("clears the busy flag on every path that ends a request", () => {
    const busy = run([
      { type: "connect", address: ACCOUNT_A },
      { type: "busy", busy: "unlock" },
    ]);
    expect(busy.busy).toBe("unlock");

    expect(walletReducer(busy, { type: "signin" }).busy).toBeNull();
    expect(walletReducer(busy, { type: "unlocked" }).busy).toBeNull();
    expect(walletReducer(busy, { type: "disconnect" }).busy).toBeNull();
  });
});

/**
 * A reel is part of a viewer's identity.
 *
 * The player component is reused across `/reel/<id>` navigations, so
 * `unlocked`/`entitlement` outlive the reel that produced them. A probe for
 * reel-1 landing after the route moved to reel-3 would otherwise mark reel-3
 * paid — the UI would then claim PAID for a reel the server has no record of.
 * The frame route is unaffected (it re-derives per request), but the client
 * would be displaying a verdict belonging to a different reel.
 */
describe("entitlement is scoped to the reel it was asked about", () => {
  it("drops the previous reel's verdict when the route changes", () => {
    const paidReel1 = paidBy(ACCOUNT_A);
    expect(paidReel1.address).toBe(ACCOUNT_A);
    expect(paidReel1.entitlement).toBe("owned");

    const onReel3 = walletReducer(paidReel1, { type: "reelChanged" });

    // The viewer survives; the verdict does not.
    expect(onReel3.address).toBe(ACCOUNT_A);
    expect(onReel3.signedIn).toBe(true);
    expect(onReel3.unlocked).toBe(false);
    expect(onReel3.entitlement).toBe("unknown");
    expect(phase(onReel3)).not.toBe("PAID");
  });

  it("stops playback and rewinds, so the new reel never shows the old frames", () => {
    const playing = run([
      { type: "connect", address: ACCOUNT_A },
      { type: "signin" },
      { type: "entitlement", entitlement: "owned" },
      { type: "playing", playing: true },
      { type: "frame", cursor: 9 },
    ]);

    const after = walletReducer(playing, { type: "reelChanged" });
    expect(after.playing).toBe(false);
    expect(after.frameCursor).toBe(0);
  });

  it("reaches PAID for the new reel only once that reel's own probe says so", () => {
    let state = paidBy(ACCOUNT_A);
    state = walletReducer(state, { type: "reelChanged" });
    expect(phase(state)).toBe("AUTHENTICATED");

    // reel-3's own probe: locked.
    state = walletReducer(state, { type: "entitlement", entitlement: "unowned" });
    expect(phase(state)).toBe("UNPAID");
    expect(state.unlocked).toBe(false);

    // A reel-1 verdict arriving late is not what unlocks reel-3, but were it
    // applied at all it would be indistinguishable from this one — which is why
    // the probe compares the reel id before dispatching.
    state = walletReducer(state, { type: "entitlement", entitlement: "owned" });
    expect(phase(state)).toBe("PAID");
  });

  it("does not let reel-1's purchase leak into a disconnect either", () => {
    const after = run([{ type: "reelChanged" }, { type: "disconnect" }], paidBy(ACCOUNT_A));
    expect(after).toEqual(DISCONNECTED);
  });
});
