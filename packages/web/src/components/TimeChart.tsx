/**
 * Streaming time-series chart.
 *
 * uPlot is used rather than a React charting library because these charts
 * update every second and there may be a dozen on screen: uPlot draws to canvas
 * and takes new data through an imperative setData, so a tick costs one redraw
 * instead of a React reconciliation over thousands of points.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import uPlot from "uplot";
import { cssVar } from "../lib/theme";

export interface ChartSeries {
  label: string;
  /** CSS custom property name, e.g. "--series-1". Re-read on theme change. */
  colorVar: string;
  /** null marks a gap (no reading at that timestamp). */
  values: (number | null)[];
}

interface Props {
  /** Unix ms timestamps, shared by every series. */
  ts: number[];
  series: ChartSeries[];
  height?: number;
  /** Full-precision formatter, used in the tooltip. */
  format: (v: number) => string;
  /** Short formatter for axis ticks. Falls back to `format`. */
  tickFormat?: (v: number) => string;
  /** Force the y axis to start at zero and span at least this much. */
  minRange?: number;
  fill?: boolean;
  className?: string;
  /** Theme token, used to force a rebuild when the palette changes. */
  themeKey: string;
}

/** Widest tick label decides the gutter, so long values are never clipped. */
function axisWidth(fmt: (v: number) => string, max: number): number {
  const samples = [0, max / 2, max].map((v) => fmt(v).length);
  return Math.min(72, Math.max(30, Math.max(...samples) * 7 + 12));
}

export function TimeChart({
  ts,
  series,
  height = 120,
  format,
  tickFormat,
  minRange = 1,
  fill = false,
  className,
  themeKey,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const fmtRef = useRef(format);
  const seriesRef = useRef(series);
  fmtRef.current = format;
  seriesRef.current = series;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const tooltip = document.createElement("div");
    tooltip.className = "u-tooltip";
    tooltip.style.display = "none";

    const stroke = series.map((s) => cssVar(s.colorVar) || "#888");
    const gridColor = cssVar("--grid");
    const muted = cssVar("--text-muted");
    const ticks = tickFormat ?? format;

    const opts: uPlot.Options = {
      width: Math.max(80, host.clientWidth || 300),
      height,
      legend: { show: false },
      padding: [8, 10, 0, 0],
      cursor: { x: true, y: false, points: { size: 7 }, drag: { x: false, y: false } },
      scales: {
        x: { time: true },
        y: {
          range: (_u, min, max) => {
            const hi = Math.max(Number.isFinite(max) ? max : 0, minRange);
            return [Math.min(0, Number.isFinite(min) ? min : 0), hi * 1.12];
          },
        },
      },
      axes: [
        {
          stroke: muted,
          grid: { show: false },
          ticks: { show: false },
          size: 26,
          gap: 4,
          font: "11px system-ui, sans-serif",
          // Wall-clock time, so a reading can be lined up against something
          // that happened. uPlot's default splits are relative and read oddly
          // on a short rolling window.
          values: (_u, splits) =>
            splits.map((t) =>
              new Date(t * 1000).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              })
            ),
        },
        {
          stroke: muted,
          grid: { stroke: gridColor, width: 1 },
          ticks: { show: false },
          size: axisWidth(ticks, minRange),
          gap: 6,
          font: "11px system-ui, sans-serif",
          values: (_u, splits) => splits.map((v) => ticks(v)),
        },
      ],
      series: [
        {},
        ...series.map((s, i) => ({
          label: s.label,
          stroke: stroke[i],
          width: 2,
          ...(fill && series.length === 1 ? { fill: hexAlpha(stroke[i] ?? "#888", 0.14) } : {}),
          points: { show: false },
          // Do not bridge gaps: a break in the line is meaningful.
          spanGaps: false,
        })),
      ],
      hooks: {
        setCursor: [
          (u) => {
            const { idx, left, top } = u.cursor;
            if (idx == null || left == null || left < 0) {
              tooltip.style.display = "none";
              return;
            }
            const t = u.data[0]?.[idx];
            const rows = seriesRef.current
              .map((s, i) => {
                const v = u.data[i + 1]?.[idx];
                if (v == null || !Number.isFinite(v)) return "";
                const c = stroke[i] ?? "#888";
                return (
                  `<div style="display:flex;gap:10px;align-items:center;justify-content:space-between">` +
                  `<span style="display:flex;gap:5px;align-items:center">` +
                  `<span style="width:8px;height:8px;border-radius:2px;background:${c};flex:none"></span>` +
                  `<span style="color:var(--text-secondary)">${escapeHtml(s.label)}</span></span>` +
                  `<span style="color:var(--text-primary);font-weight:600">${escapeHtml(
                    fmtRef.current(v as number)
                  )}</span></div>`
                );
              })
              .join("");
            if (!rows) {
              tooltip.style.display = "none";
              return;
            }
            const time =
              typeof t === "number"
                ? new Date(t * 1000).toLocaleTimeString(undefined, { hour12: false })
                : "";
            tooltip.innerHTML = `<div style="color:var(--text-muted);margin-bottom:3px">${time}</div>${rows}`;
            tooltip.style.display = "block";
            const w = tooltip.offsetWidth;
            const flip = left + w + 16 > u.over.clientWidth;
            tooltip.style.left = `${flip ? left - w - 10 : left + 10}px`;
            tooltip.style.top = `${Math.max(0, (top ?? 0) - 10)}px`;
          },
        ],
      },
    };

    const u = new uPlot(opts, [[], ...series.map(() => [])] as unknown as uPlot.AlignedData, host);
    u.over.appendChild(tooltip);
    plotRef.current = u;

    // Resize is coalesced into a frame: a window drag fires this continuously,
    // and each setSize is a full redraw.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = host.clientWidth;
        if (w > 0) u.setSize({ width: w, height });
      });
    });
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      u.destroy();
      plotRef.current = null;
    };
  }, [height, minRange, fill, themeKey, series.map((s) => s.label).join("|")]);

  useEffect(() => {
    const u = plotRef.current;
    if (!u) return;
    // Redrawing a chart nobody can see is pure waste; the next visible tick
    // repaints from the full buffer anyway.
    if (document.hidden) return;
    const x = ts.map((t) => t / 1000);
    u.setData([x, ...series.map((s) => s.values)] as unknown as uPlot.AlignedData);
  }, [ts, series]);

  return (
    <div
      ref={hostRef}
      className={className}
      // min-width:0 and overflow:hidden are load-bearing: without them a grid
      // child sizes to its content, an oversized canvas widens the host, and
      // the chart can never shrink back on a narrow viewport.
      style={{ height, width: "100%", minWidth: 0, overflow: "hidden" }}
    />
  );
}

function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
