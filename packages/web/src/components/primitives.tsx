/** Small shared building blocks: cards, meters, sparklines, status chips. */

import { createContext, useContext, type ReactNode } from "react";

/** Compact mode trims padding everywhere at once, without prop-drilling. */
export const DensityContext = createContext<"comfortable" | "compact">("comfortable");
export const useDensity = () => useContext(DensityContext);

export function Card({
  title,
  right,
  children,
  className = "",
  bodyClass = "",
  fill = false,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClass?: string;
  /**
   * Let the body take whatever height the card is given.
   *
   * A grid row stretches every card to the tallest one. Without this the body
   * keeps its content height and the surplus shows as blank space under it,
   * which is what a chart card does when its neighbour is a long list.
   */
  fill?: boolean;
}) {
  const dense = useDensity() === "compact";
  return (
    <section
      className={`flex min-w-0 flex-col rounded-xl border border-edge bg-surface-1 shadow-[0_1px_2px_rgb(0_0_0/0.04)] ${className}`}
    >
      {(title || right) && (
        <header
          className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-edge ${
            dense ? "px-3 py-1.5" : "px-4 py-2.5"
          }`}
        >
          <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
          {right}
        </header>
      )}
      {/* min-h-0 lets the body shrink below its content box, without which a
          flex child refuses to give the overflow back to the chart. */}
      <div className={`${fill ? "min-h-0 flex-1" : ""} ${bodyClass || (dense ? "p-3" : "p-4")}`}>{children}</div>
    </section>
  );
}

/**
 * Horizontal meter.
 *
 * Colour encodes severity, so it is paired with the numeric label beside it and
 * never carries the meaning alone.
 */
export function Meter({
  value,
  max = 100,
  tone = "accent",
  className = "",
}: {
  value: number;
  max?: number;
  tone?: "accent" | "good" | "warning" | "critical" | "series-2" | "series-3";
  className?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const bg = {
    accent: "var(--accent)",
    good: "var(--status-good)",
    warning: "var(--status-warning)",
    critical: "var(--status-critical)",
    "series-2": "var(--series-2)",
    "series-3": "var(--series-3)",
  }[tone];
  /*
   * `w-full` is the default, not a fixed part of the base.
   *
   * Two width utilities on one element have equal specificity, so a caller's
   * `w-14` does not reliably beat a baked-in `w-full` — whichever Tailwind
   * happens to emit later wins. Every call site that tried to size a meter was
   * silently getting full width instead, which is what squeezed the header's
   * sub-labels down to an ellipsis.
   */
  const sized = /(^|\s)(w-|min-w-|max-w-|flex-1|basis-)/.test(className);
  return (
    <div
      className={`h-1.5 ${sized ? "" : "w-full"} overflow-hidden rounded-full bg-surface-2 ${className}`}
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300 ease-out"
        style={{ width: `${pct}%`, background: bg }}
      />
    </div>
  );
}

/** Pick a tone from a utilisation percentage. */
export function utilTone(pct: number): "accent" | "warning" | "critical" {
  return pct >= 95 ? "critical" : pct >= 80 ? "warning" : "accent";
}

/** Pick a tone from a temperature in Celsius. */
export function tempTone(c: number | null): "accent" | "warning" | "critical" {
  if (c === null) return "accent";
  return c >= 90 ? "critical" : c >= 80 ? "warning" : "accent";
}

/** Compact inline sparkline. SVG is cheaper than a canvas plot at this size. */
export function Sparkline({
  values,
  colorVar = "--accent",
  width = 120,
  height = 28,
  max,
}: {
  values: number[];
  colorVar?: string;
  width?: number;
  height?: number;
  max?: number;
}) {
  if (values.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const hi = Math.max(max ?? 0, ...values, 0.0001);
  const step = width / (values.length - 1);
  const y = (v: number) => height - 1 - (Math.max(0, v) / hi) * (height - 2);
  const pts = values.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`);
  const area = `M0,${height} L${pts.join(" L")} L${width},${height} Z`;
  return (
    <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
      <path d={area} fill={`var(${colorVar})`} opacity={0.13} />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={`var(${colorVar})`}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Per-core utilisation strip.
 *
 * A single aggregate CPU figure hides the thing you usually want to know on a
 * 20-core GB10: whether load is spread across the cores or pinned to a couple
 * of them. Each core is one bar, in core order, so the split between the
 * performance and efficiency clusters stays visible.
 */
export function CoreStrip({ cores, height = 26 }: { cores: number[]; height?: number }) {
  if (!cores.length) return null;
  return (
    <div
      className="flex items-end gap-[2px]"
      style={{ height }}
      role="img"
      aria-label={`Per-core CPU utilisation across ${cores.length} cores, peak ${Math.max(...cores).toFixed(0)}%`}
    >
      {cores.map((pct, i) => {
        const tone = pct >= 95 ? "critical" : pct >= 80 ? "warning" : "accent";
        const color = {
          accent: "var(--accent)",
          warning: "var(--status-warning)",
          critical: "var(--status-critical)",
        }[tone];
        return (
          <div
            key={i}
            className="relative min-w-[3px] flex-1 rounded-[2px] bg-surface-2"
            style={{ height }}
            title={`Core ${i}: ${pct.toFixed(0)}%`}
          >
            <div
              className="absolute bottom-0 left-0 right-0 rounded-[2px] transition-[height] duration-300 ease-out"
              // A floor keeps an idle core visible as a core rather than a gap.
              style={{ height: `${Math.max(6, pct)}%`, background: color, opacity: pct < 2 ? 0.35 : 1 }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function StatusDot({ status }: { status: "online" | "offline" | "connecting" | "error" }) {
  const map = {
    online: { c: "var(--status-good)", t: "Online" },
    connecting: { c: "var(--status-warning)", t: "Connecting" },
    offline: { c: "var(--text-muted)", t: "Offline" },
    error: { c: "var(--status-critical)", t: "Error" },
  }[status];
  // Width is fixed because the label changes length as the node reconnects.
  return (
    <span className="inline-flex w-[86px] items-center gap-1.5" title={map.t}>
      <span className="h-2 w-2 flex-none rounded-full" style={{ background: map.c }} />
      <span className="truncate text-[11px] text-ink-secondary">{map.t}</span>
    </span>
  );
}

/** A labelled figure. Values stay in text tokens, never a series color. */
export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] font-medium uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-0.5 truncate text-[19px] font-semibold leading-tight text-ink" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub !== undefined && <div className="truncate text-[11px] text-ink-secondary">{sub}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "critical" | "accent";
  title?: string;
}) {
  const cls = {
    neutral: "bg-surface-2 text-ink-secondary",
    good: "text-[color:var(--status-good)]",
    warning: "text-[color:var(--status-warning)]",
    critical: "text-[color:var(--status-critical)]",
    accent: "text-[color:var(--accent)]",
  }[tone];
  const ring =
    tone === "neutral" ? "" : "bg-surface-2 ring-1 ring-inset ring-[color:var(--border)]";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${cls} ${ring}`}
    >
      {children}
    </span>
  );
}

/** Legend entry: a colored swatch plus a text label, so identity is never color alone. */
export function LegendItem({ colorVar, label, value }: { colorVar: string; label: string; value?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
      <span className="h-2 w-2 flex-none rounded-[2px]" style={{ background: `var(${colorVar})` }} />
      {label}
      {value !== undefined && <span className="tnum font-semibold text-ink">{value}</span>}
    </span>
  );
}
