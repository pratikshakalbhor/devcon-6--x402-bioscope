"use client";

import { createWalletClient, custom, type EIP1193Provider } from "viem";

/**
 * Browser-side counterpart to lib/x402Gate.ts: connect, sign in, pay.
 *
 * Everything the client needs to build a payment comes out of the 402 challenge
 * the server sent (network, asset, payTo, amount, EIP-712 domain). The client
 * holds no price and no asset address of its own, so a
 * tampered client cannot talk itself into a different deal than the one the
 * server is willing to accept — the facilitator checks the signature against
 * the server's own requirements. The one thing it does carry is public chain
 * metadata (display names, RPC URLs), needed only to add a chain the wallet
 * has never seen.
 */

export interface PaymentRequirementWire {
  scheme: string;
  network: string;
  maxAmountRequired?: string;
  amount?: string;
  asset: string;
  payTo: string;
  extra?: { name?: string; version?: string };
}

export interface PaymentRequiredBody {
  x402Version: number;
  accepts: PaymentRequirementWire[];
}

const CHAIN_ID_BY_NAME: Record<string, number> = {
  "base-sepolia": 84532,
  base: 8453,
  "avalanche-fuji": 43113,
  "polygon-amoy": 80002,
};

/**
 * Chain details for `wallet_addEthereumChain`.
 *
 * `wallet_switchEthereumChain` needs none of this, and the 402 challenge does
 * not carry it, so it lives here keyed by numeric chainId — the one identifier
 * every EIP-3326 message agrees on.
 *
 * Public constants, and deliberately not deal-affecting: the amount, asset and
 * payTo all still come from the server's own challenge, so nothing here can
 * change what the facilitator accepts.
 */
interface ChainMeta {
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls: string[];
}

const CHAIN_META: Readonly<Record<number, ChainMeta>> = {
  84532: {
    chainName: "Base Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia.base.org"],
    blockExplorerUrls: ["https://sepolia.basescan.org"],
  },
  8453: {
    chainName: "Base",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://mainnet.base.org"],
    blockExplorerUrls: ["https://basescan.org"],
  },
  43113: {
    chainName: "Avalanche Fuji Testnet",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
    blockExplorerUrls: ["https://testnet.snowtrace.io"],
  },
  43114: {
    chainName: "Avalanche C-Chain",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrls: ["https://api.avax.network/ext/bc/C/rpc"],
    blockExplorerUrls: ["https://snowtrace.io"],
  },
  80002: {
    chainName: "Polygon Amoy",
    nativeCurrency: { name: "Polygon Ecosystem Token", symbol: "POL", decimals: 18 },
    rpcUrls: ["https://polygon-amoy.drpc.org"],
    blockExplorerUrls: ["https://amoy.polygonscan.com"],
  },
  137: {
    chainName: "Polygon",
    nativeCurrency: { name: "Polygon Ecosystem Token", symbol: "POL", decimals: 18 },
    rpcUrls: ["https://polygon.drpc.org"],
    blockExplorerUrls: ["https://polygonscan.com"],
  },
};

export function chainIdFor(network: string): number {
  const caip2 = /^eip155:(\d+)$/.exec(network);
  if (caip2?.[1]) return Number(caip2[1]);
  const mapped = CHAIN_ID_BY_NAME[network];
  if (!mapped) throw new Error(`Unsupported payment network "${network}".`);
  return mapped;
}

export function injected(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as { ethereum?: EIP1193Provider }).ethereum ?? null;
}

export function hasInjectedWallet(): boolean {
  return injected() !== null;
}

export async function connectWallet(): Promise<`0x${string}`> {
  const provider = injected();
  if (!provider) throw new Error("No injected wallet found (window.ethereum is undefined).");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts[0];
  if (!account) throw new Error("Wallet returned no accounts.");
  return account as `0x${string}`;
}

export async function currentChainId(): Promise<number> {
  const provider = injected();
  if (!provider) throw new Error("No injected wallet found.");
  return Number((await provider.request({ method: "eth_chainId" })) as string);
}

/**
 * Every account the site is currently authorized to act as, in the wallet's own
 * order of preference. The first entry is the one that will be asked to sign.
 */
export async function connectedAccounts(): Promise<`0x${string}`[]> {
  const provider = injected();
  if (!provider) return [];
  const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
  return accounts.filter(
    (account): account is `0x${string}` =>
      typeof account === "string" && /^0x[0-9a-fA-F]{40}$/.test(account),
  );
}

