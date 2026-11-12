/**
 * TOR API client — one file every TOR platform imports.
 *
 * The node is the product: swap, screener, darkweb, pump, charts and the price
 * engine all read the same endpoints, so this client is deliberately thin and
 * honest. Every answer keeps the node's envelope shape, and a failure carries
 * the node's own error code instead of a generic message.
 */
import { NODE_FALLBACK, NODE_PRIMARY } from "./config";

/**
 * Two hosts, one chain. `VITE_TOR_API` / `VITE_TOR_API_FALLBACK` may point the
 * build at a local node; the defaults are the public OneNess TOR deployments.
 *
 * `API_BASE` stays the *primary* host so that absolute asset URLs keep working
 * when the fallback is answering JSON — a logo must not flicker between hosts.
 */
export const API_BASE = NODE_PRIMARY;
export const API_FALLBACK = NODE_FALLBACK;

/**
 * Which host actually answered last. Every successful call records it, and
 * `#/security` prints it, because "the app is bound to the wrong box" is a fact
 * the operator has to be able to see without reading the network tab.
 */
let activeBase: string = NODE_PRIMARY;

export function activeEndpoint(): string {
  return activeBase;
}

/** Ordered hosts to try: whichever answered last first, then the other one. */
function endpointPlan(): string[] {
  const other = activeBase === NODE_PRIMARY ? NODE_FALLBACK : NODE_PRIMARY;
  return activeBase === other ? [activeBase] : [activeBase, other];
}

export const SESSION_KEY = "tor.wallet.session";

export type ApiError = {
  code: string;
  http_status: number;
  message: string;
  details?: Record<string, unknown> | null;
};

export type Envelope<T> = {
  ok: boolean;
  data: T | null;
  error: ApiError | null;
  meta?: Record<string, unknown>;
};

export class TorError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown> | null;

  constructor(error: ApiError) {
    super(error.message || error.code);
    this.code = error.code;
    this.status = error.http_status;
    this.details = error.details ?? null;
  }
}

export type Session = {
  wallet: string;
  address: string;
  token: string;
  header: string;
};

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed?.token ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSession(session: Session | null) {
  if (!session) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function headers(extra?: HeadersInit): HeadersInit {
  const session = readSession();
  return {
    "content-type": "application/json",
    ...(session ? { [session.header || "x-wallet-session"]: session.token } : {}),
    ...(extra || {}),
  };
}

/** One attempt against exactly one host. No failover logic lives in here. */
async function attempt<T>(
  base: string,
  path: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), init?.timeoutMs ?? 45_000);
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: headers(init?.headers),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as Envelope<T> | null;
    if (!response.ok || !body || body.ok === false) {
      const error: ApiError = body?.error || {
        code: "HTTP_" + response.status,
        http_status: response.status,
        message: `the node answered ${response.status}`,
      };
      throw new TorError(error);
    }
    return body.data as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * A dead host must never look like a dead chain.
 *
 * `https://www.torblockchain.fun` and `https://torblockchain.onrender.com` serve
 * the same ledger, so a network failure — or a gateway 502/503/504 — is answered
 * by trying the other host once. A real answer from the node is *not* retried:
 * a 404 or a 403 is the node speaking, and asking twice would not change it.
 * Timeouts are not retried either: the caller asked for a deadline, and doubling
 * it silently would be a lie about how long the page took.
 */
export async function request<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const plan = endpointPlan();
  let lastProblem: unknown = null;

  for (let index = 0; index < plan.length; index += 1) {
    const base = plan[index];
    try {
      const value = await attempt<T>(base, path, init);
      activeBase = base;
      return value;
    } catch (problem) {
      lastProblem = problem;
      const aborted = (problem as Error)?.name === "AbortError";
      const networkDown = problem instanceof TypeError;
      const gatewayDown =
        problem instanceof TorError && [502, 503, 504].includes(problem.status);
      const last = index === plan.length - 1;
      if (aborted || last || !(networkDown || gatewayDown)) throw problem;
    }
  }
  throw lastProblem;
}

