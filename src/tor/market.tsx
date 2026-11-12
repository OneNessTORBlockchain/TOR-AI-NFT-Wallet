/**
 * market.tsx — the TOR AI NFT Marketplace board, details page and buy panel.
 *
 * Every number on this screen was fetched this tick: the catalogue and its asks
 * come from the marketplace engine on :8792, the fee from :8090/api/pricing, the
 * settlement route from the node's own OpenAPI document. The cards show the
 * 1024 px artwork the engine rendered (never a thumbnail blown up), and every
 * card carries the three actions the brief asks for: Buy, Details, Load into AI chat.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { analytics, engine, mediaUrl } from "./engine";
import type { EngineBoard, EngineCard } from "./engine";
import { TRANSFER_ROUTE, can, useCapabilities } from "./capabilities";
import { MINT_TARGET_TOR, useMintFee } from "./pricing";
import { useWallet } from "./wallet";
import { shortAddress, tor as fmtTor } from "./brand";
import { Empty, Stat, useToast } from "./ui";
import { api } from "./api";
import { FloorChart } from "./charts";

/* ------------------------------------------------------------------- hooks */

/** Poll the engine board; `nonce` forces an immediate re-read after a mint. */
export function useBoard(intervalMs = 20_000) {
  const [board, setBoard] = useState<EngineBoard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const tick = async () => {
      try {
        const data = await engine.board({}, controller.signal);
        if (!alive) return;
        setBoard(data);
        setError("");
      } catch (problem) {
        if (!alive || (problem as Error)?.name === "AbortError") return;
        setError(problem instanceof Error ? problem.message : "the engine did not answer");
      } finally {
        if (alive) setLoading(false);
      }
    };
    void tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [intervalMs, nonce]);

  return { board, error, loading, reload: () => setNonce((value) => value + 1) };
}

/** The AI-NFT ChatBox takes an address + token id in its hash route. */
export function chatHref(card: Pick<EngineCard, "address" | "token_id">): string {
  return `#/chat/${encodeURIComponent(card.address)}/${encodeURIComponent(String(card.token_id))}`;
}

export function detailHref(card: Pick<EngineCard, "id">): string {
  return `#/market/${encodeURIComponent(card.id)}`;
}

/* -------------------------------------------------------------------- card */

function Money({ value, muted }: { value: number | null | undefined; muted?: boolean }) {
  if (value === null || value === undefined) return <span className="muted tiny">not for sale</span>;
  return <span className={muted ? "muted" : ""}>{fmtTor(value, 4)}</span>;
}

export function MarketCard({ item, onBuy }: { item: EngineCard; onBuy?: (item: EngineCard) => void }) {
  const live = item.listing?.status === "active";
  return (
    <article className="nft-tile">
      <a className="nft-tile__media" href={detailHref(item)} aria-label={`${item.name} details`}>
        <img
          src={mediaUrl(item.image.big)}
          alt={`${item.name} — TOR AI NFT #${item.token_id}`}
          width={item.image.width}
          height={item.image.height}
          loading="lazy"
        />
        <span className="nft-tile__id">#{String(item.token_id).padStart(4, "0")}</span>
        <span className={`nft-tile__state ${live ? "is-live" : "is-idle"}`}>
          {live ? "auto-listed" : item.listing?.status ?? "unlisted"}
        </span>
      </a>
      <div className="nft-tile__body">
        <div className="spread" style={{ gap: 8 }}>
          <b className="nft-tile__name">{item.name}</b>
          {item.symbol ? <span className="pill">${item.symbol}</span> : null}
        </div>
        <div className="nft-tile__price">
          <Money value={item.listing?.price_tor} />
          <span className="muted tiny">
            {item.listing?.basis_code ? ` = ${item.listing.basis_code} ${item.listing.basis_tor} TOR × ${item.listing.basis_multiplier}` : ""}
          </span>
        </div>
        <div className="muted tiny">
          creator {shortAddress(item.mint.owner)} · minted h{item.mint.height ?? "—"}
        </div>
        <div className="nft-tile__actions">
          <button
            type="button"
            className="primary small"
            disabled={!live}
            onClick={() => onBuy?.(item)}
            title={live ? `Buy ${item.name}` : "this token carries no active ask"}
          >
            Buy
          </button>
          <a className="btn small ghost" href={detailHref(item)}>Details</a>
          <a className="btn small ghost" href={chatHref(item)}>Load into AI chat</a>
        </div>
      </div>
    </article>
  );
}

