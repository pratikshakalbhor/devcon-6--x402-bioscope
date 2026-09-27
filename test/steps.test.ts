import { describe, expect, it } from "vitest";
import { deriveSteps, type PlayerState } from "@/app/reel/[id]/steps";

/**
 * The four step buttons on the player, as pure state.
 *
 * These exist because "2 · Sign in" shipped disabled: its gate was
 * `!signedIn`, and clicking it is the only thing that sets `signedIn`. The
 * button could not be opened by any user action, and nothing in a node test
 * suite noticed, because the gate was a boolean literal buried in JSX.
 *
 * The reported symptom, preserved exactly: wallet connected, status "Wallet
 * connected. Now sign in.", Sign in unclickable, and step 3 lit up reading
 * "Checking…" when nothing was checking.
 */

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function state(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    address: null,
    signedIn: false,
    unlocked: false,
    entitlement: "unknown",
    checking: false,
    busy: null,
    playing: false,
    walletPresent: true,
    priceUsd: "$0.010000",
    ...overrides,
  };
}

function step(s: PlayerState, index: number) {
  return deriveSteps(s)[index]!;
}

describe("2 · Sign in", () => {
  it("is clickable in exactly the reported state: wallet connected, not signed in", () => {
    // This is the bug. The gate was `!signedIn`, so the only way to enable the
    // button was to be signed in already — which the button itself does.
    const s = state({ address: WALLET, signedIn: false, entitlement: "unknown" });
    expect(step(s, 1).label).toBe("2 · Sign in");
    expect(step(s, 1).disabled).toBe(false);
  });

  it("needs a connected wallet", () => {
    expect(step(state(), 1).disabled).toBe(true);
  });

  it("is finished, and therefore disabled, once signed in", () => {
    const s = state({ address: WALLET, signedIn: true, entitlement: "unowned" });
    expect(step(s, 1).label).toBe("Signed in");
    expect(step(s, 1).disabled).toBe(true);
  });

  it("is blocked while another action is in flight", () => {
    expect(step(state({ address: WALLET, busy: "connect" }), 1).disabled).toBe(true);
    expect(step(state({ address: WALLET, busy: "unlock" }), 1).disabled).toBe(true);
  });

  it("shows its own in-flight label", () => {
    const s = state({ address: WALLET, busy: "signin" });
    expect(step(s, 1).label).toBe("Signing…");
    expect(step(s, 1).disabled).toBe(true);
  });
});

describe("3 · Unlock", () => {
  it("does not claim to be checking when no check is running", () => {
    // entitlement is "unknown" and checking is false: the gate has never been
    // asked, because there is no session. The old label said "Checking…" here,
    // which is why step 3 looked like the flow had advanced past sign-in.
    const s = state({ address: WALLET, signedIn: false, entitlement: "unknown" });
    expect(step(s, 2).label).toBe("3 · Unlock");
    expect(step(s, 2).disabled).toBe(true);
  });

  it("is not highlighted before the gate has offered a price", () => {
    // `className="primary"` was hardcoded, so step 3 was the accent-coloured
    // call to action in every state, including a disconnected browser.
    expect(step(state(), 2).primary).toBe(false);
    expect(step(state({ address: WALLET }), 2).primary).toBe(false);
    expect(step(state({ address: WALLET, signedIn: true, checking: true }), 2).primary).toBe(false);
  });

  it("says Checking… only while a probe is actually in flight", () => {
    const s = state({ address: WALLET, signedIn: true, entitlement: "unknown", checking: true });
    expect(step(s, 2).label).toBe("3 · Checking…");
  });

  it("is highlighted and priced once the gate answers 402", () => {
    const s = state({ address: WALLET, signedIn: true, entitlement: "unowned" });
    expect(step(s, 2).label).toBe("3 · Unlock for $0.010000");
    expect(step(s, 2).disabled).toBe(false);
    expect(step(s, 2).primary).toBe(true);
  });

  it("is never offered to a wallet that already owns the reel", () => {
    // A returning viewer must not be shown something that would charge them.
    const s = state({ address: WALLET, signedIn: true, unlocked: true, entitlement: "owned" });
    expect(step(s, 2).label).toBe("Unlocked");
    expect(step(s, 2).disabled).toBe(true);
    expect(step(s, 2).primary).toBe(false);
  });

  it("cannot be clicked before sign-in", () => {
    expect(step(state({ address: WALLET, entitlement: "unowned" }), 2).disabled).toBe(true);
  });
});

describe("1 · Connect wallet", () => {
  it("is offered when a wallet is present and none is connected", () => {
    const s = step(state(), 0);
    expect(s.label).toBe("1 · Connect wallet");
    expect(s.disabled).toBe(false);
  });

  it("is disabled with no injected wallet, and once one is connected", () => {
    expect(step(state({ walletPresent: false }), 0).disabled).toBe(true);
    expect(step(state({ address: WALLET }), 0).label).toBe("Wallet connected");
    expect(step(state({ address: WALLET }), 0).disabled).toBe(true);
  });
});

describe("4 · Play", () => {
  it("needs the reel to be unlocked", () => {
    expect(step(state({ address: WALLET, signedIn: true }), 3).disabled).toBe(true);
    expect(step(state({ address: WALLET, signedIn: true, unlocked: true }), 3).disabled).toBe(false);
    expect(step(state({ address: WALLET, signedIn: true, unlocked: true, playing: true }), 3).label).toBe(
      "Stop",
    );
  });
});

describe("the steps as a whole", () => {
  it("never highlights more than one action, so the flow cannot look finished early", () => {
    const states: PlayerState[] = [
      state(),
      state({ address: WALLET }),
      state({ address: WALLET, busy: "connect" }),
      state({ address: WALLET, busy: "signin" }),
      state({ address: WALLET, signedIn: true, checking: true }),
      state({ address: WALLET, signedIn: true, entitlement: "unowned" }),
      state({ address: WALLET, signedIn: true, unlocked: true, entitlement: "owned" }),
    ];
    for (const s of states) {
      const highlighted = deriveSteps(s).filter((step) => step.primary);
      expect(highlighted.length).toBeLessThanOrEqual(1);
    }
  });

  it("leaves exactly one clickable step in the reported state", () => {
    const steps = deriveSteps(state({ address: WALLET, signedIn: false }));
    const clickable = steps.filter((step) => !step.disabled).map((step) => step.action);
    // Connect is spent, so sign-in is the one thing left to do.
    expect(clickable).toEqual(["signin"]);
  });
});