/**
 * `/api/openapi.json` is the raw OpenAPI 3.1 document, not an `{ok,data}` envelope,
 * so it cannot go through `request()` - the envelope check would unwrap `data` and
 * hand back `undefined`. This is the only route that skips the envelope.
 */
export async function spec<T = Record<string, unknown>>(path = "/api/openapi.json"): Promise<T> {
  let lastProblem: unknown = null;
  for (const base of endpointPlan()) {
    try {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`the node answered ${response.status}`);
      activeBase = base;
      return (await response.json()) as T;
    } catch (problem) {
      lastProblem = problem;
      /* A 404 on a document route is the node's answer; only transport broke here. */
      if (!(problem instanceof TypeError)) throw problem;
    }
  }
  throw lastProblem;
}

export const api = {
  get: <T>(path: string, timeoutMs?: number) =>
    request<T>(path, { method: "GET", timeoutMs }),
  post: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
      timeoutMs,
    }),
  spec,
  /** The host that answered last — printed on `#/security`. */
  endpoint: activeEndpoint,
  /** The pinned primary host, for "is this the real one?" comparisons. */
  primary: API_BASE,
  fallback: API_FALLBACK,
};

/* ------------------------------------------------------------------ shapes */

export type Pool = {
  base: "TOR" | "USDC" | string;
  price_usd: number | null;
  liquidity_usd: number;
  price_tor?: number;
  liquidity_tor?: number;
  token_reserve?: number;
  base_reserve?: number;
};

export type Token = {
  symbol: string;
  name: string;
  supply: number;
  holders: number | null;
  mint_address: string;
  owner: string;
  price_usd: number | null;
  price_tor: number | null;
  market_cap_usd: number | null;
  liquidity_usd: number;
  volume_24h_usd: number;
  change_24h: number | null;
  quote_assets: string[];
  pools_usd: Pool[];
  image: string | null;
  created_at: number | null;
  observations?: number;
};

export type TorRow = {
  symbol: string;
  price_usd: number;
  anchor_usd: number;
  market_cap_usd: number | null;
  liquidity_usd: number;
  volume_24h_usd: number;
  holders: number | null;
  image: string | null;
  drift: { drift: number; ratio: number; rule: string };
};

export type MarketSnapshot = {
  at: string;
  tor: TorRow;
  tokens: Token[];
  totals: {
    tokens: number;
    market_cap_usd: number;
    liquidity_usd: number;
    volume_24h_usd: number;
    tor_pools: number;
    usdc_pools: number;
    tradable: number;
  };
  sources: Record<string, string>;
};

export type Banner = {
  slot: number;
  id: string;
  kind: string;
  title: string;
  subtitle: string;
  image: string;
  link: string;
  paid: boolean;
};

export type Project = {
  id: string;
  name: string;
  tagline: string;
  logo: string;
  dev_url: string;
  onion_url: string;
  clearnet_url: string;
  port: number;
  features: string[];
};

export type Chart = {
  symbol: string;
  interval: string;
  points: number;
  candles: { time: number; open: number; high: number; low: number; close: number }[];
  summary: { first: number; last: number; high: number; low: number; change_percent: number | null };
  source: string;
  span: number;
};

export type Model = {
  id: string;
  name: string;
  context_length: number | null;
  description: string;
};

export type Quote = {
  symbol: string;
  base: string;
  side: "buy" | "sell";
  amount_in: number;
  unit_in: string;
  amount_out: number;
  unit_out: string;
  fee?: number;
  fee_bps: number;
  price_usd: number | null;
  amount_micro_in?: number;
  fee_micro?: number;
  fee_tor?: string;
  price_tor?: number;
  executable?: boolean;
  endpoint?: string;
  pool?: {
    token: string;
    token_reserve: number;
    tor_reserve: number;
    tor_reserve_tor?: string;
    fee_bps: number;
    price_tor?: number;
    liquidity_tor?: number;
    created_at?: number;
  };
};

