/**
 * View rendering: turns a ClusterSnapshot into lines of text.
 *
 * Every function here returns `string[]` rather than writing to the terminal,
 * which keeps the drawing logic testable and lets the frame loop own the
 * cursor.
 */

import type { ClusterSnapshot, FabricLink, NodeSnapshot } from "@sparktop/core";
import {
  fmtBps,
  fmtBytes,
  fmtDuration,
  fmtGbps,
  fmtTemp,
  fmtWatts,
  pctOf,
  shortImage,
} from "@sparktop/core";
import {
  BOX,
  C,
  TONE,
  bar,
  bold,
  chart,
  columns,
  coreBars,
  coreGrid,
  gauge,
  dim,
  padEnd,
  padStart,
  panel,
  sparkline,
  tempTone,
  toneFor,
  toneRgbFor,
  truncate,
} from "./ansi.ts";

export type View = "overview" | "fabric" | "processes" | "containers";

export interface RenderState {
  view: View;
  /** Index into snapshot.nodes, or -1 for "all nodes". */
  selected: number;
  width: number;
  height: number;
  paused: boolean;
  history: Map<string, number[]>;
}

/**
 * How much of the overview to draw.
 *
 * The frame has to fit the terminal, and truncating it hides whatever happens
 * to be last — which on a short window meant losing the interconnect and
 * inference panels entirely. Instead the renderer tries these in order and
 * keeps the richest one that fits, so a small terminal loses decoration rather
 * than information.
 */
interface Detail {
  trends: boolean;
  cluster: boolean;
  gauges: boolean;
  coreGrid: boolean;
  compactNodes: boolean;
  /**
   * Which panels below the nodes survive. Nodes themselves are never dropped —
   * a dashboard that cannot show the machines is not worth drawing.
   */
  secondary: "all" | "links" | "none";
}

const DETAIL_LEVELS: Detail[] = [
  { trends: true, cluster: true, gauges: true, coreGrid: true, compactNodes: false, secondary: "all" },
  { trends: true, cluster: true, gauges: true, coreGrid: false, compactNodes: false, secondary: "all" },
  { trends: false, cluster: true, gauges: true, coreGrid: false, compactNodes: false, secondary: "all" },
  { trends: false, cluster: true, gauges: false, coreGrid: false, compactNodes: false, secondary: "all" },
  { trends: false, cluster: false, gauges: false, coreGrid: false, compactNodes: false, secondary: "all" },
  /*
   * Compacting the nodes comes before discarding panels.
   *
   * Four rows of per-node detail are worth less than knowing the fabric is
   * carrying traffic and which engines are up — on a cluster tool those are
   * the reason to be looking. So a small window loses per-node depth first and
   * whole subjects last.
   */
  { trends: false, cluster: false, gauges: false, coreGrid: false, compactNodes: true, secondary: "all" },
  { trends: false, cluster: false, gauges: false, coreGrid: false, compactNodes: true, secondary: "links" },
  { trends: false, cluster: false, gauges: false, coreGrid: false, compactNodes: true, secondary: "none" },
];

export function render(snap: ClusterSnapshot | null, st: RenderState): string[] {
  const W = st.width;
  if (!snap) return [dim("Connecting to nodes…")];
  if (!snap.nodes.length) {
    return [
      "",
      C.warning("  No nodes configured."),
      "",
      dim("  Add one in config/nodes.json, or set SPARKTOP_NODES=user@host,user@host"),
      dim("  with SPARKTOP_SSH_KEY pointing at a private key."),
    ];
  }

  const nodes = st.selected >= 0 && snap.nodes[st.selected] ? [snap.nodes[st.selected]!] : snap.nodes;

  if (st.view === "overview") {
    // The frame loop keeps two rows for itself; anything beyond that is cut.
    const budget = Math.max(8, st.height - 2);
    let best: string[] = [];
    for (const d of DETAIL_LEVELS) {
      best = composeOverview(snap, nodes, st, W, d);
      if (best.length <= budget) break;
    }
    return best;
  }

  const lines: string[] = [];
  lines.push(...header(snap, st, W));
  lines.push("");

  switch (st.view) {
    case "fabric":
      lines.push(...fabricView(snap, st, W));
      break;
    case "processes":
      lines.push(...processView(nodes, W));
      break;
    case "containers":
      lines.push(...containerView(nodes, W));
      break;
  }

  return lines;
}

