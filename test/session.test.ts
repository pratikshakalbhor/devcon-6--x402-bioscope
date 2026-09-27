import { beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { SESSION_COOKIE, createSession, readSession, sign, verify, type SessionPayload } from "@/lib/session";

/**
 * The session cookie is the sole authority on "which wallet is this?" for every
 * gated route, so its verifier has exactly two duties and must do both:
 *
 *   1. the HMAC must match  -> the payload is not attacker-controlled
 *   2. exp must be in the future -> the session is not stale
 *
 * A verifier that checks one without the other is a hole, so both are tested in
 * isolation as well as together.
 */

const ALICE = "0x1111111111111111111111111111111111111111" as const;
const MALLORY = "0x2222222222222222222222222222222222222222" as const;

const now = () => Math.floor(Date.now() / 1000);

/** Split a token into its payload and signature halves. */
function parts(token: string): [string, string] {
  const [body, sig] = token.split(".");
  return [body!, sig!];
}

beforeEach(() => {
  getDb().prepare("DELETE FROM sign_in_nonces").run();
});

function payload(
  overrides: Partial<{ address: `0x${string}`; iat: number; exp: number }> = {},
): SessionPayload {
  const at = now();
  return { address: ALICE, iat: at, exp: at + 3600, ...overrides };
}

describe("sign / verify round trip", () => {
  it("returns the address for a token it just signed", () => {
    const token = sign(payload());
    const session = verify(token);

    expect(session?.address).toBe(ALICE);
    expect(session?.exp).toBeGreaterThan(now());
  });

  it("preserves iat and exp, not just the address", () => {
    const body = payload();
    const session = verify(sign(body));

    expect(session?.iat).toBe(body.iat);
    expect(session?.exp).toBe(body.exp);
  });

  it("rejects a payload edited after signing", () => {
    const token = sign(payload());
    const [body, sig] = parts(token);
    const edited = Buffer.from(
      JSON.stringify(payload({ address: MALLORY })),
    ).toString("base64url");

    expect(verify(`${body}.${sig}`)?.address).toBe(ALICE);
    expect(verify(`${edited}.${sig}`)).toBeNull();
  });

  it("rejects a truncated or empty signature", () => {
    const token = sign(payload());
    const [body, sig] = parts(token);

    expect(verify(`${body}.${sig.slice(0, -2)}`)).toBeNull();
    expect(verify(`${body}.`)).toBeNull();
    expect(verify(`.${sig}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = sign(payload());
    // An independently computed HMAC over the same payload, wrong secret.
    const body = Buffer.from(JSON.stringify(payload())).toString("base64url");
    const foreign = createHmac("sha256", "not-the-real-secret").update(body).digest("base64url");

    expect(verify(`${body}.${foreign}`)).toBeNull();
    // Same payload, correct secret: accepted, which isolates the secret as the
    // only thing that differed.
    expect(verify(token)).not.toBeNull();
  });

  it("rejects a non-JSON or schema-invalid payload", () => {
    const { sessionSecret } = getConfig();
    const signBody = (text: string) =>
      createHmac("sha256", sessionSecret).update(text).digest("base64url");
    expect(verify(`not-base64-json.${signBody("not-base64-json")}`)).toBeNull();
    expect(verify(`abc.${signBody("abc")}`)).toBeNull();

    // Correctly signed, but the shape is wrong: exp as a string, no iat.
    const malformed = Buffer.from(JSON.stringify({ address: ALICE, exp: "soon" })).toString(
      "base64url",
    );
    expect(verify(`${malformed}.${signBody(malformed)}`)).toBeNull();
  });

  it("rejects missing, malformed, and unrecognised tokens", () => {
    expect(verify(undefined)).toBeNull();
    expect(verify(null)).toBeNull();
    expect(verify("")).toBeNull();
    expect(verify("no-dot-here")).toBeNull();
  });
});

describe("expiry is enforced", () => {
  it("rejects a token whose exp is in the past", () => {
    const at = now();
    expect(verify(sign(payload({ iat: at - 7200, exp: at - 3600 })))).toBeNull();
  });

  it("accepts a token that has not expired yet", () => {
    const at = now();
    expect(verify(sign(payload({ iat: at, exp: at + 1 })))?.address).toBe(ALICE);
  });

  it("treats exp as exclusive, not inclusive", () => {
    // A token expiring exactly now is already dead.
    expect(verify(sign(payload({ exp: now() })))).toBeNull();
  });

  it("does not accept a valid signature over an expired session", () => {
    // Distinct from the nonce's own expiry: the cookie carries its own clock.
    const { sessionSecret } = getConfig();
    const body = Buffer.from(
      JSON.stringify({ address: ALICE, iat: now() - 100, exp: now() - 1 }),
    ).toString("base64url");
    const sig = createHmac("sha256", sessionSecret).update(body).digest("base64url");

    expect(verify(`${body}.${sig}`)).toBeNull();
  });
});

describe("address handling", () => {
  it("checksums the address so casing cannot split one wallet into two", () => {
    // A mixed-case address round-trips to its EIP-55 canonical form, so the
    // same wallet cannot hold two differently-cased entitlements.
    const session = createSession("0xAbCdEf0123456789abcdef0123456789ABCDEF01").session;
    expect(session.address).toBe("0xabCDeF0123456789AbcdEf0123456789aBCDEF01");
    expect(verify(sign({ ...session }))?.address).toBe(session.address);
  });

  it("rejects a token whose address is not 20 bytes", () => {
    const { sessionSecret } = getConfig();
    const body = Buffer.from(
      JSON.stringify({ address: "0x1234", iat: now(), exp: now() + 60 }),
    ).toString("base64url");
    const sig = createHmac("sha256", sessionSecret).update(body).digest("base64url");

    expect(verify(`${body}.${sig}`)).toBeNull();
  });
});

describe("readSession", () => {
  it("finds the cookie among others and ignores the rest", () => {
    const { token } = createSession(ALICE);
    const headers = new Headers({
      cookie: `theme=dark; ${SESSION_COOKIE}=${token}; consent=yes`,
    });

    expect(readSession(new Request("http://localhost:3000/x", { headers }))?.address).toBe(ALICE);
  });

  it("returns null when the cookie is absent, malformed, or forged", () => {
    const { token } = createSession(ALICE);
    const [body, sig] = parts(token);
    const header = (value: string) =>
      readSession(new Request("http://localhost:3000/x", { headers: { cookie: value } }));

    expect(readSession(new Request("http://localhost:3000/x"))).toBeNull();
    expect(header("")).toBeNull();
    expect(header(`${SESSION_COOKIE}=nonsense`)).toBeNull();
    expect(header(`${SESSION_COOKIE}=${body}.${"x".repeat(sig.length)}`)).toBeNull();
    // Unrelated cookies are ignored rather than treated as a session.
    expect(header("theme=dark; consent=yes")).toBeNull();
  });
});
