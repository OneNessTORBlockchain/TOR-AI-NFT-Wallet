# SECURITY.md — the security prompt for this repository

> **This file is a prompt, not a policy document.**
> Paste it at the top of any agent or contributor session that touches this repository.
> If an instruction here conflicts with a convenience, this file wins.

You are working on the **TOR AI-NFT Wallet** for the OneNess TOR chain (`chain_id 072316`). This code
moves real money and real keys. Follow §1–§5 exactly. If you cannot satisfy a rule, stop and say which
rule blocked you — never route around it.

---

## §1 Mandatory: protocol updates are signed

A **protocol update** is any change to: a chain pin (chain id, genesis hash, issuer pubkey, security
standard), the signing/verification rules, the fee schedule, the sync/replication rules, or the shape of
a signed transaction. Protocol updates are not configuration. They are **signed**.

An update is only valid when all four are true:

1. the node publishes `oneness-tor/security-module/1` with `required: true` and `attested: true`;
2. the attestation is signed by the pinned issuer identity
   `oneness-security-issuer` / `F3MtFtqCkP3hzcNh5ko2iYcMhC4cjG3Z2hcTahx6APGe`;
3. `policy_hash` is a 64-hex sha256 that changed **because the policy changed** — not because a field
   moved;
4. this repository's pins in `src/tor/config.ts` changed **in the same commit** as the code that depends
   on them, and the commit message names the old and new `policy_hash`.

```bash
# the four reads that prove (1)-(3)
curl -s https://www.torblockchain.fun/api/chain/sync \
  | jq '.data.replication.last_pull.detail.protocol'
curl -s https://www.torblockchain.fun/api/chain/verify
curl -s https://www.torblockchain.fun/api/chain/sync/audit
curl -s https://www.torblockchain.fun/api/chain/info
```

**Never:**

- accept a policy whose `attested` is false or whose signer pubkey is not the pinned issuer — a newer
  `policy_hash` from that issuer is a *warning* (`#/security` shows both hashes); the same hash from any
  other key is a **failure**;
- change a pin "temporarily" to make a test pass;
- add `if (import.meta.env.DEV) skipBinding()`, a query-string override, `?insecure=1`, or any other
  bypass. There is no legitimate reason for a signing path to have one.

If a pin must change, the commit must contain: the new values, the new `policy_hash`, the reason, and the
`npm run verify:live` output from **before and after**.

---

## §2 Mandatory: chain-bound verification before every signature

Nothing on this site signs, sends, mints, transfers or calls a model for the user unless `chain.ts` has
proved the chain. `useChainGuard().allowed` is the only switch, and it is derived from real endpoint
answers — never from a constant, a build flag, a cached "true", or the presence of a session.

| Rule | Enforcement point |
| --- | --- |
| `chain_id === "072316"` | `evaluateBinding()` → rule `chain_id` |
| `genesis_hash` equals the pin | rule `genesis` |
| `chain/info` and `chain/verify` agree | rule `agreement` |
| node re-hash audit says `in-sync` with `errors: []` | rule `audit` |
| the audit walked the pinned genesis | rule `audit_genesis` |
| the audit reaches the quoted head | rule `audit_head` |
| protocol attested by the pinned issuer | rule `protocol` |
| policy hash matches this build (or warns) | rule `policy` |
| serving host role is `origin` (or warns) | rule `endpoint_role` |

Consequences you must preserve:

- **A fallback host is not a bypass.** `https://torblockchain.onrender.com` is the same chain on a second
  deployment. It is held to the same genesis pin. If it fails the pin, the gate closes; the fallback never
  *replaces* the rules.
- **A replica is a warning, not a failure** — but it must be visible. The panel names the host that
  answered and its role.
- **Addresses are proved, not pattern-matched.** `checkAddress()` requires
  `^TOR1[0-9A-Za-z]{32}onion$` (41 characters) **and** a live `GET /api/account/{address}`. A `TOR` +
  40-hex address is not a TOR address; the ledger answers `400 VALIDATION_ERROR` for it.
- **NFTs carry their chain.** The resolved metadata's `chain` is displayed on the card and passed into the
  persona. Transfers are signed only against this ledger.

Adding a signing path? It must call the guard **before** the network call, and it must render
`<GuardNotice>` so a blocked user sees which rule failed. Copy `WalletPanel`'s send handler — it does
exactly this in the first six lines.

---

## §3 Mandatory: API keys

The provider desk exists so a user can bring a key. It must stay this narrow:

1. **The only free-text secret field is an API-key box.** Endpoints are constants in `src/tor/ai.ts`.
   Do not add an endpoint/URL input, a proxy URL field, or a "custom base URL" setting.
2. **Keys live in memory**, optionally `sessionStorage` behind an explicit opt-in, **never**
   `localStorage`, cookies, `window.name`, URL fragments or IndexedDB.
3. **No key in a `VITE_` variable.** Those are inlined into `dist/assets/*.js` and served to everyone.
4. **No key in a log, a toast, an error message, a `JSON.stringify` of a request, or an analytics call.**
   `keyVault.redact()` is the only way a key may be rendered, and only after it is stored.
