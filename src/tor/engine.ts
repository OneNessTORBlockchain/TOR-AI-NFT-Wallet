/**
 * engine.ts — the door to the TOR AI NFT Marketplace engine (127.0.0.1:8792).
 *
 * The node on :8090 owns identity, minting and the chain. The engine owns the
 * *market*: it mirrors the node catalogue every 20 s, prices each mint at
 * `fee × multiplier` read live from `GET :8090/api/pricing`, and publishes the
 * board this app renders. Nothing here is invented — every ask in the UI comes
 * from a row this client fetched.
 *
 * Override the base with VITE_NFT_ENGINE when the engine runs elsewhere.
 */
export const ENGINE_BASE = (
  ((import.meta.env?.VITE_NFT_ENGINE as string | undefined) ?? "http://127.0.0.1:8792").replace(/\/$/, "")
);

export class EngineError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = "EngineError";
    this.path = path;
  }
}

type Envelope<T> = { ok?: boolean; data?: T; error?: { message?: string } | null };

export async function engineGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = `${ENGINE_BASE}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" }, signal });
  } catch (cause) {
    if ((cause as Error)?.name === "AbortError") throw cause;
    throw new EngineError(
      `the marketplace engine is not answering on ${url} — start it with "npm start" in "TOR AI NFT Marketplace\\server"`,
      path,
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new EngineError(`${url} did not return JSON (HTTP ${response.status})`, path);
  }
  const envelope = body as Envelope<T>;
  if (!response.ok || envelope?.ok === false) {
    throw new EngineError(envelope?.error?.message || `HTTP ${response.status} from ${url}`, path);
  }
  return (envelope?.data ?? (body as T)) as T;
}

/** Media paths are engine-relative (`/media/nft-3-1024.svg`); absolutise once, here. */
export function mediaUrl(path?: string | null): string {
  if (!path) return "";
  if (/^(https?:|data:)/.test(path)) return path;
  return `${ENGINE_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}

/* ------------------------------------------------------------------ shapes */

export type EngineImage = {
  big: string | null;
  hero: string | null;
  thumb: string | null;
  width: number;
  height: number;
  mime: string;
  bytes: number | null;
  sha256: string | null;
  source: string;
  url: string;
};

export type EngineMint = {
  txid: string;
  txid_short: string;
  height: number | null;
  at: string | null;
  fee_tor: number | null;
  status: string | null;
  wallet: string | null;
  owner: string;
};

export type EngineListing = {
  listing_id: string;
  price_micro: number | null;
  price_tor: number | null;
  currency: string;
  status: string;
  settlement: string;
  settlement_note: string;
  basis_code: string | null;
  basis_tor: number | null;
  basis_multiplier: number | null;
  basis_at: string | null;
  source: string;
  verified: string;
  verified_height: number | null;
  note: string | null;
  listed_at: string | null;
  updated_at: string | null;
  owned_by_buyer: boolean;
};

export type EngineCard = {
  id: string;
  token_id: number;
  address: string;
  name: string;
  symbol: string;
  description: string;
  attributes: { trait_type: string; value: string }[];
  traits: number;
  image: EngineImage;
  mint: EngineMint;
  listing: EngineListing | null;
  links: { page: string; metadata: string; media: string; source_record: string };
};

export type EngineFee = {
  code: string;
  label: string;
  micro: number;
  tor: number;
  locked: boolean;
  read_at: string;
  source: string;
};

export type EnginePolicy = {
  enabled: boolean;
  multiplier: number;
  currency: string;
  rule: string;
  settlement: string;
  settlement_note: string;
};

export type EngineBoard = {
  standard: string;
  service_base: string;
  fee: EngineFee | null;
  auto_list: EnginePolicy;
  counts: { nfts: number; active: number; held: number; sales: number };
  floor_micro: number | null;
  floor_tor: number | null;
  ask_micro: number | null;
  ask_tor: number | null;
  sync: {
    last_sync_at: string | null;
    last_ok_at: string | null;
    runs: number;
    running: boolean;
    error: { message: string; at: string } | null;
    tx_probe: { txid: string; state: string; at: string } | null;
  };
  updated_at: string;
  returned: number;
  items: EngineCard[];
};

export type EngineHealth = {
  status: string;
  service: string;
  version: string;
  node_base: string;
  fee: EngineFee | null;
  totals: { nfts: number; listings: number; active: number; held: number; floor_tor: number | null };
  sync: { runs: number; last_sync_at: string | null; last_ok_at: string | null; error: { message: string } | null };
};

export type BoardQuery = { q?: string; sort?: string; status?: string; limit?: number };

export const engine = {
  board: (query: BoardQuery = {}, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.sort) params.set("sort", query.sort);
    if (query.status) params.set("status", query.status);
    if (query.limit) params.set("limit", String(query.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return engineGet<EngineBoard>(`/api/nft/board${suffix}`, signal);
  },
  card: (id: string, signal?: AbortSignal) =>
    engineGet<{ item: EngineCard }>(`/api/nft/board/${encodeURIComponent(id)}`, signal),
  health: (signal?: AbortSignal) => engineGet<EngineHealth>("/api/health", signal),
  /** Ask the engine for an out-of-band catalogue sweep instead of waiting 20 s. */
  sync: async (signal?: AbortSignal) => {
    const url = `${ENGINE_BASE}/api/nft/auto-list/run`;
    const response = await fetch(url, { method: "POST", signal });
    const body = (await response.json().catch(() => null)) as Envelope<unknown> | null;
    if (!response.ok || body?.ok === false) {
      throw new EngineError(body?.error?.message || `HTTP ${response.status} from ${url}`, url);
    }
    return body?.data;
  },
};

/* --------------------------------------------------------------- analytics */

/**
 * Market Cap Price Engine view, computed from the board the engine published —
 * no second source, no stored history, no estimate. `distinct_artworks` exists
 * because this catalogue currently holds remints of one artwork: the board must
 * say "3 minted" *and* "1 distinct artwork" or the market cap row lies.
 */
export type MarketAnalytics = {
  minted: number;
  listed: number;
  held: number;
  sales: number;
  distinct_artworks: number;
  floor_tor: number | null;
  top_tor: number | null;
  ask_tor: number | null;
  average_tor: number | null;
  fee_tor: number | null;
  fee_code: string;
  fee_locked: boolean | null;
  multiplier: number;
  settlement: string;
  updated_at: string;
};

export function analytics(board: EngineBoard): MarketAnalytics {
  const asks = board.items
    .map((item) => item.listing?.price_tor)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const total = asks.reduce((sum, value) => sum + value, 0);
  return {
    minted: board.counts.nfts,
    listed: board.counts.active,
    held: board.counts.held,
    sales: board.counts.sales,
    distinct_artworks: new Set(board.items.map((item) => item.image.sha256 || item.id)).size,
    floor_tor: board.floor_tor,
    top_tor: asks.length ? Math.max(...asks) : null,
    ask_tor: board.ask_tor,
    average_tor: asks.length ? total / asks.length : null,
    fee_tor: board.fee?.tor ?? null,
    fee_code: board.fee?.code ?? "nft_mint",
    fee_locked: board.fee ? board.fee.locked : null,
    multiplier: board.auto_list.multiplier,
    settlement: board.auto_list.settlement,
    updated_at: board.updated_at,
  };
}
