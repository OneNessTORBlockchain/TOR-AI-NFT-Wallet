/**
 * security.tsx — the gate. Nothing on this site signs, sends, mints or talks to a
 * model for the user unless the chain binding passes first.
 *
 * `chain.ts` holds the rules; this file holds the *state* (one probe shared by
 * every screen), the *verdict* the rest of the app asks for, and the page that
 * shows the evidence. The gate is deliberately boring: `allowed` is a boolean
 * derived from real endpoint answers, and `reason` is the node's own words, so a
 * blocked button always explains itself.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { API_BASE, API_FALLBACK } from "./api";
import { CHAIN_PIN } from "./config";
import { checkBinding } from "./chain";
import type { BindingState, RuleVerdict } from "./chain";
import { useToast } from "./ui";

type GuardCtx = {
  state: BindingState | null;
  /** True while a probe is in flight and no previous verdict exists. */
  checking: boolean;
  /** `fail`, or nothing checked yet → the app may not sign. */
  allowed: boolean;
  /** The node's own words for the first failing rule. */
  reason: string;
  refresh: () => Promise<void>;
};

const GUARD_DEFAULT: GuardCtx = {
  state: null,
  checking: true,
  allowed: false,
  reason: "chain binding has not been verified yet",
  refresh: async () => undefined,
};

const GuardContext = createContext<GuardCtx>(GUARD_DEFAULT);

/** Re-probe at most this often; the audit re-hashes the whole ledger on the node. */
const RECHECK_MS = 180_000;

