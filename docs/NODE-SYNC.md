# Syncing a local node with the Render-hosted node

The chain runs **one proposer, verified replicas**. `https://www.torblockchain.fun` is the origin;
`https://torblockchain.onrender.com` is a replica of the same ledger; a node you run yourself is a replica
too. A replica pulls, re-hashes, and imports — it never proposes a block and never pushes.

```
                 ┌──────────────────────────┐
   propose ────► │ origin  www.torblockchain.fun │
                 └────────────┬─────────────┘
                              │ GET  /api/chain/sync/snapshot      (replica pulls)
                              │ POST /api/chain/sync/push          (origin pushes)
                              ▼
        ┌───────────────────────────────┐     ┌──────────────────────────────┐
        │ replica  onrender            │     │ replica  your machine        │
        │ POST /api/chain/sync/accept  │     │ POST /api/chain/sync/pull    │
        └───────────────────────────────┘     └──────────────────────────────┘
                    both re-hash before importing
```

---

## 1. Environment

| Variable | Node | Meaning |
| --- | --- | --- |
| `ADMIN_TOKEN` | every node | local admin token; required for `pull`, `push`, `accept`, `snapshot` |
| `ONENESS_ORIGIN` | replica | the origin to pull from |
| `ONENESS_ORIGIN_TOKEN` | replica | origin's admin token, only if the origin requires one for `snapshot` |
| `VITE_TOR_API` | wallet build | point the wallet at your node (`http://127.0.0.1:8090`) |

The origin is also resolved from `config.fleet.yaml`, which keeps a node that does not hold the origin
token a **read-only replica**. That is why a node without the token cannot push.

---

## 2. Pull (replica ← origin)

```bash
ORIGIN=https://www.torblockchain.fun
LOCAL=http://127.0.0.1:8090

curl -s -X POST $LOCAL/api/chain/sync/pull \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"origin\":\"$ORIGIN\"}"
```

What the node does, in order:

1. `GET $ORIGIN/api/chain/sync/snapshot` — the whole ledger (`state` + every block + txs);
2. re-hash **every block** and the **state root** locally;
3. compare `genesis_hash` with its own — a mismatch aborts;
4. refuse to go backwards (`force: true` overrides, and you should need a reason);
5. swap `state.json` + `blocks.jsonl` **atomically**;
6. record the attestation: `protocol.attested`, `policy_hash`, issuer pubkey.

```json
{"ok":true,"data":{"imported":true,"height":977,"verified":{"head_hash":"78925b7e…",…},
 "protocol":{"required":true,"attested":true,
             "policy_hash":"633d7ebd…b2d75c",
             "signer":{"name":"oneness-security-issuer","pubkey":"F3MtFtqC…PGe"},
             "standard":"oneness-tor/security-module/1"}}}
```

A pull that answers `"already at the origin's height"` with `skipped: true` is **success**, not a no-op
failure.

## 3. Audit (the acceptance test)

```bash
curl -s $LOCAL/api/chain/sync/audit \
  | jq '{verdict, blocks_checked, pages, truncated, errors, height, genesis_hash, head_hash}'
```

Require `verdict: "in-sync"`, `errors: []`, `truncated: false`, and `height` equal to the origin's at the
same moment. This is the same call `#/security` reads; a local node that fails it must be fixed before
anyone trusts a wallet pointed at it.

## 4. Push (origin → replicas)

```bash
# on the origin
curl -s -X POST $ORIGIN/api/chain/sync/push \
  -H "x-admin-token: $ORIGIN_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"force":false}'
```

The origin exports its verified snapshot, keeps a copy in `data/snapshots`, and POSTs it to every
configured target, which runs the same re-hash before importing (`POST /api/chain/sync/accept`). A push
can therefore never install a ledger nobody proved.

## 5. Catch-up without a snapshot

For small gaps the block range endpoint is cheaper:

```bash
curl -s "$LOCAL/api/chain/blocks?from=970&to=977"
```

`max_blocks_per_call` is 500; page through it rather than asking for a thousand.

---

## 6. Point the wallet at the local node

```bash
VITE_TOR_API=http://127.0.0.1:8090 npm run build
npm run preview        # http://127.0.0.1:9011
```

`#/security` must still say **Bound to OneNess TOR**, name `http://127.0.0.1:8090` as the pinned primary,
and show the same genesis hash. At the same height the binding digest is identical to the hosted one,
because every other input is a constant.

---

## 7. Troubleshooting

| Symptom | Meaning | Do |
| --- | --- | --- |
| `403` on `pull`/`push`/`accept` | no or wrong `ADMIN_TOKEN` | set it on **that** node; a replica without the origin token stays read-only by design |
| `genesis mismatch` | the snapshot is a different chain | stop: the origin is not the chain you think. Compare `genesis_hash` with the pin |
| `verdict: "out-of-sync"` + `errors[]` | the local ledger did not re-hash | discard the local chain data and pull again; report the first error verbatim |
| `truncated: true` in the audit | the audit stopped early (block budget) | re-run; an incomplete audit is not a pass |
| `skipped: true, same_head: true` | already current | nothing — this is a pass |
| wallet says **Not verified** while `curl` works | the browser was blocked (mixed content, or `http://` from an `https` page) | serve the wallet over `http://127.0.0.1:9010` and retry |
| `role: "replica"` warning on `#/security` | you are pointed at a replica | fine — it is the same chain; the warning is informational |

## 8. What a replica must never do

- push a block to the origin;
- accept a snapshot without re-hashing it;
- roll back a lower head without an explicit `force: true`;
- serve a `genesis_hash` that differs from the pin — the wallet would (correctly) refuse to sign.
