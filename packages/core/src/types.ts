import type { EngineId } from "./inference.ts";
import type { SparkVariantId } from "./variants.ts";

/**
 * Shared data model for sparktop.
 *
 * Everything the collectors produce and the server broadcasts is described here.
 * All byte counts are bytes, all rates are bytes/sec unless the field name says
 * otherwise, all temperatures are degrees Celsius.
 */

export type NodeStatus = "online" | "offline" | "connecting" | "error";

/** How to reach a node over SSH. */
export interface NodeConfig {
  id: string;
  /** Display name. Defaults to the discovered hostname. */
  label?: string;
  host: string;
  port: number;
  username: string;
  /** Path to a private key on the sparktop host. Preferred over a password. */
  privateKeyPath?: string;
  /** Passphrase for the private key, if any. Stored encrypted. */
  passphraseEnc?: string;
  /** AES-256-GCM encrypted password, used only when no key is configured. */
  passwordEnc?: string;
  /** Poll interval override in ms for the fast metric tier. */
  intervalMs?: number;
  enabled: boolean;
  addedAt: number;
}

export interface AppConfig {
  nodes: NodeConfig[];
  /** Fast tier: GPU, CPU, memory, fabric counters. */
  fastIntervalMs: number;
  /** Slow tier: docker, disks, interface addressing, hardware inventory. */
  slowIntervalMs: number;
  /** Samples retained per series in the in-memory history ring buffer. */
  historySize: number;
}

// ---------------------------------------------------------------------------
// Per-node metrics
// ---------------------------------------------------------------------------

export interface CpuMetrics {
  cores: number;
  model: string;
  /** Aggregate busy percentage across all cores, 0-100. */
  usagePct: number;
  /** Per-core busy percentage, 0-100. */
  perCorePct: number[];
  loadAvg: [number, number, number];
  freqMhz: number;
  /** Number of running/total processes from /proc/loadavg. */
  procsRunning: number;
  procsTotal: number;
}