/**
 * The account the wallet is currently authorizing, without prompting.
 *
 * `eth_accounts` returns only what the user has already permitted and never
 * opens a popup, so it is safe to call on every load. It is the only honest
 * source of truth for "is a wallet connected": the session cookie says who the
 * *server* last authenticated, which is a different question and goes stale the
 * moment the user disconnects or switches accounts in the wallet.
 *
 * Returns null when the site is not connected, which is the normal state after a
 * user disconnects or locks the wallet.
 */
export async function connectedAccount(): Promise<`0x${string}` | null> {
  const account = (await connectedAccounts())[0];
  return account ? (account as `0x${string}`) : null;
}

/**
 * Subscribe to wallet-side account and chain changes. Returns an unsubscribe.
 *
 * Without this the page keeps rendering a connected, signed-in, unlocked state
 * for an account the wallet has stopped authorizing, and the next signature
 * request fails with EIP-1193 4100 ("not authorized by the user"). That is a
 * state bug, not a wallet bug: the app is asserting an identity the wallet has
 * already withdrawn.
 */
export function watchWallet(onChange: () => void): () => void {
  const provider = injected();
  if (!provider) return () => {};

  const handle = () => onChange();
  provider.on("accountsChanged", handle);
  provider.on("chainChanged", handle);

  return () => {
    provider.removeListener("accountsChanged", handle);
    provider.removeListener("chainChanged", handle);
  };
}

/**
 * Nudge the wallet onto the payment chain.
 *
 * Not cosmetic: `eth_signTypedData_v4` signs whatever chainId the wallet is on,
 * so paying from the wrong chain produces a signature the facilitator rejects.
 *
 * The two EIP-3326 methods take different, non-interchangeable params:
 *
 *   wallet_switchEthereumChain  ->  [{ chainId }]                      (only this)
 *   wallet_addEthereumChain     ->  [{ chainId, chainName,
 *                                       nativeCurrency, rpcUrls,
 *                                       blockExplorerUrls? }]
 *
 * Passing the add-shaped object to switch is not tolerated: MetaMask rejects the
 * whole call with -32602 "unexpected keys on object parameter" before the user
 * sees anything, so no switch happens and no signature prompt is ever reached.
 */
export async function ensureChain(network: string): Promise<void> {
  const provider = injected();
  if (!provider) throw new Error("No injected wallet found.");
  const want = chainIdFor(network);
  if ((await currentChainId()) === want) return;

  const chainId = `0x${want.toString(16)}` as const;

  try {
    // chainId and nothing else. This is the whole contract of the switch call.
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    return;
  } catch (error) {
    // 4902 = the wallet has never heard of this chain. Adding it also switches to
    // it, so there is nothing to retry. Any other error is the user's to resolve;
    // re-adding the chain would not help, and must not be attempted.
    if ((error as { code?: number }).code !== 4902) throw error;
  }

  const meta = CHAIN_META[want];
  if (!meta) {
    throw new Error(
      `Your wallet does not know chain ${want} (${network}), and this app has no ` +
        `details to add it with. Add it in your wallet, or set NETWORK to a chain this app knows.`,
    );
  }

  // The full add shape, and only here.
  await provider.request({ method: "wallet_addEthereumChain", params: [{ chainId, ...meta }] });
}

// ---------------------------------------------------------------------------
// Sign in (SIWX)
// ---------------------------------------------------------------------------

export async function signInWithX(address: string): Promise<void> {
  const provider = injected();
  if (!provider) throw new Error("No injected wallet found.");

  const nonceResponse = await fetch(
    `/api/auth/nonce?address=${encodeURIComponent(address)}`,
    { cache: "no-store" },
  );
  if (!nonceResponse.ok) {
    throw new Error(`Could not get a sign-in challenge (${nonceResponse.status}).`);
  }
  const { nonce, message } = (await nonceResponse.json()) as { nonce: string; message: string };

  const wallet = createWalletClient({ account: address as `0x${string}`, transport: custom(provider) });
  const signature = await wallet.signMessage({ message });

  const verifyResponse = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature, nonce }),
  });
  if (!verifyResponse.ok) {
    const body = (await verifyResponse.json().catch(() => ({}))) as { reason?: string };
    throw new Error(`Sign-in rejected: ${body.reason ?? verifyResponse.status}`);
  }
}

// ---------------------------------------------------------------------------
// Pay (x402)
// ---------------------------------------------------------------------------

/**
 * EIP-3009 `TransferWithAuthorization`, exactly as USDC declares it.
 *
 * These names, types and their order *are* the type hash the signer commits to,
 * so a single wrong entry type produces a completely different digest — a
 * signature that verifies against nothing. `nonce` is a `bytes32` here and was
 * `uint256` before, which is why every payment was rejected as
 * `invalid_exact_evm_signature` while the wallet reported a successful sign.
 */
export const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

