/**
 * Inference servers.
 *
 * Engine-neutral by design: vLLM, SGLang, llama.cpp, TGI, Triton and Ollama all
 * report the same four things once normalised — what is in flight, what is
 * queued, how fast tokens are coming out, and how full the KV cache is — so the
 * panel renders identically whatever is actually running.
 */

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
   * Input against output, as one chart of cluster totals.
   *
   * Splitting by endpoint would answer "which server" — already covered by the
   * chart above. This answers the different question of what the fleet is
   * reading versus what it is producing, which is the shape of the workload
   * rather than its distribution.
   *
   * Prompt tokens are plotted as the part that reached a model, not everything
   * the engine was handed: a cached prefix arrives as a spike of tens of
   * thousands and would flatten the output series into the axis. The ingested
   * rate is kept as a third, dimmer series so the cache's contribution is still
   * visible as the gap between them.
   */
  const ioSeries: ChartSeries[] = [
    { label: "Output", colorVar: "--series-1", values: history?.series["cluster:tokensOut"] ?? [] },
    { label: "Input (computed)", colorVar: "--series-3", values: history?.series["cluster:tokensComputed"] ?? [] },
    { label: "Input (ingested)", colorVar: "--series-4", values: history?.series["cluster:tokensIn"] ?? [] },
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

      {ioSeries.length > 0 && (
        <Card
          className="lg:col-span-2"
          title="Input and output tokens"
          right={
            <div className="flex flex-wrap gap-2.5">
              {ioSeries.map((s) => (
                <LegendItem key={s.label} colorVar={s.colorVar} label={s.label} />
              ))}
            </div>
          }
        >
          {ts.length > 1 ? (
            <>
              <TimeChart
                ts={ts}
                series={ioSeries}
                height={168}
                format={(v) => `${v.toFixed(1)} tok/s`}
                tickFormat={(v) => compactTokens(v)}
                minRange={10}
                themeKey={themeKey}
              />
              <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
                Output is what a request waits for. Input is plotted as the prompt tokens that reached a
                model; the ingested line above it is everything the engine was handed, and the gap between
                them is the prefix cache. A long conversation spends most of its input on the cheap line.
              </p>
            </>
          ) : (
            <div className="flex h-[168px] items-center justify-center text-[11px] text-ink-muted">
              Collecting…
            </div>
          )}
        </Card>
      )}
    </div>
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