// ---------------------------------------------------------------------------

function header(snap: ClusterSnapshot, st: RenderState, W: number): string[] {
  const t = snap.totals;
  const title = bold(C.series1("sparktop"));
  const nodesTxt = `${t.nodesOnline}/${t.nodes} nodes`;
  const vramPct = pctOf(t.vramUsedBytes, t.vramTotalBytes);

  const left = `${title} ${dim("│")} ${nodesTxt}`;
  const right = st.paused ? C.warning("PAUSED") : dim(new Date(snap.ts).toLocaleTimeString());
  const line1 = padEnd(left, Math.max(0, W - visible(right))) + right;

  const cells = [
    `${dim("fabric")} ${bold(fmtGbps(snap.fabric.totalTrafficGbps))}${dim(`/${snap.fabric.totalCapacityGbps}G`)}`,
    `${dim("vram")} ${toneFor(vramPct)(fmtBytes(t.vramUsedBytes))}${dim(`/${fmtBytes(t.vramTotalBytes)}`)}`,
    `${dim("cpu")} ${toneFor(t.cpuUsagePct)(`${t.cpuUsagePct.toFixed(0)}%`)}`,
    `${dim("pwr")} ${bold(fmtWatts(t.powerDrawW))}`,
    `${dim("temp")} ${tempTone(t.maxTempC)(fmtTemp(t.maxTempC))}`,
    `${dim("ctr")} ${bold(String(t.containers))}`,
    ...(t.inferenceEndpoints > 0
      ? [`${dim("tok/s")} ${bold(C.series3(String(t.tokensPerSec)))}${dim(`  req ${t.requestsRunning}/${t.requestsWaiting}`)}`]
      : []),
  ];
  return [line1, truncate(cells.join(dim("  ·  ")), W)];
}

const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/**
 * Side-by-side trend charts.
 *
 * Three narrow charts read better than one wide one here: the questions are
 * separate (is the GPU busy, is the fabric moving, are tokens coming out) and
 * putting them on a shared axis would flatten whichever has the smaller range.
 * Dropped entirely on a short terminal, where the node blocks matter more.
 */
function trends(snap: ClusterSnapshot, st: RenderState, W: number): string[] {
  /*
   * Chart height follows the terminal.
   *
   * A fixed height either wastes a tall window or crowds out the node blocks in
   * a short one. Roughly a seventh of the rows, clamped to something that can
   * still be read, means the charts grow when there is room and are dropped
   * entirely when there is not.
   */
  const H = Math.max(3, Math.min(10, Math.floor(st.height / 7)));
  if (st.height < 24 || W < 60) return [];

  const panels: { label: string; key: string; color: (s: string) => string; fmt: (v: number) => string; max?: number }[] = [
    { label: "GPU", key: "cluster:gpu", color: C.series1, fmt: (v) => `${v.toFixed(0)}%`, max: 100 },
    { label: "Fabric", key: "cluster:fabric", color: C.series3, fmt: (v) => fmtGbps(v) },
  ];
  if (snap.totals.inferenceEndpoints > 0) {
    panels.push({ label: "Tokens/s", key: "cluster:tokens", color: C.series2, fmt: (v) => v.toFixed(0) });
  }

  // Charts are laid out against the box's interior, not the frame width, or
  // the rightmost one is clipped by the border it sits inside.
  const inner = W - 4;
  const gap = 2;
  const each = Math.floor((inner - gap * (panels.length - 1)) / panels.length);
  if (each < 20) return [];

  const rendered = panels.map((p) => {
    const values = st.history.get(p.key) ?? [];
    const body = chart(values, each, H, {
      color: p.color,
      format: p.fmt,
      ...(p.max !== undefined ? { max: p.max } : {}),
      minRange: p.max === undefined ? 0.1 : 0,
    });
    const now = values.length ? p.fmt(values[values.length - 1]!) : "—";
    const head = `${dim(p.label)} ${bold(p.color(now))}`;
    return [padEnd(head, each), ...body.map((l) => padEnd(l, each))];
  });

  const rows = Math.max(...rendered.map((r) => r.length));
  const body: string[] = [];
  for (let r = 0; r < rows; r++) {
    body.push(rendered.map((col) => col[r] ?? " ".repeat(each)).join(" ".repeat(gap)));
  }
  return [...panel("Trends", body, W), ""];
}