export interface MemoryMetrics {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  freeBytes: number;
  cachedBytes: number;
  buffersBytes: number;
  sharedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export type GpuProcessType = "compute" | "graphics";

export interface GpuProcess {
  pid: number;
  name: string;
  type: GpuProcessType;
  /** VRAM held by this process. On unified-memory parts this is the GPU
   *  allocation as reported by NVML, not the process RSS. */
  vramBytes: number;
  user?: string;
  cpuPct?: number;
  rssBytes?: number;
  /** Elapsed wall time, seconds. */
  elapsedSec?: number;
  command?: string;
  /** Short docker container id, when the pid belongs to a container. */
  containerId?: string;
  containerName?: string;
}

export interface GpuMetrics {
  name: string;
  uuid: string;
  driverVersion: string;
  cudaVersion: string;
  /** GB10 and other unified-memory parts share one pool with the CPU. */
  unifiedMemory: boolean;
  utilPct: number;
  /** NVML memory-controller utilization. Often unavailable on GB10. */
  memUtilPct: number | null;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
  smClockMhz: number | null;
  /** Total VRAM. On unified parts this is the shared system pool. */
  vramTotalBytes: number;
  /** VRAM in use. On unified parts this is summed from live NVML processes,
   *  because NVML reports FB usage as N/A. */
  vramUsedBytes: number;
  /** True when vramUsedBytes was derived from process accounting rather than
   *  read directly from NVML. */
  vramUsedIsDerived: boolean;
  processes: GpuProcess[];
}

export interface ThermalSensor {
  /** Stable identifier, e.g. "mlx5:0" or "acpitz:temp3". */
  id: string;
  label: string;
  /** hwmon directory this came from, e.g. "hwmon2". Used to attach NIC
   *  temperatures to the specific fabric port that owns the chip. */
  source?: string;
  /** Coarse grouping used for display and for picking the headline temp. */
  kind: "soc" | "gpu" | "nvme" | "nic" | "wifi" | "other";
  tempC: number;
  critC?: number;
}

export interface DiskMetrics {
  mount: string;
  device: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  createdAt: number;
  /** Present when `docker stats` succeeded. */
  cpuPct?: number;
  memUsedBytes?: number;
  memLimitBytes?: number;
  networkMode?: string;
  /** True when this container has a process holding GPU memory. */
  usesGpu?: boolean;
  gpuVramBytes?: number;
  /** Selected NCCL / distributed-runtime environment, used for job inference. */
  distributed?: DistributedHints;
}

export interface DistributedHints {
  masterAddr?: string;
  masterPort?: string;
  /** Interface NCCL was told to use, e.g. enp1s0f1np1. */
  ncclSocketIfname?: string;
  /** RDMA device NCCL was told to use, e.g. rocep1s0f1. */
  ncclIbHca?: string;
  ncclIbDisabled?: boolean;
  /**
   * NCCL_IB_MERGE_NICS. On GB10 a single QSFP cable presents as two RDMA
   * interfaces of roughly 100 Gb/s each, and merging them is what allows a
   * collective to use the full ~200 Gb/s of the link.
   */
  ncclIbMergeNics?: boolean;
  worldSize?: string;
  rank?: string;
  /** Model identifier, when the container advertises one. */
  model?: string;
}

/** A network interface as seen by the kernel. */
export interface NetInterface {
  name: string;
  mac: string;
  up: boolean;
  carrier: boolean;
  /** Link speed in Mb/s from ethtool, when known. */
  speedMbps: number | null;
  addresses: string[];
  rxBytes: number;
  txBytes: number;
  rxBps: number;
  txBps: number;
  /** True for the ConnectX-7 ports that make up the Spark interconnect. */
  isFabric: boolean;
}

/**
 * One ConnectX-7 port participating in the Spark interconnect.
 *
 * The important detail: NCCL moves data over RoCE, which bypasses the kernel
 * network stack entirely. /proc/net/dev on these interfaces reports only the
 * handful of TCP bootstrap bytes, while the actual multi-hundred-gigabyte
 * transfers show up exclusively in the NIC's RDMA vport counters. sparktop
 * reads both and reports RDMA as the primary throughput number.
 */
export interface FabricPort {
  /** Kernel netdev name, e.g. enp1s0f1np1. */
  netdev: string;
  /** RDMA device name, e.g. rocep1s0f1. */
  ibdev: string | null;
  mac: string;
  state: string;
  physState: string;
  linkUp: boolean;
  /**
   * Signalling rate the RDMA subsystem reports for this port, Gb/s.
   *
   * Not the same as achievable throughput. A GB10 advertises 200 Gb/sec here
   * while the port sits behind a PCIe Gen5 x4 link that cannot carry half of
   * it — use `effectiveRateGbps` for anything the operator will read as
   * capacity.
   */
  rateGbps: number;
  /** Human label from the RDMA subsystem, e.g. "200 Gb/sec (2X NDR)". */
  rateLabel: string;
  /** Usable throughput of the PCIe link behind this NIC, Gb/s. */
  pcieCeilingGbps: number | null;
  /** The lower of the port rate and the PCIe ceiling: what this port can do. */
  effectiveRateGbps: number;
  /** True when PCIe, not the wire, is the binding constraint. */
  pcieLimited: boolean;
  addresses: string[];
  /** IPv4 /24-style network key used to pair ports across nodes. */
  subnet: string | null;

  /** Cumulative RDMA bytes received/transmitted on this port. */
  rdmaRxBytes: number;
  rdmaTxBytes: number;
  /** Cumulative non-RDMA (kernel stack) bytes. */
  tcpRxBytes: number;
  tcpTxBytes: number;

  /** Instantaneous RDMA throughput, bytes/sec. */
  rdmaRxBps: number;
  rdmaTxBps: number;
  /** Instantaneous kernel-stack throughput, bytes/sec. */
  tcpRxBps: number;
  tcpTxBps: number;

  /** RDMA throughput as a percentage of rateGbps, per direction. */
  rxUtilPct: number;
  txUtilPct: number;

