/**
 * verify.tsx — "prove it" page for a transaction id (`#/verify/<txid>`).
 *
 * A mint is only believable if the buyer can check it. This page asks the node
 * for the transaction, and when the node answers 404 it says exactly why instead
 * of hiding it: the AI-NFT mint is stamped in the studio's record at a low block
 * and the public tx index only reaches back so far. The corroboration panel then
 * shows the catalogue row that *does* carry the txid, its charge and its owner,
 * so the reader can decide what is proven and what is not.
 */
import { useEffect, useState } from "react";
import { API_BASE, api } from "./api";
import { shortAddress, tor as fmtTor } from "./brand";
import { useToast } from "./ui";

type CatalogRow = {
  id?: string;
  token_id?: number;
  name?: string;
  symbol?: string;
  txid?: string;
  height?: number | null;
  address?: string;
  wallet?: string;
  charge?: { code?: string; amount_micro?: number; amount_tor?: string | number };
};

export function VerifyTx({ txid }: { txid: string }) {
  const toast = useToast();
  const [tx, setTx] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [row, setRow] = useState<CatalogRow | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError("");
    setTx(null);
    Promise.allSettled([
      api.get<Record<string, unknown>>(`/api/chain/tx/${encodeURIComponent(txid)}`, 20_000),
      api.get<{ nfts: CatalogRow[] }>("/api/nft/catalogue?limit=200", 20_000),
      api.get<{ height: number }>("/api/chain/info", 20_000),
    ]).then(([txResult, catalogue, info]) => {
      if (!alive) return;
      if (txResult.status === "fulfilled") setTx(txResult.value);
      else setError(txResult.reason instanceof Error ? txResult.reason.message : "the node refused the lookup");
      if (catalogue.status === "fulfilled") {
        const match = (catalogue.value.nfts || []).find((item) => item.txid === txid) || null;
        setRow(match);
      }
      if (info.status === "fulfilled") setHead(info.value.height ?? null);
    }).finally(() => {
      if (alive) setBusy(false);
    });
    return () => {
      alive = false;
    };
  }, [txid]);

  return (
    <div className="stack">
      <div className="row">
        <a className="btn small ghost" href="#/market">← market</a>
        <a className="btn small ghost" href="#/create">Create an NFT</a>
      </div>

      <section className="hero">
        <div className="tag">ON-CHAIN VERIFICATION</div>
        <h1 style={{ fontSize: "clamp(22px, 3vw, 34px)" }}>Transaction {shortAddress(txid)}</h1>
        <p className="mono tiny" style={{ wordBreak: "break-all" }}>{txid}</p>
        <div className="row" style={{ marginTop: 10 }}>
          <span className={`pill ${tx ? "on" : ""}`}>
            {busy ? "asking the node…" : tx ? "found in the tx index" : "not in the tx index"}
          </span>
          <span className="pill">chain head {head ?? "—"}</span>
          {row ? <span className="pill on">mint record found</span> : null}
        </div>
      </section>

      {error ? (
        <div className="panel stack">
          <h3>The node's answer</h3>
          <div className="bad tiny mono">{error}</div>
          <p className="muted tiny" style={{ margin: 0 }}>
            That is the node speaking, not this page. The public transaction index only covers recent
            blocks{head ? ` (head is ${head})` : ""}; an AI-NFT mint is stamped in the studio record at
            the block shown below, which can sit outside that window. Nothing is being hidden: the
            catalogue row underneath is the same node's record of the mint.
          </p>
        </div>
      ) : null}

      {tx ? (
        <div className="panel stack">
          <h3>Transaction</h3>
          <pre className="persona mono tiny">{JSON.stringify(tx, null, 2)}</pre>
        </div>
      ) : null}

      {row ? (
        <div className="panel stack">
          <h3>Mint record carrying this txid</h3>
          <table>
            <tbody>
              <tr><th>Token</th><td>{row.name ?? "—"} · {row.id ?? "—"} · #{row.token_id ?? "—"}</td></tr>
              <tr><th>Symbol</th><td>{row.symbol ?? "—"}</td></tr>
              <tr><th>Minted at height</th><td>{row.height ?? "—"}</td></tr>
              <tr><th>Charged</th><td>{row.charge?.amount_tor ? fmtTor(Number(row.charge.amount_tor), 4) : "—"} ({row.charge?.code ?? "—"})</td></tr>
              <tr><th>Owner address</th><td className="mono tiny">{row.address ?? "—"}</td></tr>
              <tr><th>Owner wallet</th><td>{row.wallet ?? "—"}</td></tr>
            </tbody>
          </table>
          <div className="row">
            {row.id ? <a className="btn primary" href={`#/market/${encodeURIComponent(row.id)}`}>Open the token</a> : null}
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                void navigator.clipboard?.writeText(txid);
                toast("txid copied");
              }}
            >
              Copy txid
            </button>
            <span className="muted tiny mono" style={{ wordBreak: "break-all" }}>
              curl {`${API_BASE}/api/chain/tx/${txid}`}
            </span>
          </div>
        </div>
      ) : !busy ? (
        <div className="panel tight muted tiny">
          no mint on this node carries that txid — check it was copied whole, or look the token up on the board.
        </div>
      ) : null}
    </div>
  );
}
