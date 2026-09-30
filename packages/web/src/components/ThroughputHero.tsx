/**
 * Throughput headline.
 *
 * Token rate is the number an operator opens this dashboard for, and it was
 * previously one `Stat` among several in a row of similar weight. Nothing on
 * the page said which of the two decode figures was the one that matters, and
 * the two can differ by an order of magnitude: `decodeTokensPerSec` counts
 * every token every engine emits and therefore rises with concurrency, while
 * `perRequestTokensPerSec` is what one request actually receives and falls as
 * the server fills.
 *
 * So the panel leads with the per-request rate, at a size that reads from
 * across a desk, and shows the aggregate beside it as the throughput figure
 * rather than the headline. Their ratio is the effective batch size, which is
 * the fastest way to explain why a server that is "fast" feels slow.
 */

import type { ClusterSnapshot, HistoryPayload } from "@sparktop/core";
import { Card } from "./primitives";
import { TimeChart, type ChartSeries } from "./TimeChart";

interface Props {
  totals: ClusterSnapshot["totals"];
  history: HistoryPayload | null;
  themeKey: string;
}

const compact = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

/** One large figure with its unit, label and optional caption. */
function Figure({
  label,
  value,
  unit,
  sub,
  hero = false,
  tone,
}: {
  label: string;
  value: string;
  unit: string;
  sub?: string;
  hero?: boolean;
  tone?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span
          className={`tnum font-semibold leading-none ${hero ? "text-[44px]" : "text-[26px]"}`}
          style={tone ? { color: tone } : undefined}
        >
          {value}
        </span>
        <span className={`${hero ? "text-[15px]" : "text-[12px]"} font-medium text-ink-secondary`}>{unit}</span>
      </div>
      {sub && <div className="mt-1 text-[11px] text-ink-muted">{sub}</div>}
    </div>
  );
}

/** A small labelled stat for the secondary row. */
function Mini({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-[10px] uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="tnum mt-0.5 text-[14px] font-semibold leading-none text-ink">{value}</div>
    </div>
  );
}

export function ThroughputHero({ totals, history, themeKey }: Props) {
  const ts = history?.ts ?? [];
  const perReq = totals.perRequestTokensPerSec;
  const aggregate = totals.tokensPerSec;

  /*
   * Effective batch size, from the only two counters that can produce it.
   *
   * A value below 1 would mean the aggregate is understating what is being
   * emitted, which is a measurement artefact rather than a real state, so it
   * is withheld rather than shown as a fraction of a request.
   */
  const batch =
    perReq !== null && perReq > 0 && aggregate > 0 ? aggregate / perReq : null;

  const series: ChartSeries[] = [
    { label: "Per request", colorVar: "--series-1", values: history?.series["cluster:perReq"] ?? [] },
    { label: "Aggregate", colorVar: "--series-2", values: history?.series["cluster:tokensOut"] ?? [] },
    { label: "Input (computed)", colorVar: "--series-3", values: history?.series["cluster:tokensComputed"] ?? [] },
  ].filter((s) => s.values.some((v) => v !== null && !Number.isNaN(v)));

  return (
    <Card
      title="Throughput"
      right={
        <div className="flex flex-wrap items-center gap-3">
          {series.length > 1 && (
            <div className="flex flex-wrap gap-2.5">
              {series.map((s) => (
                <span key={s.label} className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
                  <span className="h-2 w-2 rounded-full" style={{ background: `var(${s.colorVar})` }} />
                  {s.label}
                </span>
              ))}
            </div>
          )}
        </div>
      }
    >
      <div className="flex flex-wrap items-end gap-x-10 gap-y-5">
        <Figure
          hero
          label="Per request"
          value={perReq === null ? "—" : perReq.toFixed(1)}
          unit="tok/s"
          sub="decode speed one request receives"
          tone={perReq === null ? undefined : "var(--series-1)"}
        />
        <Figure
          label="Aggregate"
          value={aggregate.toFixed(1)}
          unit="tok/s"
          sub={`${compact(totals.generationTokensTotal)} tokens generated in total`}
        />
        <Figure
          label="Input"
          value={totals.promptComputedTokensPerSec.toFixed(0)}
          unit="tok/s"
          sub={
            totals.promptTokensPerSec > totals.promptComputedTokensPerSec * 1.05
              ? `computed · ${totals.promptTokensPerSec.toFixed(0)} ingested`
              : "computed prompt tokens"
          }
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-[color:var(--border)] pt-4">
        <Mini
          label="Batch size"
          value={batch === null ? "—" : batch.toFixed(1)}
          title="Aggregate output rate divided by per-request decode speed. This is how many requests are effectively sharing the engine."
        />
        <Mini
          label="Time / token"
          value={totals.interTokenLatencyMs === null ? "—" : `${totals.interTokenLatencyMs.toFixed(0)} ms`}
          title="Mean inter-token latency during decode. The reciprocal of per-request speed."
        />
        <Mini
          label="Requests"
          value={`${totals.requestsRunning}`}
          title={`${totals.requestsRunning} in flight, ${totals.requestsWaiting} queued`}
        />
        <Mini label="Throughput" value={`${totals.requestsPerMin.toFixed(0)}/min`} title="Completed requests per minute." />
        <Mini
          label="Prefix hit"
          value={totals.promptCacheHitPct === null ? "—" : `${totals.promptCacheHitPct.toFixed(0)}%`}
          title="Share of prompt tokens served from the prefix cache rather than recomputed."
        />
        <Mini
          label="Spec accept"
          value={totals.specAcceptancePct === null ? "—" : `${totals.specAcceptancePct.toFixed(0)}%`}
          title="Share of speculative draft tokens accepted by the target model."
        />
      </div>

      {ts.length > 1 && series.length > 0 ? (
        <div className="mt-4">
          <TimeChart
            ts={ts}
            series={series}
            height={148}
            format={(v) => `${v.toFixed(1)} tok/s`}
            tickFormat={(v) => v.toFixed(0)}
            minRange={5}
            fill={series.length === 1}
            themeKey={themeKey}
          />
        </div>
      ) : (
        <div className="mt-4 flex h-[148px] items-center justify-center text-[11px] text-ink-muted">
          Collecting throughput history…
        </div>
      )}
    </Card>
  );
}
