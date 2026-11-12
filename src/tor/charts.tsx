/**
 * charts.tsx — every token chart in the wallet, plus the generator that builds them on demand.
 *
 * One rule decides this whole file: a chart is a pure function of the points it is handed, and
 * nobody here invents movement.
 *
 * What the node actually publishes, checked on the live node at 16:33Z:
 *   - `/api/market/chart/{symbol}?points=N` samples the live AMM reserve and quotes it in **TOR**
 *     (`price_tor`). For TOR itself that quote is 1.0 by definition, and for every other symbol it
 *     is the pool rate — so the raw candles say 1.00 for TOR and 0.34168 for GRAM. The *dollar*
 *     number is published separately: `/api/market/tor` carries `price_usd` (3.60), `anchor_usd`
 *     and the drift the Price & Marketcap Engine applied, and `/api/market/tokens` repeats it per
 *     token. Every axis below therefore multiplies the node's TOR quote by the node's own TOR/USD
 *     rate — that is why the TOR chart reads $3.60, not the $1.00 a raw `price_tor` implies.
 *   - all 122 sampled windows still close at ONE distinct value, so a price chart today is honestly
 *     a flat band. We draw that band at the real (USD) value and say why.
 *   - `/api/chain/events` carries `timestamp` (epoch seconds) and `kind`
 *     (mint / swap / fee / transfer) — real history, so counts per bucket are real bars.
 *   - `/api/public/tokens` carries `pools[].created_at` per pool — real pool-creation history.
 *   - the marketplace engine's board carries `listing.listed_at` / `price_tor` — real ask history.
 *   - `supply`, `holders`, `liquidity`, `market_cap`, `volume` are single current readings. There
 *     is no history endpoint for them, so they render as a rank bar against the chain maximum and
 *     never as a fake line.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { api } from "./api";
import type { Chart, Token } from "./api";
import { money, pct } from "./brand";
import { engine } from "./engine";
import type { EngineCard } from "./engine";
import { Empty, Spinner, Stat, useAsync } from "./ui";

/* ------------------------------------------------------------------- shapes */

/** `t` is epoch SECONDS — the unit the node speaks, never milliseconds. */
export type Point = { t: number; v: number };

export type ChartMode = "area" | "line" | "bars" | "candles";

export type RangeKey = "1H" | "24H" | "7D" | "30D";

export type SeriesSummary = {
  count: number;
  first: number;
  last: number;
  high: number;
  low: number;
  change: number | null;
  distinct: number;
  /** true when the window holds one value: the chart draws one honest band, not a wiggle */
  flat: boolean;
};

export const RANGES: Record<RangeKey, { label: string; seconds: number; pricePoints: number; buckets: number }> = {
  "1H": { label: "1 hour", seconds: 3_600, pricePoints: 24, buckets: 12 },
  "24H": { label: "24 hours", seconds: 86_400, pricePoints: 48, buckets: 24 },
  "7D": { label: "7 days", seconds: 604_800, pricePoints: 120, buckets: 28 },
  "30D": { label: "30 days", seconds: 2_592_000, pricePoints: 200, buckets: 30 },
};

export const RANGE_KEYS: RangeKey[] = ["1H", "24H", "7D", "30D"];

/* ------------------------------------------------------------------ helpers */

/** Axis numbers: short, mono-friendly, never scientific notation in a label. */
export function num(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01) return value.toFixed(4);
  if (abs >= 0.000001) return value.toFixed(6);
  return value.toExponential(2);
}

/** Tick label for a time axis: clock inside a day, month-day outside it. UTC, always labelled. */
export function clock(seconds: number, range: RangeKey): string {
  if (!Number.isFinite(seconds)) return "—";
  const iso = new Date(seconds * 1000).toISOString();
  return range === "1H" || range === "24H" ? iso.slice(11, 16) : iso.slice(5, 10);
}

/** The honest summary every caption quotes. */
export function summarize(points: Point[]): SeriesSummary {
  const values = points.map((point) => point.v).filter((value) => Number.isFinite(value));
  if (!values.length) {
    return { count: 0, first: 0, last: 0, high: 0, low: 0, change: null, distinct: 0, flat: true };
  }
  const first = values[0];
  const last = values[values.length - 1];
  const high = Math.max(...values);
  const low = Math.min(...values);
  const distinct = new Set(values.map((value) => value.toPrecision(12))).size;
  return {
    count: values.length,
    first,
    last,
    high,
    low,
    change: first === 0 ? null : ((last - first) / first) * 100,
    distinct,
    flat: distinct < 2,
  };
}

