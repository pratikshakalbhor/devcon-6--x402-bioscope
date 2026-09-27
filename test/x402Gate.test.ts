import jpeg from "jpeg-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, priceForReel } from "@/lib/config";
import { getDb, recordPurchase, upsertReel, type ReelRow } from "@/lib/db";
import { SESSION_COOKIE, createSession } from "@/lib/session";
import { GET as framesGET } from "../app/api/reels/[id]/frames/[n]/route";
import {
  MIME_JPEG,
  buildPaymentRequirements,
  decodePaymentHeader,
  ExactEvmAuthorizationSchema,
  encodeSettleResponse,
  facilitatorEndpoint,
  paymentHeaderFrom,
  resourceUrlFor,
  settlementHeaders,
  verifyAndSettle,
  type BuildRequirementsOptions,
} from "@/lib/x402Gate";

/**
 * The facilitator is stubbed at the HTTP boundary, so these tests exercise the
 * real request/response contract rather than a mock of our own internals. What
 * is under test is the server's side of the bargain: which requirements get
 * built, from what, and what happens to a payload that does not match them.
 */

type FetchCall = {
  url: string;
  body: Record<string, unknown>;
  method: string;
  contentType: string | null;
};

/**
 * The configured facilitator base, spelled out literally. The stub matches on
 * the *exact* endpoint URL rather than on a suffix.
 *
 * It used to dispatch on `url.endsWith("/verify")`, which `https://x402.org/
 * verify` also satisfies — so a real bug where the base path was thrown away
 * (leaving the request pointed at the marketing site, 404 HTML) was invisible
 * to every test here. Matching exactly means that mistake now fails loudly.
 */
const FACILITATOR_BASE = "https://x402.org/facilitator";
const VERIFY_URL = `${FACILITATOR_BASE}/verify`;
const SETTLE_URL = `${FACILITATOR_BASE}/settle`;

const calls: FetchCall[] = [];
let verifyHandler: (payload: unknown, requirements: Record<string, unknown>) => unknown = () => ({
  isValid: true,
  payer: PAYER,
});
let settleHandler: () => unknown = () => ({ success: true, transaction: `0x${"ef".repeat(32)}` });
let facilitatorThrows: Error | null = null;

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  if (facilitatorThrows) throw facilitatorThrows;

  const url = String(input);
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  calls.push({
    url,
    body,
    method: init?.method ?? "GET",
    contentType: new Headers(init?.headers).get("content-type") ?? null,
  });

  if (url === VERIFY_URL) {
    const payload = body.paymentPayload as { payload: { authorization: { value: string } } };
    const requirements = body.paymentRequirements as Record<string, unknown>;
    return new Response(JSON.stringify(verifyHandler(payload, requirements)), {
      headers: { "content-type": "application/json" },
    });
  }
  if (url === SETTLE_URL) {
    return new Response(JSON.stringify(settleHandler()), {
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`Unexpected facilitator request to ${url}`);
});

const PAYER = "0x3333333333333333333333333333333333333333";
/** The frame the requirements are built for. The resource URL is derived. */
const FRAME = 1;

const REEL: ReelRow = {
  id: "reel-1",
  title: "Harbour at Low Tide",
  description: "Twelve seconds of a working harbour.",
  frame_count: 24,
  price_base_units: "10000",
};

function makePayload(overrides: { value?: string; from?: string; x402Version?: number } = {}) {
  return {
    x402Version: overrides.x402Version ?? 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: overrides.from ?? PAYER,
        to: getConfig().payTo,
        value: overrides.value ?? REEL.price_base_units,
        validAfter: "0",
        validBefore: "9999999999",
        // decimal, as the x402 wire format specifies
        nonce: `0x${"ab".repeat(32)}`,
      },
    },
  };
}

const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64");

const verifyCalls = () => calls.filter((call) => call.url === VERIFY_URL);
const settleCalls = () => calls.filter((call) => call.url === SETTLE_URL);


