/**
 * Cluster-level analysis: turning a set of independent node snapshots into a
 * picture of how the machines are wired together and what they are doing.
 *
 * The interesting work here is fabric topology. Nothing on a DGX Spark reports
 * "this port is connected to that machine" — each node only knows its own
 * ports. Pairing is inferred from IPv4 addressing (two ports on the same
 * subnet, on different nodes, are cabled together) and then *verified* against
 * traffic: on a real link, A's transmit counter and B's receive counter move
 * together. When they agree the link is reported as confirmed, which
 * distinguishes a genuine point-to-point cable from two ports that merely share
 * an address range.
 */

import { EventEmitter } from "node:events";
import { NodeCollector, IDLE_BPS_THRESHOLD } from "./node.ts";
import type {
  AppConfig,
  ClusterSnapshot,
  ClusterWarning,
  DistributedJob,
  FabricLink,
  FabricPort,
  FabricSummary,
  NodeConfig,
  NodeSnapshot,
} from "./types.ts";

const BYTES_TO_GBPS = 8 / 1e9;

/** Traffic below this (bytes/sec) reads as idle rather than active. */
const ACTIVE_THRESHOLD_BPS = IDLE_BPS_THRESHOLD;

/**
 * Tolerance for cross-checking the two ends of a link.
 *
 * The endpoints are polled independently and never at the same instant, so
 * their counters are sampled over windows that can be offset by most of a poll
 * interval. Agreement within 35% (or a small absolute floor) is treated as
 * corroboration; tighter than that produces false alarms every time traffic
 * ramps.
 */
const CONFIRM_RATIO = 0.35;
const CONFIRM_FLOOR_BPS = 2_000_000;

export interface ClusterMonitorEvents {
  snapshot: (s: ClusterSnapshot) => void;
}

export declare interface ClusterMonitor {
  on<K extends keyof ClusterMonitorEvents>(e: K, l: ClusterMonitorEvents[K]): this;
  emit<K extends keyof ClusterMonitorEvents>(e: K, ...a: Parameters<ClusterMonitorEvents[K]>): boolean;
}

export class ClusterMonitor extends EventEmitter {
  private collectors = new Map<string, NodeCollector>();
  private latest = new Map<string, NodeSnapshot>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapshot: ClusterSnapshot | null = null;

  constructor(private cfg: AppConfig) {
    super();
  }

  start(): void {
    for (const n of this.cfg.nodes) if (n.enabled) this.addCollector(n);
  }

  stop(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    for (const c of this.collectors.values()) c.stop();
    this.collectors.clear();
  }

  get snapshot(): ClusterSnapshot {
    return this.lastSnapshot ?? this.build();
  }

  addNode(cfg: NodeConfig): void {
    this.cfg.nodes = this.cfg.nodes.filter((n) => n.id !== cfg.id).concat(cfg);
    this.collectors.get(cfg.id)?.stop();
    this.collectors.delete(cfg.id);
    if (cfg.enabled) this.addCollector(cfg);
    this.scheduleEmit();
  }

  removeNode(id: string): boolean {
    const c = this.collectors.get(id);
    if (c) {
      c.stop();
      this.collectors.delete(id);
    }
    this.latest.delete(id);
    const before = this.cfg.nodes.length;
    this.cfg.nodes = this.cfg.nodes.filter((n) => n.id !== id);
    this.scheduleEmit();
    return this.cfg.nodes.length !== before || !!c;
  }

  get config(): AppConfig {
    return this.cfg;
  }

  private addCollector(cfg: NodeConfig): void {
    const c = new NodeCollector(cfg, { fastMs: this.cfg.fastIntervalMs, slowMs: this.cfg.slowIntervalMs });
    c.on("snapshot", (snap) => {
      this.latest.set(cfg.id, snap);
      this.scheduleEmit();
    });
    this.collectors.set(cfg.id, c);
    c.start();
  }

