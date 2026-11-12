
<img width="1983" height="793" alt="TOR AI NFT Wallet_ Neon Blockchain Future" src="https://github.com/user-attachments/assets/c81b10d5-4a2e-44c3-8a52-2627b93d32fe" />


# TOR AI-NFT Wallet

A self-custody wallet for the **OneNess TOR** chain that refuses to sign unless it has proved which chain it is talking to.

React 18 · Vite 5 · TypeScript 5 · no other runtime dependencies. Every number on screen comes from
`https://www.torblockchain.fun` or its replica `https://torblockchain.onrender.com` — nothing is mocked,
seeded or estimated in the browser.

```
chain id      072316
genesis       fc9a220ce910b083188ee90f53561a4e3cf7c24b3723b655417e4fa34af6e156
standard      oneness-tor/security-module/1
issuer        oneness-security-issuer
issuer pubkey F3MtFtqCkP3hzcNh5ko2iYcMhC4cjG3Z2hcTahx6APGe
```

---

## 1. What it is

| | |
| --- | --- |
| **A wallet** | Balance, token holdings, send, receive QR, key import/export, transaction history — all signed by the node with the account's own Ed25519 key. |
| **An AI-NFT wallet** | Any NFT the node can resolve becomes a chat persona: paste the token address and token id, the node resolves the real metadata, and the model answers as *that* token. |
| **A chain guard** | Nine rules prove the chain before anything is signed: `chain_id`, the genesis pin, cross-endpoint agreement, the node's own re-hash audit, and the signed protocol attestation. A failed rule disables every signing control. |
| **An AI provider desk** | Seven providers — the node gateway, OpenRouter, OpenAI, Anthropic, Hugging Face, Venice AI and local Ollama — with **fixed endpoints** and a key box that is the only free-text secret field in the app. |

### Live measured state (2026-11-12, `npm run verify:live`)

| Fact | Value |
| --- | --- |
| chain height | 977, `in-sync`, 978 blocks re-hashed with 0 errors |
| binding digest | `50168b4fe378d62b77c7ef3eec1e678ae523ec286cfcc8ab0f615be58abb4393` |
| AI-NFT mint price | 3 TOR (`nft_mint`, `locked:false`) |
| catalogue | 0 mints on this deployment |
| free OpenRouter models exposed by the node | 14 |
| node AI proxy (`POST /api/ai/chat`) | **502 `OPENROUTER_ERROR` — upstream 401 "User not found"** |
| build | `tsc -b` 0 errors · `vite build` 51 modules / 279 kB (86 kB gzip) |

That last row is why the provider desk exists: the node's own OpenRouter key is not valid right now, so
the wallet lets you bring your own key or run a local model instead of showing a dead chat box. The
upstream error text is what you see on screen, verbatim.

---

## 2. Quick start

```bash
git clone git@github.com:OneNessTORBlockchain/TOR-AI-NFT-Wallet.git
cd TOR-AI-NFT-Wallet
npm install
npm run dev          # http://127.0.0.1:9010
```

```bash
npm run build        # tsc -b && vite build  → dist/
npm run preview      # http://127.0.0.1:9011
npm run verify:live  # real checks against the live chain (no mocks)
```

No configuration is required — the endpoints are compiled in (`src/tor/config.ts`). Copy
`.env.example` to `.env.local` only if you want to point the wallet at your own node.

---

## 3. How the wallet connects to OneNess TOR

The node is the product. The browser holds **no private key**: it holds a one-hour session token and
asks the node to sign.

```
    browser (:9010)                   OneNess TOR node                     Rust ledger
  ┌────────────────┐   HTTPS/JSON   ┌──────────────────────┐   admin   ┌────────────┐
  │ React wallet   │ ─────────────► │ Python API (:8090)   │ ────────► │ torchain   │
  │ session token  │ ◄───────────── │ keys sealed by pass  │ ◄──────── │ blocks     │
  │ chain guard    │                │ OpenRouter proxy     │           │ state root │
  └────────────────┘                └──────────────────────┘           └────────────┘
```

