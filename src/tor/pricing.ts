/**
 * pricing.ts — the mint fee, read from the node every time, never written down.
 *
 * `GET /api/pricing` publishes ten rows; the one that matters here is `nft_mint`.
 * The node is the only authority on what it will charge, so this file quotes
 * `row.tor` verbatim and compares it to the *product target* from the Capitain's
 * brief (2 TOR / NFT, `1.B` of the project spec). If the two disagree the UI says
 * so out loud instead of printing a comfortable number: today the node charges
 * 3.0 TOR, which is why the create screen shows a red "override not signed" strip.
 */
import { useCallback, useEffect, useState } from "react";
import { API_BASE, api } from "./api";

export type PriceRow = {
  code: string;
  label: string;
  locked: boolean;
  micro_tor: number;
  tor: number;
};

export type MintFee = {
  /** The live `nft_mint` row, or null while loading / if the node hides it. */
  row: PriceRow | null;
  rows: PriceRow[];
  loading: boolean;
  error: string;
  at: string | null;
  base: string;
  /** Node price ÷ product target, so the screen can say "+50 % over spec". */
  drift: number | null;
  matchesTarget: boolean;
};

/**
 * The product target, not a market value: it is the price the Captain wrote in
 * the brief. Kept as a default so a re-priced deployment needs no code change
 * (`VITE_MINT_TARGET_TOR`), and never used as a fallback for the live fee.
 */
export const MINT_TARGET_TOR = (() => {
  const raw = Number(import.meta.env?.VITE_MINT_TARGET_TOR);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
})();

export function useMintFee(): MintFee & { reload: () => void } {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [at, setAt] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .get<{ rows: PriceRow[] }>("/api/pricing", 20_000)
      .then((data) => {
        if (!alive) return;
        setRows(data.rows || []);
        setError("");
        setAt(new Date().toISOString());
      })
      .catch((problem: unknown) => {
        if (!alive) return;
        setError(problem instanceof Error ? problem.message : "the node did not answer /api/pricing");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  const row = rows.find((item) => item.code === "nft_mint") ?? null;
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return {
    row,
    rows,
    loading,
    error,
    at,
    base: API_BASE,
    drift: row ? row.tor / MINT_TARGET_TOR : null,
    matchesTarget: row ? Math.abs(row.tor - MINT_TARGET_TOR) < 1e-9 : false,
    reload,
  };
}
