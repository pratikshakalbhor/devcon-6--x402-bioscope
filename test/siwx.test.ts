import { beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getDb, getNonce } from "@/lib/db";
import {
  assertNonceUsable,
  buildChallengeMessage,
  challengeFromNonceRow,
  completeSiwx,
  issueChallenge,
  verifySiwx,
} from "@/lib/siwx";
import { SESSION_COOKIE, readSession, verify } from "@/lib/session";
import { POST as verifyPOST } from "../app/api/auth/verify/route";
import { GET as nonceGET } from "../app/api/auth/nonce/route";

/**
 * SIWX is only worth anything if a signature can be used exactly once and only
 * for a short time. Those two properties get the most direct tests possible,
 * and they are exercised against the real route handler so the status codes and
 * the cookie are covered too.
 *
 * The unit under test here is deliberately split: verifySiwx answers "did this
 * wallet sign this text?", assertNonceUsable answers "may this nonce be used?".
 * The route is the only place they meet, so that is where the interesting
 * attacks are tested.
 */

// Throwaway keys. Never used outside the test suite.
const ALICE = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const MALLORY = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

beforeEach(() => {
  // Nonces are single-use, so nothing can be shared between tests.
  getDb().prepare("DELETE FROM sign_in_nonces").run();
});

/** POST to the real verify handler. */
async function callVerify(body: Record<string, unknown>): Promise<Response> {
  return verifyPOST(
    new Request("http://localhost:3000/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function readSetCookie(response: Response): string | null {
  return response.headers.get("set-cookie");
}

/** Pull the raw token value out of a Set-Cookie header. */
function cookieToken(response: Response): string {
  const header = readSetCookie(response);
  if (!header) throw new Error("response set no cookie");
  return decodeURIComponent(header.split(";")[0]!.split("=")[1]!);
}

describe("challenge construction", () => {
  it("binds every field the wallet will sign to server-side values", () => {
    const message = buildChallengeMessage({
      address: "0x1111111111111111111111111111111111111111",
      nonce: "abc123",
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_000_300,
      domain: "https://bioscope.test",
    });

    expect(message).toContain("https://bioscope.test wants you to sign in");
    expect(message).toContain("0x1111111111111111111111111111111111111111");
    expect(message).toContain("URI: https://bioscope.test");
    expect(message).toContain("Version: 1");
    // base-sepolia, derived from NETWORK, not hardcoded in the message builder.
    expect(message).toContain("Chain ID: 84532");
    expect(message).toContain("Nonce: abc123");
    expect(message).toContain("Issued At: 2023-11-14T22:13:20.000Z");
    expect(message).toContain("Expiration Time: 2023-11-14T22:18:20.000Z");
  });

  it("rebuilds byte-identical text from a stored row", () => {
    const challenge = issueChallenge(ALICE.address);
    const row = getNonce(challenge.nonce);

    expect(row).toBeDefined();
    // This is the property the verify route depends on: the message the client
    // signed is the message the server reconstructs, with no drift allowed.
    expect(challengeFromNonceRow(row!)).toBe(challenge.message);
  });
});

describe("verifySiwx: signature over a given message", () => {
  it("confirms the signer matches the address", async () => {
    const message = "some text the server chose";
    const signature = await ALICE.signMessage({ message });

    const result = await verifySiwx({ address: ALICE.address, signature, message });

    expect(result).toEqual({ ok: true, address: ALICE.address });
  });

  it("rejects a signature by a different wallet", async () => {
    const message = "some text the server chose";
    const signature = await MALLORY.signMessage({ message });

    const result = await verifySiwx({ address: ALICE.address, signature, message });

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a signature over altered text", async () => {
    const signature = await ALICE.signMessage({ message: "the original" });

    const result = await verifySiwx({
      address: ALICE.address,
      signature,
      message: "the original\nGM",
    });

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects garbage without throwing", async () => {
    const result = await verifySiwx({
      address: ALICE.address,
      signature: "0xdeadbeef",
      message: "anything",
    });

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a malformed address without throwing", async () => {
    const message = "some text";
    const signature = await ALICE.signMessage({ message });

    const result = await verifySiwx({ address: "not-an-address", signature, message });

    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("assertNonceUsable: the nonce lifecycle", () => {
  it("accepts a fresh unused nonce and hands back the row", () => {
    const challenge = issueChallenge(ALICE.address);
    const check = assertNonceUsable(challenge.nonce);

    expect(check.ok).toBe(true);
    if (check.ok) expect(check.row.nonce).toBe(challenge.nonce);
  });

  it("rejects a nonce that was never issued", () => {
    expect(assertNonceUsable("deadbeefdeadbeefdeadbeefdeadbeef")).toEqual({
      ok: false,
      reason: "unknown-nonce",
    });
  });

  it("rejects a nonce once it has been used", async () => {
    const challenge = issueChallenge(ALICE.address);
    const signature = await ALICE.signMessage({ message: challenge.message });
    expect((await completeSiwx({ address: ALICE.address, signature, nonce: challenge.nonce })).ok).toBe(true);

    expect(assertNonceUsable(challenge.nonce)).toEqual({
      ok: false,
      reason: "nonce-already-used",
    });
  });

  it("rejects an expired nonce, and does not extend its life", () => {
    const challenge = issueChallenge(ALICE.address);

    // Just inside the skew allowance.
    expect(assertNonceUsable(challenge.nonce, challenge.expiresAt).ok).toBe(true);
    // Comfortably past it.
    expect(assertNonceUsable(challenge.nonce, challenge.expiresAt + 3600)).toEqual({
      ok: false,
      reason: "nonce-expired",
    });
  });

  it("stores used=0 and an expiry a few minutes out", () => {
    const challenge = issueChallenge(ALICE.address);
    const row = getNonce(challenge.nonce)!;

    expect(row.used).toBe(0);
    expect(row.address).toBe(ALICE.address);
    expect(row.expires_at - row.issued_at).toBeGreaterThan(60);
    expect(row.expires_at - row.issued_at).toBeLessThanOrEqual(600);
  });

  it("issues a distinct nonce every time", () => {
    const nonces = new Set(
      Array.from({ length: 25 }, () => issueChallenge(ALICE.address).nonce),
    );
    expect(nonces.size).toBe(25);
  });
});

describe("POST /api/auth/verify", () => {
  it("exchanges a valid signature for a signed session cookie", async () => {
    const challenge = issueChallenge(ALICE.address);
    const signature = await ALICE.signMessage({ message: challenge.message });

    const response = await callVerify({
      address: ALICE.address,
      signature,
      nonce: challenge.nonce,
    });

    expect(response.status).toBe(200);
    const setCookie = readSetCookie(response);
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");

    // The cookie is self-verifying and names the wallet.
    expect(verify(cookieToken(response))?.address).toBe(ALICE.address);
    // ...and the nonce is spent.
    expect(getNonce(challenge.nonce)?.used).toBe(1);
  });

  it("401s a replayed signature", async () => {
    const challenge = issueChallenge(ALICE.address);
    const signature = await ALICE.signMessage({ message: challenge.message });
    const body = { address: ALICE.address, signature, nonce: challenge.nonce };

    expect((await callVerify(body)).status).toBe(200);
    const second = await callVerify(body);

    expect(second.status).toBe(401);
    expect((await second.json()).reason).toBe("nonce-already-used");
  });

  it("400s a nonce that was never issued", async () => {
    const response = await callVerify({
      address: ALICE.address,
      signature: await ALICE.signMessage({ message: "anything" }),
      nonce: "deadbeefdeadbeefdeadbeefdeadbeef",
    });

    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("unknown-nonce");
  });

  it("401s an expired nonce even when the signature is perfectly valid", async () => {
    const challenge = issueChallenge(ALICE.address);
    // A genuine signature over the genuine message. Nothing is wrong with it.
    const signature = await ALICE.signMessage({ message: challenge.message });

    // Age the stored row past its expiry, as if the user had walked away.
    getDb()
      .prepare("UPDATE sign_in_nonces SET expires_at = ? WHERE nonce = ?")
      .run(Math.floor(Date.now() / 1000) - 3600, challenge.nonce);

    const response = await callVerify({
      address: ALICE.address,
      signature,
      nonce: challenge.nonce,
    });

    expect(response.status).toBe(401);
    expect((await response.json()).reason).toBe("nonce-expired");
    // Expiry is not a soft warning: the row is left unspent and unusable.
    expect(getNonce(challenge.nonce)?.used).toBe(0);
  });

  it("401s a signature over altered text and leaves the nonce usable", async () => {
    const challenge = issueChallenge(ALICE.address);
    const signature = await ALICE.signMessage({ message: `${challenge.message}\nGM` });

    const response = await callVerify({
      address: ALICE.address,
      signature,
      nonce: challenge.nonce,
    });

    expect(response.status).toBe(401);
    expect((await response.json()).reason).toBe("bad-signature");
    // A failed attempt must not burn the nonce, or one typo would force the
    // wallet through a fresh sign-in.
    expect(getNonce(challenge.nonce)?.used).toBe(0);
  });

  it("401s when the signer is not the wallet the nonce was issued to", async () => {
    // Mallory requests her own nonce, then tries to redeem it as Alice.
    const challenge = issueChallenge(MALLORY.address);
    const signature = await MALLORY.signMessage({ message: challenge.message });

    const response = await callVerify({
      address: ALICE.address,
      signature,
      nonce: challenge.nonce,
    });

    expect(response.status).toBe(401);
    expect((await response.json()).reason).toBe("address-mismatch");
  });

  it("ignores a message supplied by the client", async () => {
    // The message the wallet actually signs.
    const challenge = issueChallenge(ALICE.address);
    const signature = await ALICE.signMessage({ message: challenge.message });

    // An attacker also sends `message`, hoping the server checks the signature
    // against text they chose. It must not.
    const response = await callVerify({
      address: ALICE.address,
      signature,
      nonce: challenge.nonce,
      message: "anything at all",
    });

    // The nonce's own message is used, and the signature is valid for it.
    expect(response.status).toBe(200);
  });

  it("rejects a signature that is valid for a self-chosen message", async () => {
    // The attack this guards: sign something harmless, claim the nonce's own
    // message was never involved.
    const nonce = issueChallenge(ALICE.address).nonce;
    const signature = await ALICE.signMessage({ message: "I agree to nothing" });

    const response = await callVerify({ address: ALICE.address, signature, nonce });

    expect(response.status).toBe(401);
    expect((await response.json()).reason).toBe("bad-signature");
  });

  it("400s a malformed body", async () => {
    expect((await callVerify({ address: ALICE.address })).status).toBe(400);
    expect((await callVerify({})).status).toBe(400);
  });
});

describe("GET /api/auth/nonce", () => {
  it("returns a nonce and its expiry, bound to the requested address", async () => {
    const response = await nonceGET(
      new Request(`http://localhost:3000/api/auth/nonce?address=${ALICE.address}`),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { nonce: string; expiresAt: number; message: string };

    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(body.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(getNonce(body.nonce)?.address).toBe(ALICE.address);
    expect(body.message).toContain(body.nonce);
  });

  it("400s a missing or malformed address", async () => {
    expect((await nonceGET(new Request("http://localhost:3000/api/auth/nonce"))).status).toBe(400);
    expect(
      (
        await nonceGET(
          new Request("http://localhost:3000/api/auth/nonce?address=0xnothex"),
        )
      ).status,
    ).toBe(400);
  });
});

describe("the session cookie is the only trusted identity", () => {
  it("cannot be forged by tampering with the payload", async () => {
    const challenge = issueChallenge(ALICE.address);
    const signature = await ALICE.signMessage({ message: challenge.message });
    const response = await callVerify({
      address: ALICE.address,
      signature,
      nonce: challenge.nonce,
    });

    const token = cookieToken(response);
    const [body, sig] = token.split(".") as [string, string];

    // Re-encode the payload as Mallory, keeping Alice's signature.
    const forged = Buffer.from(
      JSON.stringify({
        address: MALLORY.address,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");

    expect(verify(`${forged}.${sig}`)).toBeNull();
    // The genuine token is unaffected by the same edit.
    expect(verify(`${body}.${sig}`)?.address).toBe(ALICE.address);  });

  it("is not accepted as a bare address header or query parameter", async () => {
    const challenge = issueChallenge(ALICE.address);
    const signature = await ALICE.signMessage({ message: challenge.message });
    const response = await callVerify({
      address: ALICE.address,
      signature,
      nonce: challenge.nonce,
    });
    const token = cookieToken(response);

    // A request claiming the address, but presenting no cookie.
    const untrusted = new Request("http://localhost:3000/api/reels", {
      headers: { "x-wallet-address": ALICE.address },
    });
    expect(readSession(untrusted)).toBeNull();
    expect(readSession(new Request("http://localhost:3000/api/reels?address=" + ALICE.address)))
      .toBeNull();

    // The cookie is the thing that works.
    const trusted = new Request("http://localhost:3000/api/reels", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(readSession(trusted)?.address).toBe(ALICE.address);
  });
});