  /**
   * Coalesce per-node updates into one cluster broadcast.
   *
   * Nodes poll independently, so without this a four-node cluster would emit
   * four nearly identical snapshots per interval.
   */
  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const s = this.build();
      this.lastSnapshot = s;
      this.emit("snapshot", s);
    }, 50);
  }

  /**
   * Analysis state carried across snapshots.
   *
   * Holds which links have proven their pairing (proof that does not expire:
   * counters only agree while traffic flows) and which warnings are currently
   * raised, so thresholds can apply hysteresis instead of flapping.
   */
  private analysis = newAnalysisState();

  private build(): ClusterSnapshot {
    const nodes = this.cfg.nodes
      .map((n) => this.latest.get(n.id))
      .filter((n): n is NodeSnapshot => n !== undefined);
    return buildClusterSnapshot(nodes, this.analysis);
  }
}

// ---------------------------------------------------------------------------
// Pure analysis, exported for testing
// ---------------------------------------------------------------------------

/**
 * State carried between snapshots.
 *
 * Both members exist to stop findings from flickering: verification is proof
 * that does not expire, and threshold-based warnings need hysteresis so a
 * sensor sitting on the boundary does not toggle an alert every second.
 */
export interface AnalysisState {
  everConfirmed: Set<string>;
  activeWarnings: Set<string>;
}

export const newAnalysisState = (): AnalysisState => ({
  everConfirmed: new Set(),
  activeWarnings: new Set(),
});

export function buildClusterSnapshot(
  nodes: NodeSnapshot[],
  state: AnalysisState = newAnalysisState()
): ClusterSnapshot {
  const { links, sharedSegments } = pairFabricPorts(nodes);
  for (const l of links) {
    if (l.confirmed) state.everConfirmed.add(l.id);
    else if (state.everConfirmed.has(l.id)) l.confirmed = true;
  }
  const jobs = inferJobs(nodes, links);
  const fabric = summarizeFabric(nodes, links, sharedSegments);
  const warnings = buildWarnings(nodes, links, state);
  state.activeWarnings = new Set(warnings.map((w) => w.id));

  return { ts: Date.now(), nodes, fabric, jobs, warnings, totals: rollUp(nodes) };
}

interface PortRef {
  node: NodeSnapshot;
  port: FabricPort;
}

/**
 * Group fabric ports by subnet and pair them into links.
 *
 * A subnet holding exactly two ports on two different nodes is a direct
 * attach cable, which is the DGX Spark topology. A subnet holding more is a
 * switched segment: with a switch in the middle, per-peer traffic cannot be
 * attributed from NIC counters alone, so no pairwise link is invented — the
 * segment is reported separately and the ports still show their own throughput.
 */
export function pairFabricPorts(nodes: NodeSnapshot[]): {
  links: FabricLink[];
  sharedSegments: { subnet: string; members: PortRef[] }[];
} {
  const bySubnet = new Map<string, PortRef[]>();
  for (const node of nodes) {
    if (node.status !== "online") continue;
    for (const port of node.fabric.ports) {
      if (!port.subnet || !port.linkUp) continue;
      const list = bySubnet.get(port.subnet) ?? [];
      list.push({ node, port });
      bySubnet.set(port.subnet, list);
    }
  }

  const links: FabricLink[] = [];
  const sharedSegments: { subnet: string; members: PortRef[] }[] = [];

  for (const [subnet, members] of bySubnet) {
    const distinctNodes = new Set(members.map((m) => m.node.id));
    if (members.length !== 2 || distinctNodes.size !== 2) {
      if (members.length > 1) sharedSegments.push({ subnet, members });
      continue;
    }
    // Stable ordering so link ids do not flip between polls.
    const [a, b] = [...members].sort((x, y) => x.node.id.localeCompare(y.node.id)) as [PortRef, PortRef];
    links.push(buildLink(subnet, a, b));
  }

  links.sort((a, b) => a.id.localeCompare(b.id));
  return { links, sharedSegments };
}

