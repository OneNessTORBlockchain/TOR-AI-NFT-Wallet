# Chart Specialist — briefing + platform guide

**To:** the Chart Specialist (you build every chart in this wallet)
**From:** the agent that restored this wallet and ran it live against the node
**Date of record:** 2026-10-28 (local) · node clock `2026-10-31T15:27Z` · height **3021** · chain id **072316**
**Rule of this document:** every number below was measured on this machine in this run. Where
something is *not* proven, it says so in §9 instead of sounding confident.

Read all of §1–§4 before you open an editor. §5 is the part that keeps the charts honest, and §6
is how your work gets accepted.

---

## 1. The platform as it stands right now (verified)

| Port | What | Evidence from this run |
| --- | --- | --- |
| **:9010** | this wallet, Vite dev (pid 62936) | `GET /` → **200**, 798 B |
| :9011 | `vite preview` of `dist/` (pid 39696) | 200 |
| **:8090** | OneNess TOR node API (python, pid 35420) | `/api/health` → `status:"ok"`, `height:3021`, `chain_id:"072316"`, `version:"1.0.0"`, `node_url:http://127.0.0.1:8545` |
| :8792 | marketplace engine (node, pid 63484) | `GET /` → 200, serves the board SPA + `/api/nft/board` |

Wallet build, verified at the end of this run: `npm run build` → exit 0, **44 modules**,
`dist/assets/index-wNmog8c9.js` **221.67 kB** (gzip 67.83 kB) + `index-DKVtxZst.css` 16.82 kB.
The first build of this run produced `index-Bw9_APcJ.js` 219.61 kB / 44 modules; `src/tor/wallet.tsx`
was then edited (21 896 B → 26 588 B) by concurrent work, which is the +2 kB. **Quote the hash of your
own build** — this line is a reference point, not a contract.

**Baseline has already moved past charts.** At 11:54 the tree was rebuilt with `src/tor/charts.tsx`
(33 067 B) in place: `dist/assets/index-DmHBjoh6.js` **233.38 kB** + `index-DcFFLfkA.css` 18.26 kB,
and `#/charts` / `#/charts/<SYMBOL>` already route to `ChartStudio`, `TokenPriceChart`,
`ChainEventChart`, plus a `Chart` pill per row on the tokens table and a sparkline on Overview. So
if you are extending the charts, measure your delta against **233.38 kB**, not 221.67 kB — and read
what is already there before rewriting it.

`.state/shot-9010.png` (1440×1100) was captured before that edit and shows the live page: header nav
(Wallet · Tokens · AI-NFTs · Send · Receive · History · Keys · AI ChatBox · Market · Create), the TOR
PUMP banner, and node numbers on screen (`TOR price $3.60 · Listed tokens 122 · chain id 072316`).
The browser was proven to hold a real socket to `:8090`, so the page is *reading the node*, not
rendering fixtures.

`vite.config.ts` ignores `**/.state/**` in the dev watcher. That folder is where verification
artifacts go (DOM dumps, probes, screenshots). Writing there does **not** reload the page — use it.

### How to drive the platform

```powershell
cd 'C:\Users\KATHY\Downloads\TOR AI-NFT WALLET'
npm run dev                 # :9010, HMR
npm run build               # tsc -b && vite build — must stay at 0 errors
npm run preview             # :9011, serves dist/

# one chart sample, timed
$sw=[Diagnostics.Stopwatch]::StartNew()
Invoke-RestMethod 'http://127.0.0.1:8090/api/market/chart/TOR?points=24' -TimeoutSec 90 |
  ForEach-Object { $sw.Stop(); "pts=$($_.data.points) interval=$($_.data.interval) $($sw.ElapsedMilliseconds)ms" }
```

Node and engine are **not yours to restart**. They are shared; restarting them drops other people's
sessions. If the node misbehaves, report it (§8), don't restart it.

---

## 2. Your assignment, in build order

Mount everything in the existing screens. Do not invent routes unless a step says so, and never
change the nav order in `src/App.tsx` (`NAV`, line 22).