beforeEach(() => {
  calls.length = 0;
  facilitatorThrows = null;
  verifyHandler = () => ({ isValid: true, payer: PAYER });
  settleHandler = () => ({ success: true, transaction: `0x${"ef".repeat(32)}` });
  upsertReel(REEL);
});

describe("buildPaymentRequirements", () => {
  it("takes the amount from the reel row, verbatim", () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });

    expect(requirements.maxAmountRequired).toBe("10000");
    expect(requirements.maxAmountRequired).toBe(REEL.price_base_units);
  });

  it("derives the resource from the reel and the frame, never from the caller", () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });

    // Server-computed: configured origin + this reel + this frame. A caller has
    // no way to point the payment at a different URL.
    expect(requirements.resource).toBe(
      `${getConfig().publicOrigin}/api/reels/reel-1/frames/${FRAME}`,
    );
    // A different frame is a different resource, but not a different price.
    expect(buildPaymentRequirements(REEL, { frame: 7 }).resource).toMatch(/\/frames\/7$/);
    expect(buildPaymentRequirements(REEL, { frame: 7 }).maxAmountRequired).toBe(
      requirements.maxAmountRequired,
    );
  });

  it("percent-encodes a reel id rather than splicing it into the path", () => {
    const requirements = buildPaymentRequirements({ ...REEL, id: "reel 1/../admin" }, { frame: FRAME });

    expect(requirements.resource).toBe(
      `${getConfig().publicOrigin}/api/reels/reel%201%2F..%2Fadmin/frames/${FRAME}`,
    );
  });

  it("refuses to build requirements for the free frame", () => {
    // Frame 0 is not a paid resource, so quoting a price for it would be wrong.
    expect(() => buildPaymentRequirements(REEL, { frame: 0 })).toThrow();
  });

  it("resourceUrlFor rejects anything that is not a paid frame", () => {
    expect(() => resourceUrlFor("reel-1", 0)).toThrow();
    expect(() => resourceUrlFor("reel-1", -1)).toThrow();
    expect(() => resourceUrlFor("reel-1", 1.5)).toThrow();
    expect(() => resourceUrlFor("reel-1", Number.NaN)).toThrow();
  });

  it("quotes a different amount for a different reel", () => {
    upsertReel({ ...REEL, id: "reel-2", price_base_units: "25000" });
    const other = buildPaymentRequirements(
      { ...REEL, id: "reel-2", price_base_units: "25000" },
      { frame: FRAME },
    );

    expect(other.maxAmountRequired).toBe("25000");
    expect(other.maxAmountRequired).not.toBe(REEL.price_base_units);
  });

  it("keeps large amounts exact instead of rounding through a float", () => {
    const huge = "9007199254740993"; // 2^53 + 1
    const requirements = buildPaymentRequirements(
      { ...REEL, price_base_units: huge },
      { frame: FRAME },
    );

    expect(requirements.maxAmountRequired).toBe(huge);
  });

  it("sends payTo and asset from server config", () => {
    const { payTo, asset } = getConfig();
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });

    expect(requirements.payTo.toLowerCase()).toBe(payTo.toLowerCase());
    expect(requirements.asset.toLowerCase()).toBe(asset.toLowerCase());
    expect(requirements.scheme).toBe("exact");
    expect(requirements.mimeType).toBe(MIME_JPEG);
  });

  it("uses the v1 short network name for v1 clients and CAIP-2 for v2", () => {
    const v1 = buildPaymentRequirements(REEL, { frame: FRAME, dialect: 1 });
    const v2 = buildPaymentRequirements(REEL, { frame: FRAME, dialect: 2 });

    expect(v1.network).toBe("base-sepolia");
    expect(v2.network).toBe("eip155:84532");
    expect(v2).toHaveProperty("amount", REEL.price_base_units);
  });

  it("pins the EIP-712 domain so the wallet and facilitator cannot disagree", () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });

    expect(requirements.extra).toMatchObject({ name: "USDC", version: "2" });
  });

  it("emits exactly the wire fields, with no caller-supplied amount", () => {
    // buildPaymentRequirements(reel, options) — options carries routing and
    // presentation detail only. Asserting the exact key set so that adding an
    // `amount` option later has to be a deliberate, visible change.
    const v1 = buildPaymentRequirements(REEL, { frame: FRAME, description: "x" });

    expect(Object.keys(v1).sort()).toEqual(
      [
        "asset",
        "description",
        "extra",
        "maxAmountRequired",
        "maxTimeoutSeconds",
        "mimeType",
        "network",
        "payTo",
        "resource",
        "scheme",
      ].sort(),
    );
    expect(v1).not.toHaveProperty("amount");

    // v2 adds `amount`, and it is the same server-side number.
    const v2 = buildPaymentRequirements(REEL, { frame: FRAME, dialect: 2 });
    expect(v2.amount).toBe(REEL.price_base_units);
    expect(v2.maxAmountRequired).toBe(REEL.price_base_units);
  });

  it("holds the amount steady across every option a caller can vary", () => {
    const amounts = new Set(
      (
        [
          { frame: FRAME },
          { frame: FRAME, dialect: 1 as const },
          { frame: FRAME, dialect: 2 as const },
          { frame: FRAME, description: "a different description" },
          { frame: FRAME, maxTimeoutSeconds: 60 },
          { frame: 2 },
          { frame: 23 },
        ] satisfies BuildRequirementsOptions[]
      ).map((options) => buildPaymentRequirements(REEL, options).maxAmountRequired),
    );

    expect([...amounts]).toEqual([REEL.price_base_units]);
  });
});

