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

  /** The live collector for a node, used to route control operations. */
  collector(nodeId: string): NodeCollector | undefined {
    return this.collectors.get(nodeId);
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

  private lastEmit = 0;

  /**
   * Coalesce per-node updates into one cluster broadcast, at a bounded rate.
   *
   * Nodes poll independently and their phases drift apart, so a short debounce
   * only merges the polls that happen to coincide: measured on two nodes it
   * still produced 1.7 broadcasts a second, and the rate grows with the node
   * count. Each broadcast is the whole cluster — about 10 KB per node — sent to
   * every connected client, so an eight-node fleet would have pushed better
   * than half a megabyte a second at each open browser tab.
   *
   * A floor on the gap between broadcasts fixes the rate at roughly one per
   * poll interval however many nodes there are. Nothing is lost: the next
   * broadcast carries the newest reading from every node, and a dashboard
   * refreshing at 1Hz has no use for four versions of the same second.
   */
  private scheduleEmit(): void {
    if (this.emitTimer) return;
    // Just under the poll interval, so a steady 1Hz cluster emits every poll
    // rather than skipping one and appearing to stutter.
    const minGap = Math.max(50, (this.cfg.fastIntervalMs ?? 1000) * 0.9);
    const wait = Math.max(50, this.lastEmit + minGap - Date.now());
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.lastEmit = Date.now();
      const s = this.build();
      this.lastSnapshot = s;
      this.emit("snapshot", s);
    }, wait);
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

  /*
   * A link runs at the pace of its slower end, and each end is capped by what
   * its NIC can push across PCIe rather than by the rate it advertises. Using
   * the advertised rate here is what made a Spark pair read as 800 Gb/s of
   * capacity when the hardware tops out near 200.
   */
  const effA = a.port.effectiveRateGbps || a.port.rateGbps || 0;
  const effB = b.port.effectiveRateGbps || b.port.rateGbps || 0;
  const rateGbps = Math.min(effA, effB) || effA || effB;
  const signalledRateGbps =
    Math.min(a.port.rateGbps || 0, b.port.rateGbps || 0) || a.port.rateGbps || b.port.rateGbps;
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
    signalledRateGbps,
    pcieLimited: a.port.pcieLimited || b.port.pcieLimited,
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
    /*
     * One direction, not both summed.
     *
     * Doubling for duplex and using the advertised port rate together
     * overstated a Spark pair by 4x — 800 Gb/s against hardware that peaks near
     * 200. Capacity is now the usable one-way rate, and traffic is the busier
     * direction, so the two are directly comparable and "X of Y" means
     * something.
     */
    totalCapacityGbps += l.rateGbps;
    totalTrafficGbps += Math.max(l.aToBGbps, l.bToAGbps);
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
     * Temperature, judged per sensor rather than against one global number.
     *
     * A Spark's sensors have very different limits: NVMe reports a critical
     * point near 85°C while the ConnectX-7 ASICs report 105°C. Comparing the
     * hottest reading in the machine to a single threshold therefore either
     * cries wolf over a NIC doing exactly what it should, or stays silent while
     * an SSD cooks. Each sensor is scored against its own critical point where
     * firmware reports one, and against a limit chosen for its kind where it
     * does not.
     */
    const FALLBACK_LIMIT: Record<string, number> = { soc: 100, gpu: 100, nvme: 85, nic: 105, wifi: 100, other: 100 };
    let worst: { sensor: (typeof n.thermal.sensors)[number]; limit: number; ratio: number } | null = null;
    for (const sensor of n.thermal.sensors) {
      const limit = sensor.critC ?? FALLBACK_LIMIT[sensor.kind] ?? 100;
      const ratio = sensor.tempC / limit;
      if (!worst || ratio > worst.ratio) worst = { sensor, limit, ratio };
    }
    const tempId = `temp-${n.id}`;
    // 92% of the limit is close enough to matter; 98% is imminent.
    if (worst && crosses(tempId, worst.ratio * 100, 92, 89)) {
      add(tempId, worst.ratio >= 0.98 ? "error" : "warn", `${n.label} running hot`,
        `${worst.sensor.label} at ${worst.sensor.tempC.toFixed(1)}°C of ${worst.limit.toFixed(0)}°C ` +
          `(${(worst.ratio * 100).toFixed(0)}% of its limit).`,
        [n.id]);
    }

    for (const d of n.disks) {
      const id = `disk-${n.id}-${d.mount}`;
      const pct = d.totalBytes > 0 ? (d.usedBytes / d.totalBytes) * 100 : 0;
      if (crosses(id, pct, 90, 88)) {
        add(id, pct >= 95 ? "error" : "warn", `${n.label}: ${d.mount} is ${pct.toFixed(0)}% full`,
          `${fmtBytes(d.availableBytes)} free of ${fmtBytes(d.totalBytes)}.`, [n.id]);
      }
    }

    /*
     * GPU clocked far below its ceiling while working, with nothing claiming
     * responsibility.
     *
     * GB10 parts have a known fault where the USB-C power-delivery negotiation
     * ends up in a state that leaves the GPU pinned to a low clock. It is
     * unusually hard to notice: utilisation still reads high, the power state
     * still reads P0, and NVML reports no throttle reason at all — the only
     * outward sign is that everything runs at roughly half speed. Detecting it
     * needs all four facts together, because each on its own is ordinary:
     * a low clock alone is an idle GPU, low power alone is a light workload,
     * and a real thermal or power cap announces itself in the throttle mask.
     */
    const g: NodeSnapshot["gpu"] = n.gpu;
    if (g && g.smClockMhz !== null && g.smClockMaxMhz !== null && g.smClockMaxMhz > 0) {
      const clockPct = (g.smClockMhz / g.smClockMaxMhz) * 100;
      const declared = g.throttleReasons?.reasons.filter((r) => r !== "idle") ?? [];
      const busy = g.utilPct >= 50;
      const cool = g.temperatureC === null || g.temperatureC < 80;
      const lowPower = g.powerDrawW !== null && g.powerDrawW < 35;
      const id = `gpu-clock-${n.id}`;

      // Clears at 55% rather than 45% so a part hovering near the line does not
      // toggle the alert every poll.
      if (busy && cool && lowPower && declared.length === 0 && crosses(id, 100 - clockPct, 55, 45)) {
        add(
          id,
          "error",
          `${n.label}: GPU stuck at low clock`,
          `SM clock ${g.smClockMhz} MHz of ${g.smClockMaxMhz} MHz (${clockPct.toFixed(0)}%) at ` +
            `${g.utilPct.toFixed(0)}% utilisation, drawing ${g.powerDrawW?.toFixed(1)} W, with no throttle ` +
            `reason reported and the part at ${g.temperatureC?.toFixed(0) ?? "?"}°C. On GB10 this is the ` +
            `signature of a USB-C power-delivery negotiation fault, which halves inference throughput. ` +
            `Check for firmware updates (fwupdmgr refresh --force && fwupdmgr get-upgrades); if none apply, ` +
            `a full power disconnect of the brick from both wall and device is the reported recovery.`,
          [n.id]
        );
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
  /*
   * Guard against counting one server twice.
   *
   * Summing per endpoint is right for the common topologies: in tensor-parallel
   * only rank 0 runs an API server, and data-parallel replicas each have their
   * own independent counters. It is wrong when the same server is reachable
   * twice — behind a proxy, or bound to two ports — where both would report
   * byte-identical cumulative totals. Identical model list *and* identical
   * lifetime token count is not a coincidence, so those fold into one.
   */
  const countedServices = new Set<string>();
  for (const n of online) {
    for (const e of n.inference ?? []) {
      inferenceEndpoints++;
      const fingerprint =
        e.generationTokensTotal !== null
          ? `${[...e.models].sort().join("|")}@${e.generationTokensTotal}@${e.requestsFinishedTotal ?? ""}`
          : `${e.id}`;
      if (countedServices.has(fingerprint)) continue;
      countedServices.add(fingerprint);
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
