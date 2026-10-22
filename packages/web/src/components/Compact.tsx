/**
 * Compact building blocks for the dense overview.
 *
 * The page used to give every figure a full card, which put the second node
 * three screens down. These tiles carry the same numbers at a fraction of the
 * height: a label with an icon, a big tabular value, and a sparkline of the
 * recent history so the trend is visible without opening a chart.
 */

import type { HistoryPayload, NodeSnapshot } from "@sparktop/core";
import { fmtBytes, fmtDuration, fmtPct, fmtTemp, fmtWatts, pctOf } from "@sparktop/core";
import { memo, type ReactNode } from "react";
import { useTween } from "../lib/useTween";
import { Icon, IconChip, type IconName } from "./Icon";
import { tempTone, utilTone } from "./primitives";
import { VariantIcon } from "./VariantIcon";

/** Last `n` finite values of a series, for a sparkline. */
export function tail(values: (number | null)[] | undefined, n = 90): number[] {
  const out: number[] = [];
  for (const v of (values ?? []).slice(-n)) if (v !== null && Number.isFinite(v)) out.push(v);
  return out;
}

/**
 * Smooth area sparkline. Fills its container's width via viewBox scaling, so a
 * tile can be any width without a ResizeObserver.
 */
export const Spark = memo(function Spark({
  values,
  color = "var(--accent)",
  height = 30,
  max,
}: {
  values: number[];
  color?: string;
  height?: number;
  max?: number;
}) {
  const W = 200;
  if (values.length < 2) return <div style={{ height }} />;
  const hi = Math.max(max ?? 0, ...values) || 1;
  const lo = 0;
  const step = W / (values.length - 1);
  const y = (v: number) => height - 2 - ((Math.max(lo, v) - lo) / (hi - lo)) * (height - 4);
  // Catmull-Rom to cubic Bezier: smooth, and passes through every sample.
  let d = `M0,${y(values[0]!).toFixed(1)}`;
  for (let i = 0; i < values.length - 1; i++) {
    const p0 = values[i - 1] ?? values[i]!;
    const p1 = values[i]!;
    const p2 = values[i + 1]!;
    const p3 = values[i + 2] ?? p2;
    const x1 = i * step, x2 = (i + 1) * step;
    const c1x = x1 + step / 6, c1y = y(p1) + (y(p2) - y(p0)) / 6;
    const c2x = x2 - step / 6, c2y = y(p2) - (y(p3) - y(p1)) / 6;
    d += ` C${c1x.toFixed(1)},${Math.min(height, c1y).toFixed(1)} ${c2x.toFixed(1)},${Math.min(height, c2y).toFixed(1)} ${x2.toFixed(1)},${y(p2).toFixed(1)}`;
  }
  const id = `sp${Math.abs(hashCode(color))}`;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${W},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
});

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** KPI tile: icon, label, animated value, sub-line, sparkline. */
export function Kpi({
  icon,
  label,
  value,
  unit,
  digits = 1,
  sub,
  color = "var(--accent)",
  spark,
  sparkMax,
  display,
}: {
  icon: IconName;
  label: string;
  value: number | null;
  unit?: string;
  digits?: number;
  sub?: ReactNode;
  color?: string;
  spark?: number[];
  sparkMax?: number;
  /** Override the formatted value (e.g. "1 · 0"). Disables the tween. */
  display?: string;
}) {
  const shown = useTween(display !== undefined ? null : value);
  return (
    <div className="kpi group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-edge bg-surface-2/40 px-3 pt-2.5 transition-colors hover:border-edge-strong">
      <div className="flex items-center gap-2">
        <IconChip name={icon} color={color} size={13} />
        <span className="truncate text-[10.5px] font-medium uppercase tracking-[0.07em] text-ink-muted">{label}</span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-1">
        <span className="tnum text-[22px] font-semibold leading-none tracking-[-0.02em] text-ink">
          {display ?? (shown === null ? "—" : shown.toFixed(digits))}
        </span>
        {unit && <span className="text-[11px] font-medium text-ink-muted">{unit}</span>}
      </div>
      <div className="mt-0.5 h-4 truncate text-[10.5px] text-ink-muted">{sub}</div>
      <div className="-mx-3 mt-auto">{spark && spark.length > 1 ? <Spark values={spark} color={color} height={26} max={sparkMax} /> : <div className="h-[26px]" />}</div>
    </div>
  );
}