  tempC: number | null;
  errors: FabricErrors;
}

/** Error and congestion counters that matter for RoCE health. */
export interface FabricErrors {
  /** Cumulative values. */
  portRcvErrors: number;
  portXmitDiscards: number;
  linkDowned: number;
  linkErrorRecovery: number;
  symbolErrors: number;
  /** RoCE-specific congestion / retransmit counters. */
  outOfSequence: number;
  packetSeqErr: number;
  outOfBuffer: number;
  rnrNakRetryErr: number;
  reqTransportRetriesExceeded: number;
  localAckTimeoutErr: number;
  /** ECN congestion notification counters. */
  cnpSent: number;
  cnpHandled: number;
  ecnMarked: number;
  /** Sum of everything above that indicates a genuine fault (not congestion). */
  totalFaults: number;
  /** Change in totalFaults since the previous sample. */
  faultsDelta: number;
}

export interface HostInfo {
  hostname: string;
  osPretty: string;
  kernel: string;
  arch: string;
  /** DMI product_name, e.g. "GX10". */
  product: string | null;
  /** DMI sys_vendor, e.g. "ASUSTeK COMPUTER INC.". */
  sysVendor: string | null;
  /** DMI product_family — "DGX Spark" on every variant. */
  productFamily: string | null;
  /** True when DMI identifies this as a DGX Spark, whoever built the chassis. */
  isSpark: boolean;
  /** Which of the eight GB10 variants this is. */
  variant: SparkVariantId;
  /** Full product name for the variant, e.g. "ASUS Ascent GX10". */
  variantName: string;
  /** Manufacturer, normalised for display, e.g. "ASUS". */
  vendor: string;
  uptimeSec: number;
  bootTime: number;
}

/**
 * An inference server found on a node.
 *
 * Cumulative token counters are kept alongside their derived rates so a client
 * that reconnects can still compute its own deltas, and so the rate can be
 * shown as unavailable rather than zero on the first sample.
 */
export interface InferenceEndpoint {
  /** `${nodeId}:${port}`. */
  id: string;
  nodeId: string;
  nodeLabel: string;
  port: number;
  engine: EngineId;
  engineLabel: string;
  /** Models the server reports serving. */
  models: string[];
  reachable: boolean;

  requestsRunning: number | null;
  requestsWaiting: number | null;
  requestsFinishedTotal: number | null;
  promptTokensTotal: number | null;
  generationTokensTotal: number | null;
  kvCachePct: number | null;

  /** Derived from cumulative counters over measured wall time. */
  generationTokensPerSec: number | null;
  promptTokensPerSec: number | null;
  requestsPerMin: number | null;

  /** Container serving this port, when it could be attributed. */
  containerName?: string;
}

export interface NodeSnapshot {
  id: string;
  label: string;
  host: string;
  status: NodeStatus;
  error: string | null;
  /** Wall-clock ms when this snapshot was assembled. */
  ts: number;
  /** Round-trip time of the last probe, ms. */
  probeMs: number;