export function candlesToPoints(candles: Chart["candles"]): Point[] {
  return candles.map((candle) => ({ t: candle.time, v: candle.close }));
}

/**
 * Bucket raw epoch-second stamps into equal windows, newest stamp on the right edge (or now,
 * when the clock is ahead of the data — whichever is later, and the caption says which).
 * Empty buckets stay, at zero: a gap in trading is information, not something to hide.
 */
export function bucketCounts(stamps: number[], range: RangeKey) {
  const { seconds, buckets } = RANGES[range];
  const clean = stamps.filter((stamp) => Number.isFinite(stamp) && stamp > 0);
  const now = Math.floor(Date.now() / 1000);
  const newest = clean.length ? Math.max(...clean) : now;
  /* When the node's events are older than the window (a quiet chain, or a clock ahead of the data),
     anchoring on "now" would draw thirty empty bars and teach nothing. Anchor on the newest real
     event instead, and let the caption say which anchor was used. */
  const stale = newest < now - seconds;
  const edge = stale ? newest : Math.max(newest, now);
  const from = edge - seconds;
  const width = seconds / buckets;
  const counts = new Array(buckets).fill(0) as number[];
  let inside = 0;
  for (const stamp of clean) {
    if (stamp < from || stamp > edge) continue;
    const index = Math.min(buckets - 1, Math.floor((stamp - from) / width));
    counts[index] += 1;
    inside += 1;
  }
  const points: Point[] = counts.map((value, index) => ({ t: from + index * width, v: value }));
  return {
    points,
    from,
    to: edge,
    inside,
    total: clean.length,
    anchoredOn: stale
      ? "the newest event the node returned — its events are older than this window"
      : "this clock",
  };
}

/** Engine board → the real ask history, one point per live listing. */
export function floorPoints(items: EngineCard[]): Point[] {
  return items
    .filter((item) => item.listing?.status === "active" && Number.isFinite(item.listing?.price_tor ?? NaN))
    .map((item) => ({
      t:
        Math.floor(Date.parse(item.listing?.listed_at || "") / 1000) ||
        Math.floor(Date.parse(item.mint.at || "") / 1000) ||
        0,
      v: Number(item.listing?.price_tor),
    }))
    .filter((point) => point.t > 0 && Number.isFinite(point.v))
    .sort((a, b) => a.t - b.t);
}

/** Every token + pool creation stamp the registry published — real on-chain history. */
export function poolStamps(tokens: Token[]): number[] {
  const stamps: number[] = [];
  for (const token of tokens) {
    for (const pool of token.pools_usd || []) {
      const at = Number((pool as unknown as { created_at?: number }).created_at);
      if (Number.isFinite(at) && at > 0) stamps.push(at);
    }
    if (Number.isFinite(token.created_at ?? NaN) && token.created_at) stamps.push(Number(token.created_at));
  }
  return stamps;
}

/* ---------------------------------------------------------------- renderer */

const VIEW = 720;

type CanvasProps = {
  points: Point[];
  candles?: Chart["candles"];
  mode: ChartMode;
  range: RangeKey;
  height?: number;
  format: (value: number) => string;
  /** what the caption calls this series, e.g. "close" or "swaps per bucket" */
  unit: string;
  note?: string;
};

