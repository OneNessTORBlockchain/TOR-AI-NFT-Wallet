/**
 * config.ts — the only two endpoints this app may talk to, and the chain it
 * refuses to be confused about.
 *
 * Everything here is a *pin*. A pin is not a preference: the app compares what
 * the node says against these constants before it will sign, mint, transfer or
 * talk to a model on the user's behalf. If a pin fails the app says so and stops
 * — it never "continues anyway".
 *
 * Changing a pin is a signed protocol update (see SECURITY.md §1): the issuer
 * attests the new value, `policy_hash` moves, and this file is updated in the
 * same commit. An unsigned change to this file is a security defect.
 */

/** Primary API host. Override at build time with `VITE_TOR_API`. */
export const NODE_PRIMARY =
  ((import.meta.env?.VITE_TOR_API as string | undefined)?.replace(/\/+$/, "") ??
    "https://www.torblockchain.fun");

/**
 * Fallback host — the same chain, served by a second Render deployment. It is a
 * *replica*, not a different network: the binding check still requires the same
 * `chain_id` and `genesis_hash`, so a fallback can never smuggle in another
 * ledger. Override with `VITE_TOR_API_FALLBACK`.
 */
export const NODE_FALLBACK =
  ((import.meta.env?.VITE_TOR_API_FALLBACK as string | undefined)?.replace(/\/+$/, "") ??
    "https://torblockchain.onrender.com");

/** Both hosts, primary first. Used for failover and for the security panel. */
export const NODE_ENDPOINTS = [NODE_PRIMARY, NODE_FALLBACK] as const;

/**
 * The OneNess TOR chain this build is bound to.
 *
 * `chainId` and `genesisHash` are consensus constants: two nodes agree they are
 * on the same chain only if both match. They are pinned here so a wallet can
 * prove which network it is signing for instead of trusting a URL.
 */
export const CHAIN_PIN = {
  name: "OneNess TOR",
  symbol: "TOR",
  chainId: "072316",
  genesisHash: "fc9a220ce910b083188ee90f53561a4e3cf7c24b3723b655417e4fa34af6e156",
  /** `data.symbol`/`native_coin_id` the node publishes for the native coin. */
  nativeCoinId: "TOR111111111111111111111111111111onion",
  /** `oneness-tor/security-module/1` — the signed policy standard. */
  securityStandard: "oneness-tor/security-module/1",
  /** `oneness-security-issuer` — the only key allowed to attest protocol rules. */
  securitySignerName: "oneness-security-issuer",
  securitySignerPubkey: "F3MtFtqCkP3hzcNh5ko2iYcMhC4cjG3Z2hcTahx6APGe",
  /** `oneness-tor-ledger-snapshot/1` — what a replica imports from an origin. */
  snapshotStandard: "oneness-tor-ledger-snapshot/1",
  /**
   * The attested policy this build was written against. It is *recorded*, not
   * enforced: the node may legitimately ship a newer signed policy. A mismatch
   * raises a visible "policy moved" warning so the operator re-reads the rules,
   * and the signature check below still proves the new policy came from the
   * issuer. Only an unsigned or foreign-signed policy is a hard failure.
   */
  knownPolicyHash: "633d7ebd165daafa68bc1c747d63b7fbc06b272cb8a4efa370cd58d040b2d75c",
  /** Address form the ledger actually mints: `TOR1` + 32 + `onion` = 41 chars. */
  addressPattern: /^TOR1[0-9A-Za-z]{32}onion$/,
  addressLength: 41,
} as const;

/** `TOR1…onion` — the only address form the chain accepts. */
export function isTorAddress(value: string): boolean {
  const text = (value || "").trim();
  return text.length === CHAIN_PIN.addressLength && CHAIN_PIN.addressPattern.test(text);
}
