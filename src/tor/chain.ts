/**
 * chain.ts — chain-bound verification, done in the browser, against real bytes.
 *
 * Three questions this file answers, in this order, before anything may be
 * signed on this page:
 *
 *   1. **Which chain is this?** `chain_id` *and* `genesis_hash` must equal the
 *      pins in `config.ts`. A hostname proves nothing; a genesis hash does.
 *   2. **Is the ledger intact?** `GET /api/chain/sync/audit` re-hashes every
 *      block with sha3-256, walks `prev_hash` links and compares genesis/head.
 *      Only `verdict: "in-sync"` with an empty `errors[]` passes. This is the
 *      consensus check the node enforces; the wallet reads its verdict instead
 *      of pretending it can re-implement the node.
 *   3. **Are the protocol rules signed?** The node attests its security module
 *      as `oneness-tor/security-module/1` with a `policy_hash` and the
 *      `oneness-security-issuer` pubkey. The signature only counts when it comes
 *      from the pinned issuer key.
 *
 * The final artefact is a **binding digest**: a sha256 over a canonical string
 * of the pinned constants plus the live head. Two people who see the same
 * digest are looking at the same chain at the same height, and anyone can
 * reproduce it from the `curl` commands printed on `#/security`.
 */
import { CHAIN_PIN, isTorAddress } from "./config";
import { api } from "./api";

/* --------------------------------------------------------------- primitives */

/**
 * Deterministic JSON: keys sorted, no whitespace. A digest over *this* string is
 * reproducible in Python, Rust or shell — which is the whole point of printing it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/** sha256 as lowercase hex, via WebCrypto (available on https and on localhost). */
export async function sha256Hex(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto is unavailable — open this wallet over https:// (or http://127.0.0.1) so chain verification can hash.",
    );
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------- shapes */

export type ChainInfo = {
  chain_id?: string;
  height?: number;
  head_hash?: string;
  genesis_hash?: string;
  accounts?: number;
  total_supply?: number;
  total_supply_micro?: number;
  founder?: string;
  fee_receiver?: string;
  coin?: { name?: string; symbol?: string; decimals?: number; native_coin_id?: string };
};

export type VerifySnapshot = {
  chain_id?: string;
  height?: number;
  head_hash?: string;
  genesis_hash?: string;
  total_supply_micro?: number;
  founder?: string;
  founder_balance_micro?: number;
  fee_receiver?: string;
  checked_at?: number;
};

/** `GET /api/chain/sync/audit` — the node's own answer to "is this ledger intact?" */
export type AuditReport = {
  verdict?: string;
  node_reachable?: boolean;
  height?: number;
  head_hash?: string;
  genesis_hash?: string;
  blocks_checked?: number;
  pages?: number;
  truncated?: boolean;
  errors?: string[];
  peers?: unknown[];
  peers_ahead?: unknown[];
};

/** The node's attestation of its security module (`oneness-tor/security-module/1`). */
export type ProtocolAttestation = {
  standard?: string;
  required?: boolean;
  attested?: boolean;
  policy_hash?: string;
  signer?: { name?: string; pubkey?: string };
};

/** `GET /api/chain/sync` — role, origin, replication and the attested protocol. */
export type SyncStatus = {
  mode?: string;
  role?: string;
  origin?: string | null;
  local_height?: number;
  head_hash?: string;
  genesis_hash?: string;
  total_supply?: number;
  last_pull?: {
    at?: number;
    ok?: boolean;
    reason?: string;
    detail?: { protocol?: ProtocolAttestation };
  } | null;
  /** On the live origin the pull (and its attestation) is reported here. */
  replication?: {
    role?: string;
    url?: string;
    configured?: boolean;
    last_pull?: { at?: number; ok?: boolean; reason?: string; detail?: { protocol?: ProtocolAttestation } } | null;
  };
  protocol?: ProtocolAttestation;
  endpoints?: Record<string, string>;
  catch_up?: { endpoint?: string; from_param?: string; to_param?: string; max_blocks_per_call?: number };
};

/* ------------------------------------------------------------------- readers */

export const chain = {
  info: (timeoutMs = 20_000) => api.get<ChainInfo>("/api/chain/info", timeoutMs),
  verify: (timeoutMs = 20_000) => api.get<VerifySnapshot>("/api/chain/verify", timeoutMs),
  /** Re-hashes every block on the node. Costs a round trip, buys a real verdict. */
  audit: (timeoutMs = 60_000) => api.get<AuditReport>("/api/chain/sync/audit", timeoutMs),
  sync: (timeoutMs = 30_000) => api.get<SyncStatus>("/api/chain/sync", timeoutMs),
};