function buildLink(subnet: string, a: PortRef, b: PortRef): FabricLink {
  const aTx = a.port.rdmaTxBps + a.port.tcpTxBps;
  const bRx = b.port.rdmaRxBps + b.port.tcpRxBps;
  const bTx = b.port.rdmaTxBps + b.port.tcpTxBps;
  const aRx = a.port.rdmaRxBps + a.port.tcpRxBps;

  // Each direction is observed twice: once as a transmit, once as a receive.
  const aToB = Math.max(aTx, bRx) * BYTES_TO_GBPS;
  const bToA = Math.max(bTx, aRx) * BYTES_TO_GBPS;
  const confirmed = agrees(aTx, bRx) && agrees(bTx, aRx);

  const rateGbps = Math.min(a.port.rateGbps || 0, b.port.rateGbps || 0) || a.port.rateGbps || b.port.rateGbps;
  const utilPct = rateGbps > 0 ? Math.min(100, Math.round((Math.max(aToB, bToA) / rateGbps) * 1000) / 10) : 0;

  return {
    id: `${a.node.id}:${a.port.netdev}<->${b.node.id}:${b.port.netdev}`,
    a: {
      nodeId: a.node.id,
      nodeLabel: a.node.label,
      netdev: a.port.netdev,
      ibdev: a.port.ibdev,
      address: a.port.addresses[0] ?? null,
    },
    b: {
      nodeId: b.node.id,
      nodeLabel: b.node.label,
      netdev: b.port.netdev,
      ibdev: b.port.ibdev,
      address: b.port.addresses[0] ?? null,
    },
    subnet,
    rateGbps,
    up: a.port.linkUp && b.port.linkUp,
    aToBGbps: round2(aToB),
    bToAGbps: round2(bToA),
    utilPct,
    active: Math.max(aTx, bRx, bTx, aRx) > ACTIVE_THRESHOLD_BPS,
    confirmed,
    faults: a.port.errors.totalFaults + b.port.errors.totalFaults,
    congestionEvents: a.port.errors.cnpSent + b.port.errors.cnpSent,
  };
}

