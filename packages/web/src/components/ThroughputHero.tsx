/**
 * Throughput headline.
 *
 * Token rate is the number an operator opens this dashboard for, so it leads
 * the page as a live instrument rather than one stat among many:
 *
 *  - Per-request decode speed is the hero, drawn as an arc gauge with an
 *    animated figure. It is what a person waiting on a reply experiences.
 *  - Aggregate throughput sits beside it. It rises with concurrency while the
 *    per-request rate can fall; an explicit in-flight count avoids implying
 *    that rates from different windows measure a batch size.
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
import { useMemo, useState } from "react";
import { useTween } from "../lib/useTween";
import { Card } from "./primitives";
import { Kpi, tail } from "./Compact";
import { IconChip } from "./Icon";
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
    <div className="relative h-[118px] w-[118px] shrink-0">
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
          {frac > 0.002 && <circle cx="84" cy="84" r={R} fill="none"
            stroke={idle ? color : "url(#gauge-grad)"} strokeWidth="12" strokeLinecap="round"
            strokeDasharray={`${track * frac} ${C}`}
            className={live ? "gauge-live" : undefined}
            style={{ transition: "stroke 400ms ease" }} />}
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-1">
        <span
          className="tnum text-[34px] font-semibold leading-none tracking-tight"
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
  const [windowMinutes, setWindowMinutes] = useState(2);
  const allTs = history?.ts ?? [];
  const cutoff = (allTs.at(-1) ?? 0) - windowMinutes * 60_000;
  const start = windowMinutes === 0 ? 0 : Math.max(0, allTs.findIndex((ts) => ts >= cutoff));
  const ts = allTs.slice(start);
  const perReq = totals.perRequestTokensPerSec;
  const aggregate = totals.tokensPerSec;
  const idle = perReq !== null && totals.latencyBasis === "lifetime";
  const live = totals.requestsRunning > 0;

  const perReqSeries = history?.series["cluster:perReq"];
  const aggSeries = history?.series["cluster:tokensOut"];
  const peak = useMemo(() => peakOf(perReqSeries), [perReqSeries]);
  const aggPeak = useMemo(() => peakOf(aggSeries), [aggSeries]);
  const gaugeMax = niceCeil(Math.max(20, peak ?? 0, perReq ?? 0) * 1.1);

  const series: ChartSeries[] = [
    { label: "Per request", colorVar: "--series-1", values: (perReqSeries ?? []).slice(start) },
    { label: "Aggregate", colorVar: "--series-3", values: (aggSeries ?? []).slice(start) },
  ].filter((s) => s.values.some((v) => v !== null && !Number.isNaN(v)));

  const pct = (v: number | null) => (v === null ? null : v);
  const tl = (k: string) => tail(history?.series[k]);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <IconChip name="bolt" size={13} />
          Throughput
        </span>
      }
      bodyClass="p-0"
      right={<LiveChip live={live} idle={idle && !live} />}
    >
      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* Left: the instrument plus a 3x2 KPI grid. */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4 rounded-xl border border-edge bg-surface-2/40 px-3 py-2">
            <Gauge value={perReq} max={gaugeMax} live={live} idle={idle} />
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-ink-muted">Per request</div>
              <div className="mt-0.5 text-[13px] font-medium leading-snug text-ink">
                {idle ? (live ? "Last measured · awaiting current sample" : "Idle — last measured rate") : "Decode speed one request receives"}
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
                <Mini label="Peak" value={peak === null ? "—" : `${peak.toFixed(1)}`} unit="tok/s" />
                <Mini label="Per token" value={perReq ? (1000 / perReq).toFixed(1) : "—"} unit="ms" />
                <Mini label="Aggregate peak" value={aggPeak ? aggPeak.toFixed(0) : "—"} unit="tok/s" />
                <Mini label="In flight" value={String(totals.requestsRunning)} unit={totals.requestsWaiting ? `· ${totals.requestsWaiting} queued` : totals.requestsRunning === 1 ? "request" : "requests"} />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Kpi dense icon="activity" label="Aggregate" value={aggregate} unit="tok/s" color="var(--series-3)"
              sub={`${totals.requestsRunning} running · ${totals.requestsWaiting} queued`} spark={tl("cluster:tokensOut")} />
            <Kpi dense icon="arrowDown" label="Prefill" value={totals.promptComputedTokensPerSec} unit="tok/s" digits={0} color="var(--series-4)"
              sub={totals.promptTokensPerSec > totals.promptComputedTokensPerSec ? `${totals.promptTokensPerSec.toFixed(0)} incl. cache` : "computed tokens"}
              spark={tl("cluster:tokensComputed")} />
            <Kpi dense icon="clock" label="Decode step" value={totals.interTokenLatencyMs} unit="ms" digits={0} color="var(--series-2)"
              sub="per engine step" spark={tl("cluster:itl")} />
            <Kpi dense icon="database" label="Prefix hit" value={pct(totals.promptCacheHitPct)} unit="%" digits={0} color="var(--series-5, var(--series-1))"
              sub="prompt from cache" spark={tl("cluster:cacheHit")} sparkMax={100} />
            <Kpi dense icon="target" label="Spec accept" value={pct(totals.specAcceptancePct)} unit="%" digits={0} color="var(--accent)"
              sub="draft tokens kept" spark={tl("cluster:specAccept")} sparkMax={100} />
            <Kpi dense icon="layers" label="Generated" value={null} display={compact(totals.generationTokensTotal)} color="var(--series-6, var(--series-3))"
              sub={`${totals.requestsPerMin.toFixed(0)}/min completed`} spark={tl("cluster:rpm")} />
          </div>
        </div>

        {/* Right: the history chart fills the column height. */}
        <div className="flex min-w-0 flex-col rounded-xl border border-edge bg-surface-2/40">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pt-2.5">
            <span className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-ink-muted">Decode · tokens / sec</span>
            <div role="group" aria-label="Throughput time range" className="flex gap-1">
              {[{ minutes: 2, label: "2m" }, { minutes: 10, label: "10m" }, { minutes: 0, label: "All" }].map(({ minutes, label }) => (
                <button key={minutes} type="button" aria-pressed={windowMinutes === minutes} onClick={() => setWindowMinutes(minutes)}
                  className={`cursor-pointer rounded px-1.5 py-0.5 text-[10px] ${windowMinutes === minutes ? "bg-surface-hover text-ink" : "text-ink-muted hover:text-ink"}`}>{label}</button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap gap-3">
              {series.map((s) => (
                <span key={s.label} className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
                  <span className="h-[3px] w-3 rounded-full" style={{ background: `var(${s.colorVar})` }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>
          <div className="min-h-[220px] flex-1 px-1 pb-1">
            {ts.length > 1 && series.length > 0 ? (
              <TimeChart
                ts={ts}
                series={series}
                grow
                minHeight={220}
                format={(v) => `${v.toFixed(1)} tok/s`}
                tickFormat={(v) => v.toFixed(0)}
                minRange={10}
                fill
                themeKey={themeKey}
              />
            ) : (
              <div className="grid h-full min-h-[220px] place-items-center text-[11px] text-ink-muted">Collecting throughput history…</div>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function Mini({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-ink-muted">{label}</div>
      <div className="tnum truncate font-semibold text-ink">
        {value} <span className="font-normal text-ink-muted">{unit}</span>
      </div>
    </div>
  );
}