/**
 * Cluster totals as a row of panels: what the fleet adds up to.
 *
 * With one machine this would only repeat the node block, so it appears from
 * two nodes up. The three questions a multi-Spark operator asks are how much
 * accelerator memory is committed across the fleet, whether the GPUs are
 * actually working, and whether the fabric between them is carrying anything —
 * so those are the three panels, each with the per-node split underneath, since
 * an aggregate hides the case where one node does all the work.
 */
function clusterSummary(snap: ClusterSnapshot, W: number): string[] {
  const online = snap.nodes.filter((n) => n.status === "online");
  if (online.length < 2) return [];

  const cols = W >= 150 ? 3 : W >= 100 ? 3 : 0;
  if (!cols) return [];
  const each = Math.floor((W - 2 * (cols - 1)) / cols);
  const inner = each - 4;
  if (inner < 18) return [];

  const t = snap.totals;
  const gaugeH = 2;
  const nameW = Math.max(...online.map((n) => n.label.length));

  // --- Unified memory ------------------------------------------------------
  const vramPct = pctOf(t.vramUsedBytes, t.vramTotalBytes);
  const vram = [
    `${bold(toneFor(vramPct)(fmtBytes(t.vramUsedBytes)))}${dim(` / ${fmtBytes(t.vramTotalBytes)}`)}`,
    ...gauge(vramPct, inner, gaugeH, toneRgbFor(vramPct)),
    ...online.map((n) => {
      const p = n.gpu ? pctOf(n.gpu.vramUsedBytes, n.gpu.vramTotalBytes) : 0;
      return `${dim(padEnd(truncate(n.label, nameW), nameW))} ${bar(p, Math.max(4, inner - nameW - 10), toneFor(p))}${padStart(fmtBytes(n.gpu?.vramUsedBytes ?? 0), 9)}`;
    }),
  ];

  // --- GPU -----------------------------------------------------------------
  const gpuMean = online.reduce((a, n) => a + (n.gpu?.utilPct ?? 0), 0) / online.length;
  const gpu = [
    `${bold(toneFor(gpuMean)(`${gpuMean.toFixed(0)}%`))}${dim(` mean · ${t.gpus} GPU${t.gpus === 1 ? "" : "s"}`)}`,
    ...gauge(gpuMean, inner, gaugeH, toneRgbFor(gpuMean)),
    ...online.map((n) => {
      const p = n.gpu?.utilPct ?? 0;
      return `${dim(padEnd(truncate(n.label, nameW), nameW))} ${bar(p, Math.max(4, inner - nameW - 10), toneFor(p))}${padStart(`${p.toFixed(0)}%`, 9)}`;
    }),
  ];

  // --- Fabric --------------------------------------------------------------
  const cap = snap.fabric.totalCapacityGbps;
  const fabPct = cap > 0 ? (snap.fabric.totalTrafficGbps / cap) * 100 : 0;
  const confirmed = snap.fabric.links.filter((l) => l.confirmed).length;
  const fabric = [
    `${bold(C.series3(fmtGbps(snap.fabric.totalTrafficGbps)))}${dim(` / ${cap}G`)}`,
    ...gauge(fabPct, inner, gaugeH, TONE.series3),
    ...(snap.fabric.links.length
      ? snap.fabric.links.slice(0, online.length + 2).map((l) => {
          const total = l.aToBGbps + l.bToAGbps;
          const p = l.rateGbps > 0 ? (total / l.rateGbps) * 100 : 0;
          // Interface names run longer than hostnames, so this column is sized
          // for them rather than borrowing the node-name width.
          const devW = Math.min(14, Math.max(...snap.fabric.links.map((x) => x.a.netdev.length)));
          return `${dim(padEnd(truncate(l.a.netdev, devW), devW))} ${bar(p, Math.max(4, inner - devW - 12), C.series3)}${padStart(fmtGbps(total), 11)}`;
        })
      : [dim("no links resolved")]),
    dim(`${snap.fabric.links.length} link${snap.fabric.links.length === 1 ? "" : "s"} · ${confirmed} confirmed`),
  ];

  /*
   * Pad every body to the tallest before boxing, so the three boxes close on
   * the same row. Ragged bottom borders make a row of panels read as three
   * unrelated things rather than one band.
   */
  const bodies = [vram, gpu, fabric];
  const tallest = Math.max(...bodies.map((b) => b.length));
  for (const b of bodies) while (b.length < tallest) b.push("");

  const blocks = [
    { lines: panel("Unified memory", vram, each), width: each },
    { lines: panel("GPU", gpu, each), width: each },
    { lines: panel("Fabric", fabric, each, C.series3), width: each },
  ];
  return [...columns(blocks, 2), ""];
}

