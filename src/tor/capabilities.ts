/**
 * capabilities.ts — what the node can actually do *right now*, read from its own
 * `GET /api/openapi.json` instead of guessed from a spec document.
 *
 * The Buy button depends on this file. `POST /api/nft/transfer` is absent from the
 * node today, so a purchase can be paid but not settled; the UI must say that with
 * the node's own evidence rather than showing a dead button or a fake success.
 * When the Node Operator ships the route, this probe flips the button on with no
 * rebuild — there is no `if (production)` anywhere.
 */
import { useCallback, useEffect, useState } from "react";
import { API_BASE, spec } from "./api";

export type OpenApiDoc = { paths?: Record<string, unknown> } & Record<string, unknown>;

export type Capabilities = {
  /** Every path the node published, e.g. `/api/nft/transfer`. */
  paths: Set<string>;
  /** True once one successful probe has landed (a failure leaves it false). */
  ready: boolean;
  /** The node's own failure text, verbatim, or "". */
  error: string;
  /** When the probe last succeeded (ISO) — printed next to the Buy button. */
  at: string | null;
  base: string;
};

const TTL_MS = 60_000;
let cache: { at: number; stamp: string; paths: Set<string> } | null = null;

/** One in-flight probe shared by every caller; a stale answer is re-read after 60 s. */
export async function nodeRoutes(force = false): Promise<{ paths: Set<string>; stamp: string }> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return { paths: cache.paths, stamp: cache.stamp };
  }
  const doc = await spec<OpenApiDoc>("/api/openapi.json");
  const paths = new Set(Object.keys(doc?.paths ?? {}));
  const stamp = new Date().toISOString();
  cache = { at: Date.now(), stamp, paths };
  return { paths, stamp };
}

/**
 * OpenAPI documents the same route as `/api/x/{id}` and callers often ask for
 * `/api/x` — match both directions so a parameterised route still counts.
 */
export function can(paths: Set<string>, route: string): boolean {
  if (paths.has(route)) return true;
  const bare = route.replace(/\{[^}]+\}/g, "").replace(/\/$/, "");
  for (const published of paths) {
    if (published.replace(/\{[^}]+\}/g, "").replace(/\/$/, "") === bare) return true;
    if (published.startsWith(route) || route.startsWith(published)) {
      const a = published.split("/").length;
      const b = route.split("/").length;
      if (a === b) return true;
    }
  }
  return false;
}

/** The exact route a purchase needs before any TOR is signed away. */
export const TRANSFER_ROUTE = "/api/nft/transfer";

export function useCapabilities(): Capabilities & { reload: () => void } {
  const [state, setState] = useState<Omit<Capabilities, "base" | "reload">>({
    paths: new Set<string>(),
    ready: false,
    error: "",
    at: null,
  });

  const load = useCallback((force: boolean) => {
    let alive = true;
    nodeRoutes(force)
      .then(({ paths, stamp }) => {
        if (alive) setState({ paths, ready: true, error: "", at: stamp });
      })
      .catch((problem: unknown) => {
        if (!alive) return;
        const text = problem instanceof Error ? problem.message : "the node did not answer /api/openapi.json";
        setState((prev) => ({ ...prev, ready: false, error: text }));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => load(false), [load]);

  return { ...state, base: API_BASE, reload: () => void load(true) };
}
