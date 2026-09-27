import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chainIdFor,
  connectedAccount,
  connectedAccounts,
  ensureChain,
  fetchPaid,
  TRANSFER_WITH_AUTHORIZATION,
  watchWallet,
} from "@/lib/x402Client";
import { privateKeyToAccount } from "viem/accounts";
import { hashTypedData, recoverAddress } from "viem";

/**
 * ensureChain against a fake EIP-1193 provider.
 *
 * This shipped a single `params` object — built with the wallet_addEthereumChain
 * shape — and passed it to wallet_switchEthereumChain. MetaMask validates params
 * strictly and answered -32602 "Received unexpected keys on object parameter.
 * Unsupported keys: chainName,nativeCurrency,rpcUrls", so the switch never
 * happened and Unlock died before reaching the EIP-712 signature prompt.
 *
 * The two methods are not interchangeable:
 *   wallet_switchEthereumChain  ->  [{ chainId }]
 *   wallet_addEthereumChain     ->  [{ chainId, chainName, nativeCurrency,
 *                                       rpcUrls, blockExplorerUrls? }]
 */

interface Call {
  method: string;
  params?: unknown[];
}

/** 4902 is "chain not known to this wallet"; 4001 is "user said no". */
function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function stubWallet(opts: {
  chainId: number;
  switchResult?: "ok" | "unknown" | "rejected";
}) {
  const calls: Call[] = [];
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push({ method, params });
      if (method === "eth_chainId") return `0x${opts.chainId.toString(16)}`;
      if (method === "wallet_switchEthereumChain") {
        if (opts.switchResult === "unknown") {
          throw rpcError(4902, "Unrecognized chain ID");
        }
        if (opts.switchResult === "rejected") {
          throw rpcError(4001, "User rejected the request");
        }
      }
      return null;
    },
  };
  (globalThis as { window?: unknown }).window = { ethereum: provider };
  return calls;
}

function switchCall(calls: Call[]): { chainId: string } {
  const call = calls.find((c) => c.method === "wallet_switchEthereumChain");
  if (!call) throw new Error("wallet_switchEthereumChain was never called");
  return call.params![0] as { chainId: string };
}

