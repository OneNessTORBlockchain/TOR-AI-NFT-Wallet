/**
 * TOR AI NFT Marketplace — OneNess TOR chain.
 *
 * One app, one wallet, two services: the node on :8090 owns identity, minting and
 * the chain; the marketplace engine on :8792 owns the board and every asking price.
 * The marketplace is the front door, the ChatBox is the companion (any card can be
 * loaded into it), and the wallet tabs stay where they were — self-custody, node-held
 * keys, nothing secret in this bundle.
 */
import { useEffect, useState } from "react";
import { api } from "./tor/api";
import type { Token } from "./tor/api";
import { BRAND, money, shortAddress, tor } from "./tor/brand";
import { ChatBox } from "./tor/chat";
import { BannerRail, Shell, Stat, TokenCell, useAsync, useToast } from "./tor/ui";
import { SignInPanel, WalletPanel, WalletPill, useWallet } from "./tor/wallet";
import { ChainGuardBadge, SecurityPage } from "./tor/security";
import { AiProvidersPage } from "./tor/providers";
import { MarketHome, TokenDetail } from "./tor/market";
import { CreateNft } from "./tor/mint";
import { VerifyTx } from "./tor/verify";
import { HistoryPage } from "./tor/history";
import { ChartStudio, ChainEventChart, TokenPriceChart, TorRateStrip, torUsd, useTorQuote } from "./tor/charts";

const NAV = [
  { href: "#/overview", label: "Wallet" },
  { href: "#/tokens", label: "Tokens" },
  { href: "#/charts", label: "Charts" },
  { href: "#/nfts", label: "AI-NFTs" },
  { href: "#/send", label: "Send" },
  { href: "#/receive", label: "Receive" },
  { href: "#/history", label: "History" },
  { href: "#/keys", label: "Keys" },
  { href: "#/chat", label: "AI ChatBox" },
  { href: "#/ai", label: "AI Providers" },
  { href: "#/security", label: "Security" },
  { href: "#/market", label: "Market" },
  { href: "#/create", label: "Create" },
];