  info: HostInfo;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  gpu: GpuMetrics | null;
  thermal: { sensors: ThermalSensor[]; maxC: number | null };
  disks: DiskMetrics[];
  docker: { available: boolean; containers: DockerContainer[] };
  network: { interfaces: NetInterface[] };
  fabric: { ports: FabricPort[] };
  inference: InferenceEndpoint[];
}

// ---------------------------------------------------------------------------
// Cluster-level views
// ---------------------------------------------------------------------------

export interface FabricLinkEndpoint {
  nodeId: string;
  nodeLabel: string;
  netdev: string;
  ibdev: string | null;
  address: string | null;
}

/**
 * A resolved point-to-point connection between two nodes.
 *
 * Direction naming: `aToBGbps` is traffic leaving A and arriving at B. Both
 * endpoints are polled, so the value is cross-checked against A's tx counter
 * and B's rx counter; `confirmed` is true when the two agree, which proves the
 * pairing is real rather than inferred from addressing alone.
 */
export interface FabricLink {
  id: string;
  a: FabricLinkEndpoint;
  b: FabricLinkEndpoint;
  subnet: string;
  /**
   * Per-direction capability of this link, Gb/s — the lower of what the two
   * ports can each actually move, not what they advertise.
   */
  rateGbps: number;
  /** Signalling rate advertised by the ports, kept for reference. */
  signalledRateGbps: number;
  /** True when PCIe limits this link below its advertised rate. */
  pcieLimited: boolean;
  up: boolean;
  aToBGbps: number;
  bToAGbps: number;
  /** Highest of the two directions as a fraction of rateGbps, 0-100. */
  utilPct: number;
  /** True when throughput exceeds the idle threshold. */
  active: boolean;
  /**
   * True once both endpoints' counters have corroborated each other, proving
   * these ports are genuinely cabled together rather than merely sharing a
   * subnet. Sticky: counters can only agree while traffic flows, so this stays
   * true once established.
   */
  confirmed: boolean;
  faults: number;
  congestionEvents: number;
}

export type WarningSeverity = "warn" | "error";

export interface ClusterWarning {
  id: string;
  severity: WarningSeverity;
  title: string;
  detail: string;
  nodeIds: string[];
}

/**
 * A workload inferred to be running across more than one node, detected by
 * matching container images plus shared NCCL/torch rendezvous settings.
 */
export interface DistributedJob {
  id: string;
  image: string;
  model?: string;
  masterAddr?: string;
  members: { nodeId: string; nodeLabel: string; containerId: string; containerName: string; rank?: string }[];
  totalVramBytes: number;
  /** Fabric links this job's rendezvous address maps onto. */
  linkIds: string[];
  /** Aggregate traffic across those links, Gb/s. */
  trafficGbps: number;
}

/**
 * A subnet carrying more than two ports, i.e. a switch rather than a direct
 * cable. Traffic there cannot be attributed to a specific peer from NIC
 * counters, so no pairwise link is inferred; this is reported alongside the
 * links so the UI can say why those ports have no partner.
 */
export interface FabricSegment {
  subnet: string;
  members: { nodeId: string; nodeLabel: string; netdev: string }[];
}

export interface FabricSummary {
  links: FabricLink[];
  segments: FabricSegment[];
  /**
   * Usable one-way capacity across every live link, Gb/s.
   *
   * One direction, not both summed, and derived from what the hardware can
   * actually move rather than what it advertises — so a pair of Sparks reads
   * ~200 Gb/s, matching NVIDIA's aggregate figure for the unit, instead of the
   * 800 that port rates and duplex doubling would suggest.
   */
  totalCapacityGbps: number;
  /** Busiest direction summed across links, Gb/s — comparable to capacity. */
  totalTrafficGbps: number;
  /** Number of ports that are up but carrying no traffic. */
  idlePorts: number;
  totalFaults: number;
}

export interface ClusterSnapshot {
  ts: number;
  nodes: NodeSnapshot[];
  fabric: FabricSummary;
  jobs: DistributedJob[];
  /**
   * Things that are actually wrong: an unreachable node, a failing link, a full
   * disk. Advisory or informational observations are deliberately not modelled
   * — an alert the operator cannot act on is noise, and context that belongs
   * next to a specific number is shown there instead.
   */
  warnings: ClusterWarning[];
  /** Aggregate roll-ups across all online nodes. */
  totals: {
    nodes: number;
    nodesOnline: number;
    gpus: number;
    vramTotalBytes: number;
    vramUsedBytes: number;
    cpuCores: number;
    cpuUsagePct: number;
    memTotalBytes: number;
    memUsedBytes: number;
    powerDrawW: number;
    maxTempC: number | null;
    containers: number;
    /** Inference servers detected across the cluster. */
    inferenceEndpoints: number;
    /** Combined generation throughput, tokens/sec. */
    tokensPerSec: number;
    /** Requests currently generating, across all endpoints. */
    requestsRunning: number;
    requestsWaiting: number;
  };
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: "snapshot"; data: ClusterSnapshot }
  | { type: "history"; data: HistoryPayload }
  | { type: "config"; data: { nodes: PublicNodeConfig[]; fastIntervalMs: number; slowIntervalMs: number } }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "subscribe" }
  | { type: "getHistory" };

/** NodeConfig with all secret material stripped, safe to send to clients. */
export interface PublicNodeConfig {
  id: string;
  label?: string;
  host: string;
  port: number;
  username: string;
  authMethod: "key" | "password" | "none";
  enabled: boolean;
  addedAt: number;
}

/**
 * Chart history.
 *
 * One timeline shared by every series, so `series[k][i]` always corresponds to
 * `ts[i]`. `null` marks a sample with no reading (a node that was offline at
 * that moment) and renders as a gap rather than a zero.
 */
export interface HistoryPayload {
  ts: number[];
  /** Keyed by `${nodeId}:${metric}`, `cluster:${metric}` or `link:${id}:ab|ba`. */
  series: Record<string, (number | null)[]>;
}
