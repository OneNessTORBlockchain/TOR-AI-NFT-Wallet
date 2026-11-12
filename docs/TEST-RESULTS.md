# Test results — real runs, no mocks

Environment: Windows 10, Node **v24.19.0**, npm **11.17.0**, git **2.50.1**, Microsoft Edge (**headless,
`--headless=new`**), Vite **5.4.21**, TypeScript **5.6**.

Every number below came out of a terminal on **2026-11-12** against the live chain. Where a run found a
bug, the bug is kept in the record.

---

## Run 1 — `npm run verify:live` (first attempt): 18 passed, 4 failed

```
2. chain binding (the pins the wallet enforces)
  PASS  chain id equals the pin                        072316 vs 072316  (268 ms)
  PASS  genesis hash equals the pin                    fc9a220ce910b083188ee90f53561a4e3cf7c24b3723b655417e4fa34af6e156
  PASS  chain/info and chain/verify agree              head 78925b7e882e0e20… at 977 vs 78925b7e882e0e20… at 977  (189 ms)
  PASS  node re-hashed every block: in-sync            in-sync · 978 blocks · 0 errors  (981 ms)
  PASS  audit walked the pinned genesis                fc9a220ce910b083188ee90f53561a4e3cf7c24b3723b655417e4fa34af6e156
  PASS  audit reaches the quoted head                  audit 977 · info 977
  FAIL  protocol rules are attested                    none · attested=undefined  (594 ms)
  FAIL  attested by the pinned issuer key              ? ?…
  FAIL  policy hash present (drift is a warning, not a failure) none (newer than this build)
  PASS  binding digest is reproducible                 cca4b791485e995f7701ec0105e00ffd7d9589d1b99666e50f32e3f5379adcd5
...
  FAIL  node AI chat answers                           HTTP 502 · OPENROUTER_ERROR · OpenRouter answered 401  (886 ms)

18 passed · 4 failed · 2 notes
```

### Bug found and fixed

The attestation was `null` because the reader looked in the wrong place. The live node publishes it under
`data.replication.last_pull.detail.protocol`; `src/tor/chain.ts` was reading `data.last_pull` /
`data.protocol` only. Confirmed by hand:

```
$ curl -s https://www.torblockchain.fun/api/chain/sync | jq -c '.data | keys'
["catch_up","endpoints","genesis_hash","head_hash","local_height","mode","note","origin","peers",
 "replication","role","submit_endpoint","total_supply"]

$ curl -s … | jq '.data.replication.last_pull.detail.protocol'
{ "required": true, "attested": true,
  "policy_hash": "633d7ebd165daafa68bc1c747d63b7fbc06b272cb8a4efa370cd58d040b2d75c",
  "signer": { "name": "oneness-security-issuer",
              "pubkey": "F3MtFtqCkP3hzcNh5ko2iYcMhC4cjG3Z2hcTahx6APGe" },
  "standard": "oneness-tor/security-module/1" }
```

Fix: `readAttestation()` now reads `sync.protocol`, then `sync.last_pull`, then
`replication.last_pull` — so the rules do not depend on which role the node is playing. The digest also
changed (`cca4b79…` → `50168b4…`) because `policy_hash` finally entered the hashed document: proof that
the digest really covers the attestation.

**The `node AI chat` failure is not a code bug.** It stayed red in the final run.

---

## Run 2 — `npm run verify:live` (final): 21 passed, 1 failed, 2 notes

```
OneNess TOR · live verification of the wallet's security claims
  primary  https://www.torblockchain.fun
  fallback https://torblockchain.onrender.com

1. host liveness
  PASS  primary /api/health                            HTTP 200 · height 977  (248 ms)
  PASS  fallback /api/health                           HTTP 200 · height 977  (202 ms)

2. chain binding (the pins the wallet enforces)
  PASS  chain id equals the pin                        072316 vs 072316  (100 ms)
  PASS  genesis hash equals the pin                    fc9a220ce910b083188ee90f53561a4e3cf7c24b3723b655417e4fa34af6e156
  PASS  chain/info and chain/verify agree              head 78925b7e882e0e20… at 977 vs 78925b7e882e0e20… at 977  (89 ms)
  PASS  node re-hashed every block: in-sync            in-sync · 978 blocks · 0 errors  (75 ms)
  PASS  audit walked the pinned genesis                fc9a220ce910b083188ee90f53561a4e3cf7c24b3723b655417e4fa34af6e156
  PASS  audit reaches the quoted head                  audit 977 · info 977
  PASS  protocol rules are attested                    oneness-tor/security-module/1 · attested=true  (116 ms)
  PASS  attested by the pinned issuer key              oneness-security-issuer F3MtFtqCkP3h…
  PASS  policy hash present (drift is a warning, not a failure) 633d7ebd…b2d75c (matches this build)
  PASS  binding digest is reproducible                 50168b4fe378d62b77c7ef3eec1e678ae523ec286cfcc8ab0f615be58abb4393
  PASS  fallback serves the same chain                 genesis fc9a220ce910b083… · height 977  (83 ms)
  NOTE  head drift between hosts                       both hosts are at the same head

3. pricing and the AI-NFT catalogue
  PASS  nft_mint price is published                    3 TOR · locked=false  (104 ms)
  PASS  catalogue answers with a real shape            0 minted · price 3 TOR  (80 ms)

4. recipient validation (a wallet must exist on this ledger)
  PASS  founder address passes the format rule         TOR12xd7zywc3iuwcls3fqzsozkgo5ahv3gnonion (41 chars)
  PASS  the ledger answers for that address            HTTP 200 · role founder  (108 ms)
  PASS  a TOR+40hex address fails the format rule      43 chars — the chain mints 41
  PASS  the ledger also refuses it                     HTTP 400 VALIDATION_ERROR  (87 ms)

5. AI gateway (the node's own key, then BYO providers)
  PASS  node AI status is readable                     configured=true · 14 free models  (86 ms)
  PASS  free model list is non-empty                   14 models  (65 ms)
  FAIL  node AI chat answers                           HTTP 502 · OPENROUTER_ERROR · OpenRouter answered 401  (132 ms)
  NOTE  BYO key or local Ollama required while this is down

21 passed · 1 failed · 2 notes
binding digest 50168b4fe378d62b77c7ef3eec1e678ae523ec286cfcc8ab0f615be58abb4393
```

