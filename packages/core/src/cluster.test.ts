/**
 * Topology and analysis tests.
 *
 * These cover the inference that has no ground truth on the node itself:
 * nothing on a Spark reports which machine its cable reaches, so pairing is
 * derived from addressing and then corroborated with traffic counters.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClusterSnapshot, inferJobs, newAnalysisState, pairFabricPorts } from "./cluster.ts";
import { loadConfig } from "./config.ts";
import { encryptSecret, decryptSecret, safeEqual } from "./crypto.ts";
import { fmtBps, fmtBytes, fmtDuration, fmtGbps, shortImage } from "./format.ts";
import type { DockerContainer, FabricPort, NodeSnapshot, GpuMetrics } from "./types.ts";

function port(over: Partial<FabricPort> = {}): FabricPort {
  const base = buildPort(over);
  // Derive the effective rate from whatever rate the test asked for, unless the
  // test set it explicitly — otherwise overriding rateGbps silently has no
  // effect on anything that reads capacity.
  const pcie = base.pcieCeilingGbps;
  const effective = over.effectiveRateGbps ?? (pcie !== null ? Math.min(base.rateGbps, pcie) : base.rateGbps);
  return { ...base, effectiveRateGbps: effective, pcieLimited: pcie !== null && pcie < base.rateGbps };
}

function buildPort(over: Partial<FabricPort> = {}): FabricPort {
  return {
    netdev: "enp1s0f1np1",
    ibdev: "rocep1s0f1",
    mac: "",
    state: "ACTIVE",
    physState: "LinkUp",
    linkUp: true,
    rateGbps: 200,
    rateLabel: "200 Gb/sec (2X NDR)",
    pcieCeilingGbps: 100.8,
    effectiveRateGbps: 100.8,
    pcieLimited: true,
    addresses: ["10.100.232.1/24"],
    subnet: "10.100.232.0/24",
    rdmaRxBytes: 0,
    rdmaTxBytes: 0,
    tcpRxBytes: 0,
    tcpTxBytes: 0,
    rdmaRxBps: 0,
    rdmaTxBps: 0,
    tcpRxBps: 0,
    tcpTxBps: 0,
    rxUtilPct: 0,
    txUtilPct: 0,
    tempC: 60,
    errors: {
      portRcvErrors: 0, portXmitDiscards: 0, linkDowned: 0, linkErrorRecovery: 0, symbolErrors: 0,
      outOfSequence: 0, packetSeqErr: 0, outOfBuffer: 0, rnrNakRetryErr: 0,
      reqTransportRetriesExceeded: 0, localAckTimeoutErr: 0,
      cnpSent: 0, cnpHandled: 0, ecnMarked: 0, totalFaults: 0, faultsDelta: 0,
    },
    ...over,
  };
}

function node(id: string, ports: FabricPort[], over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    id,
    label: id,
    host: `10.0.0.${id.length}`,
    status: "online",
    error: null,
    ts: Date.now(),
    probeMs: 100,
    info: { hostname: id, osPretty: "Ubuntu", kernel: "6.17", arch: "aarch64", product: "GX10", sysVendor: "ASUSTeK COMPUTER INC.", productFamily: "DGX Spark", isSpark: true, variant: "asus" as const, variantName: "ASUS Ascent GX10", vendor: "ASUS", uptimeSec: 100, bootTime: 0 },
    cpu: { cores: 20, model: "Cortex-X925", usagePct: 5, perCorePct: [], loadAvg: [0, 0, 0], freqMhz: 3900, procsRunning: 1, procsTotal: 100 },
    memory: { totalBytes: 128e9, usedBytes: 64e9, availableBytes: 64e9, freeBytes: 1e9, cachedBytes: 1e9, buffersBytes: 0, sharedBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0 },
    gpu: null,
    thermal: { sensors: [], maxC: 60 },
    disks: [],
    docker: { available: true, containers: [] },
    network: { interfaces: [] },
    fabric: { ports },
    inference: [],
    ...over,
  };
}

describe("fabric pairing", () => {
  test("pairs two ports that share a subnet across different nodes", () => {
    const a = node("a", [port()]);
    const b = node("b", [port({ addresses: ["10.100.232.2/24"] })]);
    const { links } = pairFabricPorts([a, b]);
    expect(links).toHaveLength(1);
    expect(links[0]!.a.nodeId).toBe("a");
    expect(links[0]!.b.nodeId).toBe("b");
    // The ports advertise 200, but a Gen5 x4 link cannot carry it.
    expect(links[0]!.rateGbps).toBeCloseTo(100.8, 1);
    expect(links[0]!.signalledRateGbps).toBe(200);
    expect(links[0]!.pcieLimited).toBe(true);
  });

  test("capacity reflects what the hardware can move, not what it advertises", () => {
    // Two links between a pair of Sparks: 2 x ~100 Gb/s usable, one direction.
    const a = node("a", [
      port(),
      port({ netdev: "p2", ibdev: "ib2", addresses: ["10.100.233.1/24"], subnet: "10.100.233.0/24" }),
    ]);
    const b = node("b", [
      port({ addresses: ["10.100.232.2/24"] }),
      port({ netdev: "p2", ibdev: "ib2", addresses: ["10.100.233.2/24"], subnet: "10.100.233.0/24" }),
    ]);
    const f = buildClusterSnapshot([a, b]).fabric;
    // Not 800: that is 2 links x 200 advertised x 2 for duplex, and wrong twice.
    expect(f.totalCapacityGbps).toBeCloseTo(201.6, 1);
  });

  test("uses the port rate when PCIe is not the constraint", () => {
    // A 25G port behind a Gen5 x4 link is limited by the wire, not the bus.
    const slow = { rateGbps: 25, pcieCeilingGbps: 100.8 };
    const a = node("a", [port(slow)]);
    const b = node("b", [port({ ...slow, addresses: ["10.100.232.2/24"] })]);
    const l = pairFabricPorts([a, b]).links[0]!;
    expect(l.rateGbps).toBe(25);
    expect(l.pcieLimited).toBe(false);
  });

  test("does not pair two ports on the same node", () => {
    const a = node("a", [port(), port({ netdev: "eth1", addresses: ["10.100.232.9/24"] })]);
    expect(pairFabricPorts([a]).links).toHaveLength(0);
  });

  test("ignores down links", () => {
    const a = node("a", [port({ linkUp: false })]);
    const b = node("b", [port({ linkUp: false, addresses: ["10.100.232.2/24"] })]);
    expect(pairFabricPorts([a, b]).links).toHaveLength(0);
  });

  test("keeps parallel cables between the same pair as separate links", () => {
    const a = node("a", [port(), port({ netdev: "enP2p1s0f1np1", ibdev: "roceP2p1s0f1", addresses: ["10.100.233.1/24"], subnet: "10.100.233.0/24" })]);
    const b = node("b", [
      port({ addresses: ["10.100.232.2/24"] }),
      port({ netdev: "enP2p1s0f1np1", ibdev: "roceP2p1s0f1", addresses: ["10.100.233.2/24"], subnet: "10.100.233.0/24" }),
    ]);
    expect(pairFabricPorts([a, b]).links).toHaveLength(2);
  });

  test("reports a switched segment instead of inventing pairwise links", () => {
    // With three ports on one subnet a switch is involved, and per-peer traffic
    // cannot be attributed from NIC counters alone.
    const nodes = ["a", "b", "c"].map((id, i) =>
      node(id, [port({ addresses: [`10.100.232.${i + 1}/24`] })])
    );
    const { links, sharedSegments } = pairFabricPorts(nodes);
    expect(links).toHaveLength(0);
    expect(sharedSegments).toHaveLength(1);
    expect(sharedSegments[0]!.members).toHaveLength(3);
  });

  test("cross-checks direction using both endpoints' counters", () => {
    // A transmits 10 GB/s; B receives the same. Counters agree => verified.
    const a = node("a", [port({ rdmaTxBps: 10e9, rdmaRxBps: 2e9 })]);
    const b = node("b", [port({ addresses: ["10.100.232.2/24"], rdmaRxBps: 10e9, rdmaTxBps: 2e9 })]);
    const l = pairFabricPorts([a, b]).links[0]!;
    expect(l.confirmed).toBe(true);
    expect(l.active).toBe(true);
    expect(l.aToBGbps).toBeCloseTo(80, 0); // 10 GB/s => 80 Gb/s
    expect(l.bToAGbps).toBeCloseTo(16, 0);
  });

  test("flags a pairing whose endpoints disagree", () => {
    const a = node("a", [port({ rdmaTxBps: 10e9 })]);
    const b = node("b", [port({ addresses: ["10.100.232.2/24"], rdmaRxBps: 1e9 })]);
    expect(pairFabricPorts([a, b]).links[0]!.confirmed).toBe(false);
  });

  test("verification is sticky once established", () => {
    const st = newAnalysisState();
    const busyA = node("a", [port({ rdmaTxBps: 10e9 })]);
    const busyB = node("b", [port({ addresses: ["10.100.232.2/24"], rdmaRxBps: 10e9 })]);
    expect(buildClusterSnapshot([busyA, busyB], st).fabric.links[0]!.confirmed).toBe(true);

    // Later, idle: counters no longer corroborate, but the cabling is unchanged.
    const idleA = node("a", [port()]);
    const idleB = node("b", [port({ addresses: ["10.100.232.2/24"] })]);
    expect(buildClusterSnapshot([idleA, idleB], st).fabric.links[0]!.confirmed).toBe(true);
  });
});

describe("job inference", () => {
  const container = (over: Partial<DockerContainer>): DockerContainer => ({
    id: "c1", name: "vllm", image: "ghcr.io/x/vllm:1", state: "running", status: "Up",
    createdAt: 0, gpuVramBytes: 100e9,
    distributed: { masterAddr: "10.100.232.1", masterPort: "25000" },
    ...over,
  });

  test("groups containers sharing a rendezvous address into one job", () => {
    const a = node("a", [], { docker: { available: true, containers: [container({ id: "c1", distributed: { masterAddr: "10.100.232.1", masterPort: "25000", rank: "0" } })] } });
    const b = node("b", [], { docker: { available: true, containers: [container({ id: "c2", distributed: { masterAddr: "10.100.232.1", masterPort: "25000", rank: "1" } })] } });
    const jobs = inferJobs([a, b], []);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.members).toHaveLength(2);
    expect(jobs[0]!.totalVramBytes).toBe(200e9);
    expect(jobs[0]!.members.map((m) => m.rank).sort()).toEqual(["0", "1"]);
  });

  test("ignores a workload confined to one node", () => {
    const a = node("a", [], { docker: { available: true, containers: [container({})] } });
    expect(inferJobs([a], [])).toHaveLength(0);
  });

  test("skips stopped containers", () => {
    const a = node("a", [], { docker: { available: true, containers: [container({ id: "c1", state: "exited" })] } });
    const b = node("b", [], { docker: { available: true, containers: [container({ id: "c2", state: "exited" })] } });
    expect(inferJobs([a, b], [])).toHaveLength(0);
  });
});

describe("warnings", () => {
  /*
   * A Spark exposes two RDMA interfaces per QSFP cable. Pinning NCCL to one of
   * them halves usable bandwidth — unlike an idle redundant cable, which is a
   * legitimate topology and must not be reported as a problem.
   */
  const twoPortNode = (id: string, ip: string, containers: DockerContainer[] = []): NodeSnapshot =>
    node(
      id,
      [
        port({ addresses: [`10.100.232.${ip}/24`] }),
        port({ netdev: "p2", ibdev: "ib2", addresses: [`10.100.233.${ip}/24`], subnet: "10.100.233.0/24" }),
      ],
      { docker: { available: true, containers } }
    );

  test("raises nothing at all for a healthy cluster", () => {
    // Tuning observations are not alerts: a correctly running cluster produces
    // an empty alert list.
    const c: DockerContainer = {
      id: "c", name: "vllm", image: "i", state: "running", status: "Up", createdAt: 0,
      distributed: { ncclIbHca: "rocep1s0f1", masterAddr: "10.100.232.1" },
    };
    const snap = buildClusterSnapshot([twoPortNode("a", "1", [c]), twoPortNode("b", "2")]);
    expect(snap.warnings).toHaveLength(0);
  });

  test("never emits an info-severity alert", () => {
    const nodes = ["a", "b", "c"].map((id, i) =>
      node(id, [port({ addresses: [`10.100.232.${i + 1}/24`] })])
    );
    const snap = buildClusterSnapshot(nodes);
    expect(snap.warnings.every((w) => w.severity === "warn" || w.severity === "error")).toBe(true);
  });

  test("reports a switched segment as fabric context, not as an alert", () => {
    const nodes = ["a", "b", "c"].map((id, i) =>
      node(id, [port({ addresses: [`10.100.232.${i + 1}/24`] })])
    );
    const snap = buildClusterSnapshot(nodes);
    expect(snap.fabric.segments).toHaveLength(1);
    expect(snap.fabric.segments[0]!.members).toHaveLength(3);
    expect(snap.warnings.some((w) => /segment/i.test(w.title))).toBe(false);
  });

  test("scores each sensor against its own limit, not a global threshold", () => {
    // A ConnectX-7 ASIC at 95C is well inside its 105C limit; an NVMe at 82C is
    // not, against 85C. Only the drive should raise anything.
    const sensors = [
      { id: "nic", label: "mlx5 asic", kind: "nic" as const, tempC: 95, critC: 105 },
      { id: "ssd", label: "nvme Composite", kind: "nvme" as const, tempC: 82, critC: 85 },
    ];
    const w = buildClusterSnapshot([node("a", [], { thermal: { sensors, maxC: 95 } })]).warnings;
    const hot = w.find((x) => x.id.startsWith("temp-"));
    expect(hot).toBeDefined();
    expect(hot!.detail).toContain("nvme Composite");
    expect(hot!.detail).not.toContain("mlx5");
  });

  test("stays quiet when a hot-running sensor is inside its own limit", () => {
    const sensors = [{ id: "nic", label: "mlx5 asic", kind: "nic" as const, tempC: 95, critC: 105 }];
    const w = buildClusterSnapshot([node("a", [], { thermal: { sensors, maxC: 95 } })]).warnings;
    expect(w.some((x) => x.id.startsWith("temp-"))).toBe(false);
  });

  test("applies hysteresis so a borderline sensor does not flap", () => {
    const st = newAnalysisState();
    // No critC, so the soc fallback limit of 100C applies.
    const hot = (c: number) =>
      node("a", [], { thermal: { sensors: [{ id: "s", label: "acpitz", kind: "soc" as const, tempC: c }], maxC: c } });
    const raised = (c: number) =>
      buildClusterSnapshot([hot(c)], st).warnings.some((w) => w.id.startsWith("temp-"));
    // Raise at 92% of the limit, clear below 89%.
    expect(raised(88)).toBe(false); // below the raise threshold
    expect(raised(93)).toBe(true); // crosses it
    expect(raised(90)).toBe(true); // drops back a little, stays raised
    expect(raised(80)).toBe(false); // clearly recovered
  });

  test("does not treat an idle redundant link as a problem", () => {
    // Traffic on one link, none on the other: a normal, healthy topology.
    const a = node("a", [
      port({ rdmaTxBps: 10e9 }),
      port({ netdev: "p2", ibdev: "ib2", addresses: ["10.100.233.1/24"], subnet: "10.100.233.0/24" }),
    ]);
    const b = node("b", [
      port({ addresses: ["10.100.232.2/24"], rdmaRxBps: 10e9 }),
      port({ netdev: "p2", ibdev: "ib2", addresses: ["10.100.233.2/24"], subnet: "10.100.233.0/24" }),
    ]);
    const w = buildClusterSnapshot([a, b]).warnings;
    expect(w.some((x) => x.id === "fabric-underused")).toBe(false);
    expect(w.some((x) => /idle/i.test(x.title))).toBe(false);
  });

  test("warns when a link negotiates below its peers", () => {
    const a = node("a", [
      port(),
      port({ netdev: "p2", ibdev: "ib2", rateGbps: 40, addresses: ["10.100.233.1/24"], subnet: "10.100.233.0/24" }),
    ]);
    const b = node("b", [
      port({ addresses: ["10.100.232.2/24"] }),
      port({ netdev: "p2", ibdev: "ib2", rateGbps: 40, addresses: ["10.100.233.2/24"], subnet: "10.100.233.0/24" }),
    ]);
    expect(buildClusterSnapshot([a, b]).warnings.some((x) => x.id.startsWith("link-slow-"))).toBe(true);
  });

  test("warns when a distributed container disabled RDMA", () => {
    const c: DockerContainer = {
      id: "c", name: "vllm", image: "i", state: "running", status: "Up", createdAt: 0,
      distributed: { ncclIbDisabled: true },
    };
    const a = node("a", [], { docker: { available: true, containers: [c] } });
    expect(buildClusterSnapshot([a]).warnings.some((x) => x.id.startsWith("nccl-tcp-"))).toBe(true);
  });

  test("reports an unreachable node as an error", () => {
    const a = node("a", [], { status: "error", error: "connect ETIMEDOUT" });
    const w = buildClusterSnapshot([a]).warnings;
    expect(w[0]!.severity).toBe("error");
    expect(w[0]!.detail).toContain("ETIMEDOUT");
  });

  test("surfaces a nearly full filesystem", () => {
    const a = node("a", [], { disks: [{ mount: "/", device: "/dev/nvme0n1p2", totalBytes: 100e9, usedBytes: 96e9, availableBytes: 4e9 }] });
    expect(buildClusterSnapshot([a]).warnings.some((x) => x.id.startsWith("disk-"))).toBe(true);
  });
});