function composeOverview(
  snap: ClusterSnapshot,
  nodes: NodeSnapshot[],
  st: RenderState,
  W: number,
  d: Detail
): string[] {
  // Everything below is laid out against a box interior.
  const I = W - 4;
  const out: string[] = [...header(snap, st, W), ""];
  if (d.trends) out.push(...trends(snap, st, W));
  // Only when looking at the fleet: drilled into one node, the totals would
  // just restate that node's own figures.
  if (d.cluster && nodes.length === snap.nodes.length) out.push(...clusterSummary(snap, W));

  const nodeBody: string[] = [];
  if (d.compactNodes) {
    for (const n of nodes) nodeBody.push(nodeLine(n, I));
  } else {
    nodes.forEach((n, i) => {
      if (i > 0) nodeBody.push("");
      nodeBody.push(...nodeBlock(n, st, I, d));
    });
  }
  out.push(...panel(`Nodes (${nodes.length})`, nodeBody, W));

  if (snap.fabric.links.length && d.secondary !== "none") {
    out.push("");
    const body = snap.fabric.links.flatMap((l) => linkLine(l, I));
    out.push(...panel("Interconnect", body, W, C.series3));
  }

  const endpoints = snap.nodes.flatMap((n) => n.inference ?? []);
  if (endpoints.length && d.secondary === "all") {
    const body: string[] = [];
    for (const e of endpoints) {
      if (!e.reachable) {
        body.push(`${C.critical("●")} ${bold(C.ink(`${e.nodeLabel}:${e.port}`))} ${dim("not responding")}`);
        continue;
      }
      const busy = (e.requestsRunning ?? 0) > 0;
      body.push(
        `${busy ? C.good("●") : dim("●")} ${bold(C.ink(padEnd(`${e.nodeLabel}:${e.port}`, 22)))}` +
          `${C.series1(padEnd(e.engineLabel, 12))}` +
          `${padStart(e.decodeTokensPerSec === null ? "-" : e.decodeTokensPerSec.toFixed(1), 7)} ${dim("tok/s")}  ` +
          `${dim("run")} ${e.requestsRunning ?? "-"}  ${dim("queue")} ${e.requestsWaiting ?? "-"}  ` +
          `${dim("served")} ${e.requestsFinishedTotal ?? "-"}` +
          (e.kvCachePct !== null ? `  ${dim("kv")} ${e.kvCachePct.toFixed(0)}%` : "")
      );
      if (e.models.length) body.push(dim(`    ${truncate(e.models.join(", "), I - 4)}`));
    }
    out.push("");
    out.push(...panel("Inference", body, W, C.series2));
  }

  if (snap.jobs.length && d.secondary === "all") {
    const body: string[] = [];
    for (const j of snap.jobs) {
      body.push(
        `${bold(C.ink(truncate(j.model ?? shortImage(j.image), 44)))}  ` +
          `${dim("ranks")} ${j.members.length}  ${dim("vram")} ${fmtBytes(j.totalVramBytes)}  ` +
          `${dim("traffic")} ${j.trafficGbps > 0.01 ? C.series3(fmtGbps(j.trafficGbps)) : dim("idle")}`
      );
      body.push(dim(`  ${j.members.map((m) => `${m.nodeLabel}${m.rank ? `#${m.rank}` : ""}`).join("  ")}`));
    }
    out.push("");
    out.push(...panel("Distributed workloads", body, W, C.series3));
  }
  // Alerts stay until the very last level: a warning is the one thing worth
  // the row it costs.
  if (snap.warnings.length && d.secondary !== "none") {
    out.push("");
    out.push(...warningLines(snap, W));
  }
  return out;
}

/**
 * One node on one line, for a window too short for anything else.
 *
 * Keeps the four figures that decide whether a machine is healthy and busy —
 * GPU, memory pressure, temperature, and whether the fabric is moving — and
 * drops everything that needs a second row to explain itself.
 */
