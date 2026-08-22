/**
 * Inference servers.
 *
 * Engine-neutral by design: vLLM, SGLang, llama.cpp, TGI, Triton and Ollama all
 * report the same four things once normalised — what is in flight, what is
 * queued, how fast tokens are coming out, and how full the KV cache is — so the
 * panel renders identically whatever is actually running.
 */

import { useEffect, useMemo, useState } from "react";
import type { HistoryPayload, InferenceEndpoint, NodeSnapshot } from "@sparktop/core";
import { Badge, Card, LegendItem, Meter, Stat, utilTone } from "./primitives";
import { TimeChart, type ChartSeries } from "./TimeChart";

interface Props {
  nodes: NodeSnapshot[];
  history: HistoryPayload | null;
  themeKey: string;
}

const num = (v: number | null | undefined, suffix = ""): string =>
  v === null || v === undefined ? "—" : `${Math.round(v * 10) / 10}${suffix}`;

export function InferenceView({ nodes, history, themeKey }: Props) {
  const endpoints = nodes.flatMap((n) => n.inference ?? []);

  if (!endpoints.length) {
    return (
      <Card title="Inference">
        <p className="text-[12px] leading-relaxed text-ink-muted">
          No inference server detected. sparktop looks for one on every locally-bound port of each
          node and identifies vLLM, SGLang, llama.cpp, TGI, Triton and Ollama automatically — start
          one and it appears here within a few seconds.
        </p>
      </Card>
    );
  }

  const totalTokens = endpoints.reduce((a, e) => a + (e.decodeTokensPerSec ?? 0), 0);
  const running = endpoints.reduce((a, e) => a + (e.requestsRunning ?? 0), 0);
  const waiting = endpoints.reduce((a, e) => a + (e.requestsWaiting ?? 0), 0);

  const series: ChartSeries[] = endpoints.slice(0, 8).map((e, i) => ({
    label: `${e.nodeLabel}:${e.port}`,
    colorVar: `--series-${(i % 8) + 1}`,
    values: history?.series[`infer:${e.id}:tokens`] ?? [],
  }));
  const ts = history?.ts ?? [];

  /*
   * Input against output, as token counts rather than rates.
   *
   * A rate answers "how fast right now", which the chart above already does per
   * endpoint. What a token chart is usually asked is "how much" — and counts
   * make the shape of the workload legible in a way rates cannot, because
   * output and input differ by orders of magnitude and a rate plot spends most
   * of its height on whichever spikes.
   *
   * The engines expose cumulative counters, so the chart carries those and
   * converts them to a running total within the window. Cache hits are plotted
   * beside input, since the interesting thing about a long conversation is how
   * much of its prompt never reached a model at all.
   */
  const ioSeries: ChartSeries[] = [
    { label: "Output", colorVar: "--series-1", values: history?.series["cluster:genTotal"] ?? [] },
    { label: "Input", colorVar: "--series-3", values: history?.series["cluster:promptTotal"] ?? [] },
    { label: "Cached input", colorVar: "--series-4", values: history?.series["cluster:cachedTotal"] ?? [] },
  ].filter((s) => s.values.length > 0);

  const totalIn = endpoints.reduce((a, e) => a + (e.prefillTokensPerSec ?? 0), 0);
  const totalComputed = endpoints.reduce(
    (a, e) => a + (e.prefillComputedTokensPerSec ?? e.prefillTokensPerSec ?? 0),
    0
  );
  const cumulativeIn = endpoints.reduce((a, e) => a + (e.promptTokensTotal ?? 0), 0);
  const cumulativeOut = endpoints.reduce((a, e) => a + (e.generationTokensTotal ?? 0), 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <Card
        title="Inference"
        right={
          <span className="text-[11px] text-ink-muted">
            {endpoints.length} endpoint{endpoints.length === 1 ? "" : "s"}
          </span>
        }
        bodyClass="p-0"
      >
        {/* Output and input given equal billing, with the lifetime totals
            underneath each: the rate says what is happening now, the total says
            how much this fleet has actually done. */}
        <div className="grid grid-cols-2 gap-4 border-b border-edge p-4 sm:grid-cols-4">
          <Stat
            label="Output"
            value={`${Math.round(totalTokens * 10) / 10}`}
            sub={`tok/s · ${compactTokens(cumulativeOut)} total`}
          />
          {/* The headline input figure is the computed one. Counting cache
              hits reports tokens the model never processed, which on a long
              agentic conversation is most of them — the ingested rate sits
              beside it below. */}
          <Stat
            label="Input"
            value={`${Math.round(totalComputed * 10) / 10}`}
            sub={
              totalIn > totalComputed * 1.05
                ? `tok/s computed · ${Math.round(totalIn)} ingested`
                : `tok/s · ${compactTokens(cumulativeIn)} total`
            }
          />
          <Stat label="In flight" value={String(running)} sub="requests" />
          <Stat label="Queued" value={String(waiting)} sub="waiting" />
        </div>

        <ul className="divide-y divide-[color:var(--border)]">
          {endpoints.map((e) => (
            <EndpointRow key={e.id} e={e} />
          ))}
        </ul>
      </Card>

      <Card
        fill
        title="Token throughput"
        right={
          series.length > 1 ? (
            <div className="flex flex-wrap gap-2.5">
              {series.map((s) => (
                <LegendItem key={s.label} colorVar={s.colorVar} label={s.label} />
              ))}
            </div>
          ) : null
        }
      >
        {ts.length > 1 ? (
          <TimeChart
            ts={ts}
            series={series}
            grow
            minHeight={172}
            format={(v) => `${v.toFixed(1)} tok/s`}
            tickFormat={(v) => v.toFixed(0)}
            minRange={10}
            fill={series.length === 1}
            themeKey={themeKey}
          />
        ) : (
          <div className="flex h-full min-h-[172px] items-center justify-center text-[11px] text-ink-muted">
            Collecting…
          </div>
        )}
      </Card>

      <TokenHistoryCard
        live={{ ts, series: ioSeries.map((x) => ({ ...x, values: bucketDeltas(x.values) })) }}
        themeKey={themeKey}
      />
    </div>
  );
}


