import { useMemo, useState } from "react";
import { fmtBytes, fmtGbps, fmtPct, fmtTemp, fmtWatts, pctOf, shortImage } from "@sparktop/core";
import type { ClusterSnapshot, ClusterWarning, DistributedJob, HistoryPayload } from "@sparktop/core";
import { useCluster } from "./lib/useCluster";
import { useTheme } from "./lib/theme";
import { SECTIONS, useLayout, type SectionId } from "./lib/useLayout";
import { Badge, Card, DensityContext, LegendItem, Meter, utilTone } from "./components/primitives";
import { Sortable } from "./components/Sortable";
import { Settings } from "./components/Settings";
import { Setup } from "./components/Setup";
import { FabricView } from "./components/FabricView";
import { InferenceView } from "./components/InferenceView";
import { ControlsView } from "./components/ControlsView";
import { RunsView } from "./components/RunsView";
import { NodeCard } from "./components/NodeCard";
import { TimeChart, type ChartSeries } from "./components/TimeChart";

export default function App() {
  const { snapshot, history, nodes: nodeConfigs, conn, staleMs, intervals, refreshConfig } = useCluster();
  const { choice, resolved, setChoice } = useTheme();
  const layout = useLayout();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const gap = layout.density === "compact" ? "gap-2.5" : "gap-4";

  const sections: Record<SectionId, React.ReactNode> = {
    // Two columns is the widest that still leaves a node card room for its
    // process and container tables at the 1800px container cap.
    nodes: snapshot && (
      <div className={`grid ${gap} xl:grid-cols-2`}>
        {snapshot.nodes.map((n, i) => (
          <NodeCard key={n.id} node={n} history={history} themeKey={resolved} seriesIndex={i} />
        ))}
      </div>
    ),
    inference: snapshot && <InferenceView nodes={snapshot.nodes} history={history} themeKey={resolved} />,
    runs: snapshot && <RunsView />,
    fabric: snapshot && <FabricView snap={snapshot} history={history} themeKey={resolved} />,
    jobs: snapshot && <Jobs jobs={snapshot.jobs} />,
    charts: snapshot && <ClusterCharts snap={snapshot} history={history} themeKey={resolved} />,
    controls: snapshot && <ControlsView nodes={snapshot.nodes} />,
  };

  const visible = layout.order.filter((id) => !layout.hidden.includes(id));

  return (
    <DensityContext.Provider value={layout.density}>
      <div className="min-h-full">
        <Header
          conn={conn}
          staleMs={staleMs}
          snap={snapshot}
          theme={resolved}
          onToggleTheme={() => setChoice(resolved === "dark" ? "light" : "dark")}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main className={`mx-auto flex max-w-[1800px] flex-col ${gap} px-4 pb-16 pt-3 xl:pl-10`}>
          {!snapshot ? (
            <Card>
              <p className="py-12 text-center text-sm text-ink-muted">
                {conn === "open" ? "Waiting for the first snapshot…" : "Connecting to sparktop server…"}
              </p>
            </Card>
          ) : snapshot.nodes.length === 0 ? (
            <Setup onAdded={refreshConfig} />
          ) : (
            <>
              {visible.map((id) => (
                <Sortable
                  key={id}
                  index={layout.order.indexOf(id)}
                  count={layout.order.length}
                  label={SECTIONS.find((s) => s.id === id)?.label ?? id}
                  onMove={layout.move}
                >
                  {sections[id]}
                </Sortable>
              ))}
            </>
          )}
        </main>

        {/* Alerts float above the page instead of occupying a slot in it, so a
            fault appearing or clearing never moves the dashboard underneath. */}
        {snapshot && snapshot.warnings.length > 0 && <AlertToasts warnings={snapshot.warnings} />}

        <Settings
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          layout={layout}
          theme={choice}
          onTheme={setChoice}
          snap={snapshot}
          nodes={nodeConfigs}
          intervals={intervals}
        />
      </div>
    </DensityContext.Provider>
  );
}