function nodeLine(n: NodeSnapshot, W: number): string {
  const dot =
    n.status === "online" ? C.good("●") : n.status === "error" ? C.critical("●") : dim("●");
  if (n.status !== "online") {
    return `${dot} ${bold(C.ink(padEnd(truncate(n.label, 16), 17)))}${dim(truncate(n.error ?? "not connected", W - 20))}`;
  }
  const g = n.gpu;
  const vramPct = g ? pctOf(g.vramUsedBytes, g.vramTotalBytes) : 0;
  const gpuPct = g?.utilPct ?? 0;
  const fab = n.fabric.ports.reduce((a, p) => a + p.rdmaRxBps + p.tcpRxBps + p.rdmaTxBps + p.tcpTxBps, 0);

  /*
   * Sized against the width actually available rather than a fixed layout —
   * this line exists because the window is small, so truncating it would
   * defeat the point. The "gpu"/"vram" captions are the first thing to go,
   * since the bars are already in a known order.
   */
  const nameW = Math.max(10, Math.min(18, Math.floor(W * 0.22)));
  const labels = W >= 96;
  const fixed = 2 + nameW + 5 + 2 + 8 + 2 + 6 + 1 + 8 + 1 + 11 + (labels ? 9 : 0);
  const barW = Math.max(3, Math.min(14, Math.floor((W - fixed) / 2)));

  return (
    `${dot} ${bold(C.ink(padEnd(truncate(n.label, nameW - 1), nameW)))}` +
    `${labels ? dim("gpu ") : ""}${bar(gpuPct, barW, toneFor(gpuPct))}${padStart(`${gpuPct.toFixed(0)}%`, 5)}  ` +
    `${labels ? dim("vram ") : ""}${bar(vramPct, barW, toneFor(vramPct))}${padStart(fmtBytes(g?.vramUsedBytes ?? 0), 8)}  ` +
    `${tempTone(n.thermal.maxC)(padStart(fmtTemp(n.thermal.maxC), 6))} ` +
    `${dim(padStart(fmtWatts(g?.powerDrawW), 8))} ` +
    `${fab > 1e6 ? C.series3(padStart(fmtBps(fab), 11)) : dim(padStart("idle", 11))}`
  );
}