/**
 * Turn a cumulative counter into tokens per bucket.
 *
 * A running total only ever climbs, so the line says nothing about when the
 * work happened — an hour of hard serving and an hour of idle look the same
 * once the slope is small against the height. Differencing gives what was
 * produced in each interval, which is what makes a workload's shape visible:
 * bursts stand up, idle sits at zero.
 *
 * A decrease means the engine restarted and its counter went back to zero. That
 * is not negative work, so the step yields nothing rather than a spike pointing
 * down.
 */
function bucketDeltas(values: (number | null)[]): (number | null)[] {
  let prev: number | null = null;
  return values.map((v) => {
    if (v === null || Number.isNaN(v)) return null;
    const d = prev === null || v < prev ? 0 : v - prev;
    prev = v;
    return d;
  });
}

/** Total across a window, ignoring gaps. */
function sumSeries(values: (number | null)[]): number {
  let total = 0;
  for (const v of values) if (v !== null && !Number.isNaN(v)) total += v;
  return total;
}

/** One stored sample, mirroring the shape `/api/runs/samples` returns. */
interface SamplePoint {
  ts: number;
  endpointId: string;
  tokensPerSec: number;
  promptTokensPerSec: number | null;
  promptComputedTokensPerSec: number | null;
  /** Cumulative counters. Null on rows written before they were recorded. */
  genTokensTotal: number | null;
  promptTokensTotal: number | null;
  cachedPromptTokensTotal: number | null;
}

/** Live window plus the durable ones, which is the whole range this can show. */
const RANGES = [
  { key: "live", label: "Live", days: 0 },
  { key: "24h", label: "24h", days: 1 },
  { key: "7d", label: "7d", days: 7 },
  { key: "30d", label: "30d", days: 30 },
] as const;

/**
 * Input against output, over a selectable window.
 *
 * "Live" is the in-memory ring — a few minutes at full resolution, which is
 * what tells you whether something is happening right now. The longer windows
 * come from the durable store, written once a minute, which is what tells you
 * whether today looks like last week.
 */