/* ------------------------------------------------------- generated api docs */

export type EndpointDoc = {
  name: string;
  group: string;
  method: string;
  path: string;
  summary: string;
  params: { name: string; in?: string; required?: boolean; type?: string }[];
  auth: string;
  cost_tor: number;
  returns?: string;
  url: string;
};

export type OpenApiDoc = {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url: string }[];
  paths?: Record<string, Record<string, { summary?: string; tags?: string[] }>>;
};

export type KeyPricing = {
  pricing: {
    standard: string;
    header: string;
    prefix: string;
    price: { code: string; label: string; tor_per_30_days: number; micro_tor_per_30_days: number };
    limits: { per_minute: number; per_day: number };
    scopes: string[];
    buy: string;
    use: string;
    revoke: string;
    note: string;
  };
  how: string[];
  catalog: string;
};

/* --------------------------------------------------------------- portfolio */

export type Holdings = {
  address: string;
  pubkey_base58?: string;
  balance_micro?: number;
  balance_tor?: string;
  tokens?: Record<string, number>;
  token_balances?: Record<string, number>;
  nonce?: number;
  role?: string;
  created_at?: number;
  updated_at?: string;
  public?: boolean;
  permanent?: boolean;
  note?: string;
};

export type ChainTotals = {
  accounts: number;
  balance: number;
  holders: number;
  pools: number;
  token_supply?: Record<string, number>;
};

export type LedgerWindow = {
  height: number;
  head_hash?: string;
  genesis_hash?: string;
  chain_id?: string;
  total_supply?: number;
  micro_per_tor?: number;
  fee_receiver?: string;
  founder?: string;
  pools?: number;
  tokens?: number;
  accounts_total?: number;
  updated_at?: string;
  node_reachable?: boolean;
  warning?: string;
};

export type HistoryRow = {
  kind?: string;
  token?: string;
  amount_tor?: string | number;
  amount?: number;
  direction?: string;
  txid?: string;
  created_at?: number;
  platform_fee?: string | number;
  [key: string]: unknown;
};

export type History = {
  records: HistoryRow[];
  totals?: Record<string, number>;
  window_days?: number;
};

/* ------------------------------------------------------------------- ai-nft */

export type NftAttribute = { trait_type: string; value: string };

/**
 * The node's resolved NFT record (`GET /api/nft/metadata` → `data.nft`).
 *
 * It is the same shape the ChatBox persona is built from, whether the NFT is a
 * 1-of-1 minted on this node, a Solana Metaplex mint, or a bare metadata URI —
 * so the wallet never has to know which chain it came from.
 */
export type NftMetadata = {
  address: string;
  token_id: string | null;
  chain: string;
  source: string;
  standard?: string;
  name: string;
  symbol: string;
  description: string;
  image: string;
  animation_url?: string;
  external_url?: string;
  attributes: NftAttribute[];
  nft_id?: string;
  owner_wallet?: string;
  txid?: string;
  height?: number;
  created_at?: string;
  metadata_uri?: string;
  metadata_url?: string;
  metadata_pinned?: boolean;
  raw?: Record<string, unknown>;
};

export type NftLoad = { nft: NftMetadata; prompt: string };

/**
 * Resolve any NFT the node can read into real metadata, plus the exact
 * `I AM THIS NFT` block the model receives. The node raises `NFT_NOT_FOUND`
 * (404) for an unknown token and `VALIDATION_ERROR` (400) for a malformed
 * address or token id, and `request()` keeps that message intact.
 */
export function nftMetadata(address: string, tokenId?: string | number | null): Promise<NftLoad> {
  const query = new URLSearchParams({ address: address.trim() });
  const token = String(tokenId ?? "").trim().replace(/^#/, "");
  if (token) query.set("token_id", token);
  return request<NftLoad>(`/api/nft/metadata?${query.toString()}`);
}
