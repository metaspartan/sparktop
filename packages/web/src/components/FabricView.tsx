/**
 * Fabric topology and link health.
 *
 * The diagram answers the question the per-node views cannot: which machines
 * are actually cabled together, over which ports, and how much is moving right
 * now in each direction.
 */

import { useMemo } from "react";
import type { ClusterSnapshot, FabricLink } from "@sparktop/core";
import { fmtGbps } from "@sparktop/core";
import { Badge, Card, LegendItem, Meter } from "./primitives";
import { TimeChart, type ChartSeries } from "./TimeChart";
import type { HistoryPayload } from "@sparktop/core";

interface Props {
  snap: ClusterSnapshot;
  history: HistoryPayload | null;
  themeKey: string;
}

export function FabricView({ snap, history, themeKey }: Props) {
  const { links } = snap.fabric;
  const labels = useMemo(() => linkLabels(links), [links]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Card
        title="Interconnect topology"
        right={
          <span className="text-[11px] text-ink-muted">
            {fmtGbps(snap.fabric.totalTrafficGbps)} of {snap.fabric.totalCapacityGbps.toFixed(0)} Gbps usable
          </span>
        }
      >
        <Topology snap={snap} />
      </Card>

      <Card
        title="Link throughput"
        right={
          links.length > 1 ? (
            <div className="flex flex-wrap gap-3">
              {links.slice(0, 4).map((l, i) => (
                <LegendItem key={l.id} colorVar={`--series-${i + 1}`} label={labels.get(l.id) ?? l.id} />
              ))}
            </div>
          ) : links.length === 1 ? (
            <div className="flex gap-3">
              <LegendItem colorVar="--series-1" label={`${links[0]!.a.nodeLabel} →`} />
              <LegendItem colorVar="--series-2" label={`${links[0]!.b.nodeLabel} →`} />
            </div>
          ) : null
        }
      >
        <LinkChart links={links} history={history} themeKey={themeKey} labels={labels} />
      </Card>

      <Card title="Links" className="lg:col-span-2" bodyClass="p-0">
        <LinkTable links={links} />
        {/* Switched segments have no pairwise link, so the table would silently
            omit those ports. Explaining it here keeps the context next to the
            data instead of turning it into an alert. */}
        {(snap.fabric.segments ?? []).length > 0 && (
          <div className="border-t border-edge px-4 py-2.5 text-[11px] leading-relaxed text-ink-muted">
            {(snap.fabric.segments ?? []).map((s) => (
              <p key={s.subnet}>
                <span className="font-medium text-ink-secondary">{s.subnet}</span> is a switched segment with{" "}
                {s.members.length} ports ({s.members.map((m) => `${m.nodeLabel}:${m.netdev}`).join(", ")}). Traffic
                through a switch cannot be attributed to a specific peer, so no point-to-point link is shown — the
                per-port throughput on each node still is.
              </p>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * Label a link for legends.
 *
 * A Spark pair is cabled with two parallel cables, so the node names alone are
 * ambiguous — the port has to disambiguate whenever a pair appears more than
 * once.
 */
function linkLabels(links: FabricLink[]): Map<string, string> {
  const pairCount = new Map<string, number>();
  for (const l of links) {
    const k = [l.a.nodeId, l.b.nodeId].sort().join("|");
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const l of links) {
    const k = [l.a.nodeId, l.b.nodeId].sort().join("|");
    const base = `${l.a.nodeLabel}↔${l.b.nodeLabel}`;
    out.set(l.id, (pairCount.get(k) ?? 0) > 1 ? `${base} · ${l.a.netdev}` : base);
  }
  return out;
}

/**
 * Node/link diagram.
 *
 * Two nodes sit side by side (the direct-attach Spark case); more are placed on
 * a circle so every link stays visible.
 */
function Topology({ snap }: { snap: ClusterSnapshot }) {
  const nodes = snap.nodes;
  const W = 640;
  const H = Math.max(220, nodes.length > 2 ? 380 : 220);
  const NW = 132;
  const NH = 62;

  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    if (nodes.length === 0) return m;
    if (nodes.length <= 2) {
      nodes.forEach((n, i) => {
        m.set(n.id, { x: nodes.length === 1 ? W / 2 : i === 0 ? NW / 2 + 16 : W - NW / 2 - 16, y: H / 2 });
      });
    } else {
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(W, H) / 2 - NH;
      nodes.forEach((n, i) => {
        const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
        m.set(n.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      });
    }
    return m;
  }, [nodes, H]);

  if (!nodes.length) {
    return <p className="py-8 text-center text-sm text-ink-muted">No nodes configured.</p>;
  }

  // Offset parallel links between the same pair so both are visible.
  const pairSeen = new Map<string, number>();

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H }} role="img"
      aria-label="Cluster interconnect topology">
      {snap.fabric.links.map((l, i) => {
        const a = pos.get(l.a.nodeId);
        const b = pos.get(l.b.nodeId);
        if (!a || !b) return null;
        const key = [l.a.nodeId, l.b.nodeId].sort().join("|");
        const n = pairSeen.get(key) ?? 0;
        pairSeen.set(key, n + 1);
        const spread = (n - 0.5) * 46;

        // Perpendicular offset so parallel cables do not overlap.
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ox = (-dy / len) * spread;
        const oy = (dx / len) * spread;
        const mx = (a.x + b.x) / 2 + ox;
        const my = (a.y + b.y) / 2 + oy;
        const d = `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
        const color = `var(--series-${(i % 4) + 1})`;
        const total = l.aToBGbps + l.bToAGbps;
        const width = l.active ? Math.min(7, 2 + (l.utilPct / 100) * 5) : 2;

        return (
          <g key={l.id}>
            <path d={d} fill="none" stroke="var(--axis)" strokeWidth={width + 2} strokeLinecap="round" opacity={0.5} />
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={width}
              strokeLinecap="round"
              opacity={l.active ? 1 : 0.34}
              // Dash animation reads as flow; speed tracks utilisation.
              strokeDasharray={l.active ? "10 8" : undefined}
            >
              {l.active && (
                <animate
                  attributeName="stroke-dashoffset"
                  from="18"
                  to="0"
                  dur={`${Math.max(0.25, 1.6 - (l.utilPct / 100) * 1.35)}s`}
                  repeatCount="indefinite"
                />
              )}
            </path>
            <text
              x={mx}
              y={my - 8}
              textAnchor="middle"
              className="tnum"
              style={{ fontSize: 11, fontWeight: 600, fill: "var(--text-primary)" }}
            >
              {total > 0.01 ? fmtGbps(total) : "idle"}
            </text>
            <text
              x={mx}
              y={my + 6}
              textAnchor="middle"
              style={{ fontSize: 9.5, fill: "var(--text-muted)" }}
            >
              {l.rateGbps.toFixed(0)}G · {l.a.netdev}
            </text>
          </g>
        );
      })}

      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const online = n.status === "online";
        const dot = online
          ? "var(--status-good)"
          : n.status === "error"
            ? "var(--status-critical)"
            : "var(--text-muted)";
        return (
          <g key={n.id} transform={`translate(${p.x - NW / 2}, ${p.y - NH / 2})`}>
            <rect
              width={NW}
              height={NH}
              rx={10}
              fill="var(--surface-2)"
              stroke="var(--border)"
              strokeWidth={1}
            />
            <circle cx={13} cy={15} r={4} fill={dot} />
            <text x={24} y={19} style={{ fontSize: 12, fontWeight: 600, fill: "var(--text-primary)" }}>
              {truncate(n.label, 13)}
            </text>
            <text x={13} y={36} style={{ fontSize: 10, fill: "var(--text-secondary)" }}>
              {n.gpu ? `GPU ${n.gpu.utilPct.toFixed(0)}%` : "no GPU"}
              {n.thermal.maxC !== null ? ` · ${n.thermal.maxC.toFixed(0)}°C` : ""}
            </text>
            <text x={13} y={51} style={{ fontSize: 10, fill: "var(--text-muted)" }}>
              {n.host}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Throughput over time.
 *
 * With one link the two directions are the interesting comparison; with several
 * links, total per link is clearer than eight direction series at once.
 */
function LinkChart({
  links,
  history,
  themeKey,
  labels,
}: {
  links: FabricLink[];
  history: HistoryPayload | null;
  themeKey: string;
  labels: Map<string, string>;
}) {
  const { ts, series } = useMemo(() => {
    const empty = { ts: [] as number[], series: [] as ChartSeries[] };
    if (!history || !links.length) return empty;
    const ts = history.ts;

    if (links.length === 1) {
      const l = links[0]!;
      const ab = history.series[`link:${l.id}:ab`];
      if (!ab) return empty;
      return {
        ts,
        series: [
          { label: `${l.a.nodeLabel} → ${l.b.nodeLabel}`, colorVar: "--series-1", values: ab },
          {
            label: `${l.b.nodeLabel} → ${l.a.nodeLabel}`,
            colorVar: "--series-2",
            values: history.series[`link:${l.id}:ba`] ?? [],
          },
        ],
      };
    }

    // Cap at four series; the categorical order is fixed and never cycled.
    return {
      ts,
      series: links.slice(0, 4).map((l, i) => {
        const ab = history.series[`link:${l.id}:ab`] ?? [];
        const ba = history.series[`link:${l.id}:ba`] ?? [];
        return {
          label: labels.get(l.id) ?? l.id,
          colorVar: `--series-${i + 1}`,
          // Both directions summed: total moved over the cable.
          values: ab.map((v, k) => {
            const other = ba[k];
            if (v === null || other === null || other === undefined) return null;
            return Math.round((v + other) * 100) / 100;
          }),
        };
      }),
    };
  }, [history, links, labels]);

  if (!links.length) {
    return (
      <p className="py-10 text-center text-sm text-ink-muted">
        No links detected. sparktop pairs ports that share a subnet across two nodes.
      </p>
    );
  }
  if (!ts.length) {
    return <p className="py-10 text-center text-sm text-ink-muted">Collecting…</p>;
  }

  return (
    <TimeChart
      ts={ts}
      series={series}
      height={168}
      minRange={0.5}
      fill={series.length === 1}
      format={(v) => fmtGbps(v)}
      // Ticks stay short so the gutter never eats the plot; the card heading
      // and the tooltip carry the unit.
      tickFormat={(v) => (v >= 1 ? `${v.toFixed(v >= 10 ? 0 : 1)}G` : `${Math.round(v * 1000)}M`)}
      themeKey={themeKey}
    />
  );
}

function LinkTable({ links }: { links: FabricLink[] }) {
  if (!links.length) {
    return (
      <p className="px-4 py-6 text-sm text-ink-muted">
        No point-to-point links resolved yet.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-[12px]">
        <thead className="bg-surface-2 text-[11px] uppercase tracking-wide text-ink-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Endpoint A</th>
            <th className="px-3 py-2 font-medium">Endpoint B</th>
            <th className="px-3 py-2 font-medium">Rate</th>
            <th className="px-3 py-2 font-medium">A → B</th>
            <th className="px-3 py-2 font-medium">B → A</th>
            <th className="px-3 py-2 font-medium">Utilisation</th>
            {/* Fixed width: the badges below change as links go active, and a
                resizing column would shift every other column with it. */}
            <th className="w-[230px] px-3 py-2 font-medium">Health</th>
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.id} className="border-t border-edge align-middle hover:bg-surface-hover">
              <td className="px-4 py-2.5">
                <div className="font-medium text-ink">{l.a.nodeLabel}</div>
                <div className="tnum text-[11px] text-ink-muted">
                  {l.a.netdev} · {l.a.address ?? "-"}
                </div>
              </td>
              <td className="px-3 py-2.5">
                <div className="font-medium text-ink">{l.b.nodeLabel}</div>
                <div className="tnum text-[11px] text-ink-muted">
                  {l.b.netdev} · {l.b.address ?? "-"}
                </div>
              </td>
              <td className="tnum px-3 py-2.5 text-ink-secondary">
                {l.rateGbps.toFixed(0)} Gbps
                {l.pcieLimited && (
                  <span
                    className="ml-1 cursor-help text-ink-muted"
                    title={`Ports advertise ${l.signalledRateGbps} Gbps, but each sits behind a PCIe link that carries about ${l.rateGbps.toFixed(0)} Gbps. The lower figure is the real ceiling.`}
                  >
                    ⓘ
                  </span>
                )}
              </td>
              <td className="tnum px-3 py-2.5 font-medium text-ink">{fmtGbps(l.aToBGbps)}</td>
              <td className="tnum px-3 py-2.5 font-medium text-ink">{fmtGbps(l.bToAGbps)}</td>
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Meter value={l.utilPct} tone={l.utilPct >= 80 ? "warning" : "accent"} className="w-20" />
                  <span className="tnum text-[11px] text-ink-secondary">{l.utilPct.toFixed(1)}%</span>
                </div>
              </td>
              <td className="w-[230px] px-3 py-2.5">
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  {l.faults > 0 ? (
                    <Badge tone="critical" title="Cumulative link and transport errors">
                      ⚠ {l.faults} errors
                    </Badge>
                  ) : (
                    <Badge tone="good" title="No link or transport errors">
                      ✓ clean
                    </Badge>
                  )}
                  {l.confirmed ? (
                    <Badge tone="neutral" title="Both endpoints' counters agree, confirming these ports are cabled together">
                      verified
                    </Badge>
                  ) : (
                    <Badge tone="warning" title="Ports share a subnet but their counters disagree">
                      unverified
                    </Badge>
                  )}
                  {/* Kept in the layout even at zero so the row does not reflow
                      the moment congestion control kicks in. */}
                  <span className={l.congestionEvents > 0 ? "" : "invisible"} aria-hidden={l.congestionEvents === 0}>
                    <Badge tone="neutral" title="ECN congestion notifications — flow control working, not an error">
                      {l.congestionEvents} CNP
                    </Badge>
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