describe("roll-ups", () => {
  test("counts only online nodes", () => {
    const a = node("a", []);
    const b = node("b", [], { status: "offline" });
    const t = buildClusterSnapshot([a, b]).totals;
    expect(t.nodes).toBe(2);
    expect(t.nodesOnline).toBe(1);
    expect(t.cpuCores).toBe(20);
  });
});

describe("formatting", () => {
  test("bytes use binary units", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(107616403456)).toBe("100 GB");
  });

  test("throughput is reported in bits, as network gear is specified", () => {
    expect(fmtBps(0)).toBe("0 bps");
    expect(fmtBps(1e9)).toBe("8.00 Gbps");
    expect(fmtGbps(0.5)).toBe("500 Mbps");
    expect(fmtGbps(200)).toBe("200 Gbps");
  });

  test("durations stay compact", () => {
    expect(fmtDuration(45)).toBe("45s");
    expect(fmtDuration(3700)).toBe("1h 1m");
    expect(fmtDuration(90000)).toBe("1d 1h");
  });

  test("image references drop the digest", () => {
    expect(shortImage("ghcr.io/anemll/dspark-vllm-gx10:0.1.1@sha256:abc")).toBe("anemll/dspark-vllm-gx10:0.1.1");
  });
});

describe("credential sealing", () => {
  test("round-trips under the configured secret", () => {
    process.env.SPARKTOP_SECRET = "test-secret-value";
    const sealed = encryptSecret("hunter2");
    expect(sealed).toStartWith("enc.v1:");
    expect(sealed).not.toContain("hunter2");
    expect(decryptSecret(sealed)).toBe("hunter2");
  });

  test("refuses to open under a different secret", () => {
    process.env.SPARKTOP_SECRET = "secret-one";
    const sealed = encryptSecret("hunter2");
    process.env.SPARKTOP_SECRET = "secret-two";
    expect(() => decryptSecret(sealed)).toThrow(/SPARKTOP_SECRET/);
  });

  test("detects tampering via the auth tag", () => {
    process.env.SPARKTOP_SECRET = "secret-one";
    const sealed = encryptSecret("hunter2");
    const parts = sealed.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  test("compares tokens without leaking length via early exit", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("GB10 low-clock detection", () => {
  /**
   * A GPU reading, defaulting to a healthy part working hard: clocked near its
   * ceiling, drawing real power, nothing throttling.
   */
  const gpu = (over: Partial<GpuMetrics> = {}): GpuMetrics => ({
    name: "NVIDIA GB10", uuid: "u", driverVersion: "580", cudaVersion: "13", unifiedMemory: true,
    utilPct: 96, memUtilPct: null, temperatureC: 61, powerDrawW: 92, powerLimitW: null,
    smClockMhz: 2405, smClockMaxMhz: 3003, throttleReasons: { mask: "0x0", reasons: [] },
    vramTotalBytes: 122e9, vramUsedBytes: 40e9, vramUsedIsDerived: true, processes: [],
    ...over,
  });

  const withGpu = (g: GpuMetrics | null) => buildClusterSnapshot([node("a", [], { gpu: g })]);
  const stuck = (over: Partial<GpuMetrics> = {}) =>
    withGpu(gpu({ smClockMhz: 799, powerDrawW: 19.5, ...over })).warnings.filter((w) =>
      w.id.startsWith("gpu-clock-")
    );

  test("catches the documented signature", () => {
    // 799 MHz of 3003 at 96% utilisation, ~19.5W, no throttle reason, cool.
    const [warning] = stuck();
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("error");
    expect(warning!.detail).toContain("799 MHz");
    expect(warning!.detail).toContain("power-delivery");
  });

  test("says nothing about a healthy part under load", () => {
    expect(withGpu(gpu()).warnings.filter((w) => w.id.startsWith("gpu-clock-"))).toHaveLength(0);
  });

  test("says nothing about an idle GPU", () => {
    // Idle clocks low and draws little — ordinary, and the reason for the
    // utilisation test.
    expect(stuck({ utilPct: 0 })).toHaveLength(0);
  });

  test("stays quiet when the driver owns up to a reason", () => {
    // A declared thermal or power cap is the GPU behaving correctly under a
    // constraint, not the silent fault.
    expect(stuck({ throttleReasons: { mask: "0x40", reasons: ["hardware thermal slowdown"] } })).toHaveLength(0);
    expect(stuck({ throttleReasons: { mask: "0x4", reasons: ["software power cap"] } })).toHaveLength(0);
  });

  test("ignores the idle bit, which is not a real reason", () => {
    expect(stuck({ throttleReasons: { mask: "0x1", reasons: ["idle"] } })).toHaveLength(1);
  });

  test("stays quiet on a hot part, which is ordinary throttling", () => {
    expect(stuck({ temperatureC: 95 })).toHaveLength(0);
  });

  test("stays quiet when the part is drawing real power", () => {
    // Low clock with high power is a different animal and not this fault.
    expect(stuck({ powerDrawW: 90 })).toHaveLength(0);
  });

  test("needs the clock to be far down, not merely off its peak", () => {
    // Boost clocks sit below the ceiling all the time.
    expect(stuck({ smClockMhz: 2200 })).toHaveLength(0);
  });

  test("stays silent when NVML does not report the ceiling", () => {
    expect(stuck({ smClockMaxMhz: null })).toHaveLength(0);
    expect(stuck({ smClockMhz: null })).toHaveLength(0);
  });

  test("says nothing for a node with no GPU", () => {
    expect(withGpu(null).warnings.filter((w) => w.id.startsWith("gpu-clock-"))).toHaveLength(0);
  });
});

describe("interval defaults", () => {
  const tmp = () => join(tmpdir(), `sparktop-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  test("moves a config still carrying the superseded per-second defaults", async () => {
    /*
     * A stored value normally beats a default, which would have left every
     * existing install polling once a second forever — the exact load the new
     * defaults exist to avoid.
     */
    const p = tmp();
    writeFileSync(p, JSON.stringify({ nodes: [], fastIntervalMs: 1000, slowIntervalMs: 10_000, historySize: 300 }));
    const cfg = await loadConfig(p);
    expect(cfg.fastIntervalMs).toBe(5_000);
    expect(cfg.slowIntervalMs).toBe(30_000);
    rmSync(p, { force: true });
  });

  test("leaves a deliberately chosen interval alone", async () => {
    // Anything that is not the old default was picked by someone.
    const p = tmp();
    writeFileSync(p, JSON.stringify({ nodes: [], fastIntervalMs: 2_000, slowIntervalMs: 15_000, historySize: 300 }));
    const cfg = await loadConfig(p);
    expect(cfg.fastIntervalMs).toBe(2_000);
    expect(cfg.slowIntervalMs).toBe(15_000);
    rmSync(p, { force: true });
  });

  test("a fresh install gets the gentler defaults", async () => {
    const cfg = await loadConfig(join(tmpdir(), "sparktop-does-not-exist.json"));
    expect(cfg.fastIntervalMs).toBe(5_000);
    expect(cfg.slowIntervalMs).toBe(30_000);
  });
});
