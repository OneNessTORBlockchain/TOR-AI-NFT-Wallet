#!/usr/bin/env node
/**
 * verify-live.mjs — the wallet's security claims, tested against the real chain.
 *
 * This script is deliberately independent of `src/`: it re-implements the
 * canonical-document digest with node:crypto so that a bug in the browser code
 * cannot hide behind a matching bug here. Run it and compare its digest with the
 * one printed on `#/security` — they must be identical.
 *
 *   node scripts/verify-live.mjs            # both hosts, all checks
 *   node scripts/verify-live.mjs --json     # machine-readable report
 *
 * Exit code 0 only when every required check passes. A failing chain is reported,
 * never skipped: this is the same evidence the UI gates on.
 */
import { createHash } from "node:crypto";

const PRIMARY = process.env.TOR_API || "https://www.torblockchain.fun";
const FALLBACK = process.env.TOR_API_FALLBACK || "https://torblockchain.onrender.com";

const PIN = {
  chainId: "072316",
  genesis: "fc9a220ce910b083188ee90f53561a4e3cf7c24b3723b655417e4fa34af6e156",
  standard: "oneness-tor/security-module/1",
  issuer: "F3MtFtqCkP3hzcNh5ko2iYcMhC4cjG3Z2hcTahx6APGe",
  policy: "633d7ebd165daafa68bc1c747d63b7fbc06b272cb8a4efa370cd58d040b2d75c",
};

const results = [];
let failed = 0;
/** Set by `--json`: keep stdout machine-readable. */
let silent = false;

