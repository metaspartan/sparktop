import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { fmtBytes, fmtGbps, fmtPct, fmtTemp, fmtWatts, pctOf, shortImage } from "@sparktop/core";
import type { ClusterSnapshot, ClusterWarning, DistributedJob, HistoryPayload } from "@sparktop/core";
import { useCluster } from "./lib/useCluster";
import { useTheme } from "./lib/theme";
import { WORKSPACES, workspaceFromHash, workspaceSections } from "./lib/dashboard";
import { SECTIONS, useLayout, type SectionId } from "./lib/useLayout";
import { Badge, Card, DensityContext, LegendItem, Meter, tempTone, utilTone } from "./components/primitives";
import { Sortable } from "./components/Sortable";
import { Settings } from "./components/Settings";
import { Setup } from "./components/Setup";
import { FabricView } from "./components/FabricView";
import { InferenceView } from "./components/InferenceView";
import { ThroughputHero } from "./components/ThroughputHero";
import { ControlsView } from "./components/ControlsView";
import { RunsView } from "./components/RunsView";
import { NodeCard } from "./components/NodeCard";
import { NodeTile } from "./components/Compact";
import { Icon, type IconName } from "./components/Icon";
import { TimeChart, type ChartSeries } from "./components/TimeChart";

export default function App() {
  const { snapshot, history, nodes: nodeConfigs, conn, staleMs, intervals, refreshConfig } = useCluster();
  const { choice, resolved, setChoice } = useTheme();
  const layout = useLayout();
  const [workspace, setWorkspace] = useState(() => workspaceFromHash(window.location.hash));
  useEffect(() => {
    const sync = () => setWorkspace(workspaceFromHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const currentView = WORKSPACES.find((view) => view.id === workspace)!;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openNode, setOpenNode] = useState<string | null>(null);

  const gap = layout.density === "compact" ? "gap-2" : "gap-3";

  const sections: Record<SectionId, React.ReactNode> = {
    // Two columns is the widest that still leaves a node card room for its
    // process and container tables at the 1800px container cap.
    nodes: snapshot && (
      <div className={`grid ${gap} lg:grid-cols-2`}>
        {snapshot.nodes.map((n) => (
          <NodeTile key={n.id} node={n} history={history} onOpen={() => setOpenNode(n.id)} />
        ))}
      </div>
    ),
    inference: snapshot && (
      <div className={`flex flex-col ${gap}`}>
        {/* Throughput leads the page. It is the figure the dashboard exists to
            show, and burying it below two node cards meant the first thing
            anyone read was a CPU graph. */}
        <ThroughputHero totals={snapshot.totals} history={history} themeKey={resolved} />
        {workspace !== "overview" && <InferenceView nodes={snapshot.nodes} history={history} themeKey={resolved} />}
      </div>
    ),
    runs: snapshot && <RunsView />,
    fabric: snapshot && <FabricView snap={snapshot} history={history} themeKey={resolved} compact={workspace === "overview"} />,
    jobs: snapshot && <Jobs jobs={snapshot.jobs} />,
    charts: snapshot && <ClusterCharts snap={snapshot} history={history} themeKey={resolved} />,
    controls: snapshot && <ControlsView nodes={snapshot.nodes} />,
  };

  const visible = workspaceSections(workspace, layout.order, layout.hidden);

  return (
    <DensityContext.Provider value={layout.density}>
      <div className="min-h-full">
        <a href="#main-content" className="skip-link" onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main-content");
          main?.focus();
          main?.scrollIntoView({ block: "start" });
        }}>Skip to dashboard</a>
        <Header
          conn={conn}
          staleMs={staleMs}
          snap={snapshot}
          theme={resolved}
          onToggleTheme={() => setChoice(resolved === "dark" ? "light" : "dark")}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main id="main-content" tabIndex={-1} className={`mx-auto flex max-w-[1680px] flex-col ${gap} px-3 pb-8 pt-4 sm:px-6`}>
          <div className="dashboard-heading flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" /> Cluster observability
              </div>
              <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.035em] text-ink">{workspace === "overview" ? "Your cluster, at a glance." : currentView.label}</h1>
              <p className="mt-1 text-[12px] text-ink-secondary">{currentView.description}</p>
            </div>
            <nav aria-label="Dashboard views" className="dashboard-nav flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-edge bg-surface-1 p-1">
              {WORKSPACES.map((view) => (
                <a key={view.id} href={`#${view.id}`} aria-current={view.id === workspace ? "page" : undefined}
                  className={`shrink-0 rounded-lg px-3 py-2 text-[11px] font-medium transition-colors ${view.id === workspace ? "bg-surface-hover text-ink shadow-sm" : "text-ink-muted hover:bg-surface-2 hover:text-ink"}`}>
                  {view.label}
                </a>
              ))}
            </nav>
          </div>
          {!snapshot ? (
            <LoadingSkeleton label={conn === "open" ? "Waiting for the first snapshot…" : "Connecting to sparktop server…"} />
          ) : snapshot.nodes.length === 0 ? (
            <Setup onAdded={refreshConfig} />
          ) : (
            <>
              {visible.length === 0 && <div className="rounded-xl border border-edge p-6 text-center text-[13px] text-ink-secondary">These panels are hidden in your layout. <button className="cursor-pointer font-medium text-ink underline" onClick={() => setSettingsOpen(true)}>Show panels in settings</button></div>}
              {visible.map((id, i) => (
                <div key={id} className="card-enter" style={{ "--i": i } as CSSProperties}>
                {workspace === "all" ? <Sortable
                  key={id}
                  index={layout.order.indexOf(id)}
                  count={layout.order.length}
                  label={SECTIONS.find((s) => s.id === id)?.label ?? id}
                  onMove={layout.move}
                >
                  {sections[id]}
                </Sortable> : <section aria-label={SECTIONS.find((s) => s.id === id)?.label}>{sections[id]}</section>}
                </div>
              ))}
            </>
          )}
        </main>

        {/* Alerts float above the page instead of occupying a slot in it, so a
            fault appearing or clearing never moves the dashboard underneath. */}
        {snapshot && snapshot.warnings.length > 0 && <AlertToasts warnings={snapshot.warnings} />}

        {openNode && snapshot && (() => {
          const i = snapshot.nodes.findIndex((n) => n.id === openNode);
          const n = snapshot.nodes[i];
          return n ? (
            <Drawer onClose={() => setOpenNode(null)} title={n.info.hostname || n.label}>
              <NodeCard node={n} history={history} themeKey={resolved} seriesIndex={i} />
            </Drawer>
          ) : null;
        })()}

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
    <header className="sticky top-0 z-30 border-b border-edge bg-surface-1/75 backdrop-blur-xl backdrop-saturate-150">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 55%, transparent) 30%, color-mix(in srgb, var(--series-1) 45%, transparent) 70%, transparent)",
          opacity: conn === "open" && !stale ? 0.9 : 0.25,
          transition: "opacity 600ms var(--ease-out)",
        }}
      />
      {/*
        Three zones: name, cluster totals, actions.
        `xl:pl-10` mirrors <main>, whose extra left padding makes room for the
        section drag handles — without it the wordmark sits 24px left of the
        content it heads. On narrow screens the totals wrap to their own row,
        which is why the zones are flex with an explicit order rather than a
        three-column grid.
      */}
      <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 sm:px-6">
        <span className="order-1 flex items-center gap-2 text-[17px] font-bold tracking-[-0.02em] text-ink">
          <span
            aria-hidden
            className="grid h-6 w-6 place-items-center rounded-[7px] text-[13px] text-white"
            style={{
              background: "linear-gradient(135deg, var(--accent-strong), var(--accent) 55%, color-mix(in srgb, var(--series-1) 70%, var(--accent)))",
              boxShadow: "var(--glow-accent)",
            }}
          >
            <Icon name="bolt" size={14} strokeWidth={2.2} />
          </span>
          <span>
            spark<span style={{ color: "var(--accent)" }}>top</span>
          </span>
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
            <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
          </button>

          <button
            onClick={onOpenSettings}
            className="relative cursor-pointer rounded-md border border-edge bg-surface-2 px-2 py-1 text-[12px] text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
            aria-label="Open settings"
            title="Settings and layout"
          >
            <Icon name="settings" size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}

