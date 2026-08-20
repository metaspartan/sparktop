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
import { BOX, C, bar, bold, dim, padEnd, padStart, rule, sparkline, tempTone, toneFor, truncate } from "./ansi.ts";

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

  const lines: string[] = [];
  lines.push(...header(snap, st, W));
  lines.push("");

  const nodes = st.selected >= 0 && snap.nodes[st.selected] ? [snap.nodes[st.selected]!] : snap.nodes;

  switch (st.view) {
    case "overview":
      lines.push(...overview(snap, nodes, st, W));
      break;
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

  if (snap.warnings.length && st.view === "overview") {
    lines.push("");
    lines.push(...warningLines(snap, W));
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
  ];
  return [line1, truncate(cells.join(dim("  ·  ")), W)];
}

const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function overview(snap: ClusterSnapshot, nodes: NodeSnapshot[], st: RenderState, W: number): string[] {
  const out: string[] = [rule("Nodes", W)];
  for (const n of nodes) {
    out.push(...nodeBlock(n, st, W));
    out.push("");
  }
  if (snap.fabric.links.length) {
    out.push(rule("Interconnect", W));
    for (const l of snap.fabric.links) out.push(...linkLine(l, W));
  }
  if (snap.jobs.length) {
    out.push("");
    out.push(rule("Distributed workloads", W));
    for (const j of snap.jobs) {
      out.push(
        `  ${bold(C.ink(truncate(j.model ?? shortImage(j.image), 44)))}  ` +
          `${dim("ranks")} ${j.members.length}  ${dim("vram")} ${fmtBytes(j.totalVramBytes)}  ` +
          `${dim("traffic")} ${j.trafficGbps > 0.01 ? C.series3(fmtGbps(j.trafficGbps)) : dim("idle")}`
      );
      out.push(dim(`    ${j.members.map((m) => `${m.nodeLabel}${m.rank ? `#${m.rank}` : ""}`).join("  ")}`));
    }
  }
  return out;
}

function nodeBlock(n: NodeSnapshot, st: RenderState, W: number): string[] {
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
  for (const [label, pct, text, key] of rows) {
    const spark = sw > 0 ? dim(sparkline(st.history.get(`${n.id}:${key}`) ?? [], sw, 100)) : "";
    out.push(
      `  ${dim(padEnd(label, 5))}${bar(pct, bw, toneFor(pct))} ${padStart(`${pct.toFixed(0)}%`, 4)} ` +
        `${padEnd(dim(text), 26)}${spark}`
    );
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
  const bw = Math.max(6, Math.min(18, W - 62));
  const status = l.faults > 0 ? C.critical(`⚠${l.faults}`) : l.confirmed ? C.good("✓") : C.warning("?");
  const flow = l.active ? C.series3("⇄") : dim("·");
  return [
    `  ${padEnd(truncate(`${l.a.nodeLabel}:${l.a.netdev}`, 26), 26)} ${flow} ` +
      `${padEnd(truncate(`${l.b.nodeLabel}:${l.b.netdev}`, 26), 26)} ` +
      `${bar(l.utilPct, bw, toneFor(l.utilPct))} ` +
      `${padStart(fmtGbps(l.aToBGbps + l.bToAGbps), 10)} ${dim(`/${l.rateGbps}G`)} ${status}`,
  ];
}

function fabricView(snap: ClusterSnapshot, st: RenderState, W: number): string[] {
  const out: string[] = [rule("Fabric links", W)];
  if (!snap.fabric.links.length) {
    out.push(dim("  No point-to-point links resolved."));
    out.push(dim("  Links are inferred from ports sharing a subnet across two nodes."));
  }
  for (const l of snap.fabric.links) {
    out.push("");
    out.push(
      `  ${bold(C.ink(l.a.nodeLabel))} ${dim(l.a.netdev)} ${dim(l.a.address ?? "")} ` +
        `${C.series1("<->")} ${bold(C.ink(l.b.nodeLabel))} ${dim(l.b.netdev)} ${dim(l.b.address ?? "")}`
    );
    const bw = Math.max(10, Math.min(30, W - 44));
    const abPct = l.rateGbps > 0 ? (l.aToBGbps / l.rateGbps) * 100 : 0;
    const baPct = l.rateGbps > 0 ? (l.bToAGbps / l.rateGbps) * 100 : 0;
    out.push(`    ${dim("A→B")} ${bar(abPct, bw, C.series1)} ${padStart(fmtGbps(l.aToBGbps), 11)}`);
    out.push(`    ${dim("B→A")} ${bar(baPct, bw, C.series2)} ${padStart(fmtGbps(l.bToAGbps), 11)}`);
    out.push(
      `    ${dim("rate")} ${l.rateGbps}G  ${dim("state")} ${l.up ? C.good("up") : C.critical("down")}  ` +
        `${dim("verified")} ${l.confirmed ? C.good("yes") : C.warning("no")}  ` +
        `${dim("errors")} ${l.faults > 0 ? C.critical(String(l.faults)) : C.good("0")}  ` +
        `${dim("cnp")} ${l.congestionEvents}`
    );
  }

  out.push("");
  out.push(rule("Ports", W));
  for (const n of snap.nodes) {
    if (n.status !== "online") continue;
    out.push(`  ${bold(C.ink(n.label))}`);
    for (const p of n.fabric.ports) {
      const state = p.linkUp ? C.good(padEnd("ACTIVE", 7)) : dim(padEnd(p.state, 7));
      out.push(
        `    ${padEnd(p.netdev, 15)} ${padEnd(dim(p.ibdev ?? "-"), 15)} ${state} ` +
          `${padStart(`${p.rateGbps}G`, 5)} ${padEnd(dim(p.addresses[0] ?? "-"), 19)} ` +
          `↓${padStart(fmtBps(p.rdmaRxBps + p.tcpRxBps), 10)} ↑${padStart(fmtBps(p.rdmaTxBps + p.tcpTxBps), 10)} ` +
          `${dim(fmtTemp(p.tempC))}`
      );
    }
  }
  out.push("");
  out.push(
    dim("  RX/TX come from the NIC's RDMA counters; RoCE bypasses the kernel stack,")
  );
  out.push(dim("  so /proc/net/dev under-reports these ports by orders of magnitude."));
  return out;
}

function processView(nodes: NodeSnapshot[], W: number): string[] {
  const out: string[] = [rule("GPU processes", W)];
  out.push(
    dim(
      `  ${padEnd("NODE", 14)}${padEnd("PID", 8)}${padEnd("TYPE", 9)}${padStart("VRAM", 10)}  ` +
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
        `  ${padEnd(truncate(n.label, 13), 14)}${padEnd(String(p.pid), 8)}` +
          `${padEnd(tone(p.type), 9)}${padStart(bold(fmtBytes(p.vramBytes)), 10)}  ` +
          `${padStart(p.cpuPct === undefined ? "-" : `${p.cpuPct.toFixed(0)}%`, 5)} ` +
          `${padStart(p.rssBytes ? fmtBytes(p.rssBytes) : "-", 9)}  ` +
          `${padEnd(truncate(p.name, 23), 24)}${dim(p.containerName ?? "host")}`
      );
    }
  }
  if (!any) out.push(dim("  Nothing is holding GPU memory."));
  return out;
}

