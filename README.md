# bioscope

A pay-per-reel video paywall built on [x402](https://x402.org). The first frame of
every reel is free; a small USDC payment on Base Sepolia unlocks the rest; and a
wallet that has already paid is served directly from its purchase row and never
charged twice.

Two boundaries do the real work, and both are structural rather than
discretionary:

1. **Paid frame bytes are never reachable from any statically-served path.**
   Frame images and the SQLite database live under `DATA_DIR` (`./data`), outside
   `public/`. A misconfigured `DATA_DIR` that resolves into a `public/` directory
   aborts at startup (`lib/config.ts:142`) instead of quietly publishing them.
2. **Repeat access is granted only to a wallet that has cryptographically proven
   it controls the address the purchase is keyed to** — never from a
   client-supplied flag. The gated route keys its lookup on
   `(session.address, reelId)`, where `session.address` came from an HMAC-signed
   cookie that was only ever issued after an EIP-4361 signature check
   (`app/api/auth/verify/route.ts:65`, `:75`).

The browser's `unlocked` flag is a cache of a server answer, used only to decide
which button to highlight. It is never consulted for authorization
(`app/reel/[id]/state.ts:19-22`).

---

## Quick start

```bash
cp .env.example .env
chmod 600 .env
# fill in PAY_TO, SESSION_SECRET, NETWORK, ASSET, APP_ORIGIN
npm install
npm rebuild better-sqlite3
npm run typecheck
npm test
npm run seed
npm run dev
```

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`npm run seed` is required before `npm run dev`: it generates the frame images
and the `reels` table. The frames are synthesized (not downloaded) so the repo
stays small, and each one carries a visible frame counter so you can see the
player advancing (`scripts/seed.ts:134`).

---

## 1. Architecture, in words

### Two signature types, deliberately kept separate

| | Sign-In-With-X | x402 payment |
|---|---|---|
| Proves | wallet control, for identity | payment of a specific amount |
| Signed over | EIP-4361 text message | EIP-712 `TransferWithAuthorization` |
| Files | `lib/siwx.ts`, `app/api/auth/nonce`, `app/api/auth/verify` | `lib/x402Gate.ts` (server), `lib/x402Client.ts` (browser) |
| Binds to | a single-use, expiring nonce | one reel, one price, one resource |
| Settled by | this app | a real x402 facilitator |

They are not interchangeable and neither is derived from the other. A valid SIWX
session says nothing about whether a wallet has paid; a settled payment says
nothing about who is browsing. The gate needs both, and checks them separately.

**SIWX lifecycle.** `GET /api/auth/nonce?address=0x…` mints and stores a nonce
bound to the requesting address, and returns the exact text to sign
(`app/api/auth/nonce/route.ts:46`). `POST /api/auth/verify` then, in order:

1. asserts the nonce exists, is unused, and is unexpired (`verify/route.ts:52`);
2. **checks the response address against the address the nonce was issued to**
   (`verify/route.ts:65`);
3. rebuilds the message from the *stored* row and verifies the signature over it
   (`verify/route.ts:74-75`);
4. burns the nonce via a compare-and-swap so concurrent replays cannot both win
   (`verify/route.ts:86`);
5. issues the signed session cookie (`verify/route.ts:101`).

Step 2 is not redundant with step 3, and this was a real vulnerability class
caught during development. `verifyMessage` proves the signature came *from*
`address`; it says nothing about which address the message *names*. Without the
binding check, a caller could mint a nonce for their own wallet and present it
while claiming to be a different address. The same reasoning drives the
`BodySchema` having no `message` field at all (`verify/route.ts:17-21`): the
message is rebuilt server-side, never accepted from the client, so a caller
cannot sign arbitrary text. The `SECURITY` note in `lib/siwx.ts:18-21` records
the rule, and the tests assert the request body is ignored.

Nonces are also capped per address (`MAX_ACTIVE_NONCES = 5`,
`nonce/route.ts:15`) so the endpoint cannot grow the table.

**x402 payment.** An EIP-3009 `TransferWithAuthorization` is signed in the
browser (`lib/x402Client.ts`) and verified *and settled* server-side against a
real facilitator (`lib/x402Gate.ts:315` `facilitatorEndpoint`, then
`verifyAndSettle`). The nonce is EIP-712 `bytes32` on the wire as a 32-byte hex
string, validated by `Bytes32Hex` (`lib/x402Gate.ts:91`).

The resource a payment is bound to is derived server-side from the already
range-checked frame number — never from `request.url` — so a rewritten `Host`
header cannot change what a payment buys
(`frames/[n]/route.ts:87-89`).

### The frame-serving gate

`app/api/reels/[id]/frames/[n]/route.ts`, in order:

| # | Check | Line | Result |
|---|---|---|---|
| 1 | frame index is a number, in range, non-zero | `:42`, `:46`, `:49` | 400 |
| 2 | reel exists | `:61` | 404 |
| 3 | `n` is a real frame **of this reel**, from the reel's own row | `:65` | 404 |
| 4 | valid session | `:73` | 401 `Sign in required.` |
| 5 | `hasPurchased(session.address, reel.id)` | `:83` | **200 — no facilitator round trip** |
| 6 | no `X-PAYMENT` header | `:91` | 402 + server-built requirements |
| 7 | `verifyAndSettle` | `:113` | 402 / 502 |
| 8 | `recordPurchase(result.payer, ...)` | `:136` | — |
| 9 | payer is the signed-in wallet | `:138` | 401, purchase still recorded |
| 10 | stream bytes | `:149` | 200, `cache-control: private, no-store` |

Step 5 is the "never pay twice" path: an existing purchase short-circuits before
any facilitator contact, so re-watching a reel you own costs nothing and cannot
be charged again.

Step 9 is a deliberate asymmetry. The money has already moved, so the entitlement
is credited to the **payer** regardless of who was browsing; only the streaming of
bytes to a mismatched session is refused. The purchase is not rolled back, because
rolling it back would discard a real settled payment.

Frame 0 is not reachable from this route at all — it returns 400 pointing at the
preview route (`:49-58`). One URL, one policy.

### The private storage boundary

`DATA_DIR`, `reelsDir` and `dbPath` are checked at startup and the process
refuses to boot if any of them resolves inside a `public/` directory
(`lib/config.ts:139-148`). This is enforced twice over: by the guard, and by
`test/storage.test.ts`, which pins the check itself.

That test needed a correct `isInside()` helper (`test/storage.test.ts:64`).
`path.relative(...).startsWith("..")` — the obvious implementation — is wrong in
both directions: it fails to detect escape across drive letters on Windows (a
`path.win32.relative` across `C:` and `D:` is absolute, not `..`-prefixed), and it
false-passes a child directory literally named `..foo`, which is *inside*. The
helper resolves both paths first, then relativizes, and treats "cannot be
expressed relatively" as outside. It takes an injectable `path.PlatformPath` so
the Windows drive case is covered by a Linux run
(`storage.test.ts:64-78`, pinned by tests at `:98`, `:103`, `:123`).

### The client-side wallet state model

Identity lives in a single reducer, `app/reel/[id]/state.ts`, not in four
independent `useState` values. All UI state derives from the wallet's **live**
account (`eth_accounts`) as the source of truth.

This replaced a real bug class. With `address`, `signedIn`, `unlocked` and
`entitlement` tracked separately, only some were cleared on any given path, so
the UI could show a signed-in, unlocked-looking state for an account MetaMask had
stopped authorizing — and the next signature request failed with EIP-1193 error
4100 (`state.ts:4-12`).

The invariant that closes the class is that `if (address === null) return
DISCONNECTED` is checked *first*, in every identity-changing transition. Because
"the wallet's account changed" and "the user disconnected" are the same
transition from the app's point of view, they are the same case
(`state.ts:127-136`): a different account returns `forgetViewer(state, next)`,
which clears session and entitlement and forces a fresh SIWX sign-in bound to the
new account; an empty account list returns `DISCONNECTED` outright. A session
for a *different* account is not this viewer's session, so `resume` refuses it
(`state.ts:188-190`).

`reelChanged` drops the verdict but keeps the viewer, because a purchase is scoped
to `(wallet, reel)` — the new reel's own probe decides, never the old reel's
answer (`state.ts:141-153`).

---

## 2. Routes

| Method | Path | Free/Paid | Behaviour |
|---|---|---|---|
| `GET` | `/api/reels` | free | Catalogue: id, title, description, frameCount, price, previewUrl, and `owned` for the signed-in wallet. Emits **no** frame path or directory name — the only image URL it hands out is the ungated preview (`:32`). |
| `HEAD` | `/api/reels` | — | not implemented |
| `GET` | `/api/reels/[id]/preview` | **always free** | Frame 0 and nothing else. No session check, no payment check, no `n` parameter — there is nothing here to walk forward from (`:8-17`). `cache-control: public, max-age=3600, immutable`. |
| `HEAD` | `/api/reels/[id]/preview` | free | Existence probe, no image transferred |
| `GET` | `/api/reels/[id]/frames/[n]` | **gated** | The 10-step gate above. `n=0` returns 400 pointing at the preview route. Paid bytes are served `private, no-store` (`:178`). |
| `HEAD` | `/api/reels/[id]/frames/[n]` | gated | Cheap entitlement probe: 200 if entitled, 402 if not, 401/404 on the earlier checks (`:195`). No facilitator contact. |
| `GET` | `/api/auth/nonce?address=0x…` | free | SIWX step 1. Mints a nonce, returns `{nonce, expiresAt, message}`. 400 if `address` is not a 20-byte hex address, 429 after 5 outstanding nonces. |
| `POST` | `/api/auth/verify` | free | SIWX step 2. Body is `{address, signature, nonce}` — **no `message` field**. Sets the `bioscope_session` cookie. 400/401 per reason. |
| `POST` | `/api/auth/logout` | free | Clears the session cookie (`maxAge: 0`, same name/path/attributes). Grants nothing, verifies nothing, touches no nonce. |

`/api/auth/logout` exists because the cookie is `HttpOnly`
(`lib/session.ts:136`), so page JavaScript could not clear it — which is exactly
why disconnecting used to leave the app authenticated: the UI reset to "Connect
Wallet" but the cookie survived and the next load restored the signed-in,
unlocked state (`logout/route.ts:9-13`).

---

## 3. Environment variables

Sourced from `lib/config.ts:49-62`. **All server-side only — never prefix any of
these with `NEXT_PUBLIC_`.**

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PAY_TO` | **yes** | — | 20-byte hex address that receives x402 payments |
| `ASSET` | **yes** | — | 20-byte hex asset contract (USDC on Base Sepolia) |
| `SESSION_SECRET` | **yes** | — | HMAC key for the session cookie; min 16 chars. Rotating it invalidates every issued session |
| `NETWORK` | no | `base-sepolia` | CAIP-2 id or alias. Must be `eip155:<chainId>`; `base-sepolia`/`basesepolia`/`84532` normalize to `eip155:84532`, `base`/`8453` to `eip155:8453` (`lib/config.ts:25-29`). Anything else throws (`:97-105`) |
| `FACILITATOR_URL` | no | `https://x402.org/facilitator` | Facilitator base URL. Must be a plain base URL — a query string or fragment is rejected (`lib/x402Gate.ts:325-327`) |
| `SIWX_DOMAIN` | no | `http://localhost:3000` | Domain and URI in the SIWX challenge text |
| `APP_ORIGIN` | no | falls back to `SIWX_DOMAIN` | Base for the x402 `resource` field. Server config on purpose: deriving it from the request would let a rewritten `Host` header choose what a payment is bound to |
| `SESSION_TTL_SECONDS` | no | `86400` | Session lifetime (24h) |
| `NONCE_TTL_SECONDS` | no | `300` | SIWX challenge lifetime (5m) |
| `DATA_DIR` | no | `./data` | Where the sqlite file and frame images live. Must be **outside** `public/` |
| `REEL_PRICES` | no | see below | JSON override of the per-reel price map, USDC base units as strings |

Default prices (`lib/config.ts:42-47`):

| Reel | Frames | Price (base units) | USD |
|---|---|---|---|
| `reel-1` — Harbour at Low Tide | 24 | `10000` | $0.010000 |
| `reel-2` — Neon Underpass | 36 | `25000` | $0.025000 |
| `reel-3` — Dust and Static | 18 | `5000` | $0.005000 |

`.env` is gitignored (`.gitignore:18`). `.env.example` holds placeholders only —
its `SESSION_SECRET` is the literal string `replace-me-with-32-bytes-of-random-hex`.

---

## 4. Tests

```bash
npm test        # vitest run
npm run typecheck
npm run build
npm run lint
```

Current state, from an actual run on this repo:

```
 Test Files  11 passed (11)
      Tests  236 passed (236)
```

| File | Tests | Covers |
|---|---|---|
| `test/x402Gate.test.ts` | 53 | 402 challenge shape, verify/settle, payer identity, header dialects |
| `test/entitlement.test.ts` | 24 | route-level entitlement, session gating, per-reel scoping |
| `test/siwx.test.ts` | 26 | challenge text, nonce lifecycle, address binding, replay |
| `test/x402Client.test.ts` | 27 | browser signing, chain switch, account guards |
| `test/state.test.ts` | 22 | the wallet reducer, incl. account switch and reel change |
| `test/storage.test.ts` | 19 | `isInside()`, the outside-`public/` guard, env-only secrets |
| `test/session.test.ts` | 15 | cookie sign/verify, expiry, EIP-55 normalization |
| `test/steps.test.ts` | 16 | the UI phase ladder |
| `test/payment-history.test.ts` | 12 | repeat payments: one entitlement, many events |
| `test/migration-payment-history.test.ts` | 12 | the schema migration over the real four-payment state |
| `test/entitlement-scope.test.ts` | 10 | per-wallet and per-reel scoping, server authority |

`test/setup.ts` points `DATA_DIR` at a fresh temp directory per test file, so
sqlite state cannot leak between files.

`.env` is gitignored (`.gitignore:18`). `.env.example` contains only
placeholders — its `SESSION_SECRET` is the literal string
`replace-me-with-32-bytes-of-random-hex` (`.env.example:22`).

---

## 5. Troubleshooting

**`invalid ELF header` / `is not a valid Win32 application`.** The native
`better_sqlite3.node` in `node_modules` was built for a different platform than
the one running Node. Fix:

```bash
npm rebuild better-sqlite3
```

If that does not stick, delete `node_modules` and `package-lock.json` and
reinstall **on the machine you will actually run this on**. A binary built in WSL
will not load in Windows Node, and vice versa.

**`An IO error occurred while attempting to create and acquire the lockfile` /
`EACCES` on `npm run dev`.** `next dev` writes `.next/dev/lock` holding its pid
and removes it on a clean exit; a hard kill leaves it behind. Normally that is
survivable, but acquiring the lock goes through a native call that throws
`EACCES` instead of reporting "not acquired" on a filesystem without working
POSIX record locks — WSL's drvfs/9p mount of a Windows drive is the common case.
The dev server then exits before binding a port, and every subsequent
`npm run dev` fails identically until the file is removed by hand.

This repo ships a `predev` hook that fixes it safely
(`scripts/dev-lock.mjs`, wired as `"predev": "node scripts/dev-lock.mjs"` in
`package.json:7`). It removes the lock **only when the recorded pid is provably
gone** (checked with `process.kill(pid, 0)`, treating `EPERM` as alive), so it
can never stomp a dev server that is actually running. If the hook is absent from
your checkout, confirm nothing is listening on the port and no `next` process is
running, then delete it by hand:

```bash
rm -f .next/dev/lock
```

**Payment accepted, then the page asks to pay again on refresh.** Historically
caused by address-casing drift: purchases were stored lowercase while the session
stored EIP-55, and SQLite `=` is case-sensitive, so the row was invisible. Fixed
by `normalizeAddress` (`lib/db.ts`) plus a `COLLATE NOCASE` rebuild. If you have
an older database, the migration runs automatically on first `getDb()`; take a
backup first (`wal_checkpoint(TRUNCATE)` + `VACUUM INTO`) and note that the
running server caches its DB handle on `globalThis.__bioscopeDb`, so **restart it**
to pick the migration up.

**`SQLITE_IOERR` / `SHMOPEN` when touching `data/bioscope.db` from WSL.** SQLite
cannot get the locks it needs on a drvfs mount. Copy the database somewhere on a
native Linux filesystem to inspect it. Do **not** copy the `-shm` file — it is a
WAL index cache, and a stale copy causes SQLite to discard the entire WAL on
open, silently emptying the database. Copy `bioscope.db` and `bioscope.db-wal`
only, and let SQLite rebuild the index.

---

## 6. Verified behaviour

Be precise about what was verified and how, because the two strongest claims here
are chain-level, not browser-level.

### Settled on-chain payments (verified by RPC)

Four payments were settled through the real facilitator against Base Sepolia
mainnet-of-testnet, and each was independently confirmed by querying
`eth_getTransactionReceipt` on `https://sepolia.base.org` — every one returned a
receipt with `status: 0x1`:

| Reel | tx_hash | Block |
|---|---|---|
| `reel-1` | `0xf5ef9a3412f78107361c20d39ee52b9c08b684ff2b8833c54a58cf36b845feaa` | `0x2d2ef40` |
| `reel-2` | `0x5553df2b8053f6af04e4ba5520c9933c4eed3134ba9bf42067a0f36c6c6a4e5f` | `0x2d2ef71` |
| `reel-3` | `0xfa48a8f8f0fad6d326cd41d5e3baff5d0bb85c189f1e415027f50176d33e9e63` | `0x2d2eb84` |
| `reel-3` | `0xff35bb7197e77894d4ec5caa353049108ee327567aa67c6f300712b1508d318d` | `0x2d2ee9e` |

These are real settled transfers. Note that `reel-3` was paid for **twice** —
which is exactly the case that motivated separating the entitlement index from
the payment ledger (see §7).

### Server responses (verified against the running app)

| Request | Result |
|---|---|
| `GET /api/reels` | 200, real catalogue, `network=eip155:84532` |
| `GET /api/reels/reel-3/preview` | 200, free first frame |
| `GET /api/reels/reel-3/frames/0` | 400 `"Frame 0 is free and is served from the preview route."` |
| `GET /api/reels/reel-3/frames/1` (no session) | 401 `"Sign in required."` |
| `GET /api/reels/reel-9/frames/1` | 404 `"Reel not found."` |

### Database-level entitlement checks (verified with the real `hasPurchased`)

Against the live database with the checksummed address
`0xa801a206B4C07Fb8d94444CD8ec3FFAE78C34b10`: `reel-1`, `reel-2` and `reel-3` all
returned `true`; an unrelated reel returned `false`. All four transaction hashes
remained individually queryable, and `payment_events` held 4 rows with 4 distinct
hashes and no duplicates. Re-running the migration changed nothing.

### Not verified here

**The browser walkthrough was not performed in this environment.** No MetaMask or
browser automation was available where this was verified, so this README makes no
claim about a manual click-through: connect wallet → sign in → 402 → chain switch
→ EIP-712 signature → settle → play to "Reel finished.", nor about the follow-up
UI checks (refresh skipping payment, an account switch resetting to
Connect-Wallet, Disconnect surviving a refresh).

Those are all covered by automated tests at the state-machine and route level
(`test/state.test.ts`, `test/entitlement.test.ts`), and the settlement half of
the flow is confirmed on-chain above — but a judge should walk it themselves:

1. Fund a Base Sepolia wallet with test USDC.
2. `npm run seed && npm run dev`, open the app, connect MetaMask, sign in.
3. Open a reel you have not paid for, click Unlock, and confirm the quoted price
   matches `/api/reels`.
4. After paying, reload the same reel and confirm no payment is requested.
5. Switch MetaMask to a different account and confirm the UI drops to
   Connect-Wallet rather than showing the previous account's unlocked state.
6. Disconnect, then reload, and confirm the session is gone.

---

## 7. Bugs found and fixed during development

Each of these is a design decision that was validated by finding a real bug.

- **Chain-switch parameters.** The MetaMask chain-check sent
  add-chain-shaped parameters to `wallet_switchEthereumChain`, which only accepts
  `{ chainId }`. Fixed to try the switch first and fall back to
  `wallet_addEthereumChain` only on error code `4902` (chain unknown to the
  wallet), with the full parameter set (`lib/x402Client.ts:210-228`).

- **Facilitator URL construction.** `new URL("/verify", base)` silently discards
  the base URL's own path segment whenever the second argument begins with a
  slash. With the default `https://x402.org/facilitator` this dropped
  `/facilitator` from every request and hit a 404 HTML page instead of the real
  endpoint — a failure that looks like a server problem, not a URL bug. Fixed
  with a trailing-slash-safe joiner that also rejects a base carrying a query
  string or fragment (`lib/x402Gate.ts:315-328`).

- **No single source of truth for client identity.** With `address`,
  `signedIn`, `unlocked` and `entitlement` in separate `useState` values, a
  wallet disconnect or account switch could leave the UI asserting an identity
  MetaMask no longer authorized, and the next signature request failed with
  EIP-1193 4100. Fixed with one reducer keyed to the wallet's live account, where
  "account changed" and "disconnected" are the same transition
  (`app/reel/[id]/state.ts`).

- **The outside-`public/` assertion was wrong in both directions.** A test used
  `path.relative(...).startsWith("..")`, which fails to detect escape across
  drive letters on Windows and would false-pass a child directory literally named
  `..foo`. Fixed with a resolve-first `isInside()` helper, and tests that pin both
  directions including the Windows case on a Linux host
  (`test/storage.test.ts:64-78`, `:88-132`).

- **Identity and payment were conflated in one table.** `recordPurchase` used
  `ON CONFLICT ... DO UPDATE SET tx_hash = excluded.tx_hash`, so a repeat purchase
  for a reel you already owned **overwrote the previous transaction hash**. The
  casing bug was masking it: two payments for `reel-3` had landed in separate
  primary-key buckets and both survived, so the loss would only have begun once
  the key was fixed. Fixed by splitting the concerns — `purchases` is the
  entitlement index (one row per `(wallet, reel)`, `COLLATE NOCASE`) and
  `payment_events` is an append-only ledger with no uniqueness constraint
  (`lib/db.ts`). This is why the live database has 3 entitlement rows and 4
  payment events: the fourth payment is real and settled, and it is not silently
  discarded.

- **A stale `-shm` file can silently empty a database.** Copying
  `bioscope.db-shm` alongside the database — the intuitive "copy everything" move
  — causes SQLite to discard the entire write-ahead log on open, because the
  copied WAL index does not match. The database appears to have no tables at all.
  Only `bioscope.db` and `bioscope.db-wal` should ever be copied; SQLite rebuilds
  the index.

---

## 8. Security

**Secrets come from the environment only.** `SESSION_SECRET` is read at
`lib/config.ts:157` and nowhere else; there is no default and no fallback.
`test/storage.test.ts:354` enforces this structurally by walking the source tree
and failing if any file hardcodes or default-provides a `SESSION_SECRET` or
`PAY_TO`. `.env` is gitignored (`.gitignore:18`); `.env.example` contains only
placeholders.

A secret scan of the source tree (excluding `node_modules`, `.next`, and `data`)
for 32+ character hex runs returns **no secrets** — every hit is a test fixture:
a mock address, a synthetic transaction hash, or a dummy nonce. For example
`test/siwx.test.ts:30` and `test/entitlement.test.ts:32` contain long hex strings
that are test data, and `test/setup.ts:20` sets the literal
`test-only-secret-not-used-anywhere-else`.

**Per-wallet, per-reel scoping is true by construction.** The entitlement table
is keyed on a composite primary key:

```sql
PRIMARY KEY (wallet_address, reel_id)
```

with `wallet_address TEXT NOT NULL COLLATE NOCASE`. One row per
`(wallet, reel)` is not a convention a caller is trusted to maintain — it is the
schema's structural constraint, so a purchase for `reel-2` cannot make `reel-1`
free, and one wallet's purchase cannot unlock another's. `hasPurchased` takes
both keys and every call site passes the session's verified address
(`frames/[n]/route.ts:83`), never a value from the request body.

**Replay and expiry.** SIWX nonces are single-use, expiring, address-bound, and
burned by compare-and-swap. x402 payments are verified *and* settled by the
facilitator before any entitlement is granted — a purchase row is only written
after a successful settlement (`frames/[n]/route.ts:136`). Paid bytes are served
`private, no-store`, so one buyer is never handed another buyer's frames from a
shared cache.

---

## Layout

```
app/
  api/
    reels/route.ts                  catalogue (free, metadata only)
    reels/[id]/preview/route.ts     frame 0 — always free
    reels/[id]/frames/[n]/route.ts  the gate
    auth/nonce/route.ts             SIWX step 1
    auth/verify/route.ts            SIWX step 2
    auth/logout/route.ts            drop the session
  reel/[id]/
    page.tsx                        the player
    state.ts                        the wallet reducer
    steps.ts                        the UI phase ladder
lib/
  config.ts   env schema, CAIP-2 normalization, the outside-public/ guard
  db.ts       schema, migrations, hasPurchased, recordPurchase, payment_events
  frames.ts   frame streaming
  session.ts  HMAC-signed session cookie
  siwx.ts     challenge building and verification
  x402Gate.ts server-side 402 / verify / settle
  x402Client.ts browser-side signing
scripts/
  seed.ts       generates frames + reels table
  dev-lock.mjs  clears a stale .next/dev/lock (predev)
data/            frames + sqlite — outside public/, gitignored
```

## Licence

Hackathon submission. Testnet only.