/** Do two independently sampled counters describe the same traffic? */
function agrees(x: number, y: number): boolean {
  const hi = Math.max(x, y);
  if (hi < CONFIRM_FLOOR_BPS) return true; // Both effectively idle.
  return Math.abs(x - y) <= hi * CONFIRM_RATIO;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function summarizeFabric(
  nodes: NodeSnapshot[],
  links: FabricLink[],
  sharedSegments: { subnet: string; members: PortRef[] }[]
): FabricSummary {
  let totalCapacityGbps = 0;
  let totalTrafficGbps = 0;
  for (const l of links) {
    if (!l.up) continue;
    totalCapacityGbps += l.rateGbps * 2; // full duplex
    totalTrafficGbps += l.aToBGbps + l.bToAGbps;
  }
  let idlePorts = 0;
  let totalFaults = 0;
  for (const n of nodes) {
    for (const p of n.fabric.ports) {
      if (!p.linkUp) continue;
      totalFaults += p.errors.totalFaults;
      if (p.rdmaRxBps + p.rdmaTxBps + p.tcpRxBps + p.tcpTxBps < ACTIVE_THRESHOLD_BPS) idlePorts++;
    }
  }
  return {
    links,
    segments: sharedSegments.map((s) => ({
      subnet: s.subnet,
      members: s.members.map((m) => ({
        nodeId: m.node.id,
        nodeLabel: m.node.label,
        netdev: m.port.netdev,
      })),
    })),
    totalCapacityGbps: round2(totalCapacityGbps),
    totalTrafficGbps: round2(totalTrafficGbps),
    idlePorts,
    totalFaults,
  };
}

/**
 * Infer multi-node workloads.
 *
 * Containers running the same image on more than one node, or sharing a
 * rendezvous address, are treated as one distributed job. This is what turns
 * "two machines each running a container" into "one tensor-parallel job with
 * ranks on both machines".
 */
export function inferJobs(nodes: NodeSnapshot[], links: FabricLink[]): DistributedJob[] {
  const groups = new Map<string, DistributedJob>();

  for (const node of nodes) {
    for (const c of node.docker.containers) {
      if (c.state !== "running") continue;
      const d = c.distributed;
      // Group by rendezvous address when present, else by image.
      const key = d?.masterAddr && d.masterPort ? `${d.masterAddr}:${d.masterPort}` : `image:${c.image}`;
      let job = groups.get(key);
      if (!job) {
        job = {
          id: key,
          image: c.image,
          ...(d?.model ? { model: d.model } : {}),
          ...(d?.masterAddr ? { masterAddr: d.masterAddr } : {}),
          members: [],
          totalVramBytes: 0,
          linkIds: [],
          trafficGbps: 0,
        };
        groups.set(key, job);
      }
      job.members.push({
        nodeId: node.id,
        nodeLabel: node.label,
        containerId: c.id.slice(0, 12),
        containerName: c.name,
        ...(d?.rank ? { rank: d.rank } : {}),
      });
      job.totalVramBytes += c.gpuVramBytes ?? 0;
    }
  }

  const jobs: DistributedJob[] = [];
  for (const job of groups.values()) {
    // A job on a single node is not distributed and is shown with its node.
    if (new Set(job.members.map((m) => m.nodeId)).size < 2) continue;
    const nodeIds = new Set(job.members.map((m) => m.nodeId));
    const related = links.filter((l) => nodeIds.has(l.a.nodeId) && nodeIds.has(l.b.nodeId));
    job.linkIds = related.map((l) => l.id);
    job.trafficGbps = round2(related.reduce((a, l) => a + l.aToBGbps + l.bToAGbps, 0));
    jobs.push(job);
  }
  return jobs.sort((a, b) => b.trafficGbps - a.trafficGbps);
}

function buildWarnings(
  nodes: NodeSnapshot[],
  links: FabricLink[],
  state: AnalysisState
): ClusterWarning[] {
  const w: ClusterWarning[] = [];
  const add = (
    id: string,
    severity: ClusterWarning["severity"],
    title: string,
    detail: string,
    nodeIds: string[] = []
  ) => w.push({ id, severity, title, detail, nodeIds });

  /**
   * Threshold with hysteresis: a reading must pass `on` to raise the warning,
   * and fall back below `off` to clear it. Without this a sensor hovering at
   * the limit toggles an alert on and off every poll.
   */
  const crosses = (id: string, value: number, on: number, off: number): boolean =>
    state.activeWarnings.has(id) ? value >= off : value >= on;

  for (const n of nodes) {
    if (n.status === "error") {
      add(`node-error-${n.id}`, "error", `${n.label} unreachable`, n.error ?? "Unknown error", [n.id]);
    } else if (n.status === "offline") {
      add(`node-offline-${n.id}`, "warn", `${n.label} offline`, "No connection to this node.", [n.id]);
    }
    if (n.status !== "online") continue;

    /*
     * Temperature. A Spark under sustained load sits comfortably in the 80s, so
     * the bar is deliberately high: this fires for genuine thermal trouble, not
     * for a machine doing its job.
     */
    const tempId = `temp-${n.id}`;
    if (n.thermal.maxC !== null && crosses(tempId, n.thermal.maxC, 90, 87)) {
      add(tempId, n.thermal.maxC >= 97 ? "error" : "warn", `${n.label} running hot`,
        `Peak sensor at ${n.thermal.maxC.toFixed(1)}°C.`, [n.id]);
    }

    for (const d of n.disks) {
      const id = `disk-${n.id}-${d.mount}`;
      const pct = d.totalBytes > 0 ? (d.usedBytes / d.totalBytes) * 100 : 0;
      if (crosses(id, pct, 90, 88)) {
        add(id, pct >= 95 ? "error" : "warn", `${n.label}: ${d.mount} is ${pct.toFixed(0)}% full`,
          `${fmtBytes(d.availableBytes)} free of ${fmtBytes(d.totalBytes)}.`, [n.id]);
      }
    }

    if (n.gpu && n.gpu.vramTotalBytes > 0) {
      const id = `vram-${n.id}`;
      const pct = (n.gpu.vramUsedBytes / n.gpu.vramTotalBytes) * 100;
      if (crosses(id, pct, 95, 92)) {
        add(id, "warn", `${n.label}: GPU memory nearly full`,
          `${fmtBytes(n.gpu.vramUsedBytes)} of ${fmtBytes(n.gpu.vramTotalBytes)} in use (${pct.toFixed(0)}%).`, [n.id]);
      }
    }

    // A distributed container that turned RDMA off falls back to TCP and loses
    // most of the fabric's bandwidth. That is a real misconfiguration.
    for (const c of n.docker.containers) {
      if (c.state === "running" && c.distributed?.ncclIbDisabled) {
        add(`nccl-tcp-${n.id}-${c.id.slice(0, 12)}`, "warn", `${c.name} is not using RDMA`,
          "NCCL_IB_DISABLE=1, so collectives fall back to TCP over the fabric instead of RoCE.", [n.id]);
      }
    }
  }

  for (const l of links) {
    if (l.faults > 0) {
      add(`link-faults-${l.id}`, "warn", `Errors on ${l.a.nodeLabel} ↔ ${l.b.nodeLabel}`,
        `${l.faults} cumulative link/transport errors on ${l.a.netdev} / ${l.b.netdev}.`,
        [l.a.nodeId, l.b.nodeId]);
    }
  }

  // A port negotiating below its peers usually means a bad cable or a
  // downshifted lane.
  const rates = links.filter((l) => l.up).map((l) => l.rateGbps);
  if (rates.length > 1) {
    const best = Math.max(...rates);
    for (const l of links) {
      if (l.up && l.rateGbps < best) {
        add(`link-slow-${l.id}`, "warn", `${l.a.nodeLabel} ↔ ${l.b.nodeLabel} negotiated ${l.rateGbps}G`,
          `Other links in this cluster negotiated ${best}G. Check the cable or transceiver.`,
          [l.a.nodeId, l.b.nodeId]);
      }
    }
  }

  const order = { error: 0, warn: 1 };
  return w.sort((a, b) => order[a.severity] - order[b.severity]);
}


function rollUp(nodes: NodeSnapshot[]): ClusterSnapshot["totals"] {
  const online = nodes.filter((n) => n.status === "online");
  let vramTotal = 0, vramUsed = 0, cores = 0, cpuSum = 0, memTotal = 0, memUsed = 0, power = 0, containers = 0, gpus = 0;
  let maxTempC: number | null = null;
  let inferenceEndpoints = 0, tokensPerSec = 0, requestsRunning = 0, requestsWaiting = 0;
  for (const n of online) {
    for (const e of n.inference ?? []) {
      inferenceEndpoints++;
      tokensPerSec += e.generationTokensPerSec ?? 0;
      requestsRunning += e.requestsRunning ?? 0;
      requestsWaiting += e.requestsWaiting ?? 0;
    }
    if (n.gpu) {
      gpus++;
      vramTotal += n.gpu.vramTotalBytes;
      vramUsed += n.gpu.vramUsedBytes;
      if (n.gpu.powerDrawW) power += n.gpu.powerDrawW;
    }
    cores += n.cpu.cores;
    cpuSum += n.cpu.usagePct;
    memTotal += n.memory.totalBytes;
    memUsed += n.memory.usedBytes;
    containers += n.docker.containers.filter((c) => c.state === "running").length;
    if (n.thermal.maxC !== null) maxTempC = maxTempC === null ? n.thermal.maxC : Math.max(maxTempC, n.thermal.maxC);
  }
  return {
    nodes: nodes.length,
    nodesOnline: online.length,
    gpus,
    vramTotalBytes: vramTotal,
    vramUsedBytes: vramUsed,
    cpuCores: cores,
    cpuUsagePct: online.length ? Math.round((cpuSum / online.length) * 10) / 10 : 0,
    memTotalBytes: memTotal,
    memUsedBytes: memUsed,
    powerDrawW: Math.round(power * 10) / 10,
    maxTempC,
    containers,
    inferenceEndpoints,
    tokensPerSec: Math.round(tokensPerSec * 10) / 10,
    requestsRunning,
    requestsWaiting,
  };
}

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
