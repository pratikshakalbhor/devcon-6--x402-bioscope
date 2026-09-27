/**
 * What each of the four step buttons says, and whether it can be clicked.
 *
 * This was four hand-written booleans inside JSX, which is how "2 · Sign in"
 * ended up disabled until you were already signed in: `disabled={!signedIn}` on
 * the button whose entire job is to set `signedIn`. A gate that reads the state
 * it is supposed to produce is a gate that can never open, and nothing in a
 * node-environment test suite could have caught it.
 *
 * So the gating lives here, as pure functions over plain values, and the JSX
 * only renders what it is told. Two rules the rest of the app depends on:
 *
 *   - sign-in is enabled by *having a wallet*, not by being signed in
 *   - the price is only ever shown once the gate has actually answered 402
 */

export type Entitlement = "unknown" | "owned" | "unowned";
export type Busy = null | "connect" | "signin" | "unlock";
export type StepAction = "connect" | "signin" | "unlock" | "play" | "stop";

/**
 * The five states of the player, in the order they are reached.
 *
 * DISCONNECTED  -> "Connect Wallet"
 * CONNECTED     -> "Sign In"
 * AUTHENTICATED -> "Check Entitlement"
 * UNPAID        -> "Unlock"
 * PAID          -> "Play"
 *
 * This is the *definition* of the state machine, kept next to the labels so the
 * two cannot drift. The important property is the shape of the fallbacks: every
 * predicate below is guarded on `address !== null`, so a wallet that disappears
 * collapses the whole ladder back to DISCONNECTED no matter what the flags say.
 * That is the bug this type exists to prevent: a stale `signedIn` / `unlocked`
 * left over from a previous account used to keep the UI in a paid-looking state
 * with no wallet behind it at all.
 */
export type Phase =
  | "DISCONNECTED"
  | "CONNECTED"
  | "AUTHENTICATED"
  | "UNPAID"
  | "PAID";

export function phase(state: {
  address: string | null;
  signedIn: boolean;
  unlocked: boolean;
  entitlement: Entitlement;
}): Phase {
  // The wallet is the source of truth for identity. Without one there is no
  // viewer, so no later state is meaningful — say so regardless of the flags.
  if (state.address === null) return "DISCONNECTED";
  if (state.unlocked || state.entitlement === "owned") return "PAID";
  if (!state.signedIn) return "CONNECTED";
  // Signed in with no verdict from the gate yet, either because the probe is in
  // flight or because it has not run. A 401 clears `signedIn` in the reducer, so
  // reaching here genuinely means "authenticated, entitlement not yet known".
  if (state.entitlement === "unknown") return "AUTHENTICATED";
  return "UNPAID";
}

export interface PlayerState {
  /** Non-null once a wallet is connected. Says nothing about identity. */
  address: string | null;
  /** True only after SIWX completed and the server issued a session cookie. */
  signedIn: boolean;
  /** True once the gate served a paid frame, or a purchase row was found. */
  unlocked: boolean;
  entitlement: Entitlement;
  /** A probe of frame 1 is actually in flight right now. */
  checking: boolean;
  busy: Busy;
  playing: boolean;
  walletPresent: boolean;
  priceUsd: string;
}
export interface Step {
  action: StepAction;
  label: string;
  disabled: boolean;
  /** The single accent-highlighted call to action, if there is one. */
  primary: boolean;
}

export function connectStep(state: PlayerState): Step {
  return {
    action: "connect",
    label: state.address
      ? "Wallet connected"
      : state.busy === "connect"
        ? "Connecting…"
        : "1 · Connect wallet",
    disabled: !state.walletPresent || state.busy !== null || state.address !== null,
    primary: false,
  };
}

export function signInStep(state: PlayerState): Step {
  return {
    action: "signin",
    label: state.signedIn
      ? "Signed in"
      : state.busy === "signin"
        ? "Signing…"
        : "2 · Sign in",
    // Enabled by a connected wallet, and by nothing else. Requiring `signedIn`
    // here would make the button unreachable: the click is what sets it.
    disabled: state.address === null || state.signedIn || state.busy !== null,
    primary: false,
  };
}

export function unlockStep(state: PlayerState): Step {
  return {
    action: "unlock",
    label: state.unlocked
      ? "Unlocked"
      : state.busy === "unlock"
        ? "Paying…"
        : state.entitlement === "unowned"
          ? `3 · Unlock for ${state.priceUsd}`
          : state.checking
            ? "3 · Checking…"
            : "3 · Unlock",
    // A price is only ever offered once the gate has said 402. A returning
    // viewer is never shown a button that would charge them again.
    disabled:
      !state.signedIn || state.busy !== null || state.unlocked || state.entitlement !== "unowned",
    // Highlighted only when there is genuinely something to pay for. Before that
    // it is just a step that has not been reached, and saying "Checking…" when
    // no check is running is a lie the UI should not tell.
    primary: state.entitlement === "unowned" && !state.unlocked,
  };
}

export function playStep(state: PlayerState): Step {
  return {
    action: state.playing ? "stop" : "play",
    label: state.playing ? "Stop" : "4 · Play",
    disabled: !state.unlocked || state.busy !== null,
    primary: false,
  };
}

/** A tuple, so the caller can destructure without `| undefined` guards. */
export type Steps = [connect: Step, signin: Step, unlock: Step, play: Step];

export function deriveSteps(state: PlayerState): Steps {
  return [connectStep(state), signInStep(state), unlockStep(state), playStep(state)];
}
