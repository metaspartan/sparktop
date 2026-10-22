/**
 * Throughput headline.
 *
 * Token rate is the number an operator opens this dashboard for, so it leads
 * the page as a live instrument rather than one stat among many:
 *
 *  - Per-request decode speed is the hero, drawn as an arc gauge with an
 *    animated figure. It is what a person waiting on a reply experiences.
 *  - Aggregate throughput sits beside it. It rises with concurrency while the
 *    per-request rate falls, and their ratio is the effective batch size.
 *  - A strip of secondary figures, all on one grid so their labels and values
 *    line up across the row at every width.
 *  - A gradient area chart of both rates over the history window.
 *
 * The per-request rate is tokens over decode seconds, read from the engine's
 * per-request histograms. It is NOT 1000/inter-token-latency: under
 * speculative decoding that histogram records one observation per engine step
 * while each step emits several tokens, which undercounts by the acceptance
 * length (3.5x on the DSpark stack this was built against).
 */

import type { ClusterSnapshot, HistoryPayload } from "@sparktop/core";
import { useMemo } from "react";
import { useTween } from "../lib/useTween";
import { Card } from "./primitives";
import { TimeChart, type ChartSeries } from "./TimeChart";

interface Props {
  totals: ClusterSnapshot["totals"];
  history: HistoryPayload | null;
  themeKey: string;
}

const compact = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

/** Highest finite value in a series, or null. */
function peakOf(values: (number | null)[] | undefined): number | null {
  let best: number | null = null;
  for (const v of values ?? []) if (v !== null && Number.isFinite(v) && (best === null || v > best)) best = v;
  return best;
}

/** Round a scale ceiling up to a readable number: 20, 25, 40, 50, 80, 100, 150... */
function niceCeil(v: number): number {
  const steps = [10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500, 750, 1000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 500) * 500;
}

/**
 * Arc gauge for the per-request rate.
 *
 * 240 degrees of sweep, open at the bottom. The scale ceiling follows the
 * history's peak (rounded to a readable number) so the needle uses the whole
 * arc on a slow model and on a fast one alike; a fixed 0-200 scale would leave
 * a 15 tok/s server as an unreadable sliver.
 */
function Gauge({
  value,
  max,
  live,
  idle,
}: {
  value: number | null;
  max: number;
  live: boolean;
  idle: boolean;
}) {
  const shown = useTween(value);
  const R = 64;
  const C = 2 * Math.PI * R;
  const sweep = 240 / 360;
  const frac = shown === null ? 0 : Math.max(0, Math.min(1, shown / max));
  const track = C * sweep;
  const color = idle ? "var(--text-muted)" : "var(--accent)";

  return (
    <div className="relative h-[168px] w-[168px] shrink-0">
      <svg viewBox="0 0 168 168" className="h-full w-full" aria-hidden>
        <defs>
          <linearGradient id="gauge-grad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--series-1)" />
            <stop offset="100%" stopColor={color} />
          </linearGradient>
        </defs>
        {/* rotate so the 240° arc is centred on the top */}
        <g transform="rotate(150 84 84)">
          <circle cx="84" cy="84" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="12"
            strokeDasharray={`${track} ${C}`} strokeLinecap="round" />
          <circle cx="84" cy="84" r={R} fill="none"
            stroke={idle ? color : "url(#gauge-grad)"} strokeWidth="12" strokeLinecap="round"
            strokeDasharray={`${track * frac} ${C}`}
            className={live ? "gauge-live" : undefined}
            style={{ transition: "stroke 400ms ease" }} />
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-1">
        <span
          className="tnum text-[40px] font-semibold leading-none tracking-tight"
          style={{ color: idle ? "var(--text-muted)" : "var(--text-primary)" }}
        >
          {shown === null ? "—" : shown.toFixed(shown >= 100 ? 0 : 1)}
        </span>
        <span className="mt-1 text-[11px] font-medium text-ink-secondary">tok/s</span>
      </div>
      <span className="tnum absolute bottom-3 left-5 text-[10px] text-ink-muted">0</span>
      <span className="tnum absolute bottom-3 right-4 text-[10px] text-ink-muted">{max}</span>
    </div>
  );
}

/** Large secondary figure with an animated value. */
function Big({ label, value, unit, sub, digits = 1 }: {
  label: string; value: number | null; unit: string; sub?: string; digits?: number;
}) {
  const shown = useTween(value);
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="tnum text-[30px] font-semibold leading-none tracking-tight text-ink">
          {shown === null ? "—" : shown.toFixed(digits)}
        </span>
        <span className="text-[12px] font-medium text-ink-secondary">{unit}</span>
      </div>
      {sub && <div className="mt-1.5 truncate text-[11px] text-ink-muted">{sub}</div>}
    </div>
  );
}

/** Cell of the secondary strip. Fixed label height keeps every value on one baseline. */
function Cell({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: string }) {
  return (
    <div className="min-w-0 px-4 py-3" title={title}>
      <div className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">{label}</div>
      <div className="tnum mt-1 truncate text-[16px] font-semibold leading-tight" style={{ color: tone ?? "var(--text-primary)" }}>
        {value}
      </div>
    </div>
  );
}

/** Live/idle chip in the card header. */
function LiveChip({ live, idle }: { live: boolean; idle: boolean }) {
  if (idle)
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-edge px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-muted)]" /> Idle · last measured
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-edge px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
      <span className="relative flex h-1.5 w-1.5">
        {live && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
      </span>
      {live ? "Live · decoding" : "Live"}
    </span>
  );
}

