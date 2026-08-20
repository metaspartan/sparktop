/**
 * Per-node collector: owns one SSH connection and turns probe output into
 * NodeSnapshots.
 *
 * Rates (CPU busy %, network and RDMA throughput) are all derived from
 * monotonic counters, so this class keeps the previous sample and divides by
 * measured wall time rather than by the nominal interval. That keeps the
 * numbers honest when a poll is late, which matters because SSH round trips to
 * a busy node are not uniform.
 */

import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Client, type ConnectConfig } from "ssh2";
import { FAST_PROBE, SLOW_PROBE } from "./probe.ts";
import { decryptSecret } from "./crypto.ts";
import { detectVariant, isDgxSpark } from "./variants.ts";
import type {
  DockerContainer,
  FabricErrors,
  FabricPort,
  GpuMetrics,
  GpuProcess,
  NetInterface,
  NodeConfig,
  NodeSnapshot,
  NodeStatus,
  ThermalSensor,
} from "./types.ts";
import {
  applyDockerEnv,
  applyDockerStats,
  applyGpuProcDetail,
  clampPct,
  cpuPctBetween,
  parseCarrier,
  parseCpuFreq,
  parseCpuInfo,
  parseCpuTimes,
  parseDisks,
  parseDocker,
  parseEthtool,
  parseFabricHwmon,
  parseFabricMap,
  parseFabricSys,
  parseGpuGraphics,
  parseGpuProcs,
  parseGpuQuery,
  parseHost,
  parseHwmon,
  parseIpAddr,
  parseLoadAvg,
  parseMeminfo,
  parseNetDev,
  parseNetInfo,
  parseRateGbps,
  parseCpuTimes as _pct,
  splitSections,
  type CpuTimes,
} from "./parse.ts";

/** A counter observed at a point in time, for rate derivation. */
interface Sample {
  value: number;
  t: number;
}

/**
 * Bytes/sec between two counter samples.
 *
 * Returns 0 rather than a negative spike when a counter goes backwards, which
 * happens on driver reload or interface reset.
 */
function ratePerSec(prev: Sample | undefined, value: number, t: number): number {
  if (!prev) return 0;
  const dt = (t - prev.t) / 1000;
  if (dt <= 0 || value < prev.value) return 0;
  return (value - prev.value) / dt;
}

/** IB `port_rcv_data`/`port_xmit_data` count 4-octet words, not bytes. */
const IB_WORD_BYTES = 4;

const IDLE_BPS_THRESHOLD = 1_000_000; // 1 MB/s — below this a link reads as idle.

export interface NodeCollectorEvents {
  snapshot: (s: NodeSnapshot) => void;
  status: (status: NodeStatus, error: string | null) => void;
}

export declare interface NodeCollector {
  on<K extends keyof NodeCollectorEvents>(e: K, l: NodeCollectorEvents[K]): this;
  emit<K extends keyof NodeCollectorEvents>(e: K, ...a: Parameters<NodeCollectorEvents[K]>): boolean;
}

export class NodeCollector extends EventEmitter {
  readonly id: string;
  private cfg: NodeConfig;
  private client: Client | null = null;
  private status: NodeStatus = "offline";
  private error: string | null = null;
  private stopped = false;

  private fastTimer: ReturnType<typeof setTimeout> | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /** Guards against overlapping polls when a node is slower than the interval. */
  private fastInFlight = false;
  private slowInFlight = false;

  // Rate-tracking state.
  private prevCpu: CpuTimes | undefined;
  private prevCores: CpuTimes[] = [];
  private prevNet = new Map<string, { rx: Sample; tx: Sample }>();
  private prevFabric = new Map<string, { rdmaRx: Sample; rdmaTx: Sample; tcpRx: Sample; tcpTx: Sample }>();
  private prevFaults = new Map<string, number>();

  // Slow-tier results, merged into every fast snapshot.
  private slow: SlowState = emptySlow();
  private lastSnapshot: NodeSnapshot | null = null;

  constructor(cfg: NodeConfig, private readonly intervals: { fastMs: number; slowMs: number }) {
    super();
    this.cfg = cfg;
    this.id = cfg.id;
  }

  get config(): NodeConfig {
    return this.cfg;
  }

