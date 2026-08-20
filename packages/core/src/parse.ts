/**
 * Pure parsers for probe output.
 *
 * Everything here is a total function over strings: given probe text it returns
 * a value, and given garbage it returns a sensible empty value rather than
 * throwing. A node that half-answers should degrade to partial metrics, never
 * take down a poll cycle.
 */

import { RS, US } from "./probe.ts";
import type {
  CpuMetrics,
  DiskMetrics,
  DockerContainer,
  DistributedHints,
  GpuProcess,
  MemoryMetrics,
  ThermalSensor,
} from "./types.ts";

/** Split raw probe output into `sectionName -> body`. */
export function splitSections(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const chunk of raw.split(RS)) {
    if (!chunk) continue;
    const nl = chunk.indexOf("\n");
    if (nl === -1) {
      out[chunk.trim()] = "";
      continue;
    }
    out[chunk.slice(0, nl).trim()] = chunk.slice(nl + 1);
  }
  return out;
}

const num = (s: string | undefined): number => {
  if (s === undefined) return 0;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : 0;
};

/** Parse a value that nvidia-smi may report as `[N/A]` or `[Not Supported]`. */
export function nvidiaNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (!t || t.startsWith("[") || t === "N/A") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function nvidiaStr(s: string | undefined): string {
  if (s === undefined) return "";
  const t = s.trim();
  return t.startsWith("[") ? "" : t;
}

const lines = (s: string | undefined): string[] =>
  (s ?? "").split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");

/**
 * Parse `grep -H .` output into `path -> value`.
 *
 * Values may themselves contain `:` (e.g. `state:4: ACTIVE`), so only the first
 * colon is treated as the separator.
 */