The failing call, by hand:

```
$ curl -s -X POST https://www.torblockchain.fun/api/ai/chat \
    -H 'content-type: application/json' \
    -d '{"prompt":"Reply with exactly: CHAIN-BOUND OK","model":"baidu/ernie-5.5-flash-preview:free"}'
{"ok":false,"data":null,"error":{"code":"OPENROUTER_ERROR","http_status":502,
 "message":"OpenRouter answered 401",
 "details":{"status":401,"body":"{\"error\":{\"message\":\"User not found.\",\"code\":401}}"}}}
```

The node's `OPENROUTER_API_KEY` is rejected upstream. That is the operator's fix; the wallet shows the
message rather than hiding it, and `#/ai` is the workaround.

---

## Run 3 — headless Edge, before the config fix (found a real gate, not a bug)

The first browser run reported **served by `https://torblockchain.onrender.com`** while the primary was
healthy. Cause: `.env.local` pinned `VITE_TOR_API=http://127.0.0.1:8090`, a node that was not running. So
every first request died on loopback and the client failed over to the second host — the failover doing
exactly its job, and `#/security` naming the host that answered, which is the only reason the cause was
visible at all. The headline read **"Bound, with a warning"**, 0 failures, 2 warnings (`replica` role).

A direct browser probe confirmed both hosts are reachable and CORS-open:

```
https://www.torblockchain.fun OK 200 40ms height=977
https://torblockchain.onrender.com OK 200 10ms height=977
```

`.env.local` was changed to leave both endpoints at their defaults.

## Run 4 — headless Edge, production build (final): 22/22

```
security page
  PASS  page rendered                                13281 bytes
  PASS  bound headline                               hero verdict
  PASS  not unbound                                  gate is open
  PASS  serving host shown                           endpoint panel
  PASS  nine rules listed                            rule rows with a PASS mark
  PASS  signed protocol                              standard printed
  PASS  issuer pubkey                                pinned key printed
  PASS  binding digest                               sha256 digest rendered
  PASS  audit verdict                                consensus result
  PASS  no error boundary                            clean render

AI providers page
  PASS  page rendered                                17431 bytes
  PASS  seven providers                              seven test buttons
  PASS  key inputs only                              password fields for keys
  PASS  fixed endpoints                              openai endpoint printed
  PASS  anthropic endpoint                           anthropic endpoint printed
  PASS  huggingface endpoint                         hf endpoint printed
  PASS  venice endpoint                              venice endpoint printed
  PASS  openrouter endpoint                          openrouter endpoint printed
  PASS  ollama endpoint                              local ollama printed
  PASS  no URL input box                             endpoints are not editable

overview page
  PASS  wallet renders                               shell title
  PASS  chain pill present                           guard badge in the header

SERVED BY: https://www.torblockchain.fun answered chain/info, chain/verify, chain/sync and the audit
H1: Bound to OneNess TOR
WARNs: 0
```

## Run 5 — the digest, two independent implementations

| Implementation | Digest |
| --- | --- |
| browser, `#/security`, WebCrypto `crypto.subtle.digest("SHA-256")` | `50168b4fe378d62b77c7ef3eec1e678ae523ec286cfcc8ab0f615be58abb4393` |
| `node scripts/verify-live.mjs`, `node:crypto` `createHash("sha256")` | `50168b4fe378d62b77c7ef3eec1e678ae523ec286cfcc8ab0f615be58abb4393` |

Same chain, same height (977), same bytes hashed. The browser's canonical document, read straight out of
the DOM:

```json
{"chain_id":"072316","genesis_hash":"fc9a220ce910b083188ee90f53561a4e3cf7c24b3723b655417e4fa34af6e156",
 "head_hash":"78925b7e882e0e2067535886f470a64b5841f08c9b725b59aba171441abbe082", …}
```

---

## Run 6 — build

```
$ npm run build
> tsc -b && vite build
vite v5.4.21 building for production...
✓ 51 modules transformed.
dist/index.html                   0.62 kB │ gzip:  0.37 kB
dist/assets/index-DuHZPcc2.css   19.04 kB │ gzip:  4.63 kB
dist/assets/index-D2fKODFB.js   279.27 kB │ gzip: 86.09 kB
✓ built in 1.62s
```

`tsc -b` with `"strict": true` → **0 errors**.

---

## What is still red, and why

| Red | Owner | Turns green when |
| --- | --- | --- |
| `node AI chat answers` — `502 OPENROUTER_ERROR`, upstream `401 "User not found"` | node operator | the node's `OPENROUTER_API_KEY` is replaced with a live key |
| AI-NFT catalogue empty (0 mints) | anyone | somebody mints a 1-of-1 (3 TOR) on this deployment |
| `#/market` needs the engine on `:8792` | operator | the marketplace engine is running, or the tab is left out |
| A live send/mint was **not** executed | — | it would spend real TOR from a funded wallet, and nothing here was authorised to spend. Wiring is proven up to the node's own refusal (`402`, `403`, `400 VALIDATION_ERROR`), which is what these runs exercise. |

Nothing in `src/` returns a fabricated balance, price, hash or signature. If a value is unknown the screen
is empty and says why.