describe("decodePaymentHeader", () => {
  it("detects the v1 dialect", () => {
    const { payload, dialect } = decodePaymentHeader(encode(makePayload()));
    expect(dialect).toBe(1);
    expect(payload.payload.authorization.from).toBe(PAYER);
  });

  it("detects the v2 dialect", () => {
    const { dialect } = decodePaymentHeader(encode(makePayload({ x402Version: 2 })));
    expect(dialect).toBe(2);
  });

  it("throws on something that is not a payment payload", () => {
    expect(() => decodePaymentHeader("not-base64-json")).toThrow();
  });
});

describe("verifyAndSettle", () => {
  it("verifies against the server-built requirements and returns the payer", async () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    const result = await verifyAndSettle(encode(makePayload()), requirements);

    expect(result.status).toBe("paid");
    if (result.status !== "paid") return;
    expect(result.payer.toLowerCase()).toBe(PAYER.toLowerCase());
    expect(result.settle.transaction).toBe(`0x${"ef".repeat(32)}`);

    // The requirements handed to the facilitator are the server's, verbatim.
    expect(verifyCalls()).toHaveLength(1);
    const sent = verifyCalls()[0]!.body.paymentRequirements as {
      maxAmountRequired: string;
      payTo: string;
      scheme: string;
    };
    expect(sent.maxAmountRequired).toBe(REEL.price_base_units);
    expect(sent.payTo.toLowerCase()).toBe(getConfig().payTo.toLowerCase());
    expect(sent.scheme).toBe("exact");
    expect(verifyCalls()[0]!.body.paymentPayload).toMatchObject({ scheme: "exact" });
  });

  it("points the facilitator at the configured URL", async () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    await verifyAndSettle(encode(makePayload()), requirements);

    // Spelled out, not recomputed with `new URL("/verify", base)` — that
    // expression is the bug, and using it here made the assertion a tautology.
    expect(verifyCalls()[0]!.url).toBe(VERIFY_URL);
  });

  it("settles only after a successful verify", async () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    await verifyAndSettle(encode(makePayload()), requirements);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/facilitator/verify",
      "/facilitator/settle",
    ]);
  });

  it("refuses to settle when verification fails", async () => {
    verifyHandler = () => ({ isValid: false, invalidReason: "invalid_exact_evm_payload_value" });

    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    const result = await verifyAndSettle(encode(makePayload()), requirements);

    expect(result).toEqual({
      status: "invalid",
      reason: "invalid_exact_evm_payload_value",
    });
    expect(settleCalls()).toHaveLength(0);
  });

  it("rejects an underpayment: the facilitator sees the server's amount, not the payload's", async () => {
    // Mirrors the facilitator's own check, which compares the signed
    // authorization against the requirements the server sent.
    verifyHandler = (payload, requirements) => {
      const value = (payload as { payload: { authorization: { value: string } } }).payload
        .authorization.value;
      const required = (requirements as { maxAmountRequired: string }).maxAmountRequired;
      return BigInt(value) >= BigInt(required)
        ? { isValid: true, payer: PAYER }
        : { isValid: false, invalidReason: "invalid_exact_evm_payload_value" };
    };

    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    const result = await verifyAndSettle(encode(makePayload({ value: "1" })), requirements);

    expect(result.status).toBe("invalid");
    expect(settleCalls()).toHaveLength(0);
  });

  it("reports a settlement failure without claiming success", async () => {
    settleHandler = () => ({ success: false, errorReason: "insufficient_funds" });

    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    const result = await verifyAndSettle(encode(makePayload()), requirements);

    expect(result).toMatchObject({ status: "error", reason: "insufficient_funds" });
  });

  it("surfaces a facilitator outage as an error, not a pass", async () => {
    facilitatorThrows = new Error("ECONNREFUSED");

    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    const result = await verifyAndSettle(encode(makePayload()), requirements);

    expect(result.status).toBe("error");
    expect(settleCalls()).toHaveLength(0);
  });

  it("surfaces a non-2xx facilitator response as an error", async () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;

    try {
      const result = await verifyAndSettle(encode(makePayload()), requirements);
      expect(result.status).toBe("error");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects a malformed header before contacting the facilitator", async () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    const result = await verifyAndSettle("!!!not-base64!!!", requirements);

    expect(result).toEqual({ status: "invalid", reason: "Malformed payment payload." });
    expect(calls).toHaveLength(0);
  });

  it("rejects a payload whose authorization does not parse", async () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    // No authorization at all.
    const result = await verifyAndSettle(
      encode({ x402Version: 1, scheme: "exact", payload: { signature: "0xab" } }),
      requirements,
    );

    expect(result).toEqual({ status: "invalid", reason: "Malformed payment payload." });
    expect(calls).toHaveLength(0);
  });
});