  get label(): string {
    return this.cfg.label || this.slow.host.hostname || this.cfg.host;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.fastTimer, this.slowTimer, this.reconnectTimer]) if (t) clearTimeout(t);
    this.fastTimer = this.slowTimer = this.reconnectTimer = null;
    this.client?.end();
    this.client = null;
    this.setStatus("offline", null);
  }

  /** Apply an edited config, reconnecting if the connection details changed. */
  update(cfg: NodeConfig): void {
    const reconnect =
      cfg.host !== this.cfg.host ||
      cfg.port !== this.cfg.port ||
      cfg.username !== this.cfg.username ||
      cfg.privateKeyPath !== this.cfg.privateKeyPath ||
      cfg.passwordEnc !== this.cfg.passwordEnc;
    this.cfg = cfg;
    if (reconnect) {
      this.stop();
      if (cfg.enabled) this.start();
    }
  }

  private setStatus(status: NodeStatus, error: string | null): void {
    if (this.status === status && this.error === error) return;
    this.status = status;
    this.error = error;
    this.emit("status", status, error);
    // Surface connection state immediately rather than waiting for a poll.
    if (status !== "online") this.emit("snapshot", this.buildOfflineSnapshot());
  }

  private async buildAuth(): Promise<ConnectConfig> {
    const base: ConnectConfig = {
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
    };
    if (this.cfg.privateKeyPath) {
      base.privateKey = await readFile(this.cfg.privateKeyPath);
      if (this.cfg.passphraseEnc) base.passphrase = decryptSecret(this.cfg.passphraseEnc);
    } else if (this.cfg.passwordEnc) {
      base.password = decryptSecret(this.cfg.passwordEnc);
    } else {
      throw new Error("No authentication configured (need privateKeyPath or password)");
    }
    return base;
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.cfg.enabled) return;
    this.setStatus("connecting", null);

    let auth: ConnectConfig;
    try {
      auth = await this.buildAuth();
    } catch (err) {
      // Bad key path or wrong SPARKTOP_SECRET will never fix itself by
      // retrying quickly, but keep retrying slowly in case the file appears.
      this.setStatus("error", (err as Error).message);
      this.scheduleReconnect();
      return;
    }

    const client = new Client();
    this.client = client;

    client.on("ready", () => {
      if (this.stopped) return client.end();
      this.reconnectAttempt = 0;
      this.setStatus("online", null);
      void this.pollSlow();
      void this.pollFast();
    });

    client.on("error", (err) => {
      this.setStatus("error", err.message);
    });

    client.on("close", () => {
      if (this.client === client) this.client = null;
      if (!this.stopped) {
        if (this.status !== "error") this.setStatus("offline", null);
        this.scheduleReconnect();
      }
    });

    try {
      client.connect(auth);
    } catch (err) {
      this.setStatus("error", (err as Error).message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // Exponential backoff, capped at 30s.
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /** Run one command on the shared connection. */
  private exec(script: string, timeoutMs: number): Promise<string> {
    const client = this.client;
    if (!client) return Promise.reject(new Error("not connected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
      client.exec(script, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return reject(err);
        }
        let out = "";
        stream.on("data", (d: Buffer) => (out += d.toString()));
        // stderr is intentionally discarded: probe sections guard their own
        // failures, and a missing optional tool should not fail the poll.
        stream.stderr.resume();
        stream.on("close", () => {
          clearTimeout(timer);
          resolve(out);
        });
        stream.on("error", (e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    });
  }

  private scheduleFast(): void {
    if (this.stopped) return;
    this.fastTimer = setTimeout(() => void this.pollFast(), this.cfg.intervalMs ?? this.intervals.fastMs);
  }

  private scheduleSlow(): void {
    if (this.stopped) return;
    this.slowTimer = setTimeout(() => void this.pollSlow(), this.intervals.slowMs);
  }

  private async pollFast(): Promise<void> {
    if (this.stopped || !this.client || this.fastInFlight) return;
    this.fastInFlight = true;
    const t0 = Date.now();
    try {
      const raw = await this.exec(FAST_PROBE, 15_000);
      const snap = this.buildSnapshot(splitSections(raw), Date.now() - t0);
      this.lastSnapshot = snap;
      this.emit("snapshot", snap);
    } catch (err) {
      if (!this.stopped) this.setStatus("error", (err as Error).message);
    } finally {
      this.fastInFlight = false;
      this.scheduleFast();
    }
  }

  private async pollSlow(): Promise<void> {
    if (this.stopped || !this.client || this.slowInFlight) return;
    this.slowInFlight = true;
    try {
      const s = splitSections(await this.exec(SLOW_PROBE, 30_000));
      const docker = parseDocker(s.docker);
      applyDockerStats(docker.containers, s.dockerstats);
      applyDockerEnv(docker.containers, s.dockerenv);
      this.slow = {
        host: parseHost(s.host),
        cpu: parseCpuInfo(s.cpuinfo),
        cudaVersion: (s.cudaversion ?? "").trim(),
        graphicsProcs: parseGpuGraphics(s.gpugraphics),
        disks: parseDisks(s.disks),
        addresses: parseIpAddr(s.addr),
        netInfo: parseNetInfo(s.netinfo),
        fabricMap: parseFabricMap(s.fabricmap),
        docker,
        loaded: true,
      };
    } catch {
      // A failed slow poll keeps the previous inventory; fast metrics continue.
    } finally {
      this.slowInFlight = false;
      this.scheduleSlow();
    }
  }

  private buildOfflineSnapshot(): NodeSnapshot {
    const base = this.lastSnapshot;
    return {
      id: this.id,
      label: this.label,
      host: this.cfg.host,
      status: this.status,
      error: this.error,
      ts: Date.now(),
      probeMs: 0,
      info: base?.info ?? {
        hostname: this.slow.host.hostname,
        osPretty: this.slow.host.osPretty,
        kernel: this.slow.host.kernel,
        arch: this.slow.host.arch,
        product: this.slow.host.product,
        sysVendor: this.slow.host.sysVendor,
        productFamily: this.slow.host.productFamily,
        isSpark: false,
        variant: "unknown" as const,
        variantName: "DGX Spark",
        vendor: "Unknown",
        uptimeSec: 0,
        bootTime: 0,
      },
      cpu: { cores: 0, model: "", usagePct: 0, perCorePct: [], loadAvg: [0, 0, 0], freqMhz: 0, procsRunning: 0, procsTotal: 0 },
      memory: {
        totalBytes: 0, usedBytes: 0, availableBytes: 0, freeBytes: 0,
        cachedBytes: 0, buffersBytes: 0, sharedBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0,
      },
      gpu: null,
      thermal: { sensors: [], maxC: null },
      disks: [],
      docker: { available: false, containers: [] },
      network: { interfaces: [] },
      fabric: { ports: [] },
    };
  }

  private buildSnapshot(s: Record<string, string>, probeMs: number): NodeSnapshot {
    const ts = Number((s.ts ?? "").trim()) || Date.now();

    // --- CPU -------------------------------------------------------------
    const cpuTimes = parseCpuTimes(s.stat);
    const usagePct = cpuPctBetween(this.prevCpu, cpuTimes.all);
    const perCorePct = cpuTimes.cores.map((c, i) => cpuPctBetween(this.prevCores[i], c));
    this.prevCpu = cpuTimes.all;
    this.prevCores = cpuTimes.cores;

    const load = parseLoadAvg(s.uptime);

    // --- Memory ----------------------------------------------------------
    const memory = parseMeminfo(s.meminfo);

    // --- Thermal ---------------------------------------------------------
    const sensors = parseHwmon(s.hwmon);

    // --- GPU -------------------------------------------------------------
    const gpu = this.buildGpu(s, memory.totalBytes, sensors);
    if (gpu?.temperatureC != null) {
      sensors.unshift({ id: "gpu:0", label: "GPU", kind: "gpu", tempC: gpu.temperatureC });
    }
    const maxC = sensors.length ? Math.max(...sensors.map((x) => x.tempC)) : null;

    // --- Network and fabric ----------------------------------------------
    const netCounters = parseNetDev(s.netdev);
    const fabricMap = parseFabricMap(s.fabricmap);
    const fabricHwmon = parseFabricHwmon(s.fabrichwmon);
    const fabricSys = parseFabricSys(s.fabricsys);
    const ethtool = parseEthtool(s.ethtool);
    const carrier = parseCarrier(s.carrier);

    const fabricNetdevs = new Set(fabricMap.values());
    const ports = this.buildFabricPorts(
      { fabricMap, fabricHwmon, fabricSys, ethtool, netCounters, sensors },
      ts
    );
    const interfaces = this.buildInterfaces(netCounters, carrier, fabricNetdevs, ts);

    /*
     * Identify the machine from DMI rather than by pattern-matching hostnames.
     * Every GB10 variant reports product_family "DGX Spark" whoever built the
     * chassis, and sys_vendor names the manufacturer.
     */
    const dmi = {
      sysVendor: this.slow.host.sysVendor,
      productName: this.slow.host.product,
      productFamily: this.slow.host.productFamily,
      productVersion: this.slow.host.productVersion,
      boardName: this.slow.host.boardName,
    };
    const variant = detectVariant(dmi);
    const info = {
      hostname: this.slow.host.hostname || this.cfg.host,
      osPretty: this.slow.host.osPretty,
      kernel: this.slow.host.kernel,
      arch: this.slow.host.arch,
      product: this.slow.host.product,
      sysVendor: this.slow.host.sysVendor,
      productFamily: this.slow.host.productFamily,
      // Fall back to the GPU name for firmware that leaves DMI unpopulated.
      isSpark: isDgxSpark(dmi) || /GB10/i.test(gpu?.name ?? ""),
      variant: variant.id,
      variantName: variant.name,
      vendor: variant.vendor,
      uptimeSec: load.uptimeSec,
      bootTime: ts - load.uptimeSec * 1000,
    };

    return {
      id: this.id,
      label: this.label,
      host: this.cfg.host,
      status: "online",
      error: null,
      ts,
      probeMs,
      info,
      cpu: {
        cores: this.slow.cpu.cores || cpuTimes.cores.length,
        model: this.slow.cpu.model,
        usagePct,
        perCorePct,
        loadAvg: load.load,
        freqMhz: parseCpuFreq(s.cpufreq),
        procsRunning: load.procsRunning,
        procsTotal: load.procsTotal,
      },
      memory,
      gpu,
      thermal: { sensors, maxC },
      disks: this.slow.disks,
      docker: this.slow.docker,
      network: { interfaces },
      fabric: { ports },
    };
  }

  private buildGpu(
    s: Record<string, string>,
    systemMemTotal: number,
    _sensors: ThermalSensor[]
  ): GpuMetrics | null {
    const gpus = parseGpuQuery(s.gpu);
    const g = gpus[0];
    if (!g) return null;

    const procs = parseGpuProcs(s.gpuprocs);
    applyGpuProcDetail(procs, s.gpuprocdetail);

    // Merge in graphics contexts discovered by the slow tier, skipping any pid
    // already present as a compute app.
    const seen = new Set(procs.map((p) => p.pid));
    for (const gp of this.slow.graphicsProcs) if (!seen.has(gp.pid)) procs.push(gp);

    /*
     * Attribute GPU processes to containers.
     *
     * The container list is owned by the slow tier and survives across fast
     * polls, so these fields must be cleared before re-accumulating — otherwise
     * each poll adds another copy of the same allocation.
     */
    for (const c of this.slow.docker.containers) {
      c.usesGpu = false;
      c.gpuVramBytes = 0;
    }
    for (const p of procs) {
      if (!p.containerId) continue;
      const c = this.slow.docker.containers.find((x) => x.id === p.containerId);
      if (c) {
        p.containerName = c.name;
        c.usesGpu = true;
        c.gpuVramBytes = (c.gpuVramBytes ?? 0) + p.vramBytes;
      }
    }

    procs.sort((a, b) => b.vramBytes - a.vramBytes);

    /*
     * GB10 has no discrete framebuffer: CPU and GPU share one LPDDR5X pool, and
     * NVML reports FB total/used as N/A. Fall back to the system pool for total
     * and to summed per-process NVML allocations for used, flagging the result
     * as derived so the UI can say so.
     */
    const unified = g.memTotalBytes === null;
    const vramTotalBytes = g.memTotalBytes ?? systemMemTotal;
    const derived = g.memUsedBytes === null;
    const vramUsedBytes = g.memUsedBytes ?? procs.reduce((a, p) => a + p.vramBytes, 0);

    return {
      name: g.name,
      uuid: g.uuid,
      driverVersion: g.driverVersion,
      cudaVersion: this.slow.cudaVersion,
      unifiedMemory: unified,
      utilPct: clampPct(g.utilPct),
      memUtilPct: g.memUtilPct,
      temperatureC: g.temperatureC,
      powerDrawW: g.powerDrawW,
      powerLimitW: g.powerLimitW,
      smClockMhz: g.smClockMhz,
      vramTotalBytes,
      vramUsedBytes,
      vramUsedIsDerived: derived,
      processes: procs,
    };
  }

  private buildFabricPorts(
    src: {
      fabricMap: Map<string, string>;
      fabricHwmon: Map<string, string>;
      fabricSys: Map<string, ReturnType<typeof parseFabricSys> extends Map<string, infer V> ? V : never>;
      ethtool: Map<string, Map<string, number>>;
      netCounters: Map<string, { rxBytes: number; txBytes: number }>;
      sensors: ThermalSensor[];
    },
    ts: number
  ): FabricPort[] {
    const ports: FabricPort[] = [];

    for (const [ibdev, netdev] of src.fabricMap) {
      const sys = src.fabricSys.get(ibdev);
      const eth = src.ethtool.get(netdev);
      const nd = src.netCounters.get(netdev);

      /*
       * Throughput source of truth.
       *
       * NCCL moves data over RoCE, which bypasses the kernel network stack, so
       * /proc/net/dev under-reports these links by orders of magnitude (5MB
       * observed against 325GB actually transferred). Prefer the NIC's RDMA
       * vport counters; fall back to the IB port counters, which count 4-octet
       * words and include both RDMA and non-RDMA traffic.
       */
      let rdmaRx = eth?.get("rx_vport_rdma_unicast_bytes");
      let rdmaTx = eth?.get("tx_vport_rdma_unicast_bytes");
      if (rdmaRx === undefined || rdmaTx === undefined) {
        rdmaRx = (sys?.counters.get("port_rcv_data") ?? 0) * IB_WORD_BYTES;
        rdmaTx = (sys?.counters.get("port_xmit_data") ?? 0) * IB_WORD_BYTES;
      }
      const tcpRx = eth?.get("rx_vport_unicast_bytes") ?? nd?.rxBytes ?? 0;
      const tcpTx = eth?.get("tx_vport_unicast_bytes") ?? nd?.txBytes ?? 0;

      const prev = this.prevFabric.get(ibdev);
      const rdmaRxBps = ratePerSec(prev?.rdmaRx, rdmaRx, ts);
      const rdmaTxBps = ratePerSec(prev?.rdmaTx, rdmaTx, ts);
      const tcpRxBps = ratePerSec(prev?.tcpRx, tcpRx, ts);
      const tcpTxBps = ratePerSec(prev?.tcpTx, tcpTx, ts);
      this.prevFabric.set(ibdev, {
        rdmaRx: { value: rdmaRx, t: ts },
        rdmaTx: { value: rdmaTx, t: ts },
        tcpRx: { value: tcpRx, t: ts },
        tcpTx: { value: tcpTx, t: ts },
      });

      const rateGbps = parseRateGbps(sys?.rate ?? "");
      const capacityBps = (rateGbps * 1e9) / 8;
      const util = (bps: number) => (capacityBps > 0 ? clampPct((bps / capacityBps) * 100) : 0);

      const errors = buildErrors(sys);
      const prevFaults = this.prevFaults.get(ibdev);
      errors.faultsDelta = prevFaults === undefined ? 0 : Math.max(0, errors.totalFaults - prevFaults);
      this.prevFaults.set(ibdev, errors.totalFaults);

      const hwmonDir = src.fabricHwmon.get(ibdev);
      const tempC = hwmonDir
        ? (src.sensors.find((x) => x.source === hwmonDir)?.tempC ?? null)
        : null;

      const addresses = this.slow.addresses.get(netdev) ?? [];
      const info = this.slow.netInfo.get(netdev);
      const state = (sys?.state ?? "").replace(/^\d+:\s*/, "") || "UNKNOWN";

      ports.push({
        netdev,
        ibdev,
        mac: info?.mac ?? "",
        state,
        physState: (sys?.physState ?? "").replace(/^\d+:\s*/, "") || "UNKNOWN",
        linkUp: state.toUpperCase() === "ACTIVE",
        rateGbps,
        rateLabel: sys?.rate ?? "",
        addresses,
        subnet: subnetOf(addresses[0]),
        rdmaRxBytes: rdmaRx,
        rdmaTxBytes: rdmaTx,
        tcpRxBytes: tcpRx,
        tcpTxBytes: tcpTx,
        rdmaRxBps,
        rdmaTxBps,
        tcpRxBps,
        tcpTxBps,
        rxUtilPct: util(rdmaRxBps + tcpRxBps),
        txUtilPct: util(rdmaTxBps + tcpTxBps),
        tempC,
        errors,
      });
    }

    ports.sort((a, b) => a.netdev.localeCompare(b.netdev));
    return ports;
  }

  private buildInterfaces(
    netCounters: Map<string, { rxBytes: number; txBytes: number }>,
    carrier: Map<string, boolean>,
    fabricNetdevs: Set<string>,
    ts: number
  ): NetInterface[] {
    const out: NetInterface[] = [];
    for (const [name, c] of netCounters) {
      if (name === "lo") continue;
      const prev = this.prevNet.get(name);
      const rxBps = ratePerSec(prev?.rx, c.rxBytes, ts);
      const txBps = ratePerSec(prev?.tx, c.txBytes, ts);
      this.prevNet.set(name, { rx: { value: c.rxBytes, t: ts }, tx: { value: c.txBytes, t: ts } });
      const info = this.slow.netInfo.get(name);
      out.push({
        name,
        mac: info?.mac ?? "",
        up: info?.operstate === "up",
        carrier: carrier.get(name) ?? false,
        speedMbps: info?.speedMbps ?? null,
        addresses: this.slow.addresses.get(name) ?? [],
        rxBytes: c.rxBytes,
        txBytes: c.txBytes,
        rxBps,
        txBps,
        isFabric: fabricNetdevs.has(name),
      });
    }
    out.sort((a, b) => Number(b.isFabric) - Number(a.isFabric) || a.name.localeCompare(b.name));
    return out;
  }
}

// ---------------------------------------------------------------------------

interface SlowState {
  host: ReturnType<typeof parseHost>;
  cpu: { cores: number; model: string };
  cudaVersion: string;
  graphicsProcs: GpuProcess[];
  disks: ReturnType<typeof parseDisks>;
  addresses: Map<string, string[]>;
  netInfo: ReturnType<typeof parseNetInfo>;
  fabricMap: Map<string, string>;
  docker: { available: boolean; containers: DockerContainer[] };
  loaded: boolean;
}

function emptySlow(): SlowState {
  return {
    host: { hostname: "", kernel: "", arch: "", osPretty: "", product: null, sysVendor: null, productFamily: null, productVersion: null, boardName: null },
    cpu: { cores: 0, model: "" },
    cudaVersion: "",
    graphicsProcs: [],
    disks: [],
    addresses: new Map(),
    netInfo: new Map(),
    fabricMap: new Map(),
    docker: { available: false, containers: [] },
    loaded: false,
  };
}

function buildErrors(sys: { counters: Map<string, number>; hwCounters: Map<string, number> } | undefined): FabricErrors {
  const c = (k: string) => sys?.counters.get(k) ?? 0;
  const h = (k: string) => sys?.hwCounters.get(k) ?? 0;
  const e: FabricErrors = {
    portRcvErrors: c("port_rcv_errors"),
    portXmitDiscards: c("port_xmit_discards"),
    linkDowned: c("link_downed"),
    linkErrorRecovery: c("link_error_recovery"),
    symbolErrors: c("symbol_error"),
    outOfSequence: h("out_of_sequence"),
    packetSeqErr: h("packet_seq_err"),
    outOfBuffer: h("out_of_buffer"),
    rnrNakRetryErr: h("rnr_nak_retry_err"),
    reqTransportRetriesExceeded: h("req_transport_retries_exceeded"),
    localAckTimeoutErr: h("local_ack_timeout_err"),
    cnpSent: h("np_cnp_sent"),
    cnpHandled: h("rp_cnp_handled"),
    ecnMarked: h("np_ecn_marked_roce_packets"),
    totalFaults: 0,
    faultsDelta: 0,
  };
  /*
   * Faults vs congestion. ECN/CNP counters mean the fabric applied
   * backpressure, which is the flow control working as designed and is normal
   * under load. Only genuine errors are summed here so a busy-but-healthy link
   * does not look broken.
   */
  e.totalFaults =
    e.portRcvErrors +
    e.portXmitDiscards +
    e.linkDowned +
    e.linkErrorRecovery +
    e.symbolErrors +
    e.outOfSequence +
    e.packetSeqErr +
    e.rnrNakRetryErr +
    e.reqTransportRetriesExceeded;
  return e;
}

/** "10.100.232.1/24" -> "10.100.232.0/24". Used to pair ports across nodes. */
export function subnetOf(cidr: string | undefined): string | null {
  if (!cidr) return null;
  const [ip, prefixStr] = cidr.split("/");
  if (!ip || !prefixStr) return null;
  const prefix = Number(prefixStr);
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isFinite(o))) return null;
  const asInt = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (asInt & mask) >>> 0;
  return `${(net >>> 24) & 255}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${prefix}`;
}

export { IDLE_BPS_THRESHOLD };