function Header({
  conn,
  staleMs,
  snap,
  theme,
  onToggleTheme,
  onOpenSettings,
}: {
  conn: "connecting" | "open" | "closed";
  staleMs: number;
  snap: ClusterSnapshot | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}) {
  const stale = conn === "open" && staleMs > 5000;
  const dot =
    conn === "open" && !stale
      ? "var(--status-good)"
      : conn === "connecting" || stale
        ? "var(--status-warning)"
        : "var(--status-critical)";
  const label = conn === "open" ? (stale ? `stale ${(staleMs / 1000).toFixed(0)}s` : "live") : conn;

  return (
    <header className="sticky top-0 z-30 border-b border-edge bg-surface-1/90 backdrop-blur">
      {/*
        Three zones: name, cluster totals, actions.
        `xl:pl-10` mirrors <main>, whose extra left padding makes room for the
        section drag handles — without it the wordmark sits 24px left of the
        content it heads. On narrow screens the totals wrap to their own row,
        which is why the zones are flex with an explicit order rather than a
        three-column grid.
      */}
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 xl:pl-10">
        <span className="order-1 text-[17px] font-bold tracking-tight text-ink">
          spark<span style={{ color: "var(--accent)" }}>top</span>
        </span>

        {/* Cluster totals live in the header rather than as a section: it is a
            one-line summary, and this keeps the node cards at the top. */}
        {snap && (
          <div className="order-3 w-full min-w-0 border-t border-edge pt-1.5 lg:order-2 lg:w-auto lg:flex-1 lg:border-0 lg:pt-0">
            <SummaryStrip snap={snap} />
          </div>
        )}

        <div className="order-2 ml-auto flex items-center gap-2 lg:order-3 lg:ml-0">
          <span
            className="flex w-[74px] items-center gap-1.5 text-[11px] text-ink-secondary"
            title={`WebSocket ${conn}`}
          >
            <span
              className="h-2 w-2 flex-none rounded-full"
              style={{
                background: dot,
                boxShadow:
                  conn === "open" && !stale ? `0 0 0 3px color-mix(in srgb, ${dot} 22%, transparent)` : undefined,
              }}
            />
            <span className="tnum truncate">{label}</span>
          </span>

          <button
            onClick={onToggleTheme}
            className="cursor-pointer rounded-md border border-edge bg-surface-2 px-2 py-1 text-[12px] text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>

          <button
            onClick={onOpenSettings}
            className="relative cursor-pointer rounded-md border border-edge bg-surface-2 px-2 py-1 text-[12px] text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
            aria-label="Open settings"
            title="Settings and layout"
          >
            ⚙
          </button>
        </div>
      </div>
    </header>
  );
}

/** Compact cluster roll-up. Every figure is tabular so nothing jitters. */
function SummaryStrip({ snap }: { snap: ClusterSnapshot }) {
  const t = snap.totals;
  const vramPct = pctOf(t.vramUsedBytes, t.vramTotalBytes);
  const items: { label: string; value: string; sub?: string; pct?: number; tone?: "series-3" | "accent" | "warning" | "critical" }[] = [
    {
      label: "Fabric",
      value: fmtGbps(snap.fabric.totalTrafficGbps),
      sub: `of ${snap.fabric.totalCapacityGbps.toFixed(0)} Gbps`,
      pct: pctOf(snap.fabric.totalTrafficGbps, snap.fabric.totalCapacityGbps),
      tone: "series-3",
    },
    { label: "VRAM", value: fmtBytes(t.vramUsedBytes), sub: `of ${fmtBytes(t.vramTotalBytes)}`, pct: vramPct, tone: utilTone(vramPct) },
    { label: "CPU", value: fmtPct(t.cpuUsagePct, 0), sub: `${t.cpuCores} cores`, pct: t.cpuUsagePct, tone: utilTone(t.cpuUsagePct) },
    { label: "Temp", value: fmtTemp(t.maxTempC), sub: "peak" },
    { label: "Power", value: fmtWatts(t.powerDrawW), sub: "GPU" },
    ...(t.inferenceEndpoints > 0
      ? [{
          label: "Tokens",
          value: `${t.tokensPerSec}/s`,
          sub: `${t.requestsRunning} running${t.requestsWaiting ? ` · ${t.requestsWaiting} queued` : ""}`,
        }]
      : []),
    { label: "Nodes", value: `${t.nodesOnline}/${t.nodes}`, sub: `${t.containers} containers` },
  ];

  return (
    /*
     * Centred between the wordmark and the actions on wide screens; a plain
     * wrapping row on narrow ones. Placement is owned by the header, so this
     * only decides how the figures sit relative to each other.
     */
    <div className="no-scrollbar flex flex-nowrap items-center gap-x-6 overflow-x-auto lg:justify-center">
      {items.map((i) => (
        <div key={i.label} className="w-[112px] flex-none lg:w-[118px]">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-wide text-ink-muted">{i.label}</span>
            <span className="tnum text-[14px] font-semibold leading-none text-ink">{i.value}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <span className="truncate text-[10px] text-ink-muted">{i.sub}</span>
            {i.pct !== undefined && <Meter value={i.pct} tone={i.tone ?? "accent"} className="w-14" />}
          </div>
        </div>
      ))}
    </div>
  );
}

const SEVERITY = {
  error: { icon: "✕", color: "var(--status-critical)", label: "Error" },
  warn: { icon: "!", color: "var(--status-warning)", label: "Warning" },
} as const;

/**
 * Faults, as floating toasts.
 *
 * Deliberately out of the document flow: alerts come and go on their own
 * schedule, and anything in-flow would push the dashboard around each time one
 * fired. Status is icon + label + text, never colour alone.
 */