describe("wire format", () => {
  it("reads the v1 header first, then the v2 one", () => {
    const v1 = new Request("http://x.test", { headers: { "X-PAYMENT": "a" } });
    const v2 = new Request("http://x.test", { headers: { "PAYMENT-SIGNATURE": "b" } });
    const both = new Request("http://x.test", {
      headers: { "X-PAYMENT": "a", "PAYMENT-SIGNATURE": "b" },
    });
    const neither = new Request("http://x.test");

    expect(paymentHeaderFrom(v1)).toBe("a");
    expect(paymentHeaderFrom(v2)).toBe("b");
    expect(paymentHeaderFrom(both)).toBe("a");
    expect(paymentHeaderFrom(neither)).toBeNull();
  });

  it("emits the settlement under both header names and exposes them to CORS", () => {
    const encoded = encodeSettleResponse({ success: true, transaction: "0x1" } as never);
    const headers = settlementHeaders(encoded);

    expect(headers["X-PAYMENT-RESPONSE"]).toBe(encoded);
    expect(headers["PAYMENT-RESPONSE"]).toBe(encoded);
    expect(headers["Access-Control-Expose-Headers"]).toContain("X-PAYMENT-RESPONSE");
  });

  it("round-trips the settlement response through base64", () => {
    const response = { success: true, transaction: "0xabc" };
    const decoded = JSON.parse(
      Buffer.from(encodeSettleResponse(response as never), "base64").toString("utf8"),
    );

    expect(decoded).toEqual(response);
  });
});

describe("config", () => {
  it("exposes a server-side price for every seeded reel", () => {
    expect(priceForReel("reel-1")).toBe("10000");
    expect(priceForReel("reel-2")).toBe("25000");
    expect(priceForReel("reel-3")).toBe("5000");
  });

  it("throws for an unknown reel rather than defaulting to something free", () => {
    expect(() => priceForReel("reel-unknown")).toThrow(/No server-side price/);
  });
});