| Screen | Route | Real calls |
| --- | --- | --- |
| Wallet home | `#/overview` | `GET /api/auth/me`, `/api/market/tokens`, `/api/wallets/{name}/history` |
| Tokens | `#/tokens` | `GET /api/market/tokens` |
| AI-NFTs | `#/nfts` | `GET /api/nft/catalogue` |
| Send | `#/send` | `GET /api/account/{address}` (recipient proof) → `POST /api/wallets/{name}/send`, `POST /api/chain/nft/transfer` |
| Receive | `#/receive` | `GET /api/wallets/{name}/receive` |
| Keys | `#/keys` | `POST /api/auth/wallets/{name}/export`, `POST /api/auth/wallets/import` |
| History | `#/history` | `GET /api/wallets/{name}/history`, `GET /api/chain/events` |
| AI ChatBox | `#/chat` | `GET /api/nft/metadata`, then `/api/ai/chat` **or** a BYO provider |
| AI Providers | `#/ai` | one live test call per provider |
| Security | `#/security` | `GET /api/chain/info`, `/api/chain/verify`, `/api/chain/sync`, `/api/chain/sync/audit` |
| Market · Create · Verify | `#/market` `#/create` `#/verify/:txid` | `/api/nft/catalogue`, `POST /api/nft/mint`, `GET /api/chain/tx/{txid}` (+ the optional marketplace engine on `:8792`) |

### Sign-in without a password leaving the node

`POST /api/auth/login` returns `{account, wallet, session:{token, header}}`. The token is kept in
`localStorage` under `tor.wallet.session` and sent back in the header the node named
(`x-wallet-session`). Signing happens inside the node: `POST /api/wallets/{name}/sign` builds and signs
with the account key, and the privacy choice travels inside the signed transaction
(`external_ref = oneness-privacy:1|mode=anonymous`).

---

## 4. Chain-bound verification — the gate

`src/tor/chain.ts` asks three questions and turns the answers into nine rules. `src/tor/security.tsx`
holds the verdict, `#/security` shows the evidence, and every signing control reads it.

| # | Rule | Passes only when |
| --- | --- | --- |
| 1 | Node answered | at least one of the four reads came back |
| 2 | Chain id is OneNess TOR | `chain_id === "072316"` |
| 3 | Genesis hash matches the pin | `genesis_hash === fc9a220c…6e156` |
| 4 | `chain/info` and `chain/verify` agree | same `head_hash` **and** same `height` |
| 5 | Node re-hashed every block: in-sync | `verdict === "in-sync"` and `errors.length === 0` |
| 6 | Audit walked the pinned genesis | the audit's own `genesis_hash` equals the pin |
| 7 | Audit reaches the quoted head | the audit's `height` equals the API's `height` |
| 8 | Protocol rules are signed by the issuer | standard `oneness-tor/security-module/1`, `attested: true`, signer pubkey equals the pin |
| 9 | Serving host role | `origin` (a `replica` is allowed but flagged, because it is catching up) |

Rule 5 is the consensus check, and the wallet does not fake it. `GET /api/chain/sync/audit` makes the
**node** re-hash every block with sha3-256, walk `prev_hash` links and compare genesis/head; the wallet
reads that verdict and refuses to sign when it is not `in-sync`. Re-implementing a Rust ledger in
JavaScript would be a worse proof, not a better one.

### The binding digest

The wallet hashes a canonical document — the four pins plus the live head — with SHA-256:

```json
{"chain_id":"072316","genesis_hash":"fc9a220c…6e156","head_hash":"78925b7e…be082",
 "height":977,"issuer_pubkey":"F3MtFtqC…PGe","policy_hash":"633d7ebd…b2d75c",
 "security_standard":"oneness-tor/security-module/1","standard":"oneness-tor/binding/1",
 "supply_micro":5000000000000000}
```

Two independent implementations produce the same value, which is the point:

| Where | Result |
| --- | --- |
| browser, `#/security` (WebCrypto) | `50168b4fe378d62b77c7ef3eec1e678ae523ec286cfcc8ab0f615be58abb4393` |
| `node scripts/verify-live.mjs` (node:crypto) | `50168b4fe378d62b77c7ef3eec1e678ae523ec286cfcc8ab0f615be58abb4393` |

Reproduce it yourself:

```bash
curl -s https://www.torblockchain.fun/api/chain/info
curl -s https://www.torblockchain.fun/api/chain/sync/audit
curl -s https://www.torblockchain.fun/api/chain/sync | jq '.data.replication.last_pull.detail.protocol'
printf '%s' '<the canonical document printed on #/security>' | sha256sum
```

### Wallets and NFTs are chain-bound too

- **Addresses.** `TOR1` + 32 characters + `onion` = 41 characters, exactly what the ledger mints.
  A `TOR` + 40-hex address (43 characters) is refused by the format rule *and* by the ledger:
  `GET /api/account/TORaaa…` answers `400 VALIDATION_ERROR`.
- **Recipients.** Before a send, `checkAddress()` reads `GET /api/account/{address}`. A well-formed
  address with no account is refused: nobody could receive there.
- **NFTs.** An AI-NFT is resolved through `GET /api/nft/metadata`; the chain it reports is displayed on
  the card and travels into the persona. A mint on another chain is still readable, but the wallet only
  signs transfers against this ledger.