function containerView(nodes: NodeSnapshot[], W: number): string[] {
  const out: string[] = [rule("Containers", W)];
  let any = false;
  for (const n of nodes) {
    if (n.status !== "online") continue;
    if (!n.docker.available) {
      out.push(`  ${bold(C.ink(n.label))} ${dim("docker unavailable")}`);
      continue;
    }
    out.push(`  ${bold(C.ink(n.label))}`);
    for (const c of n.docker.containers) {
      any = true;
      const dot = c.state === "running" ? C.good("●") : dim("●");
      out.push(
        `    ${dot} ${padEnd(truncate(c.name, 32), 33)}${padEnd(dim(truncate(shortImage(c.image), 34)), 35)}` +
          `${c.usesGpu ? C.series1(padStart(fmtBytes(c.gpuVramBytes ?? 0), 10)) : padStart("-", 10)}  ` +
          `${dim(truncate(c.status, 22))}`
      );
      if (c.distributed?.masterAddr) {
        out.push(
          dim(
            `      master ${c.distributed.masterAddr}` +
              (c.distributed.rank !== undefined ? `  rank ${c.distributed.rank}` : "") +
              (c.distributed.ncclIbHca ? `  hca ${c.distributed.ncclIbHca}` : "") +
              (c.distributed.ncclIbDisabled ? `  ${C.warning("RDMA DISABLED")}` : "")
          )
        );
      }
    }
  }
  if (!any) out.push(dim("  No containers."));
  return out;
}

function warningLines(snap: ClusterSnapshot, W: number): string[] {
  const out = [rule("Alerts", W)];
  for (const w of snap.warnings.slice(0, 6)) {
    const mark =
      w.severity === "error" ? C.critical("✕") : w.severity === "warn" ? C.warning("!") : C.series1("i");
    out.push(`  ${mark} ${bold(C.ink(truncate(w.title, W - 6)))}`);
    out.push(`    ${dim(truncate(w.detail, W - 6))}`);
  }
  return out;
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