function nodeBlock(n: NodeSnapshot, st: RenderState, W: number, d: Detail): string[] {
  const statusDot =
    n.status === "online"
      ? C.good("●")
      : n.status === "error"
        ? C.critical("●")
        : n.status === "connecting"
          ? C.warning("●")
          : dim("●");

  const head =
    `${statusDot} ${bold(C.ink(n.label))} ${dim(n.host)}` +
    // Name the actual variant: in a mixed fleet "Ascent GX10" and
    // "ThinkStation PGX" are what distinguish otherwise identical machines.
    (n.info.isSpark ? ` ${C.series1(`[${n.info.variantName || "DGX Spark"}]`)}` : "") +
    dim(`  ${n.probeMs}ms`);

  if (n.status !== "online") {
    return [head, `  ${C.critical(truncate(n.error ?? "not connected", W - 2))}`];
  }

  const g = n.gpu;
  const vramPct = g ? pctOf(g.vramUsedBytes, g.vramTotalBytes) : 0;
  const memPct = pctOf(n.memory.usedBytes, n.memory.totalBytes);
  // Bars shrink on narrow terminals but never vanish.
  const bw = Math.max(8, Math.min(24, Math.floor((W - 46) / 2)));
  const sw = Math.max(0, Math.min(20, W - 74));

  const rows: [string, number, string, string][] = [
    ["GPU", g?.utilPct ?? 0, `${(g?.utilPct ?? 0).toFixed(0)}%`, "gpu"],
    ["VRAM", vramPct, `${fmtBytes(g?.vramUsedBytes ?? 0)}/${fmtBytes(g?.vramTotalBytes ?? 0)}`, "vram"],
    ["CPU", n.cpu.usagePct, `${n.cpu.usagePct.toFixed(0)}%`, "cpu"],
    ["MEM", memPct, `${fmtBytes(n.memory.usedBytes)}/${fmtBytes(n.memory.totalBytes)}`, "mem"],
  ];

  const out = [head];

  /*
   * Wide terminals get GPU and memory as filled gauges side by side, which is
   * the shape these two numbers deserve — they are the ones read from across
   * the room. Narrower ones keep the stacked bar rows, which carry the same
   * information in a quarter of the columns.
   */
  const gaugeW = Math.floor((W - 6) / 2);
  if (d.gauges && W >= 96) {
    const gh = 3;
    const gpuPct = g?.utilPct ?? 0;
    const left = [
      `${dim("GPU")} ${bold(toneFor(gpuPct)(`${gpuPct.toFixed(0)}%`))}` +
        dim(`  ${g?.smClockMhz ? `${g.smClockMhz} MHz  ` : ""}${fmtTemp(g?.temperatureC ?? null)}  ${fmtWatts(g?.powerDrawW)}`),
      ...gauge(gpuPct, gaugeW, gh, toneRgbFor(gpuPct)),
    ];
    const right = [
      `${dim("VRAM")} ${bold(toneFor(vramPct)(`${vramPct.toFixed(0)}%`))}` +
        dim(`  ${fmtBytes(g?.vramUsedBytes ?? 0)} / ${fmtBytes(g?.vramTotalBytes ?? 0)} unified`),
      ...gauge(vramPct, gaugeW, gh, toneRgbFor(vramPct)),
    ];
    out.push(...columns([{ lines: left, width: gaugeW }, { lines: right, width: gaugeW }], 2).map((l) => `  ${l}`));
    out.push("");
    // CPU and system memory stay as rows: they are context, not headline.
    for (const [label, pct, text, key] of rows.slice(2)) {
      const spark = sw > 0 ? dim(sparkline(st.history.get(`${n.id}:${key}`) ?? [], sw, 100)) : "";
      out.push(
        `  ${dim(padEnd(label, 5))}${bar(pct, bw, toneFor(pct))} ${padStart(`${pct.toFixed(0)}%`, 4)} ` +
          `${padEnd(dim(text), 26)}${spark}`
      );
    }
  } else {
    for (const [label, pct, text, key] of rows) {
      const spark = sw > 0 ? dim(sparkline(st.history.get(`${n.id}:${key}`) ?? [], sw, 100)) : "";
      out.push(
        `  ${dim(padEnd(label, 5))}${bar(pct, bw, toneFor(pct))} ${padStart(`${pct.toFixed(0)}%`, 4)} ` +
          `${padEnd(dim(text), 26)}${spark}`
      );
    }
  }

  /*
   * Per-core load.
   *
   * The averaged CPU percentage above cannot distinguish one pinned core from
   * every core at a tenth, and on a 20-core Spark that is usually the question
   * being asked. A labelled grid is preferred where it fits, since it names the
   * core and gives a number; the one-glyph-per-core row is the fallback for a
   * terminal too narrow for cells, and both are dropped below that.
   */
  const cores = n.cpu.perCorePct ?? [];
  if (d.coreGrid && cores.length) {
    const grid = coreGrid(cores, W - 2, toneFor, cores.length > 12 ? 4 : 2);
    if (grid.length) {
      out.push("");
      out.push(dim(`  ${cores.length} cores · peak ${Math.max(...cores).toFixed(0)}%`));
      out.push(...grid.map((l) => `  ${l}`));
    } else if (W > cores.length + 20) {
      out.push(
        `  ${dim(padEnd("CORE", 5))}${coreBars(cores, toneFor)} ` +
          dim(`${cores.length} cores · peak ${Math.max(...cores).toFixed(0)}%`)
      );
    }
    out.push("");
  }

  const fabRx = n.fabric.ports.reduce((a, p) => a + p.rdmaRxBps + p.tcpRxBps, 0);
  const fabTx = n.fabric.ports.reduce((a, p) => a + p.rdmaTxBps + p.tcpTxBps, 0);
  out.push(
    `  ${dim("temp")} ${tempTone(n.thermal.maxC)(fmtTemp(n.thermal.maxC))}  ` +
      `${dim("pwr")} ${fmtWatts(g?.powerDrawW)}  ` +
      `${dim("net")} ↓${C.series3(fmtBps(fabRx))} ↑${C.series2(fmtBps(fabTx))}  ` +
      `${dim("up")} ${fmtDuration(n.info.uptimeSec)}`
  );
  return out;
}