function TokenHistoryCard({
  live,
  themeKey,
}: {
  live: { ts: number[]; series: ChartSeries[] };
  themeKey: string;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("live");
  const [samples, setSamples] = useState<SamplePoint[] | null>(null);
  const [loading, setLoading] = useState(false);

  const days = RANGES.find((r) => r.key === range)?.days ?? 0;

  useEffect(() => {
    if (days === 0) {
      setSamples(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const r = await fetch(`/api/runs/samples?days=${days}`);
        const body = (await r.json()) as { samples?: SamplePoint[] };
        if (!cancelled) setSamples(body.samples ?? []);
      } catch {
        if (!cancelled) setSamples([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    // Stored samples land once a minute; polling faster re-reads the same rows.
    const t = setInterval(() => {
      void fetch(`/api/runs/samples?days=${days}`)
        .then((r) => r.json())
        .then((b: { samples?: SamplePoint[] }) => !cancelled && setSamples(b.samples ?? []))
        .catch(() => {});
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [days]);

  /*
   * Stored samples are per endpoint; the chart is per cluster, so rows sharing
   * a timestamp are summed. A null input reading is left out of the sum rather
   * than counted as zero — rows written before those columns existed have no
   * input figure, and treating them as zero would draw a floor across history
   * that never happened.
   */
  const stored = useMemo(() => {
    if (!samples || samples.length === 0) return null;
    /*
     * Rows are per endpoint; the chart is per cluster. Each endpoint is
     * differenced on its own before the buckets are added, because differencing
     * a summed counter would turn one engine restarting into a hole in the
     * fleet's line.
     */
    const byEndpoint = new Map<string, SamplePoint[]>();
    for (const s of samples) {
      const list = byEndpoint.get(s.endpointId) ?? [];
      list.push(s);
      byEndpoint.set(s.endpointId, list);
    }
    const ts = [...new Set(samples.map((s) => s.ts))].sort((a, b) => a - b);
    const index = new Map(ts.map((t, i) => [t, i]));

    const out = new Array<number>(ts.length).fill(0);
    const inp = new Array<number>(ts.length).fill(0);
    const cached = new Array<number>(ts.length).fill(0);
    const seen = { out: false, in: false, cached: false };

    for (const rows of byEndpoint.values()) {
      rows.sort((a, b) => a.ts - b.ts);
      const prev: { out: number | null; in: number | null; cached: number | null } = {
        out: null, in: null, cached: null,
      };
      for (const r of rows) {
        const i = index.get(r.ts);
        if (i === undefined) continue;
        const step = (key: "out" | "in" | "cached", v: number | null, into: number[]) => {
          if (v === null) return;
          seen[key] = true;
          const p = prev[key];
          // A counter going backwards is a restart, which is not negative work.
          if (p !== null && v >= p) into[i]! += v - p;
          prev[key] = v;
        };
        step("out", r.genTokensTotal, out);
        step("in", r.promptTokensTotal, inp);
        step("cached", r.cachedPromptTokensTotal, cached);
      }
    }

    const series: ChartSeries[] = [
      { label: "Output", colorVar: "--series-1", values: seen.out ? out : [] },
      { label: "Input", colorVar: "--series-3", values: seen.in ? inp : [] },
      { label: "Cached input", colorVar: "--series-4", values: seen.cached ? cached : [] },
    ].filter((x) => x.values.length > 0);
    if (!series.length) return null;
    return { ts, series };
  }, [samples]);

  const shown = days === 0 ? live : stored;
  const hasData = shown !== null && shown.ts.length > 1;

  const windowTotals = useMemo(() => {
    const pick = (label: string) => shown?.series.find((s) => s.label === label)?.values ?? [];
    return {
      out: sumSeries(pick("Output")),
      in: sumSeries(pick("Input")),
      cached: sumSeries(pick("Cached input")),
    };
  }, [shown]);

  return (
    <Card
      className="lg:col-span-2"
      title="Input and output tokens"
      right={
        <div className="flex items-center gap-3">
          <div className="hidden flex-wrap gap-2.5 sm:flex">
            {(shown?.series ?? live.series).map((s) => (
              <LegendItem key={s.label} colorVar={s.colorVar} label={s.label} />
            ))}
          </div>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                aria-pressed={range === r.key}
                className={`cursor-pointer rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                  range === r.key
                    ? "bg-accent font-semibold text-[color:var(--on-accent,#08120a)]"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {hasData ? (
        <>
          {/* The window's totals, so the chart has a headline the way a
              cumulative plot used to give for free. */}
          <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="tnum text-[18px] font-semibold text-ink">
              {compactTokens(windowTotals.out + windowTotals.in)}
            </span>
            <span className="text-[11px] text-ink-muted">
              tokens in this window ·{" "}
              <span className="text-[color:var(--series-3)]">in {compactTokens(windowTotals.in)}</span>
              {windowTotals.cached > 0 && (
                <>
                  {" "}
                  (<span className="text-[color:var(--series-4)]">
                    {compactTokens(windowTotals.cached)} cached
                  </span>
                  , {((windowTotals.cached / Math.max(1, windowTotals.in)) * 100).toFixed(0)}%)
                </>
              )}{" "}
              · <span className="text-[color:var(--series-1)]">out {compactTokens(windowTotals.out)}</span>
            </span>
          </div>
          <TimeChart
            ts={shown!.ts}
            series={shown!.series}
            height={168}
            format={(v) => `${compactTokens(v)} tokens`}
            tickFormat={(v) => compactTokens(v)}
            minRange={100}
            themeKey={`${themeKey}:${range}`}
          />
          <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
            Tokens produced in each interval, so idle reads as zero and a burst stands up — a running
            total would climb whatever was happening. <b>Cached input</b> is the part of the prompt a
            prefix cache served instead of a model, so the gap below <b>Input</b> is what was actually
            computed. An engine restart contributes nothing rather than a spike downwards.
            {days > 0 && " Stored samples are written once a minute, so each point is a minute of work."}
          </p>
        </>
      ) : (
        <div className="flex h-[168px] items-center justify-center text-[11px] text-ink-muted">
          {loading
            ? "Loading…"
            : days === 0
              ? "Collecting…"
              : "No stored samples for this window yet."}
        </div>
      )}
    </Card>
  );
}

/**
 * Token counts run to hundreds of millions, which is unreadable in full and
 * pointless at that precision — the magnitude is the information.
 */
function compactTokens(v: number): string {
  const n = Math.abs(v);
  if (n >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(v / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return v.toFixed(0);
}

/** One latency figure. Null reads as "no completions", never as zero. */
function Latency({
  label,
  ms,
  hint,
  extra,
  stale = false,
}: {
  label: string;
  ms: number | null;
  hint: string;
  extra?: string;
  /** Value is the server's lifetime average, not a reading from this minute. */
  stale?: boolean;
}) {
  const shown = ms === null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
  return (
    <div
      className="min-w-0 cursor-help"
      title={stale ? `${hint} — lifetime average; nothing completed in the last minute` : hint}
    >
      <div className="truncate text-ink-muted">{label}</div>
      {/* A lifetime average is rendered in muted ink so it cannot be mistaken
          for a live reading — the number is real, but it is not from now. */}
      <div className={`tnum truncate font-medium ${stale ? "text-ink-muted" : "text-ink"}`}>
        {shown}
        {extra && <span className="ml-1 font-normal text-ink-muted">{extra}</span>}
      </div>
    </div>
  );
}

function EndpointRow({ e }: { e: InferenceEndpoint }) {
  if (!e.reachable) {
    return (
      <li className="flex items-center gap-2 px-4 py-2.5">
        <span className="h-2 w-2 flex-none rounded-full" style={{ background: "var(--status-critical)" }} />
        <span className="text-[12px] text-ink">
          {e.nodeLabel}
          <span className="text-ink-muted">:{e.port}</span>
        </span>
        <span className="text-[11px] text-ink-secondary">not responding</span>
      </li>
    );
  }

  const stale = e.latencyBasis === "lifetime";
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="h-2 w-2 flex-none rounded-full"
            style={{ background: (e.requestsRunning ?? 0) > 0 ? "var(--status-good)" : "var(--text-muted)" }}
          />
          <span className="truncate text-[12px] font-semibold text-ink">
            {e.nodeLabel}
            <span className="font-normal text-ink-muted">:{e.port}</span>
          </span>
          <Badge tone="accent">{e.engineLabel}</Badge>
          {e.containerName && <Badge tone="neutral">{e.containerName}</Badge>}
        </div>
        <span className="tnum text-[12px] font-semibold text-ink">
          {num(e.decodeTokensPerSec)} <span className="font-normal text-ink-muted">tok/s decode</span>
        </span>
      </div>

      {e.models.length > 0 && (
        <div className="mt-0.5 truncate text-[11px] text-ink-secondary" title={e.models.join(", ")}>
          {e.models.join(", ")}
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-secondary">
        <span className="tnum">
          running <span className="font-medium text-ink">{num(e.requestsRunning)}</span>
        </span>
        <span className="tnum">
          queued <span className="font-medium text-ink">{num(e.requestsWaiting)}</span>
        </span>
        <span className="tnum">
          served <span className="font-medium text-ink">{num(e.requestsFinishedTotal)}</span>
        </span>
        {e.requestsPerMin !== null && (
          <span className="tnum">
            rate <span className="font-medium text-ink">{num(e.requestsPerMin)}</span>/min
          </span>
        )}
        {e.prefillTokensPerSec !== null && (
          <span
            className="tnum cursor-help"
            title={
              e.prefillComputedTokensPerSec !== null
                ? `${num(e.prefillTokensPerSec)} tok/s of prompt were ingested, but the prefix cache already held most of them — ${num(e.prefillComputedTokensPerSec)} tok/s actually went through the model.`
                : "Prompt tokens ingested per second, cache hits included."
            }
          >
            prefill{" "}
            <span className="font-medium text-ink">
              {num(e.prefillComputedTokensPerSec ?? e.prefillTokensPerSec)}
            </span>{" "}
            tok/s
            {e.prefillComputedTokensPerSec !== null && e.prefillTokensPerSec > 0 && (
              <span className="text-ink-muted"> of {num(e.prefillTokensPerSec)} ingested</span>
            )}
          </span>
        )}
      </div>

      {/* Latency over requests completing in the last minute. When none did,
          these fall back to the server's lifetime average and are marked as
          such — otherwise a stale mean beside a decode rate of zero reads as a
          current measurement. */}
      {stale && (
        <div className="mt-1.5 text-[10px] uppercase tracking-wide text-ink-muted">
          Latency · lifetime avg (idle)
        </div>
      )}
      <div className={`grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4 ${stale ? "mt-0.5" : "mt-1.5"}`}>
        <Latency label="TTFT" ms={e.ttftMs} hint="Time to first token" stale={stale} />
        <Latency
          label="Per-token"
          ms={e.interTokenLatencyMs}
          hint="Inter-token latency during decode"
          extra={e.perRequestDecodeTokensPerSec !== null ? `${e.perRequestDecodeTokensPerSec}/s per req` : undefined}
          stale={stale}
        />
        <Latency label="Queue" ms={e.queueLatencyMs} hint="Waiting before work began" stale={stale} />
        <Latency label="End to end" ms={e.e2eLatencyMs} hint="Full request latency" stale={stale} />
      </div>

      {(e.prefillMs !== null || e.decodeMs !== null) && (
        <div className="mt-1 grid grid-cols-2 gap-x-4 text-[11px] sm:grid-cols-4">
          <Latency label="Prefill" ms={e.prefillMs} hint="Prefill phase, per request" stale={stale} />
          <Latency label="Decode" ms={e.decodeMs} hint="Decode phase, per request" stale={stale} />
        </div>
      )}

      {e.specAcceptanceRatePct !== null && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-secondary">
          <span
            className="cursor-help"
            title="Speculative decoding: a draft model proposes tokens and the target model accepts or rejects them. Output therefore arrives in bursts, which is why a one-second throughput reading swings so much."
          >
            <span className="text-ink-muted">Speculative</span>{" "}
            <span className="tnum font-medium text-ink">{e.specAcceptanceRatePct.toFixed(0)}%</span> accepted
          </span>
          {e.specMeanAcceptedLength !== null && (
            <span className="tnum">
              <span className="text-ink-muted">mean length</span>{" "}
              <span className="font-medium text-ink">{e.specMeanAcceptedLength.toFixed(2)}</span> tok/step
            </span>
          )}
        </div>
      )}

      {e.promptCacheHitPct !== null && (
        <div className="mt-1.5 flex items-center gap-2">
          <span
            className="w-16 shrink-0 cursor-help text-[11px] text-ink-muted"
            title="Share of prompt tokens served from the prefix cache instead of being recomputed. A high rate means prefill throughput reflects far less work than the raw figure suggests."
          >
            Prefix hit
          </span>
          <Meter value={e.promptCacheHitPct} tone="series-3" className="flex-1" />
          <span className="tnum w-10 shrink-0 text-right text-[11px] text-ink-secondary">
            {e.promptCacheHitPct.toFixed(0)}%
          </span>
        </div>
      )}

      {e.kvCachePct !== null && (
        <div className="mt-1.5 flex items-center gap-2">
          <span className="w-16 shrink-0 text-[11px] text-ink-muted">KV cache</span>
          <Meter value={e.kvCachePct} tone={utilTone(e.kvCachePct)} className="flex-1" />
          <span className="tnum w-10 shrink-0 text-right text-[11px] text-ink-secondary">
            {e.kvCachePct.toFixed(0)}%
          </span>
        </div>
      )}
    </li>
  );
}