/**
 * Where the node puts the attestation depends on which role it is playing: a
 * replica records it under `replication.last_pull.detail.protocol`, an origin
 * that has never pulled may publish it at `protocol`, and an older build used a
 * top-level `last_pull`. All three are read here so the rules do not depend on a
 * node version.
 */
export function readAttestation(sync: SyncStatus | null): ProtocolAttestation | null {
  if (!sync) return null;
  return (
    sync.protocol ??
    sync.last_pull?.detail?.protocol ??
    sync.replication?.last_pull?.detail?.protocol ??
    null
  );
}

/* ---------------------------------------------------------------- rule model */

export type RuleVerdict = "pass" | "warn" | "fail" | "checking";

export type BindingRule = {
  id: string;
  label: string;
  verdict: RuleVerdict;
  /** What the node actually said. Never a placeholder. */
  detail: string;
  /** The constant it was compared against, when there is one. */
  expected?: string;
};

export type BindingState = {
  status: RuleVerdict;
  rules: BindingRule[];
  /** sha256 over the canonical binding document — `null` until it can be computed. */
  digest: string | null;
  /** The exact canonical string that was hashed, so anyone can re-hash it. */
  canonical: string | null;
  info: ChainInfo | null;
  verify: VerifySnapshot | null;
  audit: AuditReport | null;
  sync: SyncStatus | null;
  attestation: ProtocolAttestation | null;
  /** Which host answered (primary or fallback). */
  endpoint: string;
  checked_at: string;
  error: string;
};

/**
 * Compare what the node said against the pins. Pure: give it the answers and it
 * returns the verdict list, so the same rules can be exercised offline in tests
 * and re-read on screen without another round trip.
 */