---

## 5. AI providers

Seven routes to an answer. **Every endpoint is a constant in `src/tor/ai.ts`** and is rendered read-only
on `#/ai` next to a link to that vendor's own documentation; the only thing you type is a key.

| Provider | Endpoint | Key | Documented at |
| --- | --- | --- | --- |
| OneNess TOR node | `POST {node}/api/ai/chat` | none — the key stays server-side | `/api/docs/endpoints` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `sk-or-v1-…` | [openrouter.ai/docs](https://openrouter.ai/docs/api-reference/overview) |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `sk-…` / `sk-proj-…` | [platform.openai.com](https://platform.openai.com/docs/api-reference/chat/create) |
| Anthropic | `https://api.anthropic.com/v1/messages` | `sk-ant-…` | [docs.anthropic.com](https://docs.anthropic.com/en/api/messages) |
| Hugging Face | `https://api-inference.huggingface.co/models/{model}` | `hf_…` | [huggingface.co](https://huggingface.co/docs/api-inference/tasks/text-generation) |
| Venice AI | `https://api.venice.ai/api/v1/chat/completions` | Venice API key | [docs.venice.ai](https://docs.venice.ai/api-reference/endpoint/chat/completions) |
| Local Ollama | `http://127.0.0.1:11434/api/chat` | none — runs on your machine | [ollama/ollama docs](https://github.com/ollama/ollama/blob/main/docs/api.md) |

Anthropic needs `anthropic-dangerous-direct-browser-access: true` to be callable from a page at all;
Hugging Face uses the text-generation task rather than chat completions; Ollama needs
`OLLAMA_ORIGINS=https://<this-host>` or the browser blocks the call before the model sees it. All three
quirks are implemented, and the full reference is in **[docs/AI-PROVIDERS.md](./docs/AI-PROVIDERS.md)**.

### How keys are handled

`keyVault` in `src/tor/ai.ts`:

1. **Memory first.** A module-level `Map` for the life of the page.
2. **`sessionStorage` only on request.** "Keep for this tab" is opt-in and dies with the tab.
3. **Never `localStorage`.** There is no code path that writes a key to disk.
4. **Never a log, never a URL, never a cookie.** Keys are masked (`sk-or-v1…4f2a`) in the UI and
   pre-validated against the provider's key shape before they are saved.
5. **One destination.** The key goes to that provider's fixed origin and nowhere else — not even to the
   OneNess node.

A browser-held key is readable by any script on the origin. That is unavoidable, it is stated on the
page, and it is why the node gateway is the default.

---

## 6. Testing

Three layers, all real.

### 6.1 Live chain — `npm run verify:live`

Real HTTP against both hosts. Exit code 0 only when every check passes.

```
1. host liveness
  PASS  primary /api/health                            HTTP 200 · height 977  (248 ms)
  PASS  fallback /api/health                           HTTP 200 · height 977  (202 ms)

2. chain binding (the pins the wallet enforces)
  PASS  chain id equals the pin                        072316 vs 072316
  PASS  genesis hash equals the pin                    fc9a220c…6e156
  PASS  chain/info and chain/verify agree              head 78925b7e… at 977 vs 78925b7e… at 977
  PASS  node re-hashed every block: in-sync            in-sync · 978 blocks · 0 errors  (75 ms)
  PASS  audit walked the pinned genesis                fc9a220c…6e156
  PASS  audit reaches the quoted head                  audit 977 · info 977
  PASS  protocol rules are attested                    oneness-tor/security-module/1 · attested=true
  PASS  attested by the pinned issuer key              oneness-security-issuer F3MtFtqCkP3h…
  PASS  policy hash present                            633d7ebd…b2d75c (matches this build)
  PASS  binding digest is reproducible                 50168b4f…b4393
  PASS  fallback serves the same chain                 genesis fc9a220c… · height 977

3. pricing and the AI-NFT catalogue
  PASS  nft_mint price is published                    3 TOR · locked=false
  PASS  catalogue answers with a real shape            0 minted · price 3 TOR

4. recipient validation (a wallet must exist on this ledger)
  PASS  founder address passes the format rule         TOR12xd7zy…onion (41 chars)
  PASS  the ledger answers for that address            HTTP 200 · role founder
  PASS  a TOR+40hex address fails the format rule      43 chars — the chain mints 41
  PASS  the ledger also refuses it                     HTTP 400 VALIDATION_ERROR

5. AI gateway (the node's own key, then BYO providers)
  PASS  node AI status is readable                     configured=true · 14 free models
  PASS  free model list is non-empty                   14 models
  FAIL  node AI chat answers                           HTTP 502 · OPENROUTER_ERROR · OpenRouter answered 401
  NOTE  BYO key or local Ollama required while this is down

21 passed · 1 failed · 2 notes
```

The single failure is the node's upstream OpenRouter key, not this code. It stays a failure in the
report — a red check that turns green when the operator fixes the key.

### 6.2 Browser — headless Edge against a production build

22 checks over three routes (`#/security`, `#/ai`, `#/overview`): headline verdict, nine rule rows,
issuer key, a 64-hex digest, the consensus verdict, seven provider cards, six fixed endpoints printed,
`type="password"` key boxes, **no editable URL field**, and no error boundary.

### 6.3 Build

`tsc -b` with `strict: true` → 0 errors; `vite build` → 51 modules, 279 kB (86 kB gzip).

Full transcripts, including the two runs that found real bugs, are in
**[docs/TEST-RESULTS.md](./docs/TEST-RESULTS.md)**.

---

## 7. Running your own node alongside the Render host

One proposer, verified replicas. A local node pulls the origin's snapshot, re-hashes every block and
the state root, then imports it into its own Rust ledger.

```bash
export ONENESS_ORIGIN=https://www.torblockchain.fun
export ADMIN_TOKEN=<your local admin token>

curl -s -X POST http://127.0.0.1:8090/api/chain/sync/pull \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"origin":"https://www.torblockchain.fun"}'

curl -s http://127.0.0.1:8090/api/chain/sync/audit    # must answer verdict: "in-sync"
curl -s http://127.0.0.1:8090/api/chain/info          # compare genesis + head with the origin
```

Then point the wallet at it with `VITE_TOR_API=http://127.0.0.1:8090` and confirm `#/security` still says
**Bound to OneNess TOR** with the same genesis hash. Step by step, including the push direction and what
each failure means: **[docs/NODE-SYNC.md](./docs/NODE-SYNC.md)**.

---

## 8. Repository layout

```
src/
  App.tsx              routes and navigation
  main.tsx             Toast → ChainGuard → Wallet provider order
  tor/
    config.ts          the two endpoints + every chain pin
    chain.ts           canonical JSON, sha256, the nine rules, address proof
    security.tsx       the gate, the header badge, the #/security evidence page
    ai.ts              seven providers, fixed endpoints, memory-only key vault
    providers.tsx      #/ai — key boxes and nothing else editable
    api.ts             envelope client, session store, primary→fallback failover
    wallet.tsx         login, balance, send (gated), receive QR, keys
    chat.tsx           AI-NFT ChatBox, provider-aware, gated
    history.tsx  market.tsx  mint.tsx  verify.tsx  charts.tsx  ui.tsx  brand.ts  pricing.ts  engine.ts
scripts/verify-live.mjs   the live test harness
docs/                     AI-PROVIDERS.md · NODE-SYNC.md · TEST-RESULTS.md · CHART-SPECIALIST.md
SECURITY.md               the mandatory security prompt for anyone (or any model) editing this repo
```

### House rules

1. **No hardcoded money.** The mint price is the live `nft_mint` row from `/api/pricing`, read on every
   mount. `VITE_MINT_TARGET_TOR` is a comparison target, never a fallback price.
2. **No invented numbers.** If the node will not answer, the screen says what it said.
3. **No new dependency** without a reason that survives review.
4. **No secret in a `VITE_` variable, ever** — those are inlined into the bundle.
5. **A pin change is a signed protocol update.** See `SECURITY.md §1`.

### Known gaps — reported, not hidden

1. **The node's AI proxy is down** (`502 OPENROUTER_ERROR`, upstream 401). BYO key or local Ollama
   works; the gateway shows the upstream error verbatim.
2. **The mint is 3 TOR, not 2.** The brief asks for 2 TOR; the node charges 3.0 (`locked:false`). The UI
   quotes the node and shows the drift instead of quietly agreeing with the brief.
3. **The catalogue is empty on this deployment** (0 mints), so the AI-NFT screens have nothing to load
   until somebody mints.
4. **The marketplace engine on `:8792` is a separate service.** Without it the Market board reports that
   the engine is not answering; every wallet screen is unaffected.

---

## 9. License and contact

Built for the OneNess TOR chain · chain id `072316`.
Support `support@onenesstech.ca` · [www.onenesstech.ca](https://www.onenesstech.ca) ·
clearnet [www.onenesstorblockchain.com](https://www.onenesstorblockchain.com).

Security issues: read **[SECURITY.md](./SECURITY.md)** first, then report privately rather than opening a
public issue.