/* --------------------------------------------------------------- buy panel */

type BuyResult = { ok: boolean; state: string; message: string; txid?: string };

/**
 * The purchase path, with the truth printed on it.
 *
 * TOR leaves a wallet only through a signed node call, and handing the NFT over
 * needs `POST /api/nft/transfer`. When that route is missing the panel says so,
 * quotes the node's settlement field and leaves the button disabled — it never
 * debits a buyer for a token nobody can deliver. The moment the route appears in
 * `/api/openapi.json` this panel unlocks itself, with no rebuild.
 */
export function BuyPanel({ item, onClose }: { item: EngineCard; onClose?: () => void }) {
  const { session, profile } = useWallet();
  const caps = useCapabilities();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BuyResult | null>(null);

  const price = item.listing?.price_tor ?? null;
  const balance = Number.parseFloat(String(profile?.wallet?.balance_tor ?? ""));
  const enough = Number.isFinite(balance) && price !== null ? balance >= price : null;
  const routeReady = caps.ready && can(caps.paths, TRANSFER_ROUTE);
  const blocked = !session
    ? "sign in first — the TOR leaves your own wallet, so the node needs your session"
    : price === null
      ? "this token has no active ask to pay"
      : !caps.ready
        ? `cannot verify settlement yet — ${caps.error || "reading /api/openapi.json"}`
        : !routeReady
          ? `the node publishes no ${TRANSFER_ROUTE} (probed ${caps.at ? new Date(caps.at).toLocaleTimeString() : "—"}) and the listing says "${item.listing?.settlement ?? "unknown"}". Paying now would take ${price} TOR and deliver nothing, so this button stays off.`
          : enough === false
            ? `your wallet holds ${balance} TOR, the ask is ${price} TOR`
            : "";

  async function buy() {
    if (!session || price === null || blocked) return;
    setBusy(true);
    setResult(null);
    try {
      const data = await api.post<{ txid?: string; settlement?: string; transferred?: boolean }>(
        TRANSFER_ROUTE,
        {
          address: item.address,
          token_id: item.token_id,
          listing_id: item.listing?.listing_id,
          to: session.address,
          price_tor: price,
          price_micro: item.listing?.price_micro,
        },
        90_000,
      );
      setResult({
        ok: true,
        state: data?.settlement || "settled",
        txid: data?.txid,
        message: data?.txid
          ? `paid and transferred — tx ${data.txid}`
          : "the node accepted the purchase",
      });
      toast("purchase settled");
    } catch (problem) {
      const message = problem instanceof Error ? problem.message : "the node refused the purchase";
      setResult({ ok: false, state: "not_settled", message });
      toast(message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="buy-panel">
      <div className="spread">
        <div>
          <div className="tag">CHECKOUT</div>
          <b>{item.name} · #{item.token_id}</b>
        </div>
        <button type="button" className="ghost small" onClick={onClose}>Close</button>
      </div>

      <img className="buy-panel__art" src={mediaUrl(item.image.big)} alt={`${item.name} artwork`} />

      <div className="buy-panel__rows">
        <div><span>Ask</span><b>{price === null ? "—" : fmtTor(price, 4)}</b></div>
        <div><span>Creator</span><b className="mono tiny">{shortAddress(item.mint.owner)}</b></div>
        <div><span>Mint tx</span><b className="mono tiny">{item.mint.txid_short}</b></div>
        <div><span>Your balance</span><b>{Number.isFinite(balance) ? fmtTor(balance, 4) : "—"}</b></div>
        <div><span>Settlement</span><b className="tiny">{item.listing?.settlement ?? "—"}</b></div>
      </div>

      {blocked ? <p className="buy-panel__blocked tiny">{blocked}</p> : null}

      <div className="row">
        <button type="button" className="primary" disabled={Boolean(blocked) || busy} onClick={() => void buy()}>
          {busy ? "Signing…" : price === null ? "No ask" : `Pay ${price} TOR`}
        </button>
        <a className="btn small ghost" href={chatHref(item)}>Ask the AI about it</a>
        <a className="btn small ghost" href={item.links.source_record} target="_blank" rel="noreferrer">Node record</a>
      </div>

      {result ? (
        <div className={`tiny ${result.ok ? "good" : "bad"}`}>
          {result.message}
          {result.txid ? <span className="mono"> · {result.txid}</span> : null}
        </div>
      ) : null}
    </div>
  );
}



/* ------------------------------------------------------------- the board */

type Filter = "all" | "listed" | "mine";

const SORTS = [
  { value: "token_desc", label: "Newest mint" },
  { value: "price_asc", label: "Ask: low → high" },
  { value: "price_desc", label: "Ask: high → low" },
  { value: "name", label: "Name" },
];

export function MarketHome() {
  const { board, error, loading, reload } = useBoard(20_000);
  const { session } = useWallet();
  const fee = useMintFee();
  const caps = useCapabilities();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("token_desc");
  const [filter, setFilter] = useState<Filter>("all");
  const [picked, setPicked] = useState<EngineCard | null>(null);
  const [syncing, setSyncing] = useState(false);

  const stats = useMemo(() => (board ? analytics(board) : null), [board]);

  const items = useMemo(() => {
    const rows = [...(board?.items ?? [])];
    const needle = q.trim().toLowerCase();
    const kept = rows.filter((item) => {
      if (filter === "listed" && item.listing?.status !== "active") return false;
      if (filter === "mine" && item.mint.owner !== session?.address) return false;
      if (!needle) return true;
      return [
        item.name,
        item.symbol,
        item.description,
        String(item.token_id),
        item.mint.txid,
        item.address,
        ...item.attributes.map((trait) => `${trait.trait_type}:${trait.value}`),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
    const ask = (item: EngineCard) => item.listing?.price_tor ?? Number.POSITIVE_INFINITY;
    if (sort === "price_asc") kept.sort((a, b) => ask(a) - ask(b));
    else if (sort === "price_desc") kept.sort((a, b) => (b.listing?.price_tor ?? -1) - (a.listing?.price_tor ?? -1));
    else if (sort === "name") kept.sort((a, b) => a.name.localeCompare(b.name));
    else kept.sort((a, b) => b.token_id - a.token_id);
    return kept;
  }, [board, q, sort, filter, session?.address]);

  async function sync() {
    setSyncing(true);
    try {
      await engine.sync();
      reload();
      toast("engine swept the node catalogue");
    } catch (problem) {
      toast(problem instanceof Error ? problem.message : "the engine refused the sweep", true);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="stack">
      <section className="hero hero--market">
        <img className="hero__banner" src="/banner.png" alt="Marché NFT TOR AI futuriste" />
        <div className="hero__copy">
          <div className="tag">ONENESS TOR · AI-NFT MARKETPLACE</div>
          <h1>Mint, own and talk to AI-NFTs on the TOR chain.</h1>
          <p>
            One artwork, one token, one conversation. Every card below is a real mint on{" "}
            <b>{caps.base.replace(/^https?:\/\//, "")}</b> — the ask comes from the marketplace
            engine, the mint transaction is the node's own txid, and any card can be loaded into
            the AI chat box to speak as that NFT.
          </p>
          <div className="row" style={{ marginTop: 14 }}>
            <a className="btn primary" href="#/create">Create an NFT</a>
            <a className="btn ghost" href="#/chat">Open the AI chat</a>
            <button type="button" className="ghost" onClick={() => void sync()} disabled={syncing}>
              {syncing ? "Sweeping…" : "Sync catalogue"}
            </button>
          </div>
        </div>
      </section>

      <div className="grid cols-4">
        <Stat
          label="Minted"
          value={stats ? String(stats.minted) : "—"}
          hint={stats ? `${stats.distinct_artworks} distinct artwork${stats.distinct_artworks === 1 ? "" : "s"}` : "reading the engine"}
        />
        <Stat label="Listed" value={stats ? String(stats.listed) : "—"} hint={stats ? `${stats.held} held · ${stats.sales} sales` : ""} />
        <Stat label="Floor" value={stats ? fmtTor(stats.floor_tor, 4) : "—"} hint="lowest live ask" />
        <Stat
          label="Mint fee"
          value={fee.row ? fmtTor(fee.row.tor, 4) : fee.loading ? "…" : "—"}
          hint={fee.row ? `live ${fee.row.code}${fee.row.locked ? " · locked" : ""}` : fee.error || "node /api/pricing"}
        />
      </div>

      {fee.row && !fee.matchesTarget ? (
        <div className="fee-strip">
          <b>price check</b>
          <span>
            the node charges <b>{fmtTor(fee.row.tor, 4)}</b> per mint; the project brief specifies{" "}
            <b>{fmtTor(MINT_TARGET_TOR, 4)}</b>. That gap is a pricing override only the node owner can
            sign — this screen quotes the node and never a number typed into the code.
          </span>
          <button type="button" className="ghost small" onClick={fee.reload}>Re-read fee</button>
        </div>
      ) : null}

      <div className="panel stack">
        <div className="spread">
          <h3 style={{ margin: 0 }}>Floor · live asks from the engine</h3>
          <a className="pill" href="#/charts">Chart generator →</a>
        </div>
        {board ? (
          <FloorChart items={board.items} />
        ) : (
          <Empty>{error || "reading the engine board…"}</Empty>
        )}
      </div>

      <div className="market-bar">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search name, symbol, token id, txid or trait…"
          aria-label="Search the marketplace"
        />
        <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort">
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <div className="tabs">
          {(["all", "listed", "mine"] as Filter[]).map((value) => (
            <button key={value} type="button" className={filter === value ? "on" : ""} onClick={() => setFilter(value)}>
              {value === "all" ? "All" : value === "listed" ? "For sale" : "My NFTs"}
            </button>
          ))}
        </div>
      </div>

      {picked ? <BuyPanel item={picked} onClose={() => setPicked(null)} /> : null}

      {loading && !board ? (
        <div className="grid cols-3">
          {[0, 1, 2].map((key) => <div key={key} className="skeleton" style={{ height: 420 }} />)}
        </div>
      ) : error && !board ? (
        <Empty>{error}</Empty>
      ) : items.length === 0 ? (
        <Empty>
          {filter === "mine"
            ? session
              ? "this wallet owns no token the engine has mirrored yet — mint one and it appears within one sync tick"
              : "sign in to see the tokens your wallet owns"
            : "no token matches this filter"}
        </Empty>
      ) : (
        <div className="market-grid">
          {items.map((item) => (
            <MarketCard key={item.id} item={item} onBuy={setPicked} />
          ))}
        </div>
      )}

      <div className="panel tight">
        <div className="spread">
          <span className="muted tiny">
            engine last synced{" "}
            {board?.sync.last_ok_at ? new Date(board.sync.last_ok_at).toLocaleTimeString() : "—"}
            {" · "}{board?.sync.runs ?? 0} sweeps
            {board?.sync.error ? ` · last error: ${board.sync.error.message}` : ""}
          </span>
          <span className="muted tiny" style={{ maxWidth: "48ch" }}>{board?.auto_list.settlement_note}</span>
        </div>
      </div>
    </div>
  );
}


/* -------------------------------------------------------------- token page */

/**
 * One token, everything the two services know about it: the 2048 px hero the
 * engine rendered, the node's mint record, the auto-listing row with its basis,
 * and the same checkout panel the board uses. `#/market/nft_0003`.
 */
export function TokenDetail({ id }: { id: string }) {
  const [item, setItem] = useState<EngineCard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [buying, setBuying] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    engine
      .card(id)
      .then((data) => {
        if (!alive) return;
        setItem(data.item);
        setError("");
      })
      .catch((problem: unknown) => {
        if (!alive) return;
        setError(problem instanceof Error ? problem.message : "the engine did not answer");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (loading && !item) {
    return (
      <div className="stack">
        <div className="skeleton" style={{ height: 460 }} />
        <div className="skeleton" style={{ height: 120 }} />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="stack">
        <Empty>{error || `the engine knows no token "${id}"`}</Empty>
        <a className="btn ghost" href="#/market">← back to the market</a>
      </div>
    );
  }

  const listing = item.listing;

  return (
    <div className="stack">
      <div className="row">
        <a className="btn small ghost" href="#/market">← market</a>
        <span className="muted tiny mono">{item.id}</span>
      </div>

      <div className="token-page">
        <figure className="token-page__art">
          <img
            src={mediaUrl(item.image.hero || item.image.big)}
            alt={`${item.name} — ${item.image.width}×${item.image.height} artwork`}
          />
          <figcaption className="muted tiny">
            {item.image.width}×{item.image.height} · {item.image.mime} · {item.image.bytes ?? "—"} B ·
            sha256 {item.image.sha256 ? shortAddress(item.image.sha256) : "—"} · {item.image.source}
          </figcaption>
        </figure>

        <div className="token-page__facts stack">
          <div>
            <div className="tag">AI-NFT #{String(item.token_id).padStart(4, "0")}</div>
            <h1 style={{ margin: "6px 0 4px", fontSize: "clamp(24px, 3vw, 38px)" }}>{item.name}</h1>
            <div className="muted tiny">{item.symbol ? `$${item.symbol} · ` : ""}{item.address}</div>
          </div>

          {item.description ? <p className="muted" style={{ margin: 0, lineHeight: 1.65 }}>{item.description}</p> : null}

          <div className="row">
            <span className={`pill ${listing?.status === "active" ? "on" : ""}`}>
              {listing ? `ask ${fmtTor(listing.price_tor, 4)}` : "no ask"}
            </span>
            <span className="pill">{listing?.status ?? "unlisted"}</span>
            <span className="pill">creator {shortAddress(item.mint.owner)}</span>
            <span className="pill">height {item.mint.height ?? "—"}</span>
            {item.traits ? <span className="pill">{item.traits} traits</span> : null}
          </div>

          <div className="row">
            <button type="button" className="primary" onClick={() => setBuying(true)} disabled={listing?.status !== "active"}>
              Buy for {listing?.price_tor ?? "—"} TOR
            </button>
            <a className="btn ghost" href={chatHref(item)}>Load into AI chat</a>
            <a className="btn ghost" href={item.links.metadata} target="_blank" rel="noreferrer">OpenSea metadata</a>
            <a className="btn ghost" href={item.links.source_record} target="_blank" rel="noreferrer">Node record</a>
          </div>

          {buying ? <BuyPanel item={item} onClose={() => setBuying(false)} /> : null}
        </div>
      </div>

      {item.attributes.length ? (
        <div className="panel tight">
          <h3>Traits</h3>
          <div className="row">
            {item.attributes.map((trait, index) => (
              <span key={`${trait.trait_type}-${index}`} className="pill">
                {trait.trait_type}: <b style={{ color: "var(--text)" }}>{trait.value}</b>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel tight">
        <h3>Provenance</h3>
        <table>
          <tbody>
            <tr><th>Mint txid</th><td className="mono tiny">{item.mint.txid}</td></tr>
            <tr><th>Minted at</th><td className="tiny">{item.mint.at ?? "—"} · h{item.mint.height ?? "—"}</td></tr>
            <tr><th>Mint fee</th><td className="tiny">{item.mint.fee_tor === null ? "—" : fmtTor(item.mint.fee_tor, 4)} ({item.mint.status ?? "—"})</td></tr>
            <tr><th>Owner</th><td className="mono tiny">{item.mint.owner}</td></tr>
            <tr><th>Listing</th><td className="tiny">{listing ? `${listing.listing_id} · ${listing.source} · ${listing.verified}` : "not listed"}</td></tr>
            <tr><th>Basis</th><td className="tiny">{listing?.basis_code ? `${listing.basis_code} ${listing.basis_tor} TOR × ${listing.basis_multiplier} = ${listing.price_tor} TOR` : "—"}</td></tr>
            <tr><th>Settlement</th><td className="tiny">{listing?.settlement ?? "—"} — {listing?.settlement_note ?? ""}</td></tr>
            <tr><th>Listed</th><td className="tiny">{listing?.listed_at ? new Date(listing.listed_at).toLocaleString() : "—"}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