function AlertToasts({ warnings }: { warnings: ClusterWarning[] }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const shown = warnings.filter((w) => !dismissed.includes(w.id)).slice(0, 4);
  if (!shown.length) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2"
      aria-live="polite"
    >
      {shown.map((w) => {
        const s = SEVERITY[w.severity];
        return (
          <div
            key={w.id}
            role={w.severity === "error" ? "alert" : "status"}
            className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-edge bg-surface-1 px-3 py-2.5 shadow-lg"
          >
            <span
              aria-hidden="true"
              className="mt-px flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold text-white"
              style={{ background: s.color }}
            >
              {s.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-semibold text-ink">
                <span className="sr-only">{s.label}: </span>
                {w.title}
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-secondary">{w.detail}</p>
            </div>
            <button
              onClick={() => setDismissed((d) => [...d, w.id])}
              className="cursor-pointer rounded px-1 text-[12px] text-ink-muted hover:bg-surface-hover hover:text-ink"
              aria-label={`Dismiss: ${w.title}`}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

function Jobs({ jobs }: { jobs: DistributedJob[] }) {
  return (
    <Card
      title="Distributed workloads"
      right={<span className="text-[11px] text-ink-muted">inferred from container topology</span>}
      bodyClass="p-0"
    >
      {jobs.length === 0 ? (
        <p className="px-4 py-2.5 text-[12px] text-ink-muted">
          No workload is currently spanning more than one node.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--border)]">
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-ink">{j.model ?? shortImage(j.image)}</div>
                <div className="truncate text-[11px] text-ink-muted">
                  {j.members.map((m) => `${m.nodeLabel}${m.rank !== undefined ? ` #${m.rank}` : ""}`).join("  ·  ")}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="accent">{j.members.length} ranks</Badge>
                {j.masterAddr && <Badge tone="neutral">master {j.masterAddr}</Badge>}
                <Badge tone="neutral">{fmtBytes(j.totalVramBytes)} VRAM</Badge>
                <Badge tone={j.trafficGbps > 0.01 ? "good" : "neutral"}>{fmtGbps(j.trafficGbps)}</Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Cross-node comparison. Series identity follows the node, never its rank. */
function ClusterCharts({
  snap,
  history,
  themeKey,
}: {
  snap: ClusterSnapshot;
  history: HistoryPayload | null;
  themeKey: string;
}) {
  const panels = useMemo(() => {
    if (!history) return [];
    const build = (metric: string): ChartSeries[] =>
      snap.nodes.slice(0, 8).map((n, i) => ({
        label: n.label,
        colorVar: `--series-${(i % 8) + 1}`,
        values: history.series[`${n.id}:${metric}`] ?? [],
      }));
    // Axis ticks stay terse; the tooltip carries the units.
    const pct = { fmt: (v: number) => `${v.toFixed(0)}%`, tick: (v: number) => `${v.toFixed(0)}`, min: 100 };
    return [
      { key: "gpu", title: "GPU utilisation", unit: "%", series: build("gpu"), ...pct },
      { key: "vram", title: "GPU memory", unit: "%", series: build("vram"), ...pct },
      { key: "cpu", title: "CPU utilisation", unit: "%", series: build("cpu"), ...pct },
      { key: "mem", title: "System memory", unit: "%", series: build("mem"), ...pct },
      {
        key: "temp", title: "Peak temperature", unit: "°C", series: build("temp"),
        fmt: (v: number) => `${v.toFixed(0)}°C`, tick: (v: number) => `${v.toFixed(0)}`, min: 90,
      },
      {
        key: "power", title: "GPU power", unit: "W", series: build("power"),
        fmt: (v: number) => `${v.toFixed(1)} W`, tick: (v: number) => `${v.toFixed(0)}`, min: 40,
      },
    ];
  }, [history, snap.nodes]);

  const ts = history?.ts ?? [];

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {panels.map((p) => (
        <Card
          key={p.key}
          title={
            <span className="flex items-baseline gap-1.5">
              {p.title}
              <span className="text-[10px] font-normal text-ink-muted">{p.unit}</span>
            </span>
          }
          right={
            // A legend is always present for two or more series, so identity is
            // never carried by colour alone.
            p.series.length > 1 ? (
              <div className="flex flex-wrap gap-2.5">
                {p.series.map((s) => (
                  <LegendItem key={s.label} colorVar={s.colorVar} label={s.label} />
                ))}
              </div>
            ) : null
          }
        >
          {ts.length > 1 ? (
            <TimeChart
              ts={ts}
              series={p.series}
              height={132}
              format={p.fmt}
              tickFormat={p.tick}
              minRange={p.min}
              fill={p.series.length === 1}
              themeKey={themeKey}
            />
          ) : (
            <div className="flex h-[132px] items-center justify-center text-[11px] text-ink-muted">
              Collecting…
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

