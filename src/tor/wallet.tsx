/** Wallet: node account login, balance, send, receive QR, key import/export. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { TorError, api, readSession, writeSession } from "./api";
import type { Session, Token } from "./api";
import { TRANSFER_ROUTE, can, useCapabilities } from "./capabilities";
import { checkAddress } from "./chain";
import { GuardNotice, useChainGuard } from "./security";
import { shortAddress, tor } from "./brand";
import { useToast } from "./ui";

type Profile = {
  account: { username?: string; role?: string } | null;
  wallet: { name: string; address: string; balance_tor?: string; tokens?: Record<string, number> };
};

type Ctx = {
  session: Session | null;
  profile: Profile | null;
  busy: boolean;
  oneTime: { privateKey: string; mnemonic: string } | null;
  login: (username: string, password: string) => Promise<void>;
  signup: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
  clearOneTime: () => void;
};

const WalletContext = createContext<Ctx>({
  session: null, profile: null, busy: false, oneTime: null,
  login: async () => undefined, signup: async () => undefined,
  logout: () => undefined, refresh: async () => undefined,
  clearOneTime: () => undefined,
});

export function WalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [oneTime, setOneTime] = useState<Ctx["oneTime"]>(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    if (!readSession()) return setProfile(null);
    try {
      setProfile(await api.get<Profile>("/api/auth/me"));
    } catch {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(
    async (path: "/api/auth/login" | "/api/auth/signup", username: string, password: string) => {
      setBusy(true);
      try {
        const data = await api.post<{
          wallet: { name: string; address: string };
          /* The node answers {session: <token>, header, expires_at, ttl_seconds} —
             reading `.token` here silently dropped the header on every request. */
          session: { token?: string; session?: string; header?: string };
          one_time?: { private_key_base58: string; mnemonic: string };
        }>(path, { username, password });
        const token = String(data.session?.token || data.session?.session || "");
        if (!token) throw new Error("the node returned no wallet session token");
        const next: Session = {
          wallet: data.wallet.name, address: data.wallet.address,
          token, header: data.session?.header || "x-wallet-session",
        };
        writeSession(next);
        setSession(next);
        await refresh();
        if (data.one_time) {
          setOneTime({ privateKey: data.one_time.private_key_base58,
                       mnemonic: data.one_time.mnemonic });
        }
        toast(path.endsWith("signup") ? "wallet created" : `signed in as ${data.wallet.name}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh, toast],
  );

  const value = useMemo<Ctx>(() => ({
    session, profile, busy, oneTime,
    login: (u, p) => open("/api/auth/login", u, p),
    signup: (u, p) => open("/api/auth/signup", u, p),
    logout: () => {
      api.post("/api/auth/logout").catch(() => undefined);
      writeSession(null);
      setSession(null);
      setProfile(null);
      setOneTime(null);
    },
    refresh,
    clearOneTime: () => setOneTime(null),
  }), [session, profile, busy, oneTime, open, refresh]);

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletPill({ onOpen }: { onOpen?: () => void }) {
  const { session, profile, logout } = useWallet();
  if (!session) return <button className="primary small" onClick={onOpen}>Sign in</button>;
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="pill on"><span className="dot" />{shortAddress(profile?.wallet?.address || session.address)}</span>
      <button className="ghost small" onClick={logout}>Sign out</button>
    </div>
  );
}

export function SignInPanel({ onDone }: { onDone?: () => void }) {
  const { login, signup, busy, oneTime, clearOneTime } = useWallet();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  if (oneTime) {
    return (
      <div className="panel stack">
        <h2>Save your private key</h2>
        <p className="muted tiny">Shown once. Anyone holding it controls the wallet.</p>
        <textarea readOnly rows={2} value={oneTime.privateKey} />
        <textarea readOnly rows={2} value={oneTime.mnemonic} />
        <button className="primary" onClick={() => { clearOneTime(); onDone?.(); }}>
          I stored it — continue
        </button>
      </div>
    );
  }

  return (
    <form
      className="panel stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");
        try {
          if (mode === "login") await login(username.trim(), password);
          else await signup(username.trim(), password);
          onDone?.();
        } catch (problem) {
          setError(problem instanceof TorError ? problem.message : (problem as Error).message);
        }
      }}
    >
      <div className="tabs">
        <button type="button" className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>Sign in</button>
        <button type="button" className={mode === "signup" ? "on" : ""} onClick={() => setMode("signup")}>New wallet</button>
      </div>
      <div className="field">
        <label>Username</label>
        <input value={username} onChange={(event) => setUsername(event.target.value)} required />
      </div>
      <div className="field">
        <label>Password</label>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
      </div>
      {error ? <div className="tiny bad">{error}</div> : null}
      <button className="primary" disabled={busy}>
        {busy ? "working…" : mode === "login" ? "Open my wallet" : "Create wallet + key"}
      </button>
    </form>
  );
}


/** One QR code exactly as `ledger._qr` builds it (segno, inline SVG data URI). */
export type ReceiveCode = {
  label?: string;
  text?: string;
  svg?: string;
  version?: number;
  warning?: string;
};

/** `GET /api/wallets/<name>/receive` — address, pubkey and the real QR codes. */
export type ReceiveView = {
  name?: string;
  address: string;
  pubkey_base58?: string;
  pubkey_hex?: string;
  qr?: { address?: ReceiveCode; pubkey?: ReceiveCode };
  how?: string;
};

function fmtAmount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(value);
}

/** A QR straight from the node, on a white card so a phone camera can read it. */
function QrTile({ code, hint, size = 190 }: { code?: ReceiveCode; hint?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!code?.svg || failed) {
    return (
      <div className="stack" style={{ gap: 6, alignItems: "center" }}>
        <div className="skeleton" style={{ width: size, height: size }} />
        <span className="muted tiny" style={{ textAlign: "center", maxWidth: size + 30 }}>
          {code?.warning || "the node returned no QR image — retry the receive panel"}
        </span>
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 6, alignItems: "center" }}>
      <div style={{ background: "#ffffff", padding: 8, borderRadius: 12, lineHeight: 0 }}>
        <img
          src={code.svg}
          alt={code.label || "receive QR"}
          width={size}
          height={size}
          onError={() => setFailed(true)}
          style={{ width: size, height: size, display: "block" }}
        />
      </div>
      <span className="muted tiny" style={{ textAlign: "center", maxWidth: size + 30 }}>
        {hint || code.text}
      </span>
    </div>
  );
}

/** Balance, receive QR, send, import/export keys, recent history. */
export type WalletTab = "receive" | "send" | "keys";

export function WalletPanel({ tab: requested = "receive" }: { tab?: WalletTab }) {
  const { session, profile, refresh, logout } = useWallet();
  const [tab, setTab] = useState<WalletTab>(requested);
  /* A deep link (#/send, #/keys) is the source of truth for the open tab. */
  useEffect(() => {
    setTab(requested);
  }, [requested]);
  const [receive, setReceive] = useState<ReceiveView | null>(null);
  const [receiveError, setReceiveError] = useState("");
  const [publicHoldings, setPublicHoldings] =
    useState<{ balance_tor?: string; tokens?: Record<string, number> } | null>(null);
  const [history, setHistory] = useState<{ records: Record<string, unknown>[] } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [to, setTo] = useState("");
  const [amountValue, setAmountValue] = useState("1");
  /* "TOR" or any token symbol this wallet holds — the Send dropdown's value. */
  const [asset, setAsset] = useState("TOR");
  /* Two things a held-balance dropdown cannot express: a token's address, and the
     token ID that turns a send into an AI-NFT transfer. Both optional. */
  const [tokenAddr, setTokenAddr] = useState("");
  const [nftTokenId, setNftTokenId] = useState("");
  const [market, setMarket] = useState<Token[]>([]);
  const caps = useCapabilities();
  const [sending, setSending] = useState(false);
  const [password, setPassword] = useState("");
  const [exported, setExported] = useState("");
  const [imported, setImported] = useState("");
  const [message, setMessage] = useState("");
  const toast = useToast();
  const walletName = session?.wallet || "";
  /* Nothing in this panel signs while the chain binding is unverified. */
  const guard = useChainGuard();

  /* The receive panel and the history are owner-only on the node: a stale session
     must say why it refused instead of leaving a skeleton running forever. */
  const loadReceive = useCallback(async () => {
    if (!walletName) return;
    setReceiveError("");
    try {
      setReceive(await api.get<ReceiveView>(
        `/api/wallets/${encodeURIComponent(walletName)}/receive`));
    } catch (problem) {
      setReceive(null);
      setReceiveError(problem instanceof TorError ? problem.message : "receive panel failed");
    }
  }, [walletName]);

  const loadHistory = useCallback(async () => {
    if (!walletName) return;
    setHistoryError("");
    try {
      setHistory(await api.get<{ records: Record<string, unknown>[] }>(
        `/api/wallets/${encodeURIComponent(walletName)}/history?days=30`));
    } catch (problem) {
      setHistory(null);
      setHistoryError(problem instanceof TorError ? problem.message : "history failed");
    }
  }, [walletName]);

  /* Balances are public on this chain, so the token dropdown keeps working even
     when the owner-only receive panel refuses an expired session. */
  const loadHoldings = useCallback(async () => {
    if (!walletName) return;
    try {
      setPublicHoldings(await api.get<{ balance_tor?: string; tokens?: Record<string, number> }>(
        `/api/wallets/${encodeURIComponent(walletName)}/balance`));
    } catch {
      setPublicHoldings(null);
    }
  }, [walletName]);

  useEffect(() => {
    void loadReceive();
    void loadHistory();
    void loadHoldings();
  }, [loadReceive, loadHistory, loadHoldings, session?.token]);

  /* The token list behind the address field: `/api/market/tokens` is the node's own
     answer to "what is this address?", keyed `tor:SYMBOL` on tokens created here. */
  useEffect(() => {
    api
      .get<{ tokens: Token[] }>("/api/market/tokens")
      .then((data) => setMarket(data.tokens || []))
      .catch(() => setMarket([]));
  }, []);

  const wantedToken = tokenAddr.trim();
  const wantedNft = nftTokenId.trim().replace(/^#/, "");
  const resolvedToken = useMemo(() => {
    const needle = wantedToken.toLowerCase();
    if (!needle) return null;
    const bare = needle.replace(/^tor:/, "");
    return (
      market.find(
        (row) =>
          row.symbol.toLowerCase() === bare ||
          (row.mint_address || "").toLowerCase() === needle ||
          `tor:${row.symbol}`.toLowerCase() === needle,
      ) || null
    );
  }, [market, wantedToken]);

  /* A resolved address drives the dropdown, so the balance + whole-unit guards above
     apply to the token the user actually named. */
  useEffect(() => {
    if (resolvedToken) setAsset(resolvedToken.symbol);
  }, [resolvedToken]);

  if (!session) return <SignInPanel />;
  const balance = profile?.wallet?.balance_tor ?? publicHoldings?.balance_tor ?? "0";
  const tokens = profile?.wallet?.tokens || publicHoldings?.tokens || {};
  const address = receive?.address || session.address;
  /* TOR first, then every token this wallet actually holds — the node's own list. */
  const assets = [
    { symbol: "TOR", balance: Number(balance) || 0 },
    ...Object.entries(tokens)
      .map(([symbol, held]) => ({ symbol, balance: Number(held) || 0 }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol)),
  ];
  const picked = assets.find((row) => row.symbol === asset) || assets[0];
  const available = picked?.balance ?? 0;
  /* Gate the AI-NFT branch on the node's own OpenAPI, not on hope. */
  const canTransferNft = caps.ready && can(caps.paths, TRANSFER_ROUTE);

  return (
    <div className="stack">
      <div className="grid cols-3">
        <div className="stat"><span>Wallet</span><b className="mono tiny">{walletName}</b><em>{shortAddress(session.address)}</em></div>
        <div className="stat"><span>TOR balance</span><b>{tor(Number(balance))}</b><em>live from the ledger</em></div>
        <div className="stat"><span>Token holdings</span><b>{Object.keys(tokens).length}</b>
          <em>{Object.entries(tokens).slice(0, 2).map(([k, v]) => `${k} ${v}`).join(" · ") || "none yet"}</em></div>
      </div>

      <div className="panel stack">
        <div className="tabs">
          {(["receive", "send", "keys"] as const).map((item) => (
            <button key={item} className={tab === item ? "on" : ""} onClick={() => setTab(item)}>
              {item === "receive" ? "Receive" : item === "send" ? "Send" : "Import / export"}
            </button>
          ))}
        </div>

        {tab === "receive" ? (
          <div className="grid cols-2">
            <div className="stack">
              <div className="field"><label>Address</label>
                <div className="row" style={{ gap: 8 }}>
                  <input readOnly value={address}
                    onFocus={(event) => event.currentTarget.select()} />
                  <button type="button" className="ghost small" onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(address);
                      toast("address copied");
                    } catch {
                      toast("copy failed — select the address and copy it", true);
                    }
                  }}>Copy</button>
                </div>
              </div>
              {receive?.pubkey_base58 ? (
                <div className="field"><label>Public key</label>
                  <input readOnly className="mono" value={receive.pubkey_base58}
                    onFocus={(event) => event.currentTarget.select()} />
                </div>
              ) : null}
              <p className="muted tiny" style={{ margin: 0 }}>
                Balances are public; spending needs this session.
              </p>
              {receiveError ? (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="tiny bad">{receiveError}</div>
                  <div className="row" style={{ gap: 8 }}>
                    <button type="button" className="ghost small"
                      onClick={() => { void loadReceive(); void loadHistory(); void loadHoldings(); }}>Retry</button>
                    <button type="button" className="ghost small" onClick={logout}>
                      Sign in again
                    </button>
                  </div>
                </div>
              ) : null}
              {history?.records?.length ? (
                <table>
                  <tbody>
                    {history.records.slice(0, 6).map((row, index) => (
                      <tr key={index}>
                        <td className="tiny mono">{String(row.kind || "")}</td>
                        <td className="tiny">{String(row.token || "TOR")}</td>
                        <td className="tiny num">
                          {row.amount_tor != null
                            ? String(row.amount_tor)
                            : `${String(row.amount ?? "")} ${String(row.token || "")}`.trim()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {historyError ? <div className="tiny bad">{historyError}</div> : null}
            </div>
            <div className="panel tight stack" style={{ alignItems: "center", gap: 12 }}>
              <QrTile code={receive?.qr?.address} hint={`${walletName} — receive TOR and any token`} />
              {receive?.qr?.pubkey?.svg ? (
                <QrTile code={receive.qr.pubkey} size={120} hint="public key" />
              ) : null}
            </div>
          </div>
        ) : null}

        {tab === "send" ? (
          <form className="stack" onSubmit={async (event) => {
            event.preventDefault();
            setMessage("");
            /* 1 ── the chain gate. A signature on an unbound chain is a signature
               for a ledger nobody proved. */
            if (!guard.allowed) {
              const why = `refusing to sign: ${guard.reason || "the chain binding did not pass"}`;
              setMessage(why);
              toast(why, true);
              return;
            }
            /* 2 ── the recipient must exist on THIS ledger, not merely look right. */
            const target = await checkAddress(to);
            if (!target.ok) {
              setMessage(`recipient refused — ${target.reason}`);
              return;
            }
            /* A token ID makes this an AI-NFT transfer: address + ID, no amount. */
            if (wantedNft) {
              if (!wantedToken) {
                setMessage("paste the AI-NFT's token address as well as its token ID");
                return;
              }
              if (!canTransferNft) {
                setMessage(
                  `the node does not publish ${TRANSFER_ROUTE}, so an AI-NFT cannot be moved from this wallet — nothing was signed`,
                );
                return;
              }
              setSending(true);
              try {
                await api.post(TRANSFER_ROUTE, {
                  to: to.trim(),
                  token_address: wantedToken,
                  token_id: Number(wantedNft),
                });
                toast(`AI-NFT #${wantedNft} transfer signed by the node`);
                await Promise.all([loadHistory(), loadReceive(), loadHoldings()]);
              } catch (problem) {
                const text = problem instanceof TorError ? problem.message : "the node refused the transfer";
                setMessage(text);
                toast(text, true);
              } finally {
                setSending(false);
              }
              return;
            }
            if (wantedToken && !resolvedToken) {
              setMessage(`${wantedToken} is not a listed token on this node`);
              return;
            }
            const value = Number(amountValue);
            if (!Number.isFinite(value) || value <= 0) {
              setMessage("enter an amount greater than zero");
              return;
            }
            /* ledger.send moves TOR in decimals but tokens in whole units. */
            if (picked.symbol !== "TOR" && Math.trunc(value) !== value) {
              setMessage(`${picked.symbol} moves whole units — use ${Math.trunc(value)} instead of ${amountValue}`);
              return;
            }
            if (value > available) {
              setMessage(`this wallet holds ${fmtAmount(available)} ${picked.symbol}, not ${amountValue}`);
              return;
            }
            setSending(true);
            try {
              const body = picked.symbol === "TOR"
                ? { to: to.trim(), amount: value }
                : { to: to.trim(), token: picked.symbol, amount_token: Math.trunc(value) };
              await api.post(`/api/wallets/${encodeURIComponent(walletName)}/send`, body);
              toast(`sent ${fmtAmount(value)} ${picked.symbol}`);
              await refresh();
              await Promise.all([loadHistory(), loadReceive(), loadHoldings()]);
            } catch (problem) {
              const text = problem instanceof TorError ? problem.message : "send failed";
              setMessage(text);
              toast(text, true);
            } finally {
              setSending(false);
            }
          }}>
            <GuardNotice action="sign a transfer" />
            <div className="field"><label>Recipient</label>
              <input value={to} onChange={(event) => setTo(event.target.value)} placeholder="TOR1…onion" required />
            </div>
            <div className="grid cols-2">
              <div className="field"><label>Token</label>
                <select value={picked.symbol} onChange={(event) => setAsset(event.target.value)}>
                  {assets.map((row) => (
                    <option key={row.symbol} value={row.symbol}>
                      {row.symbol === "TOR"
                        ? `TOR — chain coin · ${fmtAmount(row.balance)}`
                        : `${row.symbol} · ${fmtAmount(row.balance)}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field"><label>Amount ({picked.symbol})</label>
                <input value={amountValue} onChange={(event) => setAmountValue(event.target.value)}
                  inputMode={picked.symbol === "TOR" ? "decimal" : "numeric"}
                  placeholder={picked.symbol === "TOR" ? "1.5" : "1"} required />
              </div>
            </div>
            <p className="muted tiny" style={{ margin: 0 }}>
              Available: {fmtAmount(available)} {picked.symbol}
              {assets.length > 1 ? ` · ${assets.length - 1} token${assets.length === 2 ? "" : "s"} in this wallet` : ""}
              {picked.symbol === "TOR" ? "" : " · token transfers move whole units"}
            </p>
            <div className="grid cols-2">
              <div className="field"><label>Token address (optional)</label>
                <input value={tokenAddr} onChange={(event) => setTokenAddr(event.target.value)}
                  placeholder="tor:SYMBOL or a mint address" spellCheck={false} autoComplete="off" />
              </div>
              <div className="field"><label>Token ID (optional — AI-NFT)</label>
                <input value={nftTokenId} onChange={(event) => setNftTokenId(event.target.value)}
                  placeholder="3" inputMode="numeric" autoComplete="off" />
              </div>
            </div>
            {resolvedToken ? (
              <span className="tiny good">
                resolved {resolvedToken.symbol} · {resolvedToken.mint_address} — the dropdown follows it
              </span>
            ) : null}
            {wantedToken && !resolvedToken ? (
              <span className="tiny bad">no listed token on this node answers to {wantedToken}</span>
            ) : null}
            {wantedNft ? (
              <span className={`tiny ${canTransferNft ? "good" : "bad"}`}>
                {canTransferNft
                  ? `${TRANSFER_ROUTE} is published — the AI-NFT transfer can be signed`
                  : `the node does not publish ${TRANSFER_ROUTE}: an AI-NFT cannot be moved from here`}
              </span>
            ) : null}
            {message ? <div className="tiny bad">{message}</div> : null}
            <button className="primary" disabled={sending || (Boolean(wantedNft) && !canTransferNft)}>
              {sending ? "signing + broadcasting…" : wantedNft ? "Transfer AI-NFT" : `Send ${picked.symbol}`}
            </button>
          </form>
        ) : null}

        {tab === "keys" ? (
          <div className="grid cols-2">
            <div className="stack">
              <div className="field"><label>Account password</label>
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
              <button onClick={async () => {
                try {
                  const data = await api.post<{ secret_key_base58?: string; mnemonic?: string }>(
                    `/api/auth/wallets/${walletName}/export`, { password });
                  setExported(data.secret_key_base58 || data.mnemonic || "");
                  toast("key released — store it offline");
                } catch (problem) {
                  toast(problem instanceof TorError ? problem.message : "export failed", true);
                }
              }}>Export private key</button>
              {exported ? <textarea readOnly rows={3} value={exported} /> : null}
            </div>
            <div className="stack">
              <div className="field"><label>Import a private key</label>
                <textarea rows={3} value={imported} onChange={(event) => setImported(event.target.value)} />
              </div>
              <button disabled={!imported.trim() || !password} onClick={async () => {
                try {
                  await api.post("/api/auth/wallets/import", { password, secret_key_base58: imported.trim() });
                  setImported("");
                  toast("wallet imported");
                  await refresh();
                } catch (problem) {
                  toast(problem instanceof TorError ? problem.message : "import failed", true);
                }
              }}>Import into my account</button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