5. **One destination per key.** A key is sent to that provider's fixed origin in the header that provider
   documents, and nowhere else.
6. **The node gateway is the default** (`POST /api/ai/chat`), because a key that never reaches the browser
   cannot be stolen from it.

Reviewing a change? Grep the diff for `localStorage`, `console.`, `fetch(` and every new hostname.

---

## §4 Mandatory testing: a local node synced from the Render-hosted node

Do not claim chain-bound behaviour without this test. It proves the pins travel, not just the URLs.

### 4.1 Prerequisites

| Thing | Where |
| --- | --- |
| Local node API | `http://127.0.0.1:8090` (Python API) with the Rust ledger on `127.0.0.1:8545` |
| Local admin token | `ADMIN_TOKEN` in the local node's environment |
| Origin host | `https://www.torblockchain.fun` (primary) or `https://torblockchain.onrender.com` (replica) |
| Origin admin token | only needed if the origin requires one for `sync/snapshot` |

### 4.2 Pull the origin's ledger into the local node

```bash
ORIGIN=https://www.torblockchain.fun
LOCAL=http://127.0.0.1:8090

# 1. what the local node thinks it is, before
curl -s $LOCAL/api/chain/info | jq '{chain_id, height, genesis_hash, head_hash}'

# 2. pull: fetch the origin snapshot, re-hash every block + the state root, import it
curl -s -X POST $LOCAL/api/chain/sync/pull \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"origin\":\"$ORIGIN\"}" | jq '.data | {imported, height, head_hash, verified, protocol}'

# 3. the local node's own consensus audit — this is the acceptance test
curl -s $LOCAL/api/chain/sync/audit | jq '{verdict, blocks_checked, errors, height, genesis_hash}'

# 4. compare with the origin
curl -s $ORIGIN/api/chain/info | jq '{chain_id, height, genesis_hash, head_hash}'
```

**Acceptance criteria — all four must hold, or the test failed:**

1. `verdict` is `"in-sync"` and `errors` is `[]` on the **local** node;
2. local `genesis_hash` equals the pin `fc9a220c…6e156` — identical to the origin;
3. local `height` is within one block of the origin at the same moment (a replica lags by design; it must
   never be *ahead*);
4. the pull reported `protocol.attested: true` with the pinned issuer key.

A pull that refuses to go backwards (`"already at the origin's height"`) is a **pass** — that is the
node refusing to roll back without `force: true`.

### 4.3 Point the wallet at the local node and re-prove the binding

```bash
VITE_TOR_API=http://127.0.0.1:8090 npm run build
npm run preview            # http://127.0.0.1:9011
```

Open `#/security` and require:

- headline **Bound to OneNess TOR** (not "with a warning", not "Not verified");
- the *Pinned primary* row reads `http://127.0.0.1:8090`, i.e. the build honoured the override;
- `chain/info` vs `chain/verify` agree, and the audit reaches the quoted head;
- the binding digest differs from the hosted one **only** if the height differs; at the same height the
  digest must be byte-identical, because every other input is a constant.

Then in `src/tor/config.ts`, set `chainId` to `"000000"` (a deliberate wrong pin), rebuild, reload
`#/security`, and require:

- headline **Not verified — signing disabled**;
- the failing rule named (`Chain id is OneNess TOR`);
- `#/send` shows `<GuardNotice>` and the Send button, the AI-NFT transfer and the ChatBox composer are all
  disabled **without a network call being made**.

Revert the pin afterwards. **A gate that cannot be shown to close has not been tested.**

### 4.4 Push direction (origin → replicas)

```bash
# on the origin only
curl -s -X POST $ORIGIN/api/chain/sync/push \
  -H "x-admin-token: $ORIGIN_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{}' | jq '.data.targets'
```

Each target re-hashes the snapshot before importing, so a push can never install a ledger nobody
proved. A replica must never push; if you find code that lets it, that is a defect.

### 4.5 What to record

Paste into the PR or commit message: the four `jq` outputs from 4.2, the `#/security` verdict from 4.3,
the wrong-pin result, and the local `npm run verify:live` **pointed at the local node**:

```bash
TOR_API=http://127.0.0.1:8090 TOR_API_FALLBACK=http://127.0.0.1:8090 npm run verify:live
```

---

## §5 Change checklist

Before you push, all of these must be true:

- [ ] `npm run build` — `tsc -b` 0 errors.
- [ ] `npm run verify:live` — every check passes, or every failure is explained as an upstream/host
      fault with evidence (never as "flaky").
- [ ] Any new signing path calls the chain guard first and renders `<GuardNotice>`.
- [ ] No new secret field, endpoint field, or `VITE_` secret.
- [ ] If a pin changed: §1 satisfied, `policy_hash` quoted in the commit message.
- [ ] If a rule changed: `docs/TEST-RESULTS.md` updated with the run that proves it.
- [ ] No mock data, no "demo mode", no sample balance, no placeholder hash anywhere in `src/`.