export function evaluateBinding(input: {
  info: ChainInfo | null;
  verify: VerifySnapshot | null;
  audit: AuditReport | null;
  sync: SyncStatus | null;
  endpoint: string;
  error?: string;
}): { rules: BindingRule[]; status: RuleVerdict } {
  const { info, verify, audit, sync, endpoint, error } = input;
  const rules: BindingRule[] = [];
  const attestation = readAttestation(sync);

  rules.push({
    id: "endpoint",
    label: "Node answered",
    verdict: error ? "fail" : "pass",
    detail: error ? error : `${endpoint} answered chain/info, chain/verify, chain/sync and the audit`,
  });

  /* 1 ── the chain id */
  const chainId = info?.chain_id ?? verify?.chain_id ?? "";
  rules.push({
    id: "chain_id",
    label: "Chain id is OneNess TOR",
    verdict: !chainId ? "fail" : chainId === CHAIN_PIN.chainId ? "pass" : "fail",
    detail: chainId ? `node says ${chainId}` : "the node did not publish a chain_id",
    expected: CHAIN_PIN.chainId,
  });

  /* 2 ── the genesis pin: the only thing that actually names a chain */
  const genesis = info?.genesis_hash ?? verify?.genesis_hash ?? "";
  rules.push({
    id: "genesis",
    label: "Genesis hash matches the pin",
    verdict: !genesis ? "fail" : genesis.toLowerCase() === CHAIN_PIN.genesisHash ? "pass" : "fail",
    detail: genesis || "the node did not publish a genesis_hash",
    expected: CHAIN_PIN.genesisHash,
  });

  /* 3 ── two endpoints, one ledger: info and verify must agree */
  const infoHead = String(info?.head_hash ?? "");
  const verifyHead = String(verify?.head_hash ?? "");
  const infoHeight = info?.height ?? -1;
  const verifyHeight = verify?.height ?? -2;
  rules.push({
    id: "agreement",
    label: "chain/info and chain/verify agree",
    verdict:
      !infoHead || !verifyHead
        ? "fail"
        : infoHead === verifyHead && infoHeight === verifyHeight
          ? "pass"
          : "fail",
    detail:
      infoHead && verifyHead
        ? `head ${infoHead.slice(0, 16)}… at height ${infoHeight} vs ${verifyHead.slice(0, 16)}… at ${verifyHeight}`
        : "one of the two reads failed",
  });

  /* 4 ── the consensus check the node performs for us */
  const auditErrors = audit?.errors ?? [];
  rules.push({
    id: "audit",
    label: "Node re-hashed every block: in-sync",
    verdict: !audit ? "fail" : audit.verdict === "in-sync" && auditErrors.length === 0 ? "pass" : "fail",
    detail: audit
      ? `${audit.verdict ?? "no verdict"} · ${audit.blocks_checked ?? 0} blocks re-hashed` +
        (audit.truncated ? " (truncated)" : "") +
        (auditErrors.length ? ` · ${auditErrors.length} error(s): ${auditErrors[0]}` : " · 0 errors")
      : "the audit endpoint did not answer",
    expected: "in-sync",
  });

  /* 5 ── the audit must be about *this* chain, not just any chain */
  rules.push({
    id: "audit_genesis",
    label: "Audit walked the pinned genesis",
    verdict:
      audit?.genesis_hash && audit.genesis_hash.toLowerCase() === CHAIN_PIN.genesisHash ? "pass" : "fail",
    detail: audit?.genesis_hash || "the audit published no genesis_hash",
    expected: CHAIN_PIN.genesisHash,
  });

  /* 6 ── the audit must reach the head the API is quoting */
  rules.push({
    id: "audit_head",
    label: "Audit reaches the quoted head",
    verdict:
      typeof audit?.height === "number" && typeof info?.height === "number" && audit.height === info.height
        ? "pass"
        : "fail",
    detail:
      typeof audit?.height === "number"
        ? `audit height ${audit.height} · info height ${info?.height ?? "—"}`
        : "the audit published no height",
  });

  /* 7 ── signed protocol rules: standard + attested + the issuer's key */
  const signerOk = attestation?.signer?.pubkey === CHAIN_PIN.securitySignerPubkey;
  const standardOk = attestation?.standard === CHAIN_PIN.securityStandard;
  rules.push({
    id: "protocol",
    label: "Protocol rules are signed by the issuer",
    verdict:
      !attestation ? "fail" : standardOk && signerOk && attestation.attested === true ? "pass" : "fail",
    detail: attestation
      ? `${attestation.standard ?? "no standard"} · attested=${String(attestation.attested)} · ` +
        `issuer ${attestation.signer?.name ?? "?"} ${(attestation.signer?.pubkey ?? "?").slice(0, 12)}…`
      : "the node did not attest a security module",
    expected: `${CHAIN_PIN.securityStandard} signed by ${CHAIN_PIN.securitySignerName}`,
  });

  /* 8 ── policy drift is a warning, not a failure: a new policy is legitimate *if* signed */
  const policy = attestation?.policy_hash ?? "";
  rules.push({
    id: "policy",
    label: "Attested policy matches this build",
    verdict: !policy ? "fail" : policy === CHAIN_PIN.knownPolicyHash ? "pass" : "warn",
    detail: !policy
      ? "no policy_hash in the attestation"
      : policy === CHAIN_PIN.knownPolicyHash
        ? policy
        : `${policy} — newer than this build's ${CHAIN_PIN.knownPolicyHash.slice(0, 12)}…, still signed by the issuer`,
    expected: CHAIN_PIN.knownPolicyHash,
  });

  /* 9 ── a replica is legitimate, but the operator should know which box answered */
  rules.push({
    id: "endpoint_role",
    label: "Serving host role",
    verdict: sync?.role === "origin" ? "pass" : "warn",
    detail: sync
      ? `${sync.role ?? "unknown role"} · mode ${sync.mode ?? "—"} · local height ${sync.local_height ?? "—"}`
      : "the node did not describe its sync role",
    expected: "origin",
  });

  const failed = rules.some((rule) => rule.verdict === "fail");
  const warned = rules.some((rule) => rule.verdict === "warn");
  return { rules, status: failed ? "fail" : warned ? "warn" : "pass" };
}

/* ---------------------------------------------------------------- the binding */

/**
 * Fetch every read the rules need, evaluate them, and hash the result.
 *
 * Four endpoints are read concurrently and a single failure does not abort the
 * others, because the useful output is *which* rule failed. `Promise.allSettled`
 * keeps each outcome separate instead of collapsing four answers into one error.
 */