/**
 * Ring meter: a small radial fill with the value in the middle. Used for the
 * four per-node resource figures so a whole node fits on one row.
 */
export function Ring({
  pct,
  label,
  value,
  sub,
  tone,
  icon,
  spark,
}: {
  pct: number | null;
  label: string;
  value: string;
  sub?: string;
  tone: string;
  icon: IconName;
  spark?: number[];
}) {
  const shown = useTween(pct);
  const R = 19;
  const C = 2 * Math.PI * R;
  const f = Math.max(0, Math.min(1, (shown ?? 0) / 100));
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-edge bg-surface-2/40 p-2.5">
      <div className="flex items-center gap-2.5">
        <div className="relative h-12 w-12 flex-none">
          <svg viewBox="0 0 48 48" className="h-full w-full -rotate-90" aria-hidden>
            <circle cx="24" cy="24" r={R} fill="none" stroke="var(--surface-hover)" strokeWidth="4.5" />
            {f > 0.002 && (
              <circle
                cx="24" cy="24" r={R} fill="none" stroke={tone} strokeWidth="4.5" strokeLinecap="round"
                strokeDasharray={`${C * f} ${C}`}
                style={{ filter: `drop-shadow(0 0 3px color-mix(in srgb, ${tone} 45%, transparent))` }}
              />
            )}
          </svg>
          <span className="absolute inset-0 grid place-items-center" style={{ color: tone }}>
            <Icon name={icon} size={15} />
          </span>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.07em] text-ink-muted">{label}</div>
          <div className="tnum truncate text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">{value}</div>
          {sub && <div className="tnum truncate text-[10.5px] text-ink-muted">{sub}</div>}
        </div>
      </div>
      {spark && spark.length > 1 && (
        <div className="-mx-2.5 -mb-2.5 mt-2 overflow-hidden rounded-b-xl">
          <Spark values={spark} color={tone} height={22} max={100} />
        </div>
      )}
    </div>
  );
}

const TONE = { accent: "var(--accent)", warning: "var(--status-warning)", critical: "var(--status-critical)" };

/**
 * One Spark node on a single compact panel: identity, the four resource
 * rings, and a one-line footer of the figures you check second.
 */