export function ChainGuardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BindingState | null>(null);
  const [checking, setChecking] = useState(true);
  const toast = useToast();

  const run = useCallback(
    async (announce = false) => {
      setChecking(true);
      try {
        const next = await checkBinding();
        setState(next);
        if (announce) {
          if (next.status === "fail") toast("chain binding FAILED — signing is disabled", true);
          else toast(`chain bound · height ${next.info?.height ?? "—"} · ${next.status}`, next.status === "warn");
        }
      } catch (problem) {
        setState({
          status: "fail",
          rules: [],
          digest: null,
          canonical: null,
          info: null,
          verify: null,
          audit: null,
          sync: null,
          attestation: null,
          endpoint: "—",
          checked_at: new Date().toISOString(),
          error: problem instanceof Error ? problem.message : "the binding probe crashed",
        });
      } finally {
        setChecking(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void run(false);
    const timer = window.setInterval(() => void run(false), RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [run]);

  const value = useMemo<GuardCtx>(() => {
    const failing = state?.rules.find((rule) => rule.verdict === "fail") ?? null;
    return {
      state,
      checking,
      allowed: state?.status === "pass" || state?.status === "warn",
      reason: failing ? `${failing.label}: ${failing.detail}` : state?.error || "",
      refresh: () => run(true),
    };
  }, [state, checking, run]);

  return <GuardContext.Provider value={value}>{children}</GuardContext.Provider>;
}

export function useChainGuard(): GuardCtx {
  return useContext(GuardContext);
}

/* ------------------------------------------------------------------ visuals */

const TONE: Record<RuleVerdict, string> = {
  pass: "good",
  warn: "bad",
  fail: "bad",
  checking: "muted",
};

const MARK: Record<RuleVerdict, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
  checking: "…",
};

/** Header pill: the one fact that must never be more than a glance away. */
export function ChainGuardBadge() {
  const { state, checking, allowed } = useChainGuard();
  const status = checking && !state ? "checking" : state?.status ?? "fail";
  const tone = status === "pass" ? "on" : "";
  const label =
    status === "pass"
      ? `chain bound · ${state?.info?.height ?? "—"}`
      : status === "warn"
        ? "chain bound (warn)"
        : status === "checking"
          ? "verifying chain…"
          : "chain NOT verified";
  return (
    <a className={`pill ${tone}`} href="#/security" title={allowed ? "binding verified" : "signing disabled"}>
      <span className="dot" />
      {label}
    </a>
  );
}

/**
 * Inline refusal for a form. Renders nothing when the chain is bound, so a
 * healthy screen stays quiet; when it is not, the form says what to do about it.
 */
export function GuardNotice({ action }: { action: string }) {
  const { allowed, reason, state, checking } = useChainGuard();
  if (allowed) return null;
  return (
    <div className="bad tiny" style={{ lineHeight: 1.5 }}>
      <b>{checking && !state ? "Verifying the chain before you can" : `Refusing to ${action}:`}</b>{" "}
      {checking && !state ? `${action}…` : reason || "the chain binding did not pass"}
      <div style={{ marginTop: 4 }}>
        <a href="#/security">Open the security panel →</a>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- page */

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <tr>
      <th style={{ width: 230 }}>{label}</th>
      <td className={mono ? "mono tiny" : "tiny"} style={{ wordBreak: "break-all" }}>{value}</td>
    </tr>
  );
}

/**
 * `#/security` — the evidence page.
 *
 * Every value on it came from a live endpoint a second ago; nothing is cached
 * into a sentence. The bottom of the page prints the exact command that
 * reproduces the binding digest, because a proof you cannot re-run is not a proof.
 */
export function SecurityPage() {
  const { state, checking, allowed, reason, refresh } = useChainGuard();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard?.writeText(text);
      toast(`${what} copied`);
    } catch {
      toast(`could not copy ${what}`, true);
    }
  };

  const status = checking && !state ? "checking" : state?.status ?? "fail";
  const head = state?.info?.head_hash ?? "";
  const supply = state?.info?.total_supply;

  return (
    <div className="stack">
      <section className="hero">
        <div className="tag">CHAIN-BOUND VERIFICATION</div>
        <h1 style={{ fontSize: "clamp(22px, 3vw, 34px)" }}>
          {status === "pass" ? "Bound to OneNess TOR" : status === "warn" ? "Bound, with a warning" : status === "checking" ? "Verifying the chain…" : "Not verified — signing disabled"}
        </h1>
        <p className="muted tiny" style={{ margin: "6px 0 0" }}>
          {CHAIN_PIN.name} · chain id {CHAIN_PIN.chainId} · the wallet proves the chain before it signs,
          not after.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <span className={`pill ${allowed ? "on" : ""}`}>{MARK[status]}</span>
          <span className="pill">height {state?.info?.height ?? "—"}</span>
          <span className="pill">audit {state?.audit?.verdict ?? "—"}</span>
          <span className="pill">{state?.endpoint ?? "—"}</span>
          <button
            type="button"
            className="ghost small"
            disabled={busy || checking}
            onClick={async () => {
              setBusy(true);
              await refresh();
              setBusy(false);
            }}
          >
            {busy || checking ? "re-checking…" : "Re-check now"}
          </button>
        </div>
        {!allowed ? (
          <div className="bad tiny" style={{ marginTop: 10 }}>
            <b>Send, mint, transfer and AI calls are disabled.</b> {reason}
          </div>
        ) : null}
      </section>

      <div className="panel stack">
        <div className="spread">
          <h3 style={{ margin: 0 }}>The nine rules</h3>
          <span className="muted tiny">checked {state ? new Date(state.checked_at).toLocaleString() : "—"}</span>
        </div>
        <table>
          <tbody>
            {(state?.rules ?? []).map((rule) => (
              <tr key={rule.id}>
                <td style={{ width: 96 }}>
                  <span className={TONE[rule.verdict]} style={{ fontWeight: 700 }}>{MARK[rule.verdict]}</span>
                </td>
                <th style={{ width: 280 }}>{rule.label}</th>
                <td className="mono tiny" style={{ wordBreak: "break-all" }}>
                  {rule.detail}
                  {rule.expected ? <div className="muted">expected {rule.expected}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!state?.rules.length ? (
          <div className="muted tiny">
            {checking ? "asking the node…" : state?.error || "the probe produced no rules"}
          </div>
        ) : null}
      </div>

      <div className="grid cols-2">
        <div className="panel stack">
          <h3>Signed protocol rules</h3>
          <table>
            <tbody>
              <Row label="Standard" mono value={state?.attestation?.standard ?? "—"} />
              <Row label="Attested" mono value={String(state?.attestation?.attested ?? "—")} />
              <Row label="Policy hash" mono value={state?.attestation?.policy_hash ?? "—"} />
              <Row label="Issuer name" value={state?.attestation?.signer?.name ?? "—"} />
              <Row label="Issuer pubkey" mono value={state?.attestation?.signer?.pubkey ?? "—"} />
              <Row label="Pinned pubkey" mono value={CHAIN_PIN.securitySignerPubkey} />
            </tbody>
          </table>
          <p className="muted tiny" style={{ margin: 0 }}>
            A protocol change is only accepted when it carries this issuer's signature. A newer
            <code> policy_hash</code> raises a warning so an operator re-reads the rules; a foreign or
            unsigned policy is a hard failure.
          </p>
        </div>

        <div className="panel stack">
          <h3>Ledger facts</h3>
          <table>
            <tbody>
              <Row label="Chain id" mono value={state?.info?.chain_id ?? "—"} />
              <Row label="Genesis hash" mono value={state?.info?.genesis_hash ?? "—"} />
              <Row label="Head hash" mono value={head || "—"} />
              <Row label="Height" value={state?.info?.height ?? "—"} />
              <Row label="Accounts" value={state?.info?.accounts ?? "—"} />
              <Row label="Supply" value={supply ? `${supply.toLocaleString()} ${CHAIN_PIN.symbol}` : "—"} />
              <Row label="Fee receiver" mono value={state?.info?.fee_receiver ?? "—"} />
              <Row label="Sync role" value={state?.sync?.role ?? "—"} />
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel stack">
        <div className="spread">
          <h3 style={{ margin: 0 }}>Binding digest</h3>
          <button
            type="button"
            className="ghost small"
            disabled={!state?.digest}
            onClick={() => void copy(state?.digest ?? "", "digest")}
          >
            Copy digest
          </button>
        </div>
        <div className="mono tiny" style={{ wordBreak: "break-all", fontSize: 13 }}>
          {state?.digest ?? "WebCrypto unavailable — open this page over https to hash the binding"}
        </div>
        <p className="muted tiny" style={{ margin: 0 }}>
          sha256 of the canonical document below: the four pins plus the live head. Same digest means
          same chain at the same height.
        </p>
        <details>
          <summary className="tiny">The exact bytes that were hashed</summary>
          <pre className="persona mono tiny" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {state?.canonical ?? "—"}
          </pre>
        </details>
        <details>
          <summary className="tiny">Reproduce it yourself</summary>
          <pre className="persona mono tiny" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
{`# 1. the live head the digest covers
curl -s ${state?.endpoint ?? "https://www.torblockchain.fun"}/api/chain/info

# 2. the node's own consensus audit (re-hashes every block)
curl -s ${state?.endpoint ?? "https://www.torblockchain.fun"}/api/chain/sync/audit

# 3. the signed protocol attestation
curl -s ${state?.endpoint ?? "https://www.torblockchain.fun"}/api/chain/sync

# 4. re-hash the canonical document printed above
printf '%s' '<canonical document>' | sha256sum
# expect: ${state?.digest ?? "<digest>"}`}
          </pre>
        </details>
      </div>

      <div className="grid cols-2">
        <div className="panel stack">
          <h3>Consensus audit</h3>
          <table>
            <tbody>
              <Row label="Verdict" value={state?.audit?.verdict ?? "—"} />
              <Row label="Blocks re-hashed" value={state?.audit?.blocks_checked ?? "—"} />
              <Row label="Pages" value={state?.audit?.pages ?? "—"} />
              <Row label="Truncated" value={String(state?.audit?.truncated ?? "—")} />
              <Row label="Errors" value={(state?.audit?.errors ?? []).length} />
              <Row label="Node reachable" value={String(state?.audit?.node_reachable ?? "—")} />
              <Row label="Head at audit" mono value={state?.audit?.head_hash ?? "—"} />
            </tbody>
          </table>
          <p className="muted tiny" style={{ margin: 0 }}>
            The node re-hashes every block with sha3-256, walks <code>prev_hash</code> links and compares
            genesis and head. The wallet reads that verdict — it does not pretend to re-implement the
            ledger, and it will not sign on a failed one.
          </p>
        </div>

        <div className="panel stack">
          <h3>Endpoints</h3>
          <table>
            <tbody>
              <Row label="Answering host" mono value={state?.endpoint ?? "—"} />
              <Row label="Pinned primary" mono value={API_BASE} />
              <Row label="Pinned fallback" mono value={API_FALLBACK} />
              <Row label="Role" value={state?.sync?.role ?? "—"} />
              <Row label="Mode" value={state?.sync?.mode ?? "—"} />
              <Row label="Local height" value={state?.sync?.local_height ?? "—"} />
              <Row label="Last pull" value={state?.sync?.last_pull?.reason ?? "—"} />
            </tbody>
          </table>
          <p className="muted tiny" style={{ margin: 0 }}>
            The fallback is the same chain served by a second deployment: a fallback that failed the
            genesis pin would fail these rules, not replace them. To run your own node against this one,
            follow <b>docs/NODE-SYNC.md</b> and require <code>verdict: in-sync</code> before trusting it.
          </p>
          <div className="row">
            <a className="btn small ghost" href="#/ai">AI providers →</a>
            <a className="btn small ghost" href="#/overview">Back to the wallet</a>
          </div>
        </div>
      </div>
    </div>
  );
}