function hex32(bytes: Uint8Array): `0x${string}` {
  let out = "0x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out as `0x${string}`;
}

/**
 * EIP-3009 authorization nonce: 32 random bytes as 0x-prefixed hex.
 *
 * Hex, not decimal. The facilitator rebuilds the signed digest from the nonce
 * exactly as transmitted, so re-encoding it as a uint256 changes the digest and
 * invalidates the signature the wallet just produced.
 */
function authorizationNonce(): `0x${string}` {
  return hex32(crypto.getRandomValues(new Uint8Array(32)));
}

function encodePayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Fetch a paid resource, answering the 402 challenge with a signed EIP-3009
 * transfer authorization and retrying once.
 *
 * Returns the response body as a Blob along with the settlement transaction.
 */
export async function fetchPaid(
  url: string,
  address: `0x${string}`,
): Promise<{ blob: Blob; transaction: string | null }> {
  const first = await fetch(url, { cache: "no-store" });
  if (first.status !== 402) {
    if (!first.ok) throw new Error(`Unexpected status ${first.status} for ${url}.`);
    return { blob: await first.blob(), transaction: null };
  }

  const challenge = (await first.json()) as PaymentRequiredBody;
  const requirement = challenge.accepts[0];
  if (!requirement) throw new Error("Server sent a 402 with nothing to pay.");

  if (requirement.scheme !== "exact") {
    throw new Error(`Unsupported payment scheme "${requirement.scheme}".`);
  }

  await ensureChain(requirement.network);

  const provider = injected();
  if (!provider) throw new Error("No injected wallet found.");

  /**
   * The signer must be the account the wallet is authorizing *right now*, not
   * whatever address this component last stored.
   *
   * The page re-derives its address from the wallet, but a signature is a real
   * irreversible act, so the last line of defence lives next to it: if the
   * address we were handed is not the account the provider currently exposes,
   * refuse instead of signing with a stale identity. Getting this wrong either
   * throws EIP-1193 4100, or — worse — spends a real account's USDC on a reel
   * the current viewer never intended to pay for.
   */
  const live = await connectedAccount();
  if (!live) {
    throw new Error("Wallet disconnected. Connect again to pay.");
  }
  if (live.toLowerCase() !== address.toLowerCase()) {
    throw new Error(
      `Wallet is on ${live}, not ${address}. Reconnect the right account to pay.`,
    );
  }
  const signer = live;

  const chainId = chainIdFor(requirement.network);
  // Trust the server's challenge for the amount. If the client substituted its
  // own number the signature would not match the server's requirements and the
  // facilitator would reject it.
  const value = requirement.maxAmountRequired ?? requirement.amount;
  if (!value) throw new Error("Payment requirement is missing an amount.");

  const validAfter = Math.floor(Date.now() / 1000) - 60;
  const validBefore = Math.floor(Date.now() / 1000) + 300;

  const wallet = createWalletClient({
    account: signer,
    transport: custom(provider),
  });

  const authorization = {
    from: signer,
    to: requirement.payTo,
    value,
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce: authorizationNonce(),
  };

  const signature = await wallet.signTypedData({
    domain: {
      name: requirement.extra?.name ?? "USDC",
      version: requirement.extra?.version ?? "2",
      chainId,
      verifyingContract: requirement.asset as `0x${string}`,
    },
    types: { TransferWithAuthorization: [...TRANSFER_WITH_AUTHORIZATION] },
    primaryType: "TransferWithAuthorization",
    // viem wants real integers for a uint256; the wire form is decimal strings.
    // The nonce is the exception: it is a bytes32, so it is passed and sent as
    // the same hex the wallet signed over.
    message: {
      from: signer,
      to: requirement.payTo as `0x${string}`,
      value: BigInt(value),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce: authorization.nonce,
    },
  });

  const paymentHeader = encodePayload({
    x402Version: challenge.x402Version,
    scheme: "exact",
    network: requirement.network,
    payload: { signature, authorization },
  });

  const second = await fetch(url, {
    cache: "no-store",
    headers: { "X-PAYMENT": paymentHeader },
  });

  if (!second.ok) {
    const body = (await second.json().catch(() => ({}))) as { reason?: string; error?: string };
    throw new Error(body.reason ?? body.error ?? `Payment failed (${second.status}).`);
  }

  const encoded = second.headers.get("X-PAYMENT-RESPONSE") ?? second.headers.get("PAYMENT-RESPONSE");
  let transaction: string | null = null;
  if (encoded) {
    try {
      const decoded = JSON.parse(atob(encoded)) as { transaction?: string };
      transaction = decoded.transaction ?? null;
    } catch {
      transaction = null;
    }
  }

  return { blob: await second.blob(), transaction };
}