export const NodeTile = memo(function NodeTile({
  node,
  history,
  onOpen,
}: {
  node: NodeSnapshot;
  history: HistoryPayload | null;
  onOpen?: () => void;
}) {
  const h = (m: string) => tail(history?.series[`${node.id}:${m}`]);
  const online = node.status === "online";
  const g = node.gpu;
  const vramPct = g ? pctOf(g.vramUsedBytes, g.vramTotalBytes) : null;
  const memPct = pctOf(node.memory.usedBytes, node.memory.totalBytes);
  const ep = node.inference[0];
  const dot = online ? "var(--status-good)" : node.status === "connecting" ? "var(--status-warning)" : "var(--status-critical)";

  return (
    <section className="card flex min-w-0 flex-col rounded-2xl">
      <header className="flex items-center gap-3 border-b border-edge px-4 py-2.5">
        <VariantIcon variant={node.info.variant} width={34} title={node.info.variantName} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold tracking-[-0.01em] text-ink">{node.info.hostname || node.label}</span>
            <span className="relative flex h-2 w-2">
              {online && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50" style={{ background: dot }} />}
              <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: dot }} />
            </span>
          </div>
          <div className="truncate text-[11px] text-ink-muted">
            {node.info.variantName || "DGX Spark"} · {node.host}
            {online && <> · up {fmtDuration(node.info.uptimeSec)}</>}
          </div>
        </div>
        {ep && (
          <span className="hidden items-center gap-1.5 rounded-full border border-edge px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary sm:inline-flex" title={ep.models.join(", ")}>
            <Icon name="sparkle" size={11} className="text-[var(--accent)]" />
            {ep.engineLabel} :{ep.port}
          </span>
        )}
        {onOpen && (
          <button
            onClick={onOpen}
            className="cursor-pointer rounded-lg border border-edge px-2 py-1 text-[11px] text-ink-secondary transition-colors hover:border-edge-strong hover:text-ink"
          >
            Details
          </button>
        )}
      </header>

      {!online ? (
        <div className="flex items-center gap-2 px-4 py-6 text-[12px] text-ink-muted">
          <Icon name="alert" size={14} className="text-[var(--status-critical)]" />
          {node.error ?? `Node is ${node.status}`}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4">
          <Ring
            icon="gpu" label="GPU"
            pct={g?.utilPct ?? null}
            value={g ? fmtPct(g.utilPct) : "—"}
            sub={g?.smClockMhz ? `${g.smClockMhz} MHz` : g?.name}
            tone={TONE[utilTone(g?.utilPct ?? 0)]}
            spark={h("gpu")}
          />
          <Ring
            icon="memory" label="VRAM"
            pct={vramPct}
            value={g ? fmtBytes(g.vramUsedBytes) : "—"}
            sub={g ? `of ${fmtBytes(g.vramTotalBytes)}` : undefined}
            tone={TONE[utilTone(vramPct ?? 0)]}
            spark={h("vram")}
          />
          <Ring
            icon="cpu" label="CPU"
            pct={node.cpu.usagePct}
            value={fmtPct(node.cpu.usagePct)}
            sub={`${node.cpu.cores} cores · load ${node.cpu.loadAvg[0].toFixed(1)}`}
            tone={TONE[utilTone(node.cpu.usagePct)]}
            spark={h("cpu")}
          />
          <Ring
            icon="thermo" label="Temp"
            pct={node.thermal.maxC === null ? null : Math.min(100, node.thermal.maxC)}
            value={fmtTemp(node.thermal.maxC)}
            sub={g?.powerDrawW != null ? `${fmtWatts(g.powerDrawW)} GPU` : undefined}
            tone={TONE[tempTone(node.thermal.maxC)]}
            spark={h("temp")}
          />
        </div>
      )}

      {online && (
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-edge px-4 py-2 text-[11px] text-ink-muted">
          <span className="flex items-center gap-1.5"><Icon name="database" size={12} /> RAM <b className="tnum font-medium text-ink-secondary">{fmtPct(memPct ?? 0)}</b></span>
          <span className="flex items-center gap-1.5"><Icon name="box" size={12} /> <b className="tnum font-medium text-ink-secondary">{node.docker.containers.filter((c) => c.state === "running").length}</b> containers</span>
          <span className="flex items-center gap-1.5"><Icon name="layers" size={12} /> <b className="tnum font-medium text-ink-secondary">{g?.processes.length ?? 0}</b> GPU procs</span>
          <span className="flex items-center gap-1.5"><Icon name="activity" size={12} /> probe <b className="tnum font-medium text-ink-secondary">{node.probeMs} ms</b></span>
          {ep?.perRequestDecodeTokensPerSec != null && (
            <span className="ml-auto flex items-center gap-1.5 text-ink-secondary">
              <Icon name="bolt" size={12} className="text-[var(--accent)]" />
              <b className="tnum font-semibold text-ink">{ep.perRequestDecodeTokensPerSec.toFixed(1)}</b> tok/s
            </span>
          )}
        </footer>
      )}
    </section>
  );
});