export function ThroughputHero({ totals, history, themeKey }: Props) {
  const ts = history?.ts ?? [];
  const perReq = totals.perRequestTokensPerSec;
  const aggregate = totals.tokensPerSec;
  const idle = perReq !== null && totals.latencyBasis === "lifetime";
  const live = !idle && totals.requestsRunning > 0;

  const perReqSeries = history?.series["cluster:perReq"];
  const aggSeries = history?.series["cluster:tokensOut"];
  const peak = useMemo(() => peakOf(perReqSeries), [perReqSeries]);
  const aggPeak = useMemo(() => peakOf(aggSeries), [aggSeries]);
  const gaugeMax = niceCeil(Math.max(20, peak ?? 0, perReq ?? 0) * 1.1);

  /*
   * Effective batch size. The two rates come from different windows (the
   * per-request rate from completed requests, the aggregate from a counter
   * delta over the scrape interval), so straight after idle the ratio can dip
   * below 1. A batch is never smaller than one request, so that is withheld.
   */
  const ratio = perReq !== null && perReq > 0 && aggregate > 0 ? aggregate / perReq : null;
  const batch = ratio !== null && ratio >= 1 ? ratio : null;

  const series: ChartSeries[] = [
    { label: "Per request", colorVar: "--series-1", values: perReqSeries ?? [] },
    { label: "Aggregate", colorVar: "--series-3", values: aggSeries ?? [] },
    { label: "Input (computed)", colorVar: "--series-4", values: history?.series["cluster:tokensComputed"] ?? [] },
  ].filter((s) => s.values.some((v) => v !== null && !Number.isNaN(v)));

  const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(0)}%`);

  return (
    <Card
      title="Throughput"
      bodyClass="p-0"
      right={
        <div className="flex flex-wrap items-center gap-3">
          {series.length > 1 && (
            <div className="hidden flex-wrap gap-3 sm:flex">
              {series.map((s) => (
                <span key={s.label} className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
                  <span className="h-2 w-2 rounded-full" style={{ background: `var(${s.colorVar})` }} />
                  {s.label}
                </span>
              ))}
            </div>
          )}
          <LiveChip live={live} idle={idle} />
        </div>
      }
    >
      <div className="grid gap-6 p-5 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center">
        <div className="flex items-center gap-6">
          <Gauge value={perReq} max={gaugeMax} live={live} idle={idle} />
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-muted">Per request</div>
            <div className="mt-1 text-[13px] font-medium text-ink">
              {idle ? "Idle — last measured rate" : "Decode speed one request receives"}
            </div>
            <div className="mt-3 space-y-1 text-[11px] text-ink-muted">
              <div>
                Peak <span className="tnum font-medium text-ink-secondary">{peak === null ? "—" : `${peak.toFixed(1)} tok/s`}</span>
              </div>
              <div>
                Per token{" "}
                <span className="tnum font-medium text-ink-secondary">
                  {perReq ? `${(1000 / perReq).toFixed(1)} ms` : "—"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
          <Big
            label="Aggregate"
            value={aggregate}
            unit="tok/s"
            sub={aggPeak ? `peak ${aggPeak.toFixed(0)} · ${totals.requestsRunning} running` : `${totals.requestsRunning} running`}
          />
          <Big
            label="Batch"
            value={batch}
            unit="×"
            sub={batch ? "aggregate ÷ per request" : "single stream"}
          />
          <Big
            label="Prefill"
            value={totals.promptComputedTokensPerSec}
            unit="tok/s"
            digits={0}
            sub={
              totals.promptTokensPerSec > totals.promptComputedTokensPerSec
                ? `${totals.promptTokensPerSec.toFixed(0)} ingested incl. cache`
                : "computed prompt tokens"
            }
          />
        </div>
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-edge border-y border-edge sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
        <Cell
          label="Inter-token"
          value={totals.interTokenLatencyMs === null ? "—" : `${totals.interTokenLatencyMs.toFixed(0)} ms`}
          title="Mean time per engine decode step. Under speculative decoding a step emits several tokens."
        />
        <Cell label="In flight" value={`${totals.requestsRunning} · ${totals.requestsWaiting} queued`} />
        <Cell label="Completed" value={`${totals.requestsPerMin.toFixed(0)}/min`} />
        <Cell label="Prefix hit" value={pct(totals.promptCacheHitPct)}
          title="Share of prompt tokens served from the prefix cache." />
        <Cell label="Spec accept" value={pct(totals.specAcceptancePct)}
          title="Share of speculative draft tokens accepted by the target model." />
        <Cell label="Generated" value={compact(totals.generationTokensTotal)}
          title={`${totals.generationTokensTotal.toLocaleString()} output tokens since the engines started`} />
      </div>

      <div className="px-3 pb-3 pt-4">
        {ts.length > 1 && series.length > 0 ? (
          <TimeChart
            ts={ts}
            series={series}
            height={200}
            format={(v) => `${v.toFixed(1)} tok/s`}
            tickFormat={(v) => v.toFixed(0)}
            minRange={10}
            fill
            themeKey={themeKey}
          />
        ) : (
          <div className="flex h-[200px] items-center justify-center text-[11px] text-ink-muted">
            Collecting throughput history…
          </div>
        )}
      </div>
    </Card>
  );
}