export function ChartCanvas({
  points,
  candles,
  mode,
  range,
  height = 240,
  format,
  unit,
  note,
}: CanvasProps) {
  const rawId = useId();
  const gradientId = `torchart-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [hover, setHover] = useState<number | null>(null);

  const usingCandles = mode === "candles" && Array.isArray(candles) && candles.length > 0;
  const bars = usingCandles ? candles! : [];
  const series = usingCandles ? bars.map((candle) => ({ t: candle.time, v: candle.close })) : points;
  const scaleValues = usingCandles
    ? bars.flatMap((candle) => [candle.low, candle.high])
    : series.map((point) => point.v);

  if (!series.length || !scaleValues.length) {
    return <Empty>{note || "the node returned no series for this window"}</Empty>;
  }

  const summary = summarize(series);
  const pad = { top: 14, right: 66, bottom: 22, left: 8 };
  const plotW = VIEW - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  let min = Math.min(...scaleValues);
  let max = Math.max(...scaleValues);
  const flat = max - min < 1e-12;
  if (mode === "bars") {
    /* counts start at zero and stop at the exact tallest bucket, so the top label is a real number
       and the tallest bar is not floating in the middle of the plot */
    min = 0;
    max = Math.max(1, Math.ceil(max));
  } else if (!flat) {
    const breather = (max - min) * 0.08;
    min -= breather;
    max += breather;
  }

  const tMin = Math.min(...series.map((point) => point.t));
  const tMax = Math.max(...series.map((point) => point.t));
  const tSpan = tMax - tMin;
  const xAt = (t: number) => pad.left + (tSpan > 0 ? ((t - tMin) / tSpan) * plotW : plotW / 2);
  const flatY = mode === "bars" ? pad.top + plotH : pad.top + plotH / 2;
  const yAt = (v: number) => (flat ? flatY : pad.top + (1 - (v - min) / (max - min)) * plotH);

  const tone =
    summary.flat || summary.change === null
      ? "var(--accent)"
      : summary.change >= 0
        ? "var(--good)"
        : "var(--bad)";
  const linePath = series
    .map((point, index) => `${index ? "L" : "M"}${xAt(point.t).toFixed(2)},${yAt(point.v).toFixed(2)}`)
    .join(" ");
  const bottom = pad.top + plotH;
  const lastX = xAt(series[series.length - 1].t).toFixed(2);
  const firstX = xAt(series[0].t).toFixed(2);
  const areaPath = `${linePath} L${lastX},${bottom.toFixed(2)} L${firstX},${bottom.toFixed(2)} Z`;

  const slot = plotW / Math.max(1, series.length);
  const hovered = hover === null ? null : series[hover];
  const hoveredCandle = hover === null || !usingCandles ? null : bars[hover];

  function onPointer(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const target = tMin + ratio * tSpan;
    let best = 0;
    let gap = Number.POSITIVE_INFINITY;
    series.forEach((point, index) => {
      const distance = Math.abs(point.t - target);
      if (distance < gap) {
        gap = distance;
        best = index;
      }
    });
    setHover(best);
  }

  return (
    <figure className="tor-chart">
      <div className="tor-chart__read">
        <span className="muted tiny">{hovered ? `${clock(hovered.t, range)} UTC` : `${unit} · ${RANGES[range].label}`}</span>
        <b>{format(hovered ? hovered.v : summary.last)}</b>
        {summary.change !== null && !summary.flat ? (
          <span className={summary.change >= 0 ? "good tiny" : "bad tiny"}>{pct(summary.change)}</span>
        ) : (
          <span className="muted tiny">flat window</span>
        )}
      </div>

      <svg
        className="chart"
        viewBox={`0 0 ${VIEW} ${height}`}
        role="img"
        aria-label={`${unit} chart over ${RANGES[range].label}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity="0.36" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const y = pad.top + fraction * plotH;
          return (
            <line
              key={fraction}
              x1={pad.left}
              x2={pad.left + plotW}
              y1={y}
              y2={y}
              stroke="var(--line)"
              strokeWidth={fraction === 1 ? 1 : 0.6}
            />
          );
        })}

        {mode === "area" && !summary.flat ? <path d={areaPath} fill={`url(#${gradientId})`} /> : null}

        {(mode === "area" || mode === "line") && !summary.flat ? (
          <path d={linePath} fill="none" stroke={tone} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ) : null}

        {mode === "bars"
          ? series.map((point, index) => {
              const width = Math.max(1, slot * 0.66);
              const y = yAt(point.v);
              return (
                <rect
                  key={index}
                  x={xAt(point.t) - width / 2}
                  y={y}
                  width={width}
                  height={Math.max(point.v > 0 ? 1 : 0, bottom - y)}
                  fill={tone}
                  opacity={0.75}
                />
              );
            })
          : null}

        {usingCandles
          ? bars.map((candle, index) => {
              const width = Math.max(1, slot * 0.62);
              const x = xAt(candle.time);
              const up = candle.close >= candle.open;
              const colour = up ? "var(--good)" : "var(--bad)";
              const bodyTop = Math.min(yAt(candle.open), yAt(candle.close));
              const bodyHeight = Math.max(1, Math.abs(yAt(candle.open) - yAt(candle.close)));
              return (
                <g key={index}>
                  <line x1={x} x2={x} y1={yAt(candle.high)} y2={yAt(candle.low)} stroke={colour} strokeWidth={1} />
                  <rect x={x - width / 2} y={bodyTop} width={width} height={bodyHeight} fill={colour} opacity={0.9} />
                </g>
              );
            })
          : null}

        {summary.flat ? (
          <line
            x1={pad.left}
            x2={pad.left + plotW}
            y1={flatY}
            y2={flatY}
            stroke={tone}
            strokeWidth={2}
            strokeDasharray="7 5"
          />
        ) : null}

        {(flat ? [0.5] : [0, 0.5, 1]).map((fraction) => (
          <text
            key={fraction}
            x={VIEW - 6}
            y={pad.top + fraction * plotH + (flat || fraction !== 0 ? 3 : 9)}
            textAnchor="end"
          >
            {format(flat ? summary.last : max - fraction * (max - min))}
          </text>
        ))}

        {[0, 1, 2, 3].map((step) => {
          const index = Math.min(series.length - 1, Math.round((step / 3) * (series.length - 1)));
          const point = series[index];
          return (
            <text
              key={step}
              x={xAt(point.t)}
              y={height - 6}
              textAnchor={step === 0 ? "start" : step === 3 ? "end" : "middle"}
            >
              {clock(point.t, range)}
            </text>
          );
        })}

        {hovered ? (
          <g>
            <line
              x1={xAt(hovered.t)}
              x2={xAt(hovered.t)}
              y1={pad.top}
              y2={bottom}
              stroke="var(--line-strong)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle cx={xAt(hovered.t)} cy={yAt(hovered.v)} r={3.5} fill={tone} stroke="var(--bg)" strokeWidth={1.5} />
          </g>
        ) : null}

        <rect
          x={pad.left}
          y={pad.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          style={{ cursor: "crosshair" }}
          onPointerMove={onPointer}
          onPointerLeave={() => setHover(null)}
        />


      </svg>

      <figcaption className="tiny muted">
        {hoveredCandle
          ? `O ${format(hoveredCandle.open)} · H ${format(hoveredCandle.high)} · L ${format(hoveredCandle.low)} · C ${format(hoveredCandle.close)}`
          : note}
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------- sparkline */

/** Inline trend for a table row: no axes, no labels, one honest line. */
export function Sparkline({
  points,
  width = 104,
  height = 26,
  tone,
}: {
  points: Point[];
  width?: number;
  height?: number;
  tone?: string;
}) {
  const summary = summarize(points);
  const stroke =
    tone || (summary.flat || summary.change === null ? "var(--muted)" : summary.change >= 0 ? "var(--good)" : "var(--bad)");
  const pad = 2;
  if (points.length < 2 || summary.flat) {
    return (
      <svg className="tor-spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="one value — no movement to draw">
        <line x1={pad} x2={width - pad} y1={height / 2} y2={height / 2} stroke={stroke} strokeWidth={1.5} strokeDasharray="4 3" />
      </svg>
    );
  }
  const values = points.map((point) => point.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const path = points
    .map((point, index) => {
      const x = pad + (index / (points.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (point.v - min) / span) * (height - pad * 2);
      return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="tor-spark" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="trend">
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------- TOR/USD — the node's own number */

/**
 * The one number this file is forbidden to invent.
 *
 * `/api/market/chart/{symbol}` answers in TOR: `price_tor`. TOR's own quote is 1.0 (1 TOR = 1 TOR),
 * so a chart that prints `$1.00` on it is quoting TOR in TOR and calling it dollars — the exact bug
 * this section exists to kill. The USD figure is published by the node on `/api/market/tor`
 * (`price_usd` 3.60 today, `anchor_usd`, the engine's drift), and per token on
 * `/api/market/tokens/{symbol}`. We read that rate and scale; nothing here hard-codes 3.60, and if
 * the quote cannot be read the axis stays in TOR rather than lying with a dollar sign.
 */
export type TorQuote = {
  symbol: string;
  price_usd: number;
  anchor_usd: number;
  price_tor: number;
  drift?: { drift: number; ratio: number; rule: string };
};

let quoteCache: { at: number; promise: Promise<TorQuote> } | null = null;

/** 700 bytes; shared by every chart on a screen for 15 s, so one screen makes one read. */
export function torQuote(force = false): Promise<TorQuote> {
  const now = Date.now();
  if (!force && quoteCache && now - quoteCache.at < 15_000) return quoteCache.promise;
  const promise = api.get<TorQuote>("/api/market/tor", 15_000);
  quoteCache = { at: now, promise };
  promise.catch(() => {
    if (quoteCache && quoteCache.promise === promise) quoteCache = null;
  });
  return promise;
}

/** TOR/USD exactly as the node prices it this tick, or 0 when the quote is unreadable. */
export function torUsd(quote: TorQuote | null | undefined): number {
  if (!quote) return 0;
  const usd = Number(quote.price_usd);
  const perTor = Number(quote.price_tor) > 0 ? Number(quote.price_tor) : 1;
  return Number.isFinite(usd) && usd > 0 ? usd / perTor : 0;
}

/** USD for an amount the node quoted in TOR — null instead of a fake number. */
export function toUsd(amountTor: number, quote: TorQuote | null | undefined): number | null {
  const rate = torUsd(quote);
  const amount = Number(amountTor);
  return rate > 0 && Number.isFinite(amount) ? amount * rate : null;
}

/**
 * The rate strip: TOR/USD as the node publishes it, re-read every 20 s like the marketplace board.
 * Every dollar figure on the charts page is scaled by the number shown here.
 */
export function TorRateStrip() {
  const [quote, setQuote] = useState<TorQuote | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const read = () =>
      torQuote(true)
        .then((value) => {
          if (!alive) return;
          setQuote(value);
          setError("");
        })
        .catch((problem: Error) => {
          if (alive) setError(problem.message || "the node did not answer");
        });
    void read();
    const timer = window.setInterval(read, 20_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const rate = torUsd(quote);
  return (
    <div className="tor-rate">
      <div>
        <span className="muted tiny">TOR/USD</span>
        <b>{rate > 0 ? money(rate) : error || "reading /api/market/tor…"}</b>
      </div>
      <div>
        <span className="muted tiny">USD anchor</span>
        <b>{money(quote?.anchor_usd)}</b>
      </div>
      <div>
        <span className="muted tiny">engine drift</span>
        <b title={quote?.drift?.rule}>{quote?.drift ? num(quote.drift.drift) : "—"}</b>
      </div>
      <span className="muted tiny">
        {quote
          ? `GET /api/market/tor · ${quote.symbol} priced in USD by the node, refreshed every 20 s — every $ below is this rate`
          : "waiting for the node's own price"}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ live series */

/** The node's own candle endpoint, scaled into the dollars the same node publishes. */
export function TokenPriceChart({
  symbol,
  range,
  mode,
  height = 260,
}: {
  symbol: string;
  range: RangeKey;
  mode: ChartMode;
  height?: number;
}) {
  const chart = useAsync(
    () => api.get<Chart>(`/api/market/chart/${encodeURIComponent(symbol)}?points=${RANGES[range].pricePoints}`, 30_000),
    [symbol, range],
  );
  const quote = useAsync(() => torQuote(), []);

  if (chart.loading) return <Spinner label={`reading /api/market/chart/${symbol}…`} />;
  if (chart.error) return <Empty>{chart.error}</Empty>;
  if (!chart.data) return <Empty>the node returned no chart for {symbol}</Empty>;
  /* wait for the rate: a TOR quote with a "$" in front of it is the bug this fixes */
  if (quote.loading && !quote.data) return <Spinner label="reading the node's TOR/USD quote…" />;

  const rate = torUsd(quote.data);
  const quoted = chart.data.candles || [];
  const candles =
    rate > 0
      ? quoted.map((candle) => ({
          time: candle.time,
          open: candle.open * rate,
          high: candle.high * rate,
          low: candle.low * rate,
          close: candle.close * rate,
        }))
      : quoted;
  const points = candlesToPoints(candles);
  const summary = summarize(points);
  const shown = (value: number) => (rate > 0 ? money(value) : num(value));

  const source =
    rate > 0
      ? `the node quotes this series in TOR and prices TOR at ${money(rate)} on /api/market/tor, so the axis is that quote × ${rate.toFixed(4)}`
      : `the node's TOR/USD quote could not be read${quote.error ? ` (${quote.error})` : ""}, so the axis stays in TOR — a dollar sign on a TOR price would be wrong`;
  const torClause =
    rate > 0 && symbol.toUpperCase() === "TOR"
      ? ` /api/market/chart answers in TOR and 1 TOR is always 1 TOR, which is why the raw candles read 1.00: the dollar value is the node's own ${money(rate)} quote, not $1.00.`
      : "";
  const note = summary.flat
    ? `${symbol}: ${points.length} sampled windows, every one closed at ${shown(summary.last)} — ${source}.${torClause} ` +
      `The endpoint samples the live AMM reserve and stores no price history, so one dashed band at the real value is the honest picture.`
    : `${chart.data.source} · ${points.length} samples · span ${chart.data.span} · high ${shown(summary.high)} · low ${shown(summary.low)} — ${source}.${torClause}`;

  return (
    <ChartCanvas
      points={points}
      candles={candles}
      mode={mode}
      range={range}
      height={height}
      format={(value) => (rate > 0 ? money(value) : num(value))}
      unit={`${symbol} price · ${rate > 0 ? "USD" : "TOR"}`}
      note={note}
    />
  );
}

/* -------------------------------------------------- real timestamp series */

/** Real chain history: events of one kind, counted per bucket. */
export function ChainEventChart({
  kind,
  range,
  height = 240,
}: {
  kind?: "mint" | "swap" | "fee" | "transfer";
  range: RangeKey;
  height?: number;
}) {
  const events = useAsync(() => api.get<{ events: { timestamp: number; kind: string }[] }>("/api/chain/events", 30_000), []);
  if (events.loading) return <Spinner label="reading /api/chain/events…" />;
  if (events.error) return <Empty>{events.error}</Empty>;

  const all = events.data?.events || [];
  const stamps = all
    .filter((event) => !kind || event.kind === kind)
    .map((event) => Number(event.timestamp))
    .filter((stamp) => Number.isFinite(stamp));
  const bucket = bucketCounts(stamps, range);
  const label = kind ? `${kind} events` : "chain events";

  return (
    <ChartCanvas
      points={bucket.points}
      mode="bars"
      range={range}
      height={height}
      format={(value) => num(value)}
      unit={`${label} per bucket`}
      note={`${bucket.inside} of the node's last ${bucket.total} ${label} fall inside ${RANGES[range].label} (window anchored on ${bucket.anchoredOn}). Each bar counts node events — nothing here is estimated.`}
    />
  );
}

/** Pool + token creation stamps from the registry — the chain's own onboarding history. */
export function PoolCreationChart({ range, height = 240 }: { range: RangeKey; height?: number }) {
  const tokens = useAsync(() => api.get<{ tokens: Token[] }>("/api/public/tokens", 60_000), []);
  if (tokens.loading) return <Spinner label="reading /api/public/tokens…" />;
  if (tokens.error) return <Empty>{tokens.error}</Empty>;

  const bucket = bucketCounts(poolStamps(tokens.data?.tokens || []), range);
  return (
    <ChartCanvas
      points={bucket.points}
      mode="bars"
      range={range}
      height={height}
      format={(value) => num(value)}
      unit="pools + tokens created per bucket"
      note={`${bucket.inside} of ${bucket.total} creation stamps fall inside ${RANGES[range].label} — read from each token's and pool's own created_at on the registry.`}
    />
  );
}

/** Floor from the engine board: every point is a real live ask. */
export function FloorChart({
  items,
  range = "30D",
  height = 200,
}: {
  items: EngineCard[];
  range?: RangeKey;
  height?: number;
}) {
  const points = floorPoints(items);
  if (!points.length) return <Empty>the engine reports no live ask, so there is no floor series to draw</Empty>;
  const summary = summarize(points);
  return (
    <ChartCanvas
      points={points}
      mode={summary.flat ? "line" : "area"}
      range={range}
      height={height}
      format={(value) => `${num(value)} TOR`}
      unit="NFT floor"
      note={`${points.length} live ask${points.length === 1 ? "" : "s"} from the marketplace engine, oldest first · ${
        summary.flat
          ? "one price level, so the band is flat by nature"
          : `range ${num(summary.low)}–${num(summary.high)} TOR`
      }`}
    />
  );
}

/** Loads the board itself, for screens that do not already hold it. */
export function FloorChartLive({ height = 200 }: { height?: number }) {
  const board = useAsync(() => engine.board({ limit: 200 }), []);
  if (board.loading) return <Spinner label="reading the marketplace engine board…" />;
  if (board.error) return <Empty>{board.error}</Empty>;
  return <FloorChart items={board.data?.items || []} height={height} />;
}

/* --------------------------------------------------------- single reading */

/** One current value, compared to the chain maximum. Never a time series. */
export function RankBar({
  label,
  value,
  max,
  format,
}: {
  label: string;
  value: number;
  max: number;
  format: (value: number) => string;
}) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className="tor-rank">
      <div className="spread">
        <span className="muted tiny">{label}</span>
        <b>{format(value)}</b>
      </div>
      <div className="tor-rank__track">
        <i style={{ width: `${(share * 100).toFixed(2)}%` }} />
      </div>
      <span className="muted tiny">
        {max > 0
          ? `${(share * 100).toFixed(1)}% of the chain maximum (${format(max)}) · one current reading — the node publishes no history for this field`
          : "nothing to compare against on this chain yet"}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ the generator */

/** The registry row `/api/public/tokens` returns — the fields the studio can chart. */
type RegistryToken = {
  symbol: string;
  name: string;
  supply: number;
  circulating?: number;
  holders: number | null;
  price_tor: number;
  liquidity_tor: number;
  market_cap_tor: number;
  volume_24h_tor: number;
  volume_24h_swaps?: number;
  created_at?: number;
};

export type MetricKey =
  | "price"
  | "swaps"
  | "mints"
  | "fees"
  | "transfers"
  | "pools"
  | "floor"
  | "holders"
  | "supply"
  | "liquidity"
  | "market_cap"
  | "volume";

export const METRICS: { key: MetricKey; label: string; series: boolean; hint: string }[] = [
  { key: "price", label: "Price", series: true, hint: "the node's sampled AMM closes" },
  { key: "swaps", label: "Swaps", series: true, hint: "chain swap events per bucket" },
  { key: "mints", label: "Mints", series: true, hint: "chain mint events per bucket" },
  { key: "fees", label: "Protocol fees", series: true, hint: "fee events per bucket" },
  { key: "transfers", label: "Transfers", series: true, hint: "transfer events per bucket" },
  { key: "pools", label: "Pools created", series: true, hint: "registry created_at per bucket" },
  { key: "floor", label: "AI-NFT floor", series: true, hint: "live asks from the engine" },
  { key: "holders", label: "Holders", series: false, hint: "one current registry reading" },
  { key: "supply", label: "Supply", series: false, hint: "one current registry reading" },
  { key: "liquidity", label: "Pool liquidity", series: false, hint: "one current registry reading" },
  { key: "market_cap", label: "Market cap", series: false, hint: "one current registry reading" },
  { key: "volume", label: "24 h volume", series: false, hint: "one current registry reading" },
];

const MODES: { key: ChartMode; label: string }[] = [
  { key: "area", label: "Area" },
  { key: "line", label: "Line" },
  { key: "bars", label: "Bars" },
  { key: "candles", label: "Candles" },
];

function readingValue(token: RegistryToken, metric: MetricKey): number {
  switch (metric) {
    case "holders":
      return Number(token.holders ?? 0);
    case "supply":
      return Number(token.supply ?? 0);
    case "liquidity":
      return Number(token.liquidity_tor ?? 0);
    case "market_cap":
      return Number(token.market_cap_tor ?? 0);
    case "volume":
      return Number(token.volume_24h_tor ?? 0);
    default:
      return 0;
  }
}

function readingFormat(metric: MetricKey): (value: number) => string {
  return metric === "holders" || metric === "supply" ? (value) => num(value) : (value) => `${num(value)} TOR`;
}

/**
 * The generator: token × metric × window × draw mode, built from whatever the node truly answers.
 * `initialSymbol` lets a route (`#/charts/SOL`) open straight onto one token.
 */
export function ChartStudio({ initialSymbol }: { initialSymbol?: string }) {
  const registry = useAsync(() => api.get<{ tokens: RegistryToken[] }>("/api/public/tokens", 60_000), []);
  const tokens = registry.data?.tokens || [];
  const [symbol, setSymbol] = useState(initialSymbol || "TOR");
  const [metric, setMetric] = useState<MetricKey>("price");
  const [range, setRange] = useState<RangeKey>("24H");
  const [mode, setMode] = useState<ChartMode>("area");

  const current = useMemo(
    () => tokens.find((token) => token.symbol === symbol) || tokens.find((token) => token.symbol === "TOR") || tokens[0] || null,
    [tokens, symbol],
  );
  const picked = METRICS.find((item) => item.key === metric) || METRICS[0];
  /* the same node quote the charts scale by — registry prices are quoted in TOR, never dollars */
  const quote = useAsync(() => torQuote(), []);
  const rate = torUsd(quote.data);
  const currentUsd = current ? toUsd(current.price_tor, quote.data) : null;
  const chainMax = useMemo(() => {
    if (!current || picked.series) return 0;
    return tokens.reduce((best, token) => Math.max(best, readingValue(token, metric)), 0);
  }, [tokens, current, metric, picked.series]);

  return (
    <section className="panel stack tor-studio">
      <div className="spread">
        <h2 style={{ margin: 0 }}>Chart generator</h2>
        <span className="pill">
          {tokens.length ? `${tokens.length} tokens on the registry` : registry.error || "reading the registry…"}
        </span>
      </div>
      <p className="muted tiny" style={{ margin: 0 }}>
        Pick a token, a metric and a window, and the panel draws whatever the node can actually answer.
        Metrics backed by timestamps — chain events, pool creation, live asks — are real history. Fields
        the node publishes only as a current value are shown as one reading against the chain maximum,
        never as an invented line.
      </p>

      <div className="tor-controls">
        <label className="tor-field">
          <span>Token</span>
          <select value={symbol} onChange={(event) => setSymbol(event.target.value)} disabled={!tokens.length}>
            {tokens.length ? null : <option value={symbol}>{symbol}</option>}
            {tokens.map((token) => (
              <option key={`${token.symbol}-${token.name}`} value={token.symbol}>
                {token.symbol} — {token.name}
              </option>
            ))}
          </select>
        </label>

        <label className="tor-field">
          <span>Metric</span>
          <select value={metric} onChange={(event) => setMetric(event.target.value as MetricKey)}>
            {METRICS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <div className="tor-field">
          <span>Window</span>
          <div className="tor-chips">
            {RANGE_KEYS.map((key) => (
              <button key={key} type="button" className={key === range ? "on" : ""} onClick={() => setRange(key)}>
                {key}
              </button>
            ))}
          </div>
        </div>

        <div className="tor-field">
          <span>Draw as</span>
          <div className="tor-chips">
            {MODES.map((item) => (
              <button
                key={item.key}
                type="button"
                className={item.key === mode ? "on" : ""}
                disabled={!picked.series || (item.key === "candles" && metric !== "price")}
                onClick={() => setMode(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="tor-studio__body">
        {(() => {
          const KIND_BY_METRIC: Partial<Record<MetricKey, "mint" | "swap" | "fee" | "transfer">> = {
            swaps: "swap",
            mints: "mint",
            fees: "fee",
            transfers: "transfer",
          };
          const eventKind = KIND_BY_METRIC[metric];

          if (!picked.series) {
            if (!current) return <Spinner label="waiting for the registry…" />;
            const poolCount = (current as unknown as { pools?: unknown[] }).pools?.length ?? 0;
            return (
              <div className="stack" style={{ gap: 12 }}>
                <div className="spread">
                  <b>
                    {current.symbol} · {current.name}
                  </b>
                  <span className="muted tiny">{picked.hint}</span>
                </div>
                <RankBar
                  label={`${current.symbol} ${picked.label.toLowerCase()}`}
                  value={readingValue(current, metric)}
                  max={chainMax}
                  format={readingFormat(metric)}
                />
                <div className="grid cols-3">
                  <Stat
                    label="Price"
                    value={currentUsd !== null ? money(currentUsd) : `${num(current.price_tor)} TOR`}
                    hint={
                      rate > 0
                        ? `${num(current.price_tor)} TOR per unit × TOR/USD ${money(rate)} from /api/market/tor`
                        : quote.error || "the node's USD quote is unreadable — showing the raw TOR price"
                    }
                  />
                  <Stat label="Holders" value={num(Number(current.holders ?? 0))} hint="registry holder count" />
                  <Stat label="Pools" value={num(poolCount)} hint="pools quoting this token" />
                </div>
              </div>
            );
          }

          return (
            <div className="stack" style={{ gap: 12 }}>
              <div className="spread">
                <b>{current ? `${current.symbol} · ${current.name}` : symbol}</b>
                <span className="muted tiny">
                  {picked.hint}
                  {current ? ` · registry price ${num(current.price_tor)} TOR${currentUsd !== null ? ` = ${money(currentUsd)}` : ""}` : ""}
                </span>
              </div>
              {metric === "price" ? <TokenPriceChart symbol={symbol} range={range} mode={mode} height={230} /> : null}
              {eventKind ? <ChainEventChart kind={eventKind} range={range} height={220} /> : null}
              {metric === "pools" ? <PoolCreationChart range={range} height={220} /> : null}
              {metric === "floor" ? <FloorChartLive height={220} /> : null}
            </div>
          );
        })()}
      </div>
    </section>
  );
}