function linkLine(l: FabricLink, W: number): string[] {
  const status = l.faults > 0 ? C.critical(`⚠${l.faults}`) : l.confirmed ? C.good("✓") : C.warning("?");
  const flow = l.active ? C.series3("⇄") : dim("·");
  /*
   * Endpoint names take what is left after the figures, split evenly, rather
   * than a fixed 26 columns that overflows an 80-column terminal.
   */
  const tail = 10 + 1 + `/${l.rateGbps}G`.length + 2;
  const endW = Math.max(8, Math.min(26, Math.floor((W - tail - 12) / 2)));
  const bw = Math.max(4, Math.min(18, W - tail - endW * 2 - 8));
  return [
    `  ${padEnd(truncate(`${l.a.nodeLabel}:${l.a.netdev}`, endW), endW)} ${flow} ` +
      `${padEnd(truncate(`${l.b.nodeLabel}:${l.b.netdev}`, endW), endW)} ` +
      `${bar(l.utilPct, bw, toneFor(l.utilPct))} ` +
      `${padStart(fmtGbps(l.aToBGbps + l.bToAGbps), 10)} ${dim(`/${l.rateGbps}G`)} ${status}`,
  ];
}

function fabricView(snap: ClusterSnapshot, st: RenderState, W: number): string[] {
  const I = W - 4;
  const out: string[] = [];
  const links: string[] = [];
  if (!snap.fabric.links.length) {
    links.push(dim("No point-to-point links resolved."));
    links.push(dim("Links are inferred from ports sharing a subnet across two nodes."));
  }
  for (const l of snap.fabric.links) {
    if (links.length) links.push("");
    links.push(
      `${bold(C.ink(l.a.nodeLabel))} ${dim(l.a.netdev)} ${dim(l.a.address ?? "")} ` +
        `${C.series1("<->")} ${bold(C.ink(l.b.nodeLabel))} ${dim(l.b.netdev)} ${dim(l.b.address ?? "")}`
    );
    const bw = Math.max(10, Math.min(30, I - 44));
    const abPct = l.rateGbps > 0 ? (l.aToBGbps / l.rateGbps) * 100 : 0;
    const baPct = l.rateGbps > 0 ? (l.bToAGbps / l.rateGbps) * 100 : 0;
    links.push(`  ${dim("A→B")} ${bar(abPct, bw, C.series1)} ${padStart(fmtGbps(l.aToBGbps), 11)}`);
    links.push(`  ${dim("B→A")} ${bar(baPct, bw, C.series2)} ${padStart(fmtGbps(l.bToAGbps), 11)}`);
    links.push(
      `  ${dim("rate")} ${l.rateGbps}G  ${dim("state")} ${l.up ? C.good("up") : C.critical("down")}  ` +
        `${dim("verified")} ${l.confirmed ? C.good("yes") : C.warning("no")}  ` +
        `${dim("errors")} ${l.faults > 0 ? C.critical(String(l.faults)) : C.good("0")}  ` +
        `${dim("cnp")} ${l.congestionEvents}`
    );
  }
  out.push(...panel("Fabric links", links, W, C.series3));

  const ports: string[] = [];
  for (const n of snap.nodes) {
    if (n.status !== "online") continue;
    if (ports.length) ports.push("");
    ports.push(`${bold(C.ink(n.label))}`);
    for (const p of n.fabric.ports) {
      const state = p.linkUp ? C.good(padEnd("ACTIVE", 7)) : dim(padEnd(p.state, 7));
      ports.push(
        `  ${padEnd(p.netdev, 15)} ${padEnd(dim(p.ibdev ?? "-"), 15)} ${state} ` +
          `${padStart(`${p.rateGbps}G`, 5)} ${padEnd(dim(p.addresses[0] ?? "-"), 19)} ` +
          `↓${padStart(fmtBps(p.rdmaRxBps + p.tcpRxBps), 10)} ↑${padStart(fmtBps(p.rdmaTxBps + p.tcpTxBps), 10)} ` +
          `${dim(fmtTemp(p.tempC))}`
      );
    }
  }
  ports.push("");
  ports.push(dim("RX/TX come from the NIC's RDMA counters; RoCE bypasses the kernel stack,"));
  ports.push(dim("so /proc/net/dev under-reports these ports by orders of magnitude."));
  out.push("");
  out.push(...panel("Ports", ports, W));
  return out;
}

