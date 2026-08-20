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

  const totalTokens = endpoints.reduce((a, e) => a + (e.generationTokensPerSec ?? 0), 0);
  const running = endpoints.reduce((a, e) => a + (e.requestsRunning ?? 0), 0);
  const waiting = endpoints.reduce((a, e) => a + (e.requestsWaiting ?? 0), 0);

  const series: ChartSeries[] = endpoints.slice(0, 8).map((e, i) => ({
    label: `${e.nodeLabel}:${e.port}`,
    colorVar: `--series-${(i % 8) + 1}`,
    values: history?.series[`infer:${e.id}:tokens`] ?? [],
  }));
  const ts = history?.ts ?? [];

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
        <div className="grid grid-cols-3 gap-4 border-b border-edge p-4">
          <Stat label="Generation" value={`${Math.round(totalTokens * 10) / 10}`} sub="tokens/sec" />
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
            height={172}
            format={(v) => `${v.toFixed(1)} tok/s`}
            tickFormat={(v) => v.toFixed(0)}
            minRange={10}
            fill={series.length === 1}
            themeKey={themeKey}
          />
        ) : (
          <div className="flex h-[172px] items-center justify-center text-[11px] text-ink-muted">
            Collecting…
          </div>
        )}
      </Card>
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
          {num(e.generationTokensPerSec)} <span className="font-normal text-ink-muted">tok/s</span>
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
        {e.promptTokensPerSec !== null && (
          <span className="tnum">
            prompt <span className="font-medium text-ink">{num(e.promptTokensPerSec)}</span> tok/s
          </span>
        )}
      </div>

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