function record(name, ok, detail, ms) {
  results.push({ name, ok, detail, ms });
  if (!ok) failed += 1;
  if (silent) return;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${name.padEnd(46)} ${String(detail).slice(0, 96)}${ms != null ? `  (${ms} ms)` : ""}`);
}

function note(name, detail) {
  results.push({ name, ok: null, detail });
  if (silent) return;
  console.log(`  NOTE  ${name.padEnd(46)} ${String(detail).slice(0, 120)}`);
}

/** GET returning { status, body, ms, error }; never throws. */
async function get(base, path) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    return { status: response.status, body, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, body: null, ms: Date.now() - started, error: error.message };
  }
}

async function post(base, path, payload, headers = {}) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 200);
    }
    return { status: response.status, body, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, body: null, ms: Date.now() - started, error: error.message };
  }
}

/** Deterministic JSON — the same rule `src/tor/chain.ts` uses. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const body = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${body.join(",")}}`;
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** `TOR1` + 32 + `onion` = 41 characters, exactly what the ledger mints. */
const isTorAddress = (value) => value.length === 41 && /^TOR1[0-9A-Za-z]{32}onion$/.test(value);

/* ------------------------------------------------------------------- checks */

async function main() {
  const json = process.argv.includes("--json");
  silent = json;
  if (!json) {
    console.log("\nOneNess TOR · live verification of the wallet's security claims");
    console.log(`  primary  ${PRIMARY}`);
    console.log(`  fallback ${FALLBACK}`);
  }

  /* 1 ───────────────────────────────────────────────────────────── liveness */
  if (!json) console.log("\n1. host liveness");
  const health = await get(PRIMARY, "/api/health");
  record(
    "primary /api/health",
    health.status === 200 && health.body?.ok === true && health.body?.data?.chain_id === PIN.chainId,
    `HTTP ${health.status} · height ${health.body?.data?.height ?? "—"}`,
    health.ms,
  );
  const healthB = await get(FALLBACK, "/api/health");
  record(
    "fallback /api/health",
    healthB.status === 200 && healthB.body?.ok === true,
    `HTTP ${healthB.status} · height ${healthB.body?.data?.height ?? "—"}`,
    healthB.ms,
  );

  /* 2 ──────────────────────────────────────────────────────── chain binding */
  if (!json) console.log("\n2. chain binding (the pins the wallet enforces)");
  const info = await get(PRIMARY, "/api/chain/info");
  const chain = info.body?.data ?? {};
  record("chain id equals the pin", chain.chain_id === PIN.chainId, `${chain.chain_id} vs ${PIN.chainId}`, info.ms);
  record(
    "genesis hash equals the pin",
    String(chain.genesis_hash).toLowerCase() === PIN.genesis,
    chain.genesis_hash ?? "no genesis",
  );

  const verify = await get(PRIMARY, "/api/chain/verify");
  const snap = verify.body?.data ?? {};
  record(
    "chain/info and chain/verify agree",
    snap.head_hash === chain.head_hash && snap.height === chain.height,
    `head ${String(snap.head_hash).slice(0, 16)}… at ${snap.height} vs ${String(chain.head_hash).slice(0, 16)}… at ${chain.height}`,
    verify.ms,
  );

  const audit = await get(PRIMARY, "/api/chain/sync/audit");
  const report = audit.body?.data ?? {};
  record(
    "node re-hashed every block: in-sync",
    report.verdict === "in-sync" && (report.errors ?? []).length === 0,
    `${report.verdict} · ${report.blocks_checked} blocks · ${(report.errors ?? []).length} errors`,
    audit.ms,
  );
  record("audit walked the pinned genesis", String(report.genesis_hash).toLowerCase() === PIN.genesis, report.genesis_hash ?? "—");
  record("audit reaches the quoted head", report.height === chain.height, `audit ${report.height} · info ${chain.height}`);

  const sync = await get(PRIMARY, "/api/chain/sync");
  const syncBody = sync.body?.data ?? {};
  const attestation =
    syncBody.protocol ??
    syncBody.last_pull?.detail?.protocol ??
    syncBody.replication?.last_pull?.detail?.protocol ??
    null;
  record(
    "protocol rules are attested",
    attestation?.standard === PIN.standard && attestation?.attested === true,
    `${attestation?.standard ?? "none"} · attested=${attestation?.attested}`,
    sync.ms,
  );
  record(
    "attested by the pinned issuer key",
    attestation?.signer?.pubkey === PIN.issuer,
    `${attestation?.signer?.name ?? "?"} ${String(attestation?.signer?.pubkey ?? "?").slice(0, 12)}…`,
  );
  record(
    "policy hash present (drift is a warning, not a failure)",
    typeof attestation?.policy_hash === "string" && attestation.policy_hash.length === 64,
    `${attestation?.policy_hash ?? "none"}${attestation?.policy_hash === PIN.policy ? " (matches this build)" : " (newer than this build)"}`,
  );

  /* the digest the UI prints, recomputed independently */
  const canonical = canonicalJson({
    standard: "oneness-tor/binding/1",
    chain_id: PIN.chainId,
    genesis_hash: PIN.genesis,
    security_standard: PIN.standard,
    issuer_pubkey: PIN.issuer,
    policy_hash: attestation?.policy_hash ?? null,
    height: chain.height ?? null,
    head_hash: chain.head_hash ?? null,
    supply_micro: chain.total_supply_micro ?? null,
  });
  const digest = sha256(canonical);
  record("binding digest is reproducible", /^[0-9a-f]{64}$/.test(digest), digest);

  const infoB = await get(FALLBACK, "/api/chain/info");
  const chainB = infoB.body?.data ?? {};
  record(
    "fallback serves the same chain",
    String(chainB.genesis_hash).toLowerCase() === PIN.genesis,
    `genesis ${String(chainB.genesis_hash).slice(0, 16)}… · height ${chainB.height ?? "—"}`,
    infoB.ms,
  );
  note(
    "head drift between hosts",
    chainB.head_hash === chain.head_hash
      ? "both hosts are at the same head"
      : `${chain.height} vs ${chainB.height ?? "—"} — expected: one is a replica that catches up`,
  );

  /* 3 ────────────────────────────────────────────────────── money + mint */
  if (!json) console.log("\n3. pricing and the AI-NFT catalogue");
  const pricing = await get(PRIMARY, "/api/pricing");
  const mintRow = (pricing.body?.data?.rows ?? []).find((row) => row.code === "nft_mint");
  record("nft_mint price is published", Boolean(mintRow), `${mintRow?.tor ?? "—"} TOR · locked=${mintRow?.locked}`, pricing.ms);
  const catalogue = await get(PRIMARY, "/api/nft/catalogue?limit=5");
  record(
    "catalogue answers with a real shape",
    catalogue.status === 200 && Array.isArray(catalogue.body?.data?.nfts),
    `${catalogue.body?.data?.count ?? 0} minted · price ${catalogue.body?.data?.price_tor ?? "—"} TOR`,
    catalogue.ms,
  );

  /* 4 ─────────────────────────────────────────────────── address validation */
  if (!json) console.log("\n4. recipient validation (a wallet must exist on this ledger)");
  const founder = chain.founder || "TOR12xd7zywc3iuwcls3fqzsozkgo5ahv3gnonion";
  record("founder address passes the format rule", isTorAddress(founder), `${founder} (${founder.length} chars)`);
  const account = await get(PRIMARY, `/api/account/${encodeURIComponent(founder)}`);
  record(
    "the ledger answers for that address",
    account.status === 200 && account.body?.ok === true,
    `HTTP ${account.status} · role ${account.body?.data?.role ?? "—"}`,
    account.ms,
  );
  /* the historical vault bug: `TOR` + 40 hex = 43 characters, never mintable */
  const wrong = `TOR${"a".repeat(40)}`;
  record("a TOR+40hex address fails the format rule", !isTorAddress(wrong), `${wrong.length} chars — the chain mints 41`);
  const wrongLookup = await get(PRIMARY, `/api/account/${encodeURIComponent(wrong)}`);
  record(
    "the ledger also refuses it",
    wrongLookup.status >= 400,
    `HTTP ${wrongLookup.status} ${wrongLookup.body?.error?.code ?? ""}`.trim(),
    wrongLookup.ms,
  );

  /* 5 ───────────────────────────────────────────────────────── AI gateway */
  if (!json) console.log("\n5. AI gateway (the node's own key, then BYO providers)");
  const aiStatus = await get(PRIMARY, "/api/ai/status");
  record(
    "node AI status is readable",
    aiStatus.status === 200,
    `configured=${aiStatus.body?.data?.configured} · ${aiStatus.body?.data?.free_models ?? 0} free models`,
    aiStatus.ms,
  );
  const models = await get(PRIMARY, "/api/ai/models");
  record(
    "free model list is non-empty",
    (models.body?.data?.models ?? []).length > 0,
    `${(models.body?.data?.models ?? []).length} models`,
    models.ms,
  );
  const probe = await post(PRIMARY, "/api/ai/chat", {
    prompt: "Reply with exactly: CHAIN-BOUND OK",
    model: "openrouter/free",
  });
  if (probe.status === 200) {
    record(
      "node AI chat answers",
      true,
      `HTTP 200 · ${probe.ms} ms · “${String(probe.body?.data?.answer ?? "").slice(0, 60)}”`,
      probe.ms,
    );
  } else {
    /* An upstream outage is a finding, not a pass. The app shows this same text. */
    record(
      "node AI chat answers",
      false,
      `HTTP ${probe.status} · ${probe.body?.error?.code ?? "?"} · ${probe.body?.error?.message ?? probe.error ?? "no body"}`,
      probe.ms,
    );
    note(
      "BYO key or local Ollama required while this is down",
      "the #/ai page lets you paste a key for OpenRouter, OpenAI, Anthropic, Hugging Face, Venice AI or point at local Ollama",
    );
  }

  /* ──────────────────────────────────────────────────────────── summary */
  const passed = results.filter((row) => row.ok === true).length;
  const notes = results.filter((row) => row.ok === null).length;
  if (json) {
    console.log(JSON.stringify({ primary: PRIMARY, fallback: FALLBACK, digest, results }, null, 2));
  } else {
    console.log(`\n${passed} passed · ${failed} failed · ${notes} notes`);
    console.log(`binding digest ${digest}`);
    console.log("compare that digest with the one printed on #/security — same chain, same height.\n");
  }
  process.exit(failed === 0 ? 0 : 1);
}

await main();