function processView(nodes: NodeSnapshot[], W: number): string[] {
  const out: string[] = [];
  out.push(
    dim(
      `${padEnd("NODE", 14)}${padEnd("PID", 8)}${padEnd("TYPE", 9)}${padStart("VRAM", 10)}  ` +
        `${padStart("CPU", 5)} ${padStart("RSS", 9)}  ${padEnd("PROCESS", 24)}CONTAINER`
    )
  );
  let any = false;
  for (const n of nodes) {
    if (n.status !== "online" || !n.gpu) continue;
    for (const p of n.gpu.processes) {
      any = true;
      const tone = p.type === "compute" ? C.series1 : C.muted;
      out.push(
        `${padEnd(truncate(n.label, 13), 14)}${padEnd(String(p.pid), 8)}` +
          `${padEnd(tone(p.type), 9)}${padStart(bold(fmtBytes(p.vramBytes)), 10)}  ` +
          `${padStart(p.cpuPct === undefined ? "-" : `${p.cpuPct.toFixed(0)}%`, 5)} ` +
          `${padStart(p.rssBytes ? fmtBytes(p.rssBytes) : "-", 9)}  ` +
          `${padEnd(truncate(p.name, 23), 24)}${dim(p.containerName ?? "host")}`
      );
    }
  }
  if (!any) out.push(dim("Nothing is holding GPU memory."));
  return panel("GPU processes", out, W);
}

function containerView(nodes: NodeSnapshot[], W: number): string[] {
  const out: string[] = [];
  let any = false;
  for (const n of nodes) {
    if (n.status !== "online") continue;
    if (!n.docker.available) {
      out.push(`${bold(C.ink(n.label))} ${dim("docker unavailable")}`);
      continue;
    }
    if (out.length) out.push("");
    out.push(`${bold(C.ink(n.label))}`);
    for (const c of n.docker.containers) {
      any = true;
      const dot = c.state === "running" ? C.good("●") : dim("●");
      out.push(
        `  ${dot} ${padEnd(truncate(c.name, 32), 33)}${padEnd(dim(truncate(shortImage(c.image), 34)), 35)}` +
          `${c.usesGpu ? C.series1(padStart(fmtBytes(c.gpuVramBytes ?? 0), 10)) : padStart("-", 10)}  ` +
          `${dim(truncate(c.status, 22))}`
      );
      if (c.distributed?.masterAddr) {
        out.push(
          dim(
            `    master ${c.distributed.masterAddr}` +
              (c.distributed.rank !== undefined ? `  rank ${c.distributed.rank}` : "") +
              (c.distributed.ncclIbHca ? `  hca ${c.distributed.ncclIbHca}` : "") +
              (c.distributed.ncclIbDisabled ? `  ${C.warning("RDMA DISABLED")}` : "")
          )
        );
      }
    }
  }
  if (!any) out.push(dim("No containers."));
  return panel("Containers", out, W);
}

function warningLines(snap: ClusterSnapshot, W: number): string[] {
  const out: string[] = [];
  const worst = snap.warnings.some((w) => w.severity === "error") ? C.critical : C.warning;
  for (const w of snap.warnings.slice(0, 6)) {
    const mark =
      w.severity === "error" ? C.critical("✕") : w.severity === "warn" ? C.warning("!") : C.series1("i");
    out.push(`${mark} ${bold(C.ink(truncate(w.title, W - 8)))}`);
    out.push(`  ${dim(truncate(w.detail, W - 8))}`);
  }
  return panel("Alerts", out, W, worst);
}

/** Bottom status bar with the key map. */
export function footer(st: RenderState, W: number, nodeCount: number): string {
  const key = (k: string, label: string, active = false): string =>
    `${active ? C.series1(bold(k)) : bold(k)}${dim(":" + label)}`;
  const parts = [
    key("o", "overview", st.view === "overview"),
    key("f", "fabric", st.view === "fabric"),
    key("p", "procs", st.view === "processes"),
    key("c", "ctrs", st.view === "containers"),
    key("←→", nodeCount > 1 ? (st.selected < 0 ? "all" : `node ${st.selected + 1}`) : "node"),
    key("space", st.paused ? "resume" : "pause"),
    key("q", "quit"),
  ];
  return truncate(dim(BOX.h.repeat(2)) + " " + parts.join(dim("  ")), W);
}