export function parseGrepH(body: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of lines(body)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

export interface CpuTimes {
  total: number;
  idle: number;
}

/** Aggregate and per-core jiffy totals from /proc/stat. */
export function parseCpuTimes(body: string | undefined): { all: CpuTimes; cores: CpuTimes[] } {
  let all: CpuTimes = { total: 0, idle: 0 };
  const cores: CpuTimes[] = [];
  for (const line of lines(body)) {
    const parts = line.trim().split(/\s+/);
    const label = parts[0];
    if (!label || !label.startsWith("cpu")) continue;
    const vals = parts.slice(1).map(num);
    const total = vals.reduce((a, b) => a + b, 0);
    // Fields: user nice system idle iowait irq softirq steal guest guest_nice
    const idle = (vals[3] ?? 0) + (vals[4] ?? 0);
    if (label === "cpu") all = { total, idle };
    else cores.push({ total, idle });
  }
  return { all, cores };
}

/** Busy percentage between two jiffy samples. */
export function cpuPctBetween(prev: CpuTimes | undefined, cur: CpuTimes): number {
  if (!prev) return 0;
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return 0;
  return clampPct(((dTotal - dIdle) / dTotal) * 100);
}

export const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

export function parseLoadAvg(body: string | undefined): {
  uptimeSec: number;
  load: [number, number, number];
  procsRunning: number;
  procsTotal: number;
} {
  // Section `uptime` contains /proc/uptime then /proc/loadavg.
  const l = lines(body);
  const uptimeSec = num(l[0]?.trim().split(/\s+/)[0]);
  const la = (l[1] ?? "").trim().split(/\s+/);
  const procs = (la[3] ?? "0/0").split("/");
  return {
    uptimeSec,
    load: [num(la[0]), num(la[1]), num(la[2])],
    procsRunning: num(procs[0]),
    procsTotal: num(procs[1]),
  };
}

export function parseCpuFreq(body: string | undefined): number {
  const vals = lines(body).map((l) => num(l));
  if (!vals.length) return 0;
  // Report the fastest active core; on big.LITTLE the mean is misleading.
  return Math.round(Math.max(...vals) / 1000);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function parseMeminfo(body: string | undefined): MemoryMetrics {
  const kv = new Map<string, number>();
  for (const line of lines(body)) {
    const [k, v] = line.split(":");
    if (!k || v === undefined) continue;
    kv.set(k.trim(), num(v.trim().split(/\s+/)[0]) * 1024);
  }
  const total = kv.get("MemTotal") ?? 0;
  const available = kv.get("MemAvailable") ?? 0;
  const swapTotal = kv.get("SwapTotal") ?? 0;
  const swapFree = kv.get("SwapFree") ?? 0;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: Math.max(0, total - available),
    freeBytes: kv.get("MemFree") ?? 0,
    cachedBytes: kv.get("Cached") ?? 0,
    buffersBytes: kv.get("Buffers") ?? 0,
    sharedBytes: kv.get("Shmem") ?? 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

export interface RawGpu {
  index: number;
  name: string;
  uuid: string;
  driverVersion: string;
  utilPct: number;
  memUtilPct: number | null;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
  smClockMhz: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
}

export function parseGpuQuery(body: string | undefined): RawGpu[] {
  const out: RawGpu[] = [];
  for (const line of lines(body)) {
    const f = line.split(",").map((s) => s.trim());
    if (f.length < 12) continue;
    const mb = (s: string | undefined) => {
      const n = nvidiaNum(s);
      return n === null ? null : n * 1024 * 1024;
    };
    out.push({
      index: num(f[0]),
      name: nvidiaStr(f[1]),
      uuid: nvidiaStr(f[2]),
      driverVersion: nvidiaStr(f[3]),
      utilPct: nvidiaNum(f[4]) ?? 0,
      memUtilPct: nvidiaNum(f[5]),
      temperatureC: nvidiaNum(f[6]),
      powerDrawW: nvidiaNum(f[7]),
      powerLimitW: nvidiaNum(f[8]),
      smClockMhz: nvidiaNum(f[9]),
      memTotalBytes: mb(f[10]),
      memUsedBytes: mb(f[11]),
    });
  }
  return out;
}

/** `pid, process_name, used_memory` from --query-compute-apps. */
export function parseGpuProcs(body: string | undefined): GpuProcess[] {
  const out: GpuProcess[] = [];
  for (const line of lines(body)) {
    const f = line.split(",").map((s) => s.trim());
    if (f.length < 3) continue;
    const pid = num(f[0]);
    if (!pid) continue;
    out.push({
      pid,
      name: f[1] ?? "",
      type: "compute",
      vramBytes: (nvidiaNum(f[2]) ?? 0) * 1024 * 1024,
    });
  }
  return out;
}

/**
 * Enrich GPU processes with owner/CPU/RSS and container id.
 *
 * The section holds `ps` output, then a `---` marker, then `pid<US>cgroupId`
 * lines.
 */
export function applyGpuProcDetail(procs: GpuProcess[], body: string | undefined): void {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const [psPart = "", cgPart = ""] = (body ?? "").split("\n---\n");
  for (const line of lines(psPart)) {
    const f = line.trim().split(/\s+/);
    const p = byPid.get(num(f[0]));
    if (!p) continue;
    p.user = f[1];
    p.cpuPct = num(f[2]);
    p.rssBytes = num(f[3]) * 1024;
    p.elapsedSec = num(f[4]);
  }
  for (const line of lines(cgPart)) {
    const [pidStr, cid] = line.split(US);
    const p = byPid.get(num(pidStr));
    if (p && cid && cid.trim()) p.containerId = cid.trim();
  }
}

/**
 * Graphics-context processes, scraped from the nvidia-smi process table.
 *
 * NVML has no `--query-graphics-apps`, so desktop clients (Xorg, gnome-shell)
 * are only visible in the human-readable table. They hold trivial amounts of
 * memory, which is why this lives in the slow tier.
 */
export function parseGpuGraphics(body: string | undefined): GpuProcess[] {
  const out: GpuProcess[] = [];
  for (const line of lines(body)) {
    // | 0   N/A  N/A      3067      G   /usr/lib/xorg/Xorg      18MiB |
    const f = line.replace(/^\||\|$/g, "").trim().split(/\s+/);
    const typeIdx = f.findIndex((x) => x === "G" || x === "C" || x === "C+G");
    if (typeIdx < 1) continue;
    const pid = num(f[typeIdx - 1]);
    if (!pid) continue;
    const memTok = f[f.length - 1] ?? "";
    const mib = /^(\d+)MiB$/.exec(memTok);
    out.push({
      pid,
      name: f[typeIdx + 1] ?? "",
      type: f[typeIdx] === "G" ? "graphics" : "compute",
      vramBytes: mib ? num(mib[1]) * 1024 * 1024 : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Thermal
// ---------------------------------------------------------------------------

const SENSOR_KIND = (chipName: string, label: string): ThermalSensor["kind"] => {
  const n = `${chipName} ${label}`.toLowerCase();
  if (n.includes("mlx5")) return "nic";
  if (n.includes("nvme")) return "nvme";
  if (n.includes("gpu") || n.includes("tegra")) return "gpu";
  if (n.includes("phy") || n.includes("wifi") || n.includes("mt79")) return "wifi";
  if (n.includes("acpitz") || n.includes("soc") || n.includes("cpu")) return "soc";
  return "other";
};

/**
 * Build sensors from bulk hwmon reads.
 *
 * Chips are disambiguated by their hwmon index because a Spark exposes four
 * separate `mlx5` chips (one per ConnectX-7 port) that would otherwise collide.
 */
export function parseHwmon(body: string | undefined): ThermalSensor[] {
  const files = parseGrepH(body);
  const chipNames = new Map<string, string>();
  for (const [path, val] of files) {
    const m = /^\/sys\/class\/hwmon\/(hwmon\d+)\/name$/.exec(path);
    if (m?.[1]) chipNames.set(m[1], val.trim());
  }

  // Count chips per name so repeated chips get a stable numeric suffix.
  const seen = new Map<string, number>();
  const chipLabel = new Map<string, string>();
  for (const hw of [...chipNames.keys()].sort(
    (a, b) => num(a.replace("hwmon", "")) - num(b.replace("hwmon", ""))
  )) {
    const base = chipNames.get(hw) ?? "unknown";
    const total = [...chipNames.values()].filter((v) => v === base).length;
    if (total > 1) {
      const i = seen.get(base) ?? 0;
      seen.set(base, i + 1);
      chipLabel.set(hw, `${base}${i}`);
    } else {
      chipLabel.set(hw, base);
    }
  }

  const out: ThermalSensor[] = [];
  for (const [path, val] of files) {
    const m = /^\/sys\/class\/hwmon\/(hwmon\d+)\/(temp\d+)_input$/.exec(path);
    if (!m) continue;
    const [, hw, temp] = m;
    if (!hw || !temp) continue;
    const chip = chipLabel.get(hw) ?? "unknown";
    const label = files.get(`/sys/class/hwmon/${hw}/${temp}_label`)?.trim() ?? "";
    const crit = files.get(`/sys/class/hwmon/${hw}/${temp}_crit`);
    const tempC = num(val) / 1000;
    if (!Number.isFinite(tempC) || tempC <= 0 || tempC > 200) continue;
    out.push({
      id: `${chip}:${temp}`,
      label: label ? `${chip} ${label}` : chip,
      source: hw,
      kind: SENSOR_KIND(chipNames.get(hw) ?? "", label),
      tempC: Math.round(tempC * 10) / 10,
      ...(crit ? { critC: num(crit) / 1000 } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface NetDevCounters {
  rxBytes: number;
  txBytes: number;
}

export function parseNetDev(body: string | undefined): Map<string, NetDevCounters> {
  const out = new Map<string, NetDevCounters>();
  for (const line of lines(body)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const name = line.slice(0, i).trim();
    if (!name || name === "face" || name.startsWith("Inter-")) continue;
    const f = line.slice(i + 1).trim().split(/\s+/);
    out.set(name, { rxBytes: num(f[0]), txBytes: num(f[8]) });
  }
  return out;
}

/** `/sys/class/infiniband/<ibdev>/device/net/<netdev>` -> netdev by ibdev. */
export function parseFabricMap(body: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines(body)) {
    const m = /\/sys\/class\/infiniband\/([^/]+)\/device\/net\/(.+)$/.exec(line.trim());
    if (m?.[1] && m[2]) out.set(m[1], m[2].trim());
  }
  return out;
}

/**
 * `/sys/class/infiniband/<ibdev>/device/hwmon/<hwmonN>` -> hwmon dir by ibdev.
 *
 * A Spark exposes four identically named `mlx5` hwmon chips; this is what makes
 * it possible to attribute each temperature to the right port instead of
 * assuming enumeration order matches.
 */
export function parseFabricHwmon(body: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lines(body)) {
    const m = /\/sys\/class\/infiniband\/([^/]+)\/device\/hwmon\/(hwmon\d+)$/.exec(line.trim());
    if (m?.[1] && m[2]) out.set(m[1], m[2]);
  }
  return out;
}

export interface FabricSysValues {
  rate: string;
  state: string;
  physState: string;
  counters: Map<string, number>;
  hwCounters: Map<string, number>;
}

/** Group bulk infiniband sysfs reads by device. */
export function parseFabricSys(body: string | undefined): Map<string, FabricSysValues> {
  const out = new Map<string, FabricSysValues>();
  const get = (dev: string): FabricSysValues => {
    let v = out.get(dev);
    if (!v) {
      v = { rate: "", state: "", physState: "", counters: new Map(), hwCounters: new Map() };
      out.set(dev, v);
    }
    return v;
  };
  for (const [path, raw] of parseGrepH(body)) {
    const m = /^\/sys\/class\/infiniband\/([^/]+)\/ports\/\d+\/(.+)$/.exec(path);
    if (!m?.[1] || !m[2]) continue;
    const v = get(m[1]);
    const rest = m[2];
    const val = raw.trim();
    if (rest === "rate") v.rate = val;
    else if (rest === "state") v.state = val;
    else if (rest === "phys_state") v.physState = val;
    else if (rest.startsWith("counters/")) v.counters.set(rest.slice(9), num(val));
    else if (rest.startsWith("hw_counters/")) v.hwCounters.set(rest.slice(12), num(val));
  }
  return out;
}

/** Per-interface ethtool RDMA/unicast byte and packet counters. */
export function parseEthtool(body: string | undefined): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  let cur: Map<string, number> | undefined;
  for (const line of lines(body)) {
    if (line.startsWith("IF" + US)) {
      cur = new Map();
      out.set(line.slice(3), cur);
      continue;
    }
    if (!cur) continue;
    const [k, v] = line.split(":");
    if (k && v !== undefined) cur.set(k.trim(), num(v));
  }
  return out;
}

export function parseCarrier(body: string | undefined): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [path, val] of parseGrepH(body)) {
    const m = /^\/sys\/class\/net\/([^/]+)\/carrier$/.exec(path);
    if (m?.[1]) out.set(m[1], val.trim() === "1");
  }
  return out;
}

/** Parse `rate` text such as "200 Gb/sec (2X NDR)" into Gb/s. */
export function parseRateGbps(rate: string): number {
  const m = /^([\d.]+)\s*Gb/.exec(rate.trim());
  return m?.[1] ? Number(m[1]) : 0;
}

/** `ip -o -4 addr show` -> interface -> ["10.100.232.1/24", ...] */
export function parseIpAddr(body: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of lines(body)) {
    const f = line.trim().split(/\s+/);
    const name = f[1];
    const inetIdx = f.indexOf("inet");
    if (!name || inetIdx === -1) continue;
    const cidr = f[inetIdx + 1];
    if (!cidr) continue;
    const list = out.get(name) ?? [];
    list.push(cidr);
    out.set(name, list);
  }
  return out;
}

export interface NetInfoRow {
  speedMbps: number | null;
  carrier: boolean;
  operstate: string;
  mac: string;
}

export function parseNetInfo(body: string | undefined): Map<string, NetInfoRow> {
  const out = new Map<string, NetInfoRow>();
  for (const line of lines(body)) {
    const f = line.split(US);
    const name = f[0]?.trim();
    if (!name) continue;
    const speed = f[1]?.trim();
    out.set(name, {
      speedMbps: speed && Number(speed) > 0 ? Number(speed) : null,
      carrier: f[2]?.trim() === "1",
      operstate: f[3]?.trim() ?? "unknown",
      mac: f[4]?.trim() ?? "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Disks, host, docker
// ---------------------------------------------------------------------------

export function parseDisks(body: string | undefined): DiskMetrics[] {
  const out: DiskMetrics[] = [];
  const seen = new Set<string>();
  for (const line of lines(body)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const mount = f[5] ?? "";
    if (seen.has(mount)) continue;
    seen.add(mount);
    out.push({
      device: f[0] ?? "",
      totalBytes: num(f[1]),
      usedBytes: num(f[2]),
      availableBytes: num(f[3]),
      mount,
    });
  }
  return out;
}

export function parseHost(body: string | undefined): {
  hostname: string;
  kernel: string;
  arch: string;
  osPretty: string;
  product: string | null;
  sysVendor: string | null;
  productFamily: string | null;
  productVersion: string | null;
  boardName: string | null;
} {
  const l = (body ?? "").split("\n").map((s) => s.trim());
  // DMI fields commonly hold this placeholder when the OEM left them unset.
  const dmi = (v: string | undefined): string | null =>
    !v || v === "Default string" || v === "To Be Filled By O.E.M." ? null : v;
  return {
    hostname: l[0] ?? "",
    kernel: l[1] ?? "",
    arch: l[2] ?? "",
    osPretty: l[3] ?? "",
    product: dmi(l[4]),
    sysVendor: dmi(l[5]),
    productFamily: dmi(l[6]),
    productVersion: dmi(l[7]),
    boardName: dmi(l[8]),
  };
}

export function parseDocker(body: string | undefined): { available: boolean; containers: DockerContainer[] } {
  const l = lines(body);
  if (!l.length || l[0]?.trim() !== "OK") return { available: false, containers: [] };
  const containers: DockerContainer[] = [];
  for (const line of l.slice(1)) {
    const f = line.split(US);
    if (f.length < 5 || !f[0]) continue;
    const created = Date.parse((f[5] ?? "").replace(/ [A-Z]{3,4}$/, ""));
    containers.push({
      id: f[0],
      name: f[1] ?? "",
      image: f[2] ?? "",
      state: f[3] ?? "",
      status: f[4] ?? "",
      createdAt: Number.isFinite(created) ? created : 0,
    });
  }
  return { available: true, containers };
}

const SIZE_UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
};

/** Parse docker's human-readable sizes, e.g. "7.17GiB". */
export function parseDockerSize(s: string): number {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(s.trim());
  if (!m?.[1] || !m[2]) return 0;
  return Number(m[1]) * (SIZE_UNITS[m[2].toLowerCase()] ?? 1);
}

export function applyDockerStats(containers: DockerContainer[], body: string | undefined): void {
  // `docker stats` reports short ids; match on prefix.
  for (const line of lines(body)) {
    const f = line.split(US);
    const id = f[0]?.trim();
    if (!id) continue;
    const c = containers.find((x) => x.id.startsWith(id));
    if (!c) continue;
    c.cpuPct = num((f[1] ?? "").replace("%", ""));
    const [used, limit] = (f[2] ?? "").split("/");
    if (used) c.memUsedBytes = parseDockerSize(used);
    if (limit) c.memLimitBytes = parseDockerSize(limit);
  }
}

export function applyDockerEnv(containers: DockerContainer[], body: string | undefined): void {
  for (const line of lines(body)) {
    const f = line.split(US).filter((x) => x !== "");
    const id = f[0]?.trim();
    if (!id) continue;
    const c = containers.find((x) => x.id === id || x.id.startsWith(id));
    if (!c) continue;
    const env = new Map<string, string>();
    for (const kv of f.slice(1)) {
      const i = kv.indexOf("=");
      if (i > 0) env.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    c.networkMode = env.get("NETWORKMODE");
    const d: DistributedHints = {};
    const set = <K extends keyof DistributedHints>(k: K, v: DistributedHints[K]) => {
      if (v !== undefined && v !== "") d[k] = v;
    };
    set("masterAddr", env.get("MASTER_ADDR") ?? env.get("VLLM_HOST_IP"));
    set("masterPort", env.get("MASTER_PORT"));
    set("ncclSocketIfname", env.get("NCCL_SOCKET_IFNAME"));
    set("ncclIbHca", env.get("NCCL_IB_HCA"));
    set("worldSize", env.get("WORLD_SIZE"));
    set("rank", env.get("RANK") ?? env.get("NODE_RANK"));
    set("model", env.get("DSPARK_MODEL") ?? env.get("MODEL") ?? env.get("MODEL_NAME"));
    const ibDis = env.get("NCCL_IB_DISABLE");
    if (ibDis !== undefined) d.ncclIbDisabled = ibDis === "1";
    const merge = env.get("NCCL_IB_MERGE_NICS");
    if (merge !== undefined) d.ncclIbMergeNics = merge === "1";
    if (Object.keys(d).length) c.distributed = d;
  }
}

/**
 * Core count and CPU model.
 *
 * A GB10 pairs Cortex-X925 and Cortex-A725 clusters, so lscpu reports more than
 * one model line. Distinct names are joined so the UI shows the real
 * heterogeneous configuration rather than only the first cluster.
 */
export function parseCpuInfo(body: string | undefined): { cores: number; model: string } {
  const l = lines(body);
  const models = [...new Set(l.slice(1).map((s) => s.trim()).filter(Boolean))];
  return { cores: num(l[0]) || 1, model: models.join(" + ") };
}

// ---------------------------------------------------------------------------
// Inference endpoints
// ---------------------------------------------------------------------------

/** Discovery output: `PORT<US>8888<US>metrics` per identified server. */
export function parseDiscoveredEndpoints(
  body: string | undefined
): { port: number; kind: "metrics" | "ollama" | "openai" }[] {
  const out: { port: number; kind: "metrics" | "ollama" | "openai" }[] = [];
  const seen = new Set<number>();
  for (const line of lines(body)) {
    const f = line.split(US);
    if (f[0] !== "PORT") continue;
    const port = num(f[1]);
    const kind = f[2]?.trim();
    if (!port || seen.has(port)) continue;
    if (kind !== "metrics" && kind !== "ollama" && kind !== "openai") continue;
    seen.add(port);
    out.push({ port, kind });
  }
  return out.sort((a, b) => a.port - b.port);
}

/**
 * Split the scrape section into per-endpoint bodies.
 *
 * Each block starts with an `EP` header and ends at an `END` marker, so an
 * endpoint that returned nothing is still represented — the difference between
 * "no data" and "not reachable" matters to the UI.
 */
export function parseInferenceScrapes(
  body: string | undefined
): { port: number; kind: string; body: string }[] {
  const out: { port: number; kind: string; body: string }[] = [];
  if (!body) return out;
  const END = `${US}END${US}`;
  let cur: { port: number; kind: string; body: string } | null = null;
  const buf: string[] = [];

  const flush = () => {
    if (cur) {
      cur.body = buf.join("\n").trim();
      out.push(cur);
    }
    buf.length = 0;
  };

  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(`EP${US}`)) {
      flush();
      const f = line.split(US);
      cur = { port: num(f[1]), kind: (f[2] ?? "").trim(), body: "" };
      continue;
    }
    if (line.trim() === END.trim() || line.includes(END)) {
      flush();
      cur = null;
      continue;
    }
    if (cur) buf.push(line);
  }
  flush();
  return out.filter((e) => e.port > 0);
}