// ---------------------------------------------------------------------------
// The gate, as the route actually behaves
// ---------------------------------------------------------------------------

/**
 * The three states a request for a paid frame can be in, driven through the real
 * handler rather than a reimplementation.
 *
 * The facilitator is stubbed at the fetch boundary above, so `calls` doubles as
 * a record of every outbound request. That is what makes "no facilitator call
 * made" checkable rather than assumed.
 */
describe("GET /api/reels/:id/frames/1", () => {
  const VIEWER = "0x7777777777777777777777777777777777777777";
  const FRAME_COUNT = 3;

  beforeAll(async () => {
    const { reelsDir } = getConfig();
    const dir = path.join(reelsDir, REEL.id);
    await fs.mkdir(dir, { recursive: true });
    for (let n = 0; n < FRAME_COUNT; n++) {
      await fs.writeFile(
        path.join(dir, `frame-${String(n).padStart(2, "0")}.jpg`),
        jpeg.encode({ data: Buffer.alloc(4 * 4 * 3, 0x30), width: 4, height: 4 }, 50).data,
      );
    }
    upsertReel({ ...REEL, frame_count: FRAME_COUNT });
  });

  const request = (cookie: string | null, headers: Record<string, string> = {}) => {
    const all = new Headers(headers);
    if (cookie) all.set("cookie", `${SESSION_COOKIE}=${cookie}`);
    return new Request(`http://localhost:3000/api/reels/${REEL.id}/frames/1`, { headers: all });
  };

  const callGate = (cookie: string | null, headers: Record<string, string> = {}) =>
    framesGET(request(cookie, headers), { params: Promise.resolve({ id: REEL.id, n: "1" }) });

  beforeEach(() => {
    getDb().prepare("DELETE FROM purchases").run();
  });

  it("401s with no session, and never offers a price to an anonymous caller", async () => {
    const response = await callGate(null);

    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    // No payment terms leak out before identity is established.
    expect(body).not.toHaveProperty("accepts");
    expect(body).not.toHaveProperty("maxAmountRequired");
    // And nothing was asked of the facilitator.
    expect(calls).toEqual([]);
  });

  it("401s when the session cookie is present but not valid", async () => {
    // Unsigned payload claiming to be the viewer.
    const unsigned = Buffer.from(
      JSON.stringify({ address: VIEWER, iat: 0, exp: 9_999_999_999 }),
    ).toString("base64url");

    expect((await callGate(unsigned)).status).toBe(401);
    expect((await callGate(`${unsigned}.bogus-hmac`)).status).toBe(401);
    expect((await callGate("not-even-a-token")).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("402s a session with no purchase and no X-PAYMENT, with usable requirements", async () => {
    const response = await callGate(createSession(VIEWER).token);

    expect(response.status).toBe(402);

    const body = (await response.json()) as {
      x402Version: number;
      error: string;
      accepts: Record<string, unknown>[];
    };
    expect(body.x402Version).toBe(1);
    expect(body.error).toBeTruthy();
    expect(body.accepts).toHaveLength(1);

    // A client must be able to act on this without guessing anything.
    const requirement = body.accepts[0]!;
    expect(requirement.scheme).toBe("exact");
    expect(requirement.network).toBe("base-sepolia");
    expect(requirement.maxAmountRequired).toBe(REEL.price_base_units);
    expect(requirement.payTo).toBe(getConfig().payTo);
    expect(requirement.asset).toBe(getConfig().asset);
    expect(requirement.mimeType).toBe("image/jpeg");
    expect(requirement.maxTimeoutSeconds).toBeGreaterThan(0);
    expect(requirement.resource).toBe(
      `${getConfig().publicOrigin}/api/reels/${REEL.id}/frames/1`,
    );
    expect(requirement.extra).toMatchObject({ name: "USDC", version: "2" });

    // Quoting a price is not a payment: nothing was verified or settled.
    expect(verifyCalls()).toHaveLength(0);
    expect(settleCalls()).toHaveLength(0);
  });

  it("puts the same challenge in PAYMENT-REQUIRED, not only in the body", async () => {
    // v1 clients read the body; v2 clients read the header. Both must describe
    // the identical challenge, or a v2 client signs against requirements the
    // facilitator will not be asked to verify.
    const response = await callGate(createSession(VIEWER).token);

    expect(response.status).toBe(402);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // A 402 must not be cached by anything, including a service worker.
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "PAYMENT-REQUIRED",
    );

    const encoded = response.headers.get("PAYMENT-REQUIRED");
    expect(encoded).toBeTruthy();

    const fromHeader = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as {
      accepts: Record<string, unknown>[];
    };
    const fromBody = (await response.json()) as { accepts: Record<string, unknown>[] };
    expect(fromHeader.accepts).toEqual(fromBody.accepts);
  });

  it("re-sends the challenge when a payment is rejected", async () => {
    // A rejection means "sign again". Handing the requirements back in the same
    // 402 saves the client a round trip it does not need to make.
    verifyHandler = () => ({ isValid: false, invalidReason: "insufficient balance" });

    const response = await callGate(createSession(VIEWER).token, {
      "X-PAYMENT": encode(makePayload({ from: VIEWER })),
    });

    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: string; reason: string };
    expect(body.reason).toBe("insufficient balance");
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("serves the frame from a purchase row without calling the facilitator", async () => {
    recordPurchase(VIEWER, REEL.id, "0xaaa");

    const response = await callGate(createSession(VIEWER).token);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-bioscope-entitlement")).toBe("granted");

    // Real bytes, not an error envelope.
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    // This is the "never pay twice" path: no verify, no settle, no round trip.
    expect(calls).toEqual([]);
  });

  it("does not let one wallet's purchase row serve another wallet", async () => {
    recordPurchase("0x8888888888888888888888888888888888888888", REEL.id, "0xbbb");

    const response = await callGate(createSession(VIEWER).token);

    expect(response.status).toBe(402);
    expect(calls).toEqual([]);
  });

  it("serves frame 0 only from the preview route, never here", async () => {
    recordPurchase(VIEWER, REEL.id, "0xaaa");
    const response = await framesGET(request(createSession(VIEWER).token), {
      params: Promise.resolve({ id: REEL.id, n: "0" }),
    });

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

/**
 * The URL construction itself.
 *
 * This is the fix for a real outage: `new URL("/verify", "https://x402.org/
 * facilitator")` resolves to `https://x402.org/verify`, because a reference
 * starting with `/` is absolute and discards the base's path. Every verify and
 * settle went to the marketing site and came back as 404 HTML.
 */
describe("facilitatorEndpoint", () => {
  it("keeps the base path", () => {
    expect(facilitatorEndpoint("https://x402.org/facilitator", "/verify").href).toBe(
      "https://x402.org/facilitator/verify",
    );
    expect(facilitatorEndpoint("https://x402.org/facilitator", "/settle").href).toBe(
      "https://x402.org/facilitator/settle",
    );
  });

  it("does not matter whether the base has a trailing slash", () => {
    for (const base of [
      "https://x402.org/facilitator",
      "https://x402.org/facilitator/",
      "https://x402.org/facilitator///",
    ]) {
      expect(facilitatorEndpoint(base, "/verify").href).toBe(
        "https://x402.org/facilitator/verify",
      );
    }
  });

  it("never produces a doubled or dropped slash", () => {
    const url = facilitatorEndpoint("https://x402.org/facilitator/", "/verify").href;
    expect(url).not.toContain("facilitator//verify");
    expect(url.endsWith("/facilitator/verify")).toBe(true);
  });

  it("keeps a deeper base path intact", () => {
    expect(facilitatorEndpoint("https://gw.example.com/x402/facilitator", "/verify").href).toBe(
      "https://gw.example.com/x402/facilitator/verify",
    );
  });

  it("preserves scheme, host and port", () => {
    // A local facilitator, for development.
    expect(facilitatorEndpoint("http://localhost:3000/facilitator", "/verify").href).toBe(
      "http://localhost:3000/facilitator/verify",
    );
  });

  it("refuses a base whose query string would swallow the endpoint", () => {
    expect(() => facilitatorEndpoint("https://x402.org/facilitator?k=v", "/verify")).toThrow(
      /no query string or fragment/,
    );
    expect(() => facilitatorEndpoint("https://x402.org/facilitator#frag", "/verify")).toThrow(
      /no query string or fragment/,
    );
  });

  it("refuses a base that is not a URL at all", () => {
    expect(() => facilitatorEndpoint("x402.org/facilitator", "/verify")).toThrow(
      /not a usable base URL/,
    );
  });
});

describe("the request the gate actually makes", () => {
  it("POSTs JSON to the exact facilitator verify URL", async () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    await verifyAndSettle(encode(makePayload()), requirements);

    const call = verifyCalls()[0]!;
    expect(call.url).toBe("https://x402.org/facilitator/verify");
    expect(call.method).toBe("POST");
    expect(call.contentType).toBe("application/json");
  });

  it("POSTs JSON to the exact facilitator settle URL", async () => {
    const requirements = buildPaymentRequirements(REEL, { frame: FRAME });
    await verifyAndSettle(encode(makePayload()), requirements);

    const call = settleCalls()[0]!;
    expect(call.url).toBe("https://x402.org/facilitator/settle");
    expect(call.method).toBe("POST");
    expect(call.contentType).toBe("application/json");
  });
});

/**
 * The nonce on the wire.
 *
 * `authorization.nonce` is an EIP-3009 `bytes32`, carried as 0x-prefixed hex.
 * It was validated as a decimal integer string, which rejected every correctly
 * signed payment *and* accepted nonces too large to fit in 32 bytes.
 */
describe("ExactEvmAuthorizationSchema: the nonce", () => {
  const NONCE = `0x${"ab".repeat(32)}`;

  function authorization(nonce: string) {
    return {
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      to: "0xD700EECa36cbe92eDbC4A0ae30B131C42760d4c9",
      value: "10000",
      validAfter: "1700000000",
      validBefore: "1700000300",
      nonce,
    };
  }

  it("accepts a 32-byte hex nonce", () => {
    expect(ExactEvmAuthorizationSchema.safeParse(authorization(NONCE)).success).toBe(true);
  });

  it("accepts an all-zero nonce", () => {
    expect(ExactEvmAuthorizationSchema.safeParse(authorization(`0x${"00".repeat(32)}`)).success).toBe(
      true,
    );
  });

  it("rejects the decimal form the client used to send", () => {
    // This is what the old schema demanded, and it is not what the facilitator
    // hashes — so a payment signed over the real nonce was refused at the door.
    expect(ExactEvmAuthorizationSchema.safeParse(authorization("123456789012345678901234567890")).success).toBe(
      false,
    );
  });

  it("rejects a nonce that is not exactly 32 bytes", () => {
    expect(ExactEvmAuthorizationSchema.safeParse(authorization("0xabcd")).success).toBe(false);
    expect(ExactEvmAuthorizationSchema.safeParse(authorization(`0x${"ab".repeat(31)}`)).success).toBe(
      false,
    );
    expect(ExactEvmAuthorizationSchema.safeParse(authorization(`0x${"ab".repeat(33)}`)).success).toBe(
      false,
    );
  });

  it("rejects an unprefixed hex nonce", () => {
    expect(ExactEvmAuthorizationSchema.safeParse(authorization("ab".repeat(32))).success).toBe(false);
  });

  it("still requires the amount and window as decimal integers", () => {
    // Unchanged: these really are uint256 on the wire.
    const base = authorization(NONCE);
    expect(ExactEvmAuthorizationSchema.safeParse({ ...base, value: "0x2710" }).success).toBe(false);
    expect(ExactEvmAuthorizationSchema.safeParse({ ...base, validAfter: "-1" }).success).toBe(false);
  });
});