export async function checkBinding(): Promise<BindingState> {
  const checked_at = new Date().toISOString();
  const [info, verify, audit, sync] = await Promise.allSettled([
    chain.info(),
    chain.verify(),
    chain.audit(),
    chain.sync(),
  ]);

  const infoValue = info.status === "fulfilled" ? info.value : null;
  const verifyValue = verify.status === "fulfilled" ? verify.value : null;
  const auditValue = audit.status === "fulfilled" ? audit.value : null;
  const syncValue = sync.status === "fulfilled" ? sync.value : null;
  const failures = [info, verify, audit, sync]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => (result.reason instanceof Error ? result.reason.message : "no answer"));
  /* Only a total blackout is the endpoint's fault; one bad read is a failed rule. */
  const error = failures.length === 4 ? failures[0] : "";

  const { rules, status } = evaluateBinding({
    info: infoValue,
    verify: verifyValue,
    audit: auditValue,
    sync: syncValue,
    endpoint: api.endpoint(),
    error,
  });

  /* The digest covers the pins *and* the live head, so it moves with the chain. */
  const canonical = canonicalJson({
    standard: "oneness-tor/binding/1",
    chain_id: CHAIN_PIN.chainId,
    genesis_hash: CHAIN_PIN.genesisHash,
    security_standard: CHAIN_PIN.securityStandard,
    issuer_pubkey: CHAIN_PIN.securitySignerPubkey,
    policy_hash: readAttestation(syncValue)?.policy_hash ?? null,
    height: infoValue?.height ?? null,
    head_hash: infoValue?.head_hash ?? null,
    supply_micro: infoValue?.total_supply_micro ?? null,
  });

  let digest: string | null = null;
  try {
    digest = await sha256Hex(canonical);
  } catch {
    digest = null;
  }

  return {
    status,
    rules,
    digest,
    canonical,
    info: infoValue,
    verify: verifyValue,
    audit: auditValue,
    sync: syncValue,
    attestation: readAttestation(syncValue),
    endpoint: api.endpoint(),
    checked_at,
    error,
  };
}

/* ------------------------------------------------------- recipient validation */

export type AddressCheck = {
  ok: boolean;
  address: string;
  /** Why it was refused, or what the ledger said about it. */
  reason: string;
  /** True only when `GET /api/account/<address>` answered for this address. */
  exists: boolean;
  balance_tor?: string;
  role?: string;
};

/**
 * A wallet "functions on OneNess TOR" only if the ledger knows it. The regex is
 * cheap and catches typos; the ledger read catches everything else — including a
 * well-formed address that belongs to a different network, which is exactly the
 * class of mistake that loses coins.
 */
export async function checkAddress(value: string, timeoutMs = 15_000): Promise<AddressCheck> {
  const address = (value || "").trim();
  if (!address) {
    return { ok: false, address, exists: false, reason: "enter a recipient address" };
  }
  if (!isTorAddress(address)) {
    return {
      ok: false,
      address,
      exists: false,
      reason:
        `${address.length} characters — a OneNess TOR address is ${CHAIN_PIN.addressLength}: ` +
        "`TOR1` + 32 characters + `onion`",
    };
  }
  try {
    const account = await api.get<{ address?: string; balance_tor?: string; role?: string }>(
      `/api/account/${encodeURIComponent(address)}`,
      timeoutMs,
    );
    return {
      ok: true,
      address,
      exists: true,
      balance_tor: account?.balance_tor,
      role: account?.role,
      reason: `the ledger knows this address${account?.role ? ` (${account.role})` : ""}`,
    };
  } catch (problem) {
    const text = problem instanceof Error ? problem.message : "the ledger did not answer";
    return {
      ok: false,
      address,
      exists: false,
      reason: /404|NOT_FOUND|not found/i.test(text)
        ? "a well-formed TOR address, but this ledger has no account for it — nobody could receive here"
        : text,
    };
  }
}

/* ------------------------------------------------ canonical signature message */

/**
 * The string every signed state-changing call in this ecosystem signs:
 * `method`, `path`, `timestamp`, `nonce`, `sha256(body)` — the rule the node
 * documents at `POST /wallet/verify`. Building it here means the wallet can show
 * the exact bytes it is asking the node to verify instead of a black box.
 */
export async function canonicalSignatureMessage(input: {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body?: unknown;
}): Promise<{ message: string; bodyHash: string }> {
  const bodyText = input.body === undefined ? "" : canonicalJson(input.body);
  const bodyHash = await sha256Hex(bodyText);
  const message = [
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.nonce,
    bodyHash,
  ].join("\n");
  return { message, bodyHash };
}

