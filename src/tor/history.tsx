/**
 * Transaction history — two honest views of the same ledger.
 *
 * Signed in, the page reads the node's own window endpoint,
 * `GET /api/wallets/{name}/history?days=…`, which already converts every row into
 * `amount_tor` / `amount` + `token` + `direction` and returns running totals. That
 * is the authoritative view of YOUR wallet and the one the CSV export uses.
 *
 * Signed out (or looking at the chain at large), the page reads the public feed,
 * `GET /api/chain/events`, which is the 30-day window exactly as the ledger stores
 * it — raw integer amounts, hex txids, block heights. Nothing is re-scaled here,
 * because a 1e8 guess is worse than an honest raw number.
 */
import { useState } from "react";
import { api } from "./api";
import type { History as HistoryPayload, HistoryRow } from "./api";
import { relative, shortAddress } from "./brand";
import { Empty, Spinner, useAsync, useToast } from "./ui";
import { useWallet } from "./wallet";

/** One row of `GET /api/chain/events` — the ledger's own shape. */
type ChainEvent = {
  seq?: number;
  kind?: string;
  from?: string;
  to?: string;
  token?: string | null;
  amount?: number;
  fee?: number;
  note?: string;
  txid?: string;
  height?: number;
  timestamp?: number;
  block_hash?: string;
  external_ref?: string;
  visibility?: string;
};

const WINDOWS = [7, 30, 90];