/** `#/chat/<token address>/<token id>` — how a card hands an NFT to the ChatBox. */
export function chatSeedFrom(route: string): { address: string; token_id: string } | null {
  const match = /^#\/chat\/([^/]+)\/([^/?#]+)/.exec(route);
  if (!match) return null;
  try {
    return { address: decodeURIComponent(match[1]), token_id: decodeURIComponent(match[2]) };
  } catch {
    return { address: match[1], token_id: match[2] };
  }
}

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash || "#/overview");

  useEffect(() => {
    const onHash = () => {
      setRoute(window.location.hash || "#/overview");
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const tokenMatch = /^#\/market\/([^/?#]+)/.exec(route);
  const chartMatch = /^#\/charts(?:\/([^/?#]+))?/.exec(route);
  const verifyMatch = /^#\/verify\/([^/?#]+)/.exec(route);
  const seed = chatSeedFrom(route);
  /* "#/market/nft_0003" highlights "#/market" */
  const activeBase = route.split("/").slice(0, 2).join("/");

  return (
    <Shell
      title="TOR AI NFT WALLET"
      tagline="ONENESS TOR · SEND · RECEIVE · AI-NFT CHATBOX"
      logo="/logo.svg"
      nav={NAV}
      active={activeBase}
      walletPill={
        <div className="row" style={{ gap: 8 }}>
          <ChainGuardBadge />
          <WalletPill onOpen={() => { window.location.hash = "#/overview"; }} />
        </div>
      }
    >
      {route.startsWith("#/security") ? <SecurityPage /> : null}
      {route.startsWith("#/ai") ? <AiProvidersPage /> : null}
      {route.startsWith("#/send") ? <WalletPanel tab="send" /> : null}
      {route.startsWith("#/receive") ? <WalletPanel tab="receive" /> : null}
      {route.startsWith("#/keys") ? <WalletPanel tab="keys" /> : null}
      {route.startsWith("#/history") ? <HistoryPage /> : null}
      {route.startsWith("#/tokens") ? <Tokens /> : null}
      {chartMatch ? <Charts symbol={chartMatch[1] ? decodeURIComponent(chartMatch[1]) : undefined} /> : null}
      {route.startsWith("#/nfts") ? <Nfts /> : null}
      {tokenMatch ? <TokenDetail id={decodeURIComponent(tokenMatch[1])} /> : null}
      {verifyMatch ? <VerifyTx txid={decodeURIComponent(verifyMatch[1])} /> : null}
      {route.startsWith("#/create") ? <CreateNft /> : null}
      {route.startsWith("#/chat") ? <Chat seed={seed} /> : null}
      {route === "#/market" || route === "#/market/" ? <MarketHome /> : null}
      {route === "#/overview" || route === "#/" ? <Overview /> : null}
    </Shell>
  );
}

/* ------------------------------------------------------------------ charts */

/**
 * `#/charts` and `#/charts/<SYMBOL>` — the generator, plus two panels that need no choice made
 * for them: TOR's own sampled price and the chain's real swap rhythm.
 */
function Charts({ symbol }: { symbol?: string }) {
  return (
    <div className="stack">
      <div className="panel stack">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Charts</h2>
          <span className="pill">every series is read from the node · nothing is drawn by hand</span>
        </div>
        <p className="muted tiny" style={{ margin: 0 }}>
          The generator below builds a chart on demand: choose the token, the metric and the window.
          The two panels under it need no choices — TOR's one USD quote (the same number every
          panel prints), and the chain's swap rhythm counted from real event timestamps.
        </p>
        <TorRateStrip />
      </div>

      <ChartStudio initialSymbol={symbol} />

      <div className="grid cols-2">
        <div className="panel stack">
          <div className="spread">
            <h3 style={{ margin: 0 }}>TOR price · 24 h</h3>
            <a className="pill" href="#/charts/TOR">Open in the generator →</a>
          </div>
          <TokenPriceChart symbol="TOR" range="24H" mode="area" height={210} />
        </div>
        <div className="panel stack">
          <div className="spread">
            <h3 style={{ margin: 0 }}>Swap rhythm · 24 h</h3>
            <span className="pill">chain events</span>
          </div>
          <ChainEventChart kind="swap" range="24H" height={210} />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- overview */
function Overview() {
  const { session, profile, refresh } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  /* One poll of the node's own market engine for the token list, and one poll of
     the node's TOR/USD quote for every dollar figure. The quote is the same
     `GET /api/market/tor` the charts read, so the balance hint and the chart strip
     can never print two different prices. */
  const market = useAsync(
    () => api.get<{ tokens: Token[]; tor: { price_usd: number } }>("/api/market/tokens"),
    [],
  );
  const { quote: torQuote } = useTorQuote();
  const torPrice = torUsd(torQuote);
  const history = useAsync(
    () =>
      session
        ? api.get<{ records: Record<string, unknown>[] }>(
            `/api/wallets/${encodeURIComponent(session.wallet)}/history?days=30`,
          )
        : Promise.resolve({ records: [] as Record<string, unknown>[] }),
    [session?.wallet],
  );

  if (!session) {
    return (
      <div className="stack">
        <BannerRail />
        <div className="panel stack">
          <h2 style={{ margin: 0 }}>Open or create your Tor AI-NFT Wallet</h2>
          <p className="muted" style={{ margin: 0 }}>
            One wallet for every TOR platform. The node seals the key with your account
            password; this browser never stores it.
          </p>
          <div className="grid cols-3">
            <Stat label="Network" value={BRAND.chain} hint={`chain id ${BRAND.chainId}`} />
            <Stat label="TOR price" value={money(torPrice)} hint="TOR/USD · one quote, every 30 s" />
            <Stat
              label="Listed tokens"
              value={String(market.data?.tokens?.length ?? 0)}
              hint="with logos and pool prices"
            />
          </div>
        </div>
        <SignInPanel />
      </div>
    );
  }

  const balance = Number(profile?.wallet?.balance_tor ?? 0);
  const holdings = Object.entries(profile?.wallet?.tokens || {});
  const priced = holdings.map(([symbol, qty]) => ({
    symbol,
    qty: Number(qty) || 0,
    token: (market.data?.tokens || []).find((item) => item.symbol === symbol),
  }));
  const records = history.data?.records || [];
  const address = profile?.wallet?.address || session.address;

  return (
    <div className="stack">
      <div className="grid cols-3">
        <Stat
          label="Address"
          value={<span className="mono tiny">{shortAddress(address)}</span>}
          hint={session.wallet}
        />
        <Stat
          label="TOR balance"
          value={tor(balance)}
          hint={`${money(balance * torPrice)} at ${money(torPrice)} / TOR`}
        />
        <Stat
          label="Token holdings"
          value={String(holdings.length)}
          hint={priced.slice(0, 2).map((row) => `${row.symbol} ${row.qty}`).join(" · ") || "none yet"}
        />
      </div>

      <div className="panel stack">
        <div className="spread">
          <h3 style={{ margin: 0 }}>TOR price · node samples</h3>
          <a className="pill" href="#/charts">Chart generator →</a>
        </div>
        <TokenPriceChart symbol="TOR" range="24H" mode="area" height={190} />
      </div>

      <div className="panel stack">
        <div className="spread">
          <h3 style={{ margin: 0 }}>Quick actions</h3>
          <button
            className="ghost small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await refresh();
                toast("balances refreshed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "refreshing…" : "Refresh balances"}
          </button>
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <a className="pill" href="#/send">Send TOR</a>
          <a className="pill" href="#/receive">Receive / QR</a>
          <a className="pill" href="#/keys">Import / export key</a>
          <a className="pill" href="#/history">Transaction history</a>
          <a className="pill" href="#/tokens">Token holdings</a>
          <a className="pill" href="#/nfts">AI-NFT holdings</a>
          <a className="pill" href="#/chat">Ask the AI-NFT</a>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="panel stack">
          <h3 style={{ margin: 0 }}>Holdings</h3>
          {priced.length ? (
            <table>
              <thead>
                <tr><th>Token</th><th className="num">You hold</th><th className="num">Value</th></tr>
              </thead>
              <tbody>
                {priced.map((row) => (
                  <tr key={row.symbol}>
                    <td><TokenCell symbol={row.symbol} name={row.token?.name} image={row.token?.image} /></td>
                    <td className="num">{row.qty.toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                    <td className="num">{money(row.qty * (row.token?.price_usd ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted tiny">No tokens yet — receive some, then refresh.</div>
          )}
        </div>

        <div className="panel stack">
          <div className="spread">
            <h3 style={{ margin: 0 }}>Recent activity</h3>
            <a className="pill" href="#/history">Full history →</a>
          </div>
          {records.length ? (
            <table>
              <thead>
                <tr><th>Kind</th><th>Token</th><th className="num">Amount</th><th>Tx</th></tr>
              </thead>
              <tbody>
                {records.slice(0, 8).map((row, index) => (
                  <tr key={index}>
                    <td className="tiny">{String(row.kind || "—")}</td>
                    <td className="tiny">{String(row.token || "TOR")}</td>
                    <td className="tiny num">{String(row.amount_tor ?? row.amount ?? "—")}</td>
                    <td className="tiny mono">{row.txid ? shortAddress(String(row.txid)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted tiny">{history.error || "No activity in the last 30 days."}</div>
          )}
        </div>
      </div>

      <BannerRail />
    </div>
  );
}

/* ------------------------------------------------------------------ tokens */
function Tokens() {
  const { profile } = useWallet();
  const market = useAsync(() => api.get<{ tokens: Token[] }>("/api/market/tokens"), []);
  const held = profile?.wallet?.tokens || {};

  const rows = (market.data?.tokens || [])
    .map((token) => ({ token, qty: Number(held[token.symbol] || 0) }))
    .sort((a, b) => b.qty * (b.token.price_usd ?? 0) - a.qty * (a.token.price_usd ?? 0));

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="spread">
          <h2 style={{ margin: 0 }}>Tokens</h2>
          <span className="pill">{rows.length} listed · logos served by the node</span>
        </div>
        {rows.length ? (
          <table>
            <thead>
              <tr>
                <th>Token</th><th className="num">You hold</th><th className="num">Price</th>
                <th className="num">Value</th><th className="num">Pool liquidity</th><th>Pools</th><th>Chart</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.token.symbol}>
                  <td>
                    <TokenCell symbol={row.token.symbol} name={row.token.name} image={row.token.image} />
                  </td>
                  <td className="num">
                    {row.qty ? row.qty.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—"}
                  </td>
                  <td className="num">{money(row.token.price_usd)}</td>
                  <td className="num">{row.qty ? money(row.qty * (row.token.price_usd ?? 0)) : "—"}</td>
                  <td className="num">{money(row.token.liquidity_usd)}</td>
                  <td>{row.token.quote_assets.map((item) => <span key={item} className="pill">{item}</span>)}</td>
                  <td>
                    <a className="pill" href={`#/charts/${encodeURIComponent(row.token.symbol)}`}>
                      open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted tiny">{market.error || "The node listed no tokens yet."}</div>
        )}
      </div>
      <p className="muted tiny">
        Balances come from your account on {BRAND.chain}; prices and pool depth come from the
        node's own market engine on the same request.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------- nfts */
type NftRow = {
  id: string;
  name: string;
  description?: string;
  image?: string;
  symbol?: string;
  owner?: string;
  mint_address?: string;
  address?: string;
  token_id?: number;
};

function Nfts() {
  const { session, profile } = useWallet();
  const [onlyMine, setOnlyMine] = useState(false);
  const nfts = useAsync(() => api.get<{ nfts: NftRow[] }>("/api/nft/catalogue?limit=48"), []);
  const address = profile?.wallet?.address || session?.address || "";
  const all = nfts.data?.nfts || [];
  /* The catalogue row's `owner` is the wallet that paid the 3 TOR mint — that is the holder. */
  const mine = address ? all.filter((nft) => nft.owner === address) : [];
  const list = onlyMine ? mine : all;

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="spread">
          <h2 style={{ margin: 0 }}>AI-NFT holdings</h2>
          <div className="row" style={{ gap: 8 }}>
            <span className="pill">{all.length} minted on this node</span>
            <button
              className={onlyMine ? "small" : "ghost small"}
              onClick={() => setOnlyMine((value) => !value)}
              disabled={!address}
              title={address ? "Filter by this wallet's address" : "sign in first"}
            >
              {onlyMine ? "Showing only mine" : `Only mine · ${address ? mine.length : "—"}`}
            </button>
          </div>
        </div>
        {address ? (
          <p className="muted tiny" style={{ margin: 0 }}>
            Owned by <span className="mono">{shortAddress(address)}</span> ·{" "}
            {mine.length} of {all.length} 1-of-1s. Ownership is read from the catalogue's{" "}
            <code>owner</code> field, which is the mint payer.
          </p>
        ) : (
          <p className="muted tiny" style={{ margin: 0 }}>
            The catalogue is public. <a href="#/overview">Sign in</a> to see which of these AI-NFTs
            this wallet actually holds.
          </p>
        )}
        {list.length ? (
          <div className="grid cols-4">
            {list.map((nft) => (
              <div key={nft.id} className="panel tight stack" style={{ gap: 8 }}>
                {nft.image ? (
                  <img src={nft.image} alt={nft.name} style={{ width: "100%", borderRadius: 12 }} />
                ) : (
                  <div className="skeleton" style={{ height: 120 }} />
                )}
                <b>{nft.name}</b>
                <span className="muted tiny">
                  {nft.symbol || "AI-NFT"}
                  {nft.token_id ? ` · #${nft.token_id}` : ""}
                </span>
                <span className="muted tiny">
                  owner {shortAddress(nft.owner)}
                  {nft.owner === address ? " · you" : ""}
                </span>
                <a
                  className="pill"
                  href={
                    nft.address && nft.token_id
                      ? `#/chat/${encodeURIComponent(nft.address)}/${nft.token_id}`
                      : "#/chat"
                  }
                >
                  Ask the AI about it
                </a>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted tiny">
            {nfts.error ||
              (onlyMine
                ? "This wallet holds none of the AI-NFTs minted on this node yet."
                : "No AI-NFTs minted on this node yet.")}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- chat */
function Chat({ seed }: { seed: { address: string; token_id: string } | null }) {
  const nfts = useAsync(() => api.get<{ nfts: NftRow[] }>("/api/nft/catalogue?limit=50"), []);
  const [picked, setPicked] = useState("");
  const list = nfts.data?.nfts || [];
  const chosen = list.find((item) => item.id === picked) || null;
  /* a card's "Load into AI chat" arrives through the hash (#/chat/<address>/<id>) and wins */
  const nft = seed
    ? { address: seed.address, token_id: seed.token_id }
    : chosen
      ? { address: chosen.address, token_id: chosen.token_id }
      : null;

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="field">
          <label>Quick pick from this node's catalogue (optional)</label>
          <select value={picked} onChange={(event) => setPicked(event.target.value)}>
            <option value="">No NFT — use the two fields below</option>
            {list.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.token_id ? ` · #${item.token_id}` : ""}
              </option>
            ))}
          </select>
        </div>
        <p className="muted tiny" style={{ margin: 0 }}>
          Picking one fills the ChatBox's address + token ID fields and loads it. Any other NFT
          works too: paste its token address and token ID below, or press <b>Load into AI chat</b> on
          any marketplace card. The node resolves the metadata and forwards it to the model; your
          private key never leaves the node, and the OpenRouter key never reaches this bundle.
        </p>
      </div>
      <ChatBox
        title="AI-NFT ChatBox"
        nft={nft}
        hint="OpenRouter free models, proxied by the node — load any NFT and pick any free model."
        onDetach={() => setPicked("")}
      />
    </div>
  );
}