**C1 — TOR rate strip on `#/overview`.** TOR's own series on this chain is `1.0` by definition
(§4.1). Do **not** draw TOR candles: draw a rate strip (price / 24 h / liquidity / holders as cells)
from `GET /api/market/overview` — **10 ms**, and it carries the whole `tor` block (§4.2; the
single-object `/api/market/tor` is the same data but takes 8.2 s, so don't use it for a strip).
Mount inside `Overview()` (`src/App.tsx:90`) under the three `Stat` cards.

**C2 — candlestick panel on `#/tokens`, driven by selection.** `Tokens()` is `src/App.tsx:253`. Add a
chart panel above the table and a **Select** action per row. Only the selected symbol is fetched —
one request, on demand. Never fetch a chart per table row: 123 rows × 1.4–25 s per call will take the
node down (§4.1, §4.7).

**C3 — sparkline column, opt-in.** Same rule: sparkline **only** for rows already in view *after* the
C2 chart for that symbol has been fetched, reusing that cached payload. No second request per row.

**C4 — pool depth chart** for the selected symbol, from `/api/market/pools` (fast: 24 ms). Reserves
are `token_reserve` / `tor_reserve` / `price_tor`; draw the levels the node actually published and
label the axis in TOR.

**C5 — liquidity split** (donut or bars) from the same pools payload: 172 books, `tor_pools: 122`,
`usdc_pools: 50`. This is a *composition* chart, not a time series — it is fully supported today.

**C6 — AI-NFT market panel on `#/market`.** `GET :8792/api/nft/board` gives counts, floor and every
ask, but **no history** (§4.6). So: counts, floor, ask spread, fee basis — as numbers and bars. A
"floor over time" line does not exist yet; do not draw one.

---

## 3. House rules — how code is written on this platform

These are not preferences; the whole repo is consistent and a reviewer will reject anything that
breaks them.

1. **No new runtime dependencies.** `package.json` has `react`, `react-dom` and nothing else.
   `lightweight-charts` is **not** a dependency here and must not become one without the Captain's
   approval. Draw with inline **SVG** — it survives DOM dumps, screenshots and `aria-*` labelling,
   and it adds 0 kB. Canvas is allowed only if you can show SVG cannot do the job.
2. **One data path.** Everything goes through `src/tor/api.ts`: `API_BASE`, the `{ok,data,error}`
   envelope, `request()`, `api.get<T>(path, timeoutMs?)`, `TorError` carrying the node's own code and
   `http_status`. Never a bare `fetch` to `:8090` in a component, never a hardcoded URL literal.
   Engine calls go through `src/tor/engine.ts` (`engineGet`, `engine.board`, `engine.health`).
3. **Errors are the node's words.** A screen shows `problem.message` (e.g. `NFT_NOT_FOUND`) plus a
   retry — never "Something went wrong", never a fabricated fallback point.
4. **Loading state is `useAsync`** (`src/tor/ui.tsx:238`) or a local `useState` + `AbortController` if
   you need abort-on-unmount. Skeletons use `.skeleton`; empty panels use `<Empty>`.
5. **Format numbers with `src/tor/brand.ts`**: `money()` (USD), `tor()` (TOR + unit), `compact()`
   (K/M/B for volume), `pct()`, `shortAddress()`, `relative()` (timestamps). No ad-hoc
   `toFixed` sprinkled in JSX for money.
6. **Style with the design system, not inline hex.** Tokens are in `src/tor/styles.css` §`root`
   (`--accent`, `--accent-2`, `--good`, `--bad`, `--warn`, `--muted`, `--line`, `--panel`,
   `--radius`, `--glow`); direction colour is `var(--good)` / `var(--bad)`; surfaces are `.panel`,
   layout is `.stack` / `.row` / `.spread` / `.grid cols-2|3|4`; chips are `.pill`; labels are
   `.muted tiny`; numbers in tables get `className="num"`. A chart container reuses the existing
   `.chart { width:100%; height:auto; display:block }` rule (line 233) — extend it in
   `styles.css` under the `/* charts */` banner rather than inventing a CSS island.
7. **Accessibility is part of the chart**: `role="img"`, an `aria-label` carrying the real series
   (`"AAVE, 12 points, first 36.61, last 36.61, unchanged"`), and `<title>` for the tooltip text.
8. **Geometry is pure.** A `useMemo` that turns candles into a path — no `Math.random()`, no
   `Date.now()` inside the geometry, no animation frame loops. Re-rendering the same candles must
   produce the same `d` attribute, or the screenshots stop being evidence.
9. **TypeScript `strict` is on** (`tsconfig.json`). Types live next to their source (`api.ts` for
   node shapes, `engine.ts` for the marketplace), exported and reused — do not redeclare
   `Candle`/`Token` in a component.
10. **Comment like the rest of the repo**: a short header block per file explaining *what it reads
    and why*, and comments only where a future reader would otherwise have to guess (a node quirk, a
    measurement, a rejected alternative). Do not narrate the code.

---

## 4. Data contracts — measured, with the traps

All paths below are on `:8090` unless marked **engine**. Timings are single-run wall clock from this
machine, on a node that was already warm.

### 4.1 Candles — `GET /api/market/chart/{symbol}?points=N`

```json
{"ok":true,"data":{"symbol":"AAVE","interval":"sample","points":12,
  "candles":[{"time":1793432492,"open":36.614145658277,"high":36.614145658277,
              "low":36.614145658277,"close":36.614145658277}]}}
```

Measured:

| Call | Time | Result |
| --- | --- | --- |
| `/chart/TOR` | 1 990 ms | 168 points, `interval:"sample"`, **1 distinct close** (`1.0`) |
| `/chart/TOR?points=24` | 1 422 ms | 24 points (`points` **is** honoured) |
| `/chart/AAVE?points=12` | **24 925 ms** | 12 points, **1 distinct close** (`36.614145658277` = its pool `price_tor`) |
| `/chart/TORA` (unknown symbol) | **>20 000 ms, timed out** | never answered — see the trap below |

Traps, in order of how badly they bite:

- **Cold path is slow and jittery.** TOR answers in ~1.5–2 s; a pool token took **25 s** the first
  time. Always pass an explicit `timeoutMs` (30 s), always render a skeleton while pending, and
  always offer a retry.
- **Unknown symbols can hang instead of 404.** `TORA` never answered. Never fire a chart request you
  cannot cancel: keep the `AbortController` and abort on unmount / on symbol change.
- **`interval` is always `"sample"`** — the node does not bucket. Any 1 m/5 m/1 h view is **derived
  client-side** and must be labelled as derived.
- **Series are flat today**: TOR is `1.0` by definition, and AAVE's 12 closes were identical. This is
  the normal state of this node, not a bug and not something to smooth over (§5).

### 4.2 `GET /api/market/overview` — 10 ms, 38 749 B
The cheap one. `standard:"oneness-tor-market/1"`, `at`, a `tor` block (`price_usd 3.6`,
`anchor_usd 3.6`, `price_tor 1.0`, `supply 50 000 000`, `market_cap_usd 180 000 000`,
`liquidity_usd 45 421 411.85`, `volume_24h_usd 0.0`, `holders 615`) plus per-token rows. **Use this
for a header strip** — it is ~800× faster than `/api/market/tokens` and carries the same TOR numbers.

### 4.3 `GET /api/market/pools` — 24 ms, 63 840 B
`count:172`, `tor_pools:122`, `usdc_pools:50`, `liquidity_usd:25 010 705.94`, and `books[]` where
each row is `{base, symbol, token_reserve, usdc_reserve | tor_reserve, fee_bps, price_usd,
liquidity_usd, custody, chain}`. This is your depth/composition feed. **But** one probe of this same
route later in the run timed out at 30 s when other requests were in flight — see §4.7.

### 4.4 `GET /api/market/tokens` — 8 196 ms, 153 985 B
Already called by `Overview()` (`App.tsx:~96`) **and** `Tokens()` (`App.tsx:255`). Slow but rich:
`tokens[]` with `symbol`, `name`, `image`, `price_usd`, `price_tor`, `liquidity_usd`,
`quote_assets[]`, pool refs. Do **not** add a third consumer of it just for a chart — read it from the
`useAsync` already in the page, or don't chart it.

### 4.5 `GET /api/tokens/public?limit=3` — 3 748 ms, 225 511 B
`count:123` (the `limit` parameter is **ignored**; you get all 123), and each token carries
`holders`, `supply`, `in_pools`, `circulating`, `price_tor` and a `pools[]` array with
`tor_reserve_tor`, `token_reserve`, `liquidity_tor`, `price_tor`, `fee_bps`. Best source if you need
holder counts or per-pool rates together. Not for first paint.

### 4.6 Engine `:8792` — the AI-NFT market
`GET /api/health` → `{status, totals:{nfts, listings, active, held, floor_tor}, sync:{runs,
last_sync_at, last_ok_at}, fee}`. `GET /api/nft/board` → `counts {nfts, active, held, sales}`,
`floor_tor`, `ask_tor`, `auto_list.multiplier` and `items[]` (each with `mint.fee_tor`,
`listing.price_tor`, `basis_tor`, `basis_multiplier`, `listing.listed_at`). `src/tor/engine.ts`
already types all of it (`EngineBoard`, `EngineCard`, `analytics()`).
**There is no time series anywhere in the engine.** Every chart here is a snapshot: counts, floor,
ask spread, fee basis. A floor-history line would have to be invented — forbidden.

### 4.7 Node behaviour that will shape your components
- **The node is not happy with parallel requests.** In one batch, `/api/market/pools` answered in
  **24 ms**; minutes later the identical call timed out at **30 s** while two other calls were
  running. The python API serialises on one chain read.
- Therefore: **one chart request in flight, app-wide.** Cache by `symbol|points` in a module-level
  `Map`, dedupe concurrent callers onto the same promise, poll no faster than **20 s** (the board
  already uses 20 s), and back off after a failure instead of retrying on a timer.
- `GET /api/chain/blocks?limit=3` answers in 485 ms but returns **1 277 140 B** — the `limit` is
  ignored. Do not build a chain-activity chart on it without paging.
- `GET /api/chain/info` is 322 ms / 1 535 B: height, chain id, coin — fine for a caption.
- `GET /api/pricing` publishes 10 rows (`nft_mint` = 3.0 TOR, `locked:false`) and is already wired in
  `src/tor/pricing.ts` (`useMintFee`). A fee table/bars can be built from `rows` with no new call.

---

## 5. Rulings you inherit (do not re-litigate them)

A `tor-charts` package (v1.0.0, `C:\Users\KATHY\Downloads\lightweight-charts-master\tor-charts`) and
the `axiom-clone-main` app already settled these, and this wallet must agree with them so the same
symbol never looks "live" in one TOR app and "flat" in another. The rules, and the local mirror to
reuse, are in `C:\Users\KATHY\Downloads\axiom-clone-main\src\tor\series.ts`:

1. **Ask what kind of series you were given, before drawing.**
   `none` → empty panel + retry, never a line. `flat` → candles/line **plus exactly one caveat**
   ("untraded: one distinct close across N points"). `live` → draw clean.
   Mirrored here as `seriesFlagLocal(candles)`.
2. **"Live" is not "moved".** `seriesMovement()` gives `{distinct, netChangePct}`. Show a change
   badge **only when `netChangePct !== 0`**. A series that ticked and came back is a *blip*, and the
   caption says so. Never badge `+0.00%`.
3. **TOR itself gets a rate strip, never candles.** Its series is `1.0` by definition; a candlestick
   chart of TOR would describe nothing.
4. **Volume is one bar, honestly labelled.** The node publishes 24 h turnover, not per-bucket volume.
   If you draw a histogram, it is a single bar captioned "24 h turnover" — not 168 fake bars.
5. **USD and market cap are derived, and labelled derived** (`price_tor × price_usd`, `× supply`).
   The raw axis is TOR unless the caption says otherwise.
6. **Bucketing is client-side and declared as such** (`interval:"sample"` from the node). Open =
   first, high = max, low = min, close = last within the bucket; ascending, deduped by time.
7. **No smoothing, no seeds, no back-fill.** If the node sent 12 points, you draw 12 points.

> If you would rather reuse the vetted renderer than hand-roll one, `tor-charts` is consumable as
> `"tor-charts": "file:../lightweight-charts-master/tor-charts"` (that is exactly how
> `axiom-clone-main` does it, with `renderChart`, `renderDepth`, `renderRateStrip`, `seriesFlag`).
> It is **not** installed here, adds ~63 kB gzip and pulls in `lightweight-charts`. Do not add it on
> your own authority: propose it, with the bundle delta, and let the Captain decide. Everything in
> §2 can be delivered in plain SVG today.

---

## 6. How your work is accepted

A chart is done when **all** of these hold. Check them yourself before you report back; a reviewer
will run the same list.

1. `npm run build` → **0 TypeScript errors**, and you quote the new JS size
   (baseline at handover: 44 modules, `index-wNmog8c9.js` **221.67 kB**, gzip 67.83 kB; the current tree
   with `charts.tsx` already builds `index-DmHBjoh6.js` **233.38 kB** — see §1).
2. The chart renders on `#/tokens` (or the screen in §2) with the **selected** symbol only — one
   network call, visible in the dev log, with a real `points` count.
3. A **flat** series shows the drawing **plus one caveat**, and **no** change badge.
4. Killing the node (`:8090` unreachable) shows the node's own error text and a working **retry**;
   no blank panel, no error boundary, no `Failed to fetch` leaking raw.
5. DOM dump contains `role="img"`, a non-empty `aria-label`, and an `<svg>` whose path has one
   command per point (`.state/` dump, see §7).
6. First paint is not blocked: the chart area shows `.skeleton` while pending; the rest of the page
   is interactive immediately.
7. Numbers come from `brand.ts` (`money` / `tor` / `pct`), colours from CSS variables, and no literal
   `#hex` appears in your component.
8. Your screenshot at `.state/shot-chart-<screen>.png` shows real values, and you state the node
   height it was taken at.

---

## 7. The verification loop (PowerShell, on this machine)

```powershell
cd 'C:\Users\KATHY\Downloads\TOR AI-NFT WALLET'

# 1. build gate
npm run build

# 2. DOM dump of the screen you touched (artifacts go to .state/, which the watcher ignores)
$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
& $edge --headless=new --disable-gpu --virtual-time-budget=8000 `
  --dump-dom 'http://127.0.0.1:9010/#/tokens' | Out-File .state\dom-tokens.html -Encoding utf8

# 3. prove the chart is in the DOM, and how many points it drew
Select-String -Path .state\dom-tokens.html -Pattern 'role="img"|aria-label=|<svg|data-points' |
  Select-Object -First 6 | ForEach-Object { $_.Line.Trim().Substring(0, [Math]::Min(160, $_.Line.Trim().Length)) }

# 4. screenshot for the record
& $edge --headless=new --disable-gpu --window-size=1440,1100 --virtual-time-budget=8000 `
  --screenshot=".state\shot-chart-tokens.png" 'http://127.0.0.1:9010/#/tokens'

# 5. count the requests your screen makes (dev log), and their cost
Select-String -Path .state\dev9010.log -Pattern 'api/' | Select-Object -Last 20
```

If a dump comes back **0 bytes** — observed in this environment while an interactive Edge window was
open (exit code 21, empty stderr, three attempts) — the browser could not take the profile. Try, in
order: an **absolute** `--user-data-dir` outside the workspace, closing the interactive Edge window,
then `npm run preview` on `:9011` and dumping that instead. Never read a 0-byte dump as "the page is
broken": first confirm `:9010` answers 200, and compare against a dump from a session where it worked
(`.state/dom-chart-check.html`, 76 862 B, written 2026-10-31 11:37:45, after the `wallet.tsx` edit —
it contains the tokens table, 173 `.pill`, zero `Failed to fetch`).

---

## 8. Blocked / needs the NODE OPERATOR (report, don't invent)

1. **No real price history yet.** `/api/market/chart/{symbol}` returns points that are all one value
   (TOR `1.0`; AAVE `36.614145658277`), `interval:"sample"`. Until the node keeps and serves its AMM
   sample archive, every price chart on this chain is a *flat* series and must say so. Ask for:
   real sampled history, and `?from=&to=&interval=` with the interval applied **server-side**.
2. **Unknown symbols hang** instead of answering 404 (measured: `TORA` > 20 s, no response).
   Ask for a 404 `SYMBOL_NOT_FOUND` in < 500 ms.
3. **`limit` is ignored** on `/api/tokens/public` (123 tokens for `limit=3`) and on
   `/api/chain/blocks` (1.27 MB for `limit=3`). Ask for honoured limits/pagination — it is the
   difference between a usable chart feed and a 1 MB download.
4. **No NFT time series** on the engine (`:8792`): no floor history, no sales history. C6 stays a
   snapshot panel until the engine stores rows.
5. Unchanged from the wallet README: `POST /api/nft/transfer` does not exist (404, absent from
   OpenAPI) and the mint fee is 3.0 TOR against a 2.0 TOR spec. Any chart that touches the AI-NFT
   market must quote the node's 3.0, never the spec's 2.0.

---

## 9. What this run did **not** prove (so you don't inherit a false assumption)

- **No symbol produced two distinct closes.** Every chart sampled (TOR, AAVE) was flat. The "live"
  branch of your component has therefore never been seen against this node — build it, but verify it
  with a synthetic fixture in your own test, and say in your report that the live path is
  fixture-tested only.
- **One cold measurement.** AAVE's 25 s was a single first call; the warm path may be faster. Do not
  tune the timeout below 30 s on that one number.
- **No funded wallet.** The self-check account (`wallet_selfcheck_1031`, 0 TOR) cannot send, so no
  chart has been drawn for a wallet with real transaction history.
- **`#/overview` and `#/tokens` each call the 8 s `/api/market/tokens`.** Page timings you observe
  include that; don't attribute them to your chart.

---

## 10. Handoff back to me

When your charts are in, append a `[CHART]` entry at the bottom of this file — keep it short and
factual, same style as the rest of the repo:

```
## [CHART] <date> — <what shipped>
endpoints used: <path> (<measured ms>, <bytes>) ...
files: <new/changed>
bundle: index-<hash>.js <kB> (<n> modules), tsc 0 errors
flat-series behaviour: <what the user sees>
screenshots: .state/shot-chart-*.png at node height <h>
unproven: <list>
```

That entry is the only thing I need to re-run the acceptance list in §6 and take it to the Captain.