function num(value: unknown): string {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed)) {
    return value === null || value === undefined || value === "" ? "—" : String(value);
  }
  return parsed.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function raw(value?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** `amount_tor` wins when the node sent one; otherwise the bare amount + symbol. */
function walletAmount(row: HistoryRow): string {
  if (row.amount_tor !== null && row.amount_tor !== undefined && row.amount_tor !== "") {
    return `${num(row.amount_tor)} ${row.token || "TOR"}`;
  }
  if (row.amount !== null && row.amount !== undefined) {
    return `${num(row.amount)} ${row.token || "TOR"}`;
  }
  return "—";
}

function downloadCsv(wallet: string, rows: HistoryRow[]) {
  const columns = ["kind", "direction", "token", "amount", "amount_tor", "platform_fee", "txid", "created_at"];
  const body = rows.map((row) => columns.map((key) => JSON.stringify(String(row[key] ?? ""))).join(","));
  const blob = new Blob([[columns.join(","), ...body].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${wallet || "wallet"}-history.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function HistoryPage() {
  const { session } = useWallet();
  const toast = useToast();
  const walletName = session?.wallet || "";

  const [tab, setTab] = useState<"wallet" | "chain">(session ? "wallet" : "chain");
  const [days, setDays] = useState(30);
  const [tick, setTick] = useState(0);

  const wallet = useAsync(
    () =>
      walletName
        ? api.get<HistoryPayload>(
            `/api/wallets/${encodeURIComponent(walletName)}/history?days=${days}&limit=200`,
          )
        : Promise.resolve({ records: [] as HistoryRow[], totals: {}, window_days: days }),
    [walletName, days, tick],
  );

  const chain = useAsync(
    () => api.get<{ events: ChainEvent[] }>("/api/chain/events?limit=200"),
    [tick],
  );

  const records = wallet.data?.records || [];
  const events = chain.data?.events || [];
  const busy = wallet.loading || chain.loading;

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="spread">
          <div>
            <h2 style={{ margin: 0 }}>Transaction history</h2>
            <p className="muted tiny" style={{ margin: "6px 0 0" }}>
              {session
                ? `Every move on ${walletName} inside the node's public window, newest first.`
                : "Sign in to see your own rows; the public chain tab needs no session."}
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="ghost small" onClick={() => setTick((value) => value + 1)} disabled={busy}>
              {busy ? "loading…" : "Refresh"}
            </button>
            {session && records.length ? (
              <button
                className="ghost small"
                onClick={() => {
                  downloadCsv(walletName, records);
                  toast(`exported ${records.length} rows to CSV`);
                }}
              >
                Export CSV
              </button>
            ) : null}
          </div>
        </div>

        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <div className="tabs">
            {(
              [
                ["wallet", "My wallet"],
                ["chain", "Public chain"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? "on" : ""}
                onClick={() => setTab(key)}
                disabled={key === "wallet" && !session}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "wallet" ? (
            <div className="row" style={{ gap: 6 }}>
              {WINDOWS.map((value) => (
                <button
                  key={value}
                  className={`ghost small ${days === value ? "on" : ""}`}
                  onClick={() => setDays(value)}
                >
                  {value}d
                </button>
              ))}
              <span className="muted tiny">
                {records.length} row{records.length === 1 ? "" : "s"}
                {wallet.data?.window_days ? ` · node window ${wallet.data.window_days}d` : ""}
              </span>
            </div>
          ) : (
            <span className="muted tiny">
              {events.length} public event{events.length === 1 ? "" : "s"} · 30-day window
            </span>
          )}
        </div>
      </div>

      {tab === "wallet" ? (
        !session ? (
          <div className="panel stack">
            <Empty>
              No session in this browser — open <a href="#/overview">the wallet</a>, sign in with your
              node account and come back. Balances are public; a wallet's row-by-row history needs
              its session.
            </Empty>
          </div>
        ) : (
          <div className="stack">
            <div className="grid cols-3">
              <div className="stat">
                <span>Rows</span>
                <b>{records.length}</b>
                <em>last {days} days</em>
              </div>
              <div className="stat">
                <span>Incoming</span>
                <b className="good">
                  {records.filter((row) => String(row.direction || "").toLowerCase().includes("in")).length}
                </b>
                <em>credited to this wallet</em>
              </div>
              <div className="stat">
                <span>Outgoing</span>
                <b className="bad">
                  {records.filter((row) => String(row.direction || "").toLowerCase().includes("out")).length}
                </b>
                <em>signed by this wallet</em>
              </div>
            </div>

            {wallet.data?.totals && Object.keys(wallet.data.totals).length ? (
              <div className="panel tight stack" style={{ gap: 8 }}>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <span className="muted tiny" style={{ letterSpacing: "0.16em", textTransform: "uppercase" }}>
                    Totals
                  </span>
                  {Object.entries(wallet.data.totals).map(([key, value]) => {
                    /* `totals.tokens` is an object of per-symbol sums; the rest are scalars. */
                    if (value && typeof value === "object") {
                      const entries = Object.entries(value as Record<string, number>);
                      if (!entries.length) return null;
                      return entries.map(([symbol, qty]) => (
                        <span key={`${key}-${symbol}`} className="pill">
                          {symbol} · {num(qty)}
                        </span>
                      ));
                    }
                    return (
                      <span key={key} className="pill">
                        {key.replace(/_/g, " ")} · {num(value)}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="panel stack">
              <h3 style={{ margin: 0 }}>Rows</h3>
              {wallet.error ? (
                <div className="tiny bad">{wallet.error}</div>
              ) : wallet.loading && !records.length ? (
                <Spinner label="reading the node's window…" />
              ) : records.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Kind</th>
                      <th>Direction</th>
                      <th>Token</th>
                      <th className="num">Amount</th>
                      <th className="num">Platform fee</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((row, index) => (
                      <tr key={`${row.txid || "row"}-${index}`}>
                        <td className="tiny muted">{relative(row.created_at)}</td>
                        <td className="tiny">{String(row.kind || "—")}</td>
                        <td className="tiny">{String(row.direction || "—")}</td>
                        <td className="tiny">{String(row.token || "TOR")}</td>
                        <td className="tiny num">{walletAmount(row)}</td>
                        <td className="tiny num">
                          {row.platform_fee !== null && row.platform_fee !== undefined
                            ? `${num(row.platform_fee)} TOR`
                            : "—"}
                        </td>
                        <td className="tiny mono">
                          {row.txid ? (
                            <a href={`#/verify/${encodeURIComponent(String(row.txid))}`} title={String(row.txid)}>
                              {shortAddress(String(row.txid))}
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty>{wallet.error || "No transactions in this window."}</Empty>
              )}
            </div>
          </div>
        )
      ) : (
        <div className="panel stack">
          <div className="spread">
            <h3 style={{ margin: 0 }}>Public chain feed</h3>
            <span className="pill">raw ledger units · 1 TOR = 100,000,000 micro</span>
          </div>
          {chain.error ? (
            <div className="tiny bad">{chain.error}</div>
          ) : chain.loading && !events.length ? (
            <Spinner label="reading /api/chain/events…" />
          ) : events.length ? (
            <table>
              <thead>
                <tr>
                  <th>Height</th>
                  <th>When</th>
                  <th>Kind</th>
                  <th>From → To</th>
                  <th>Token</th>
                  <th className="num">Amount</th>
                  <th className="num">Fee</th>
                  <th>Note</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event, index) => (
                  <tr key={`${event.txid || "event"}-${index}`}>
                    <td className="tiny num">{event.height ?? "—"}</td>
                    <td className="tiny muted">{relative(event.timestamp)}</td>
                    <td className="tiny">{event.kind || "—"}</td>
                    <td className="tiny mono">
                      {shortAddress(event.from)} → {shortAddress(event.to)}
                    </td>
                    <td className="tiny">{event.token || "TOR"}</td>
                    <td className="tiny num">{raw(event.amount)}</td>
                    <td className="tiny num">{raw(event.fee)}</td>
                    <td className="tiny muted" style={{ maxWidth: 320 }}>{event.note || "—"}</td>
                    <td className="tiny mono">
                      {event.txid ? (
                        <a href={`#/verify/${encodeURIComponent(event.txid)}`} title={event.txid}>
                          {shortAddress(event.txid)}
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>{chain.error || "The node published no events in the 30-day window."}</Empty>
          )}
          <p className="muted tiny" style={{ margin: 0 }}>
            Amounts and fees are printed exactly as the ledger returns them
            (<code>GET /api/chain/events</code>). Your own converted rows — with{" "}
            <code>amount_tor</code> and <code>platform_fee</code> — live on the wallet tab behind a
            session.
          </p>
        </div>
      )}
    </div>
  );
}