/** Compact cluster roll-up. Every figure is tabular so nothing jitters. */
function SummaryStrip({ snap }: { snap: ClusterSnapshot }) {
  /*
   * Cluster health at a glance, as icon pills. Throughput lives in the hero
   * directly below, so the header no longer repeats it: it carries only what
   * the hero does not, and it fits one line at laptop width.
   */
  const t = snap.totals;
  const vramPct = pctOf(t.vramUsedBytes, t.vramTotalBytes);
  const hasFabric = snap.fabric.totalCapacityGbps > 0;
  const tone = (p: number | null) => `var(--${{ accent: "accent", warning: "status-warning", critical: "status-critical", "series-3": "series-3" }[utilTone(p ?? 0)]})`;
  const pills: { icon: IconName; label: string; value: string; pct?: number | null; color?: string; title: string }[] = [
    { icon: "server", label: "Nodes", value: `${t.nodesOnline}/${t.nodes}`, color: t.nodesOnline === t.nodes ? "var(--status-good)" : "var(--status-critical)", title: `${t.nodesOnline} of ${t.nodes} nodes online` },
    { icon: "memory", label: "VRAM", value: fmtBytes(t.vramUsedBytes), pct: vramPct, color: tone(vramPct), title: `${fmtBytes(t.vramUsedBytes)} of ${fmtBytes(t.vramTotalBytes)}` },
    { icon: "cpu", label: "CPU", value: fmtPct(t.cpuUsagePct, 0), pct: t.cpuUsagePct, color: tone(t.cpuUsagePct), title: `${t.cpuCores} cores` },
    { icon: "power", label: "Power", value: fmtWatts(t.powerDrawW), title: "GPU power draw, all nodes" },
    { icon: "thermo", label: "Peak", value: fmtTemp(t.maxTempC), color: `var(--${({ accent: "text-secondary", warning: "status-warning", critical: "status-critical" } as Record<string, string>)[tempTone(t.maxTempC)] ?? "text-secondary"})`, title: "Hottest sensor in the cluster" },
    ...(hasFabric
      ? [{ icon: "link" as IconName, label: "Fabric", value: fmtGbps(snap.fabric.totalTrafficGbps), pct: pctOf(snap.fabric.totalTrafficGbps, snap.fabric.totalCapacityGbps), color: "var(--series-3)", title: `of ${snap.fabric.totalCapacityGbps.toFixed(0)} Gbps capacity` }]
      : []),
    { icon: "box", label: "Containers", value: `${t.containers}`, title: "Running containers, all nodes" },
  ];
  return (
    <div className="no-scrollbar flex flex-nowrap items-center gap-1.5 overflow-x-auto lg:[justify-content:safe_center]">
      {pills.map((p) => (
        <div
          key={p.label}
          title={`${p.label}: ${p.title}`}
          className="relative flex flex-none items-center gap-1.5 overflow-hidden rounded-full border border-edge bg-surface-2/50 py-1 pl-2 pr-2.5"
        >
          <Icon name={p.icon} size={13} style={{ color: p.color ?? "var(--text-muted)" }} />
          <span className="hidden text-[10.5px] text-ink-muted xl:inline">{p.label}</span>
          <span className="tnum text-[12px] font-semibold text-ink">{p.value}</span>
          {p.pct != null && (
            <span
              aria-hidden
              className="absolute bottom-0 left-0 h-[2px] rounded-full transition-[width] duration-700"
              style={{ width: `${Math.min(100, p.pct)}%`, background: p.color }}
            />
          )}
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
      /*
       * SM clock against the part's ceiling. Placed here because it is the one
       * series that exposes a GB10 pinned low by the power-delivery fault: every
       * other panel stays healthy while the clock sits at ~82% of max, so a flat
       * line here is the signal, not a spike.
       */
      {
        key: "clock", title: "SM clock", unit: "MHz", series: build("clock"),
        fmt: (v: number) => `${v.toFixed(0)} MHz`, tick: (v: number) => `${v.toFixed(0)}`, min: 1000,
      },
    ];
  }, [history, snap.nodes]);

  const ts = history?.ts ?? [];

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
              height={112}
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

/**
 * Placeholder shaped like the dashboard, shown until the first snapshot.
 *
 * A bare "loading" line gives the eye nothing to settle on and then the whole
 * page jumps into place. Blocks the size of the real sections make the swap
 * read as content filling in rather than a layout appearing.
 */
function LoadingSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-live="polite">
      <div className="card rounded-2xl p-5">
        <div className="flex items-center gap-6">
          <div className="skeleton h-[168px] w-[168px] rounded-full" />
          <div className="flex-1 space-y-3">
            <div className="skeleton h-3 w-24" />
            <div className="skeleton h-8 w-48" />
            <div className="skeleton h-3 w-64" />
          </div>
        </div>
        <div className="skeleton mt-6 h-[180px] w-full" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="skeleton h-[320px]" />
        <div className="skeleton h-[320px]" />
      </div>
      <p className="text-center text-[12px] text-ink-muted">{label}</p>
    </div>
  );
}


/**
 * Right-hand drawer for node detail.
 *
 * The overview shows every node as a compact tile; the full card with its
 * process and container tables opens here, so looking at one node never
 * pushes the others off screen. Escape and the scrim both close it.
 */
function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label="Close" onClick={onClose} className="drawer-scrim absolute inset-0 cursor-default bg-black/45 backdrop-blur-[2px]" />
      <div className="drawer-panel relative flex h-full w-full max-w-[920px] flex-col overflow-y-auto border-l border-edge bg-surface-0 p-3 shadow-2xl">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[13px] font-semibold text-ink">{title}</span>
          <button onClick={onClose} className="cursor-pointer rounded-lg border border-edge px-2 py-1 text-[11px] text-ink-secondary hover:text-ink">
            Close <kbd className="ml-1 text-ink-muted">Esc</kbd>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