function addCall(calls: Call[]): Record<string, unknown> {
  const call = calls.find((c) => c.method === "wallet_addEthereumChain");
  if (!call) throw new Error("wallet_addEthereumChain was never called");
  return call.params![0] as Record<string, unknown>;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("chainIdFor", () => {
  it("reads the CAIP-2 form the server sends", () => {
    expect(chainIdFor("eip155:84532")).toBe(84532);
  });

  it("still accepts the short names", () => {
    expect(chainIdFor("base-sepolia")).toBe(84532);
  });

  it("refuses an unknown network rather than guessing", () => {
    expect(() => chainIdFor("not-a-chain")).toThrow(/Unsupported payment network/);
  });
});

describe("ensureChain: already on the payment chain", () => {
  it("sends no wallet_* call at all", async () => {
    // The common case must stay completely silent — no prompt, no error.
    const calls = stubWallet({ chainId: 84532 });
    await ensureChain("eip155:84532");
    expect(calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });
});

describe("ensureChain: on a different chain", () => {
  it("sends chainId and nothing else to wallet_switchEthereumChain", async () => {
    // The regression itself. `as never` used to hide the type mismatch, so the
    // add-shaped object compiled fine and died at runtime in the wallet.
    const calls = stubWallet({ chainId: 1, switchResult: "ok" });
    await ensureChain("eip155:84532");

    expect(Object.keys(switchCall(calls))).toEqual(["chainId"]);
    expect(switchCall(calls).chainId).toBe("0x14a34");
  });

  it("never puts add-only keys on the switch call", async () => {
    const calls = stubWallet({ chainId: 137, switchResult: "ok" });
    await ensureChain("eip155:84532");
    const params = switchCall(calls) as Record<string, unknown>;
    for (const key of ["chainName", "nativeCurrency", "rpcUrls", "blockExplorerUrls"]) {
      expect(params).not.toHaveProperty(key);
    }
  });

  it("does not add the chain when the switch succeeds", async () => {
    const calls = stubWallet({ chainId: 1, switchResult: "ok" });
    await ensureChain("eip155:84532");
    expect(calls.some((c) => c.method === "wallet_addEthereumChain")).toBe(false);
  });
});

describe("ensureChain: wallet does not know the chain (4902)", () => {
  it("switches first, then adds with the full EIP-3085 shape", async () => {
    const calls = stubWallet({ chainId: 1, switchResult: "unknown" });
    await ensureChain("eip155:84532");

    const order = calls.map((c) => c.method);
    expect(order.indexOf("wallet_switchEthereumChain")).toBeLessThan(
      order.indexOf("wallet_addEthereumChain"),
    );
    // The switch attempt is still the minimal shape, even on the way to add.
    expect(Object.keys(switchCall(calls))).toEqual(["chainId"]);
  });

  it("sends real Base Sepolia details to wallet_addEthereumChain", async () => {
    const calls = stubWallet({ chainId: 1, switchResult: "unknown" });
    await ensureChain("eip155:84532");
    const params = addCall(calls);

    expect(params).toEqual({
      chainId: "0x14a34",
      chainName: "Base Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://sepolia.base.org"],
      blockExplorerUrls: ["https://sepolia.basescan.org"],
    });
  });

  it("does not invent an RPC URL out of the network name", async () => {
    // The old code built `https://rpc.testnet.x402.org/${network}` from a CAIP-2
    // string, which is not a URL for any chain.
    const calls = stubWallet({ chainId: 1, switchResult: "unknown" });
    await ensureChain("eip155:84532");
    for (const url of addCall(calls).rpcUrls as string[]) {
      expect(url.startsWith("https://")).toBe(true);
      expect(url).not.toContain("eip155");
      expect(url).not.toContain("x402.org");
    }
  });

  it("uses the name a human recognises, not the CAIP-2 id", async () => {
    const calls = stubWallet({ chainId: 1, switchResult: "unknown" });
    await ensureChain("eip155:84532");
    expect(addCall(calls).chainName).toBe("Base Sepolia");
  });
});

describe("ensureChain: other wallet errors", () => {
  it("rethrows a user rejection instead of trying to add the chain", async () => {
    // 4001 means no. Offering to add a chain would be both wrong and alarming.
    const calls = stubWallet({ chainId: 1, switchResult: "rejected" });
    await expect(ensureChain("eip155:84532")).rejects.toThrow(/User rejected/);
    expect(calls.some((c) => c.method === "wallet_addEthereumChain")).toBe(false);
  });

  it("explains itself when it has no details for the chain", async () => {
    // Better a clear message than a chain added with a fabricated RPC URL.
    const calls = stubWallet({ chainId: 1, switchResult: "unknown" });
    await expect(ensureChain("eip155:31337")).rejects.toThrow(/has no\s+details to add it/);
    expect(calls.some((c) => c.method === "wallet_addEthereumChain")).toBe(false);
  });

  it("throws when there is no wallet at all", async () => {
    (globalThis as { window?: unknown }).window = {};
    await expect(ensureChain("eip155:84532")).rejects.toThrow(/No injected wallet/);
  });
});

/**
 * The EIP-3009 signature the wallet is asked to produce.
 *
 * This shipped with `nonce` typed `uint256` instead of `bytes32`. A wrong entry
 * type changes the type hash, so the digest is completely different — the
 * wallet signs it happily, the facilitator recovers some other address, and every
 * payment failed as `invalid_exact_evm_signature`. Nothing in the browser looked
 * wrong, because nothing was wrong locally.
 */

/** The EIP-712 domain the server pins via `extra`, for Base Sepolia USDC. */
const DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: 84532,
  verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`,
};

const NONCE_BYTES32 = `0x${"11".repeat(32)}` as `0x${string}`;
const FROM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as `0x${string}`;
const TO = "0xD700EECa36cbe92eDbC4A0ae30B131C42760d4c9" as `0x${string}`;

const FIXED_TYPES = { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION] };
const COMMON_MESSAGE = {
  from: FROM,
  to: TO,
  value: 10000n,
  validAfter: 1n,
  validBefore: 2n,
};

const MESSAGE_BYTES32 = { ...COMMON_MESSAGE, nonce: NONCE_BYTES32 };

describe("TransferWithAuthorization EIP-712 declaration", () => {
  it("matches USDC's EIP-3009 struct exactly, in order", () => {
    expect(TRANSFER_WITH_AUTHORIZATION).toEqual([
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ]);
  });

  it("types the nonce as bytes32, not uint256", () => {
    // The single field type that broke every payment.
    expect(TRANSFER_WITH_AUTHORIZATION.at(-1)).toEqual({ name: "nonce", type: "bytes32" });
  });

  it("recovers to the signer, so the digest matches what was signed", async () => {
    const account = privateKeyToAccount(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    const signature = await account.signTypedData({
      domain: DOMAIN,
      types: FIXED_TYPES,
      primaryType: "TransferWithAuthorization",
      message: MESSAGE_BYTES32,
    });
    const hash = hashTypedData({
      domain: DOMAIN,
      types: FIXED_TYPES,
      primaryType: "TransferWithAuthorization",
      message: MESSAGE_BYTES32,
    });
    const recovered = await recoverAddress({ hash, signature });
    expect(recovered.toLowerCase()).toBe(account.address.toLowerCase());
  });

});

/**
 * The wallet as a source of truth.
 *
 * The 4100 in the bug report ("The requested account and/or method has not been
 * authorized by the user") was not a wallet fault. The page held an address in
 * component state, the user disconnected or switched account in MetaMask, and
 * the next signature request was made with the retired address. Nothing read
 * `eth_accounts` outside a connect, and nothing was subscribed to
 * `accountsChanged`, so the app asserted an identity the wallet had withdrawn.
 *
 * These pin the three accessors that make the wallet — not the session cookie —
 * the authority on who is connected.
 */
describe("wallet as the source of truth", () => {
  const A = "0xa801a206B4C07Fb8d94444CD8ec3FFAE78C34b10";
  const B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  afterEach(() => {
    delete (globalThis as { window?: { ethereum?: unknown } }).window?.ethereum;
  });

  function install(
    respond: (method: string) => unknown,
  ): {
    calls: string[];
    listeners: Record<string, (() => void)[]>;
    fns: (event: string) => (() => void)[];
  } {
    const calls: string[] = [];
    const listeners: Record<string, (() => void)[]> = {};
    (globalThis as { window?: unknown }).window = {
      ethereum: {
        async request({ method }: { method: string }) {
          calls.push(method);
          return respond(method);
        },
        on(event: string, fn: () => void) {
          (listeners[event] ??= []).push(fn);
        },
        removeListener(event: string, fn: () => void) {
          listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
        },
      },
    };
    const fns = (event: string) => listeners[event] ?? [];
    return { calls, listeners, fns };
  }

  it("reads the live account without prompting", async () => {
    const { calls } = install((method) => (method === "eth_accounts" ? [A] : null));

    await expect(connectedAccount()).resolves.toBe(A);
    // eth_accounts only: no eth_requestAccounts, so nothing opens a popup.
    expect(calls).toEqual(["eth_accounts"]);
  });

  it("reports no account once the wallet disconnects", async () => {
    install(() => []);

    await expect(connectedAccount()).resolves.toBeNull();
    await expect(connectedAccounts()).resolves.toEqual([]);
  });

  it("reports no account when there is no injected wallet at all", async () => {
    delete (globalThis as { window?: unknown }).window;
    await expect(connectedAccount()).resolves.toBeNull();
    await expect(connectedAccounts()).resolves.toEqual([]);
  });

  it("keeps only well-formed hex addresses", async () => {
    install(() => [A, "garbage", null, B]);
    await expect(connectedAccounts()).resolves.toEqual([A, B]);
  });

  it("subscribes to both account and chain changes", () => {
    const { fns } = install(() => [A]);
    const unsubscribe = watchWallet(() => {});

    expect(fns("accountsChanged")).toHaveLength(1);
    expect(fns("chainChanged")).toHaveLength(1);
    unsubscribe();
    expect(fns("accountsChanged")).toHaveLength(0);
    expect(fns("chainChanged")).toHaveLength(0);
  });

  it("is a no-op when there is no provider, and still returns an unsubscribe", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => watchWallet(() => {})()).not.toThrow();
  });

  it("stops listening after unsubscribe, so a late event cannot resurrect state", () => {
    const { fns } = install(() => [A]);
    const seen: string[] = [];
    const unsubscribe = watchWallet(() => seen.push("event"));

    fns("accountsChanged")[0]?.();
    unsubscribe();
    fns("chainChanged").forEach((fn) => fn());
    // The first call happened before unsubscribing; nothing after it.
    expect(seen).toHaveLength(1);
  });
});

/**
 * fetchPaid refuses to sign with an account the wallet is not authorizing.
 *
 * Requirement: the signer must come from the currently connected wallet account,
 * never from stale component state. The page now re-derives its address from
 * `eth_accounts`, but a signature spends real USDC, so the check sits next to
 * the signing rather than trusting a caller far away to have kept it fresh.
 */
describe("fetchPaid refuses a stale signer", () => {
  const PAYER = "0xa801a206B4C07Fb8d94444CD8ec3FFAE78C34b10";
  const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  const CHALLENGE = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0xD700EECa36cbe92eDbC4A0ae30B131C42760d4c9",
        maxAmountRequired: "10000",
        extra: { name: "USDC", version: "2" },
      },
    ],
  };

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    vi.unstubAllGlobals();
  });

  function installWallet(accounts: string[]) {
    const signed: unknown[] = [];
    (globalThis as { window?: unknown }).window = {
      ethereum: {
        async request({ method }: { method: string; params?: unknown[] }) {
          if (method === "eth_accounts") return accounts;
          if (method === "eth_chainId") return "0x14a34";
          if (method === "wallet_switchEthereumChain") return null;
          return null;
        },
        on() {},
        removeListener() {},
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/frames/1")) {
          return new Response(JSON.stringify(CHALLENGE), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    return { signed };
  }

  it("refuses to sign when the wallet authorizes a different account", async () => {
    installWallet([OTHER]);

    // The caller still believes it is PAYER, e.g. because the user switched
    // accounts after the page rendered.
    await expect(fetchPaid("/api/reels/x/frames/1", PAYER as `0x${string}`)).rejects.toThrow(
      /Wallet is on .*not .*Reconnect the right account/s,
    );
  });

  it("refuses to sign at all when the wallet is disconnected", async () => {
    installWallet([]);

    await expect(fetchPaid("/api/reels/x/frames/1", PAYER as `0x${string}`)).rejects.toThrow(
      /Wallet disconnected/,
    );
  });

  it("accepts a differently-cased but equal live account", async () => {
    // EIP-55 casing differences are the same account, not a mismatch.
    const { signed } = installWallet([PAYER.toLowerCase()]);
    expect(signed).toHaveLength(0);
  });
});
