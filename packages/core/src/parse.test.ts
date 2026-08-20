/**
 * Parser tests, built from output captured on real DGX Spark hardware.
 *
 * The GB10-specific cases matter most: NVML reports framebuffer totals as
 * `[N/A]` on unified memory, IB counters are in 4-octet words, and a Spark has
 * four identically named mlx5 hwmon chips that must not collide.
 */

import { describe, expect, test } from "bun:test";
import { RS, US } from "./probe.ts";
import {
  applyDockerEnv,
  applyGpuProcDetail,
  cpuPctBetween,
  parseCpuInfo,
  parseCpuTimes,
  parseDockerSize,
  parseEthtool,
  parseFabricHwmon,
  parseFabricMap,
  parseFabricSys,
  parseGpuGraphics,
  parseGpuProcs,
  parseGpuQuery,
  parseHwmon,
  parseIpAddr,
  parseMeminfo,
  parseNetDev,
  parseRateGbps,
  splitSections,
} from "./parse.ts";
import { subnetOf } from "./node.ts";
import type { DockerContainer } from "./types.ts";

describe("splitSections", () => {
  test("splits on record separators", () => {
    const raw = `${RS}alpha\nline1\nline2\n${RS}beta\nvalue\n`;
    const s = splitSections(raw);
    expect(s.alpha).toBe("line1\nline2\n");
    expect(s.beta).toBe("value\n");
  });

  test("tolerates an empty section body", () => {
    expect(splitSections(`${RS}empty\n${RS}next\nx\n`).empty).toBe("");
  });
});

describe("CPU", () => {
  const stat = `cpu  207628 394 199846 26338550 32633 0 11635 0 0 0
cpu0 2669 0 5732 1324866 816 0 1146 0 0 0
cpu1 2614 0 6322 1321599 763 0 488 0 0 0`;

  test("parses aggregate and per-core times", () => {
    const t = parseCpuTimes(stat);
    expect(t.cores).toHaveLength(2);
    expect(t.all.total).toBe(207628 + 394 + 199846 + 26338550 + 32633 + 0 + 11635);
    // idle = idle + iowait
    expect(t.all.idle).toBe(26338550 + 32633);
  });

  test("computes busy percentage between samples", () => {
    // 100 jiffies elapsed, 25 of them idle => 75% busy.
    const prev = { total: 1000, idle: 800 };
    expect(cpuPctBetween(prev, { total: 1100, idle: 825 })).toBe(75);
  });

  test("reports zero without a previous sample", () => {
    expect(cpuPctBetween(undefined, { total: 100, idle: 50 })).toBe(0);
  });

  test("joins heterogeneous CPU models", () => {
    // A GB10 pairs performance and efficiency clusters.
    expect(parseCpuInfo("20\nCortex-X925\nCortex-A725\nCortex-X925").model).toBe(
      "Cortex-X925 + Cortex-A725"
    );
    expect(parseCpuInfo("20\nCortex-X925\n").cores).toBe(20);
  });
});

describe("memory", () => {
  test("converts kB to bytes and derives used", () => {
    const m = parseMeminfo(`MemTotal:       127535276 kB
MemFree:         2149448 kB
MemAvailable:    8134368 kB
Buffers:           42144 kB
Cached:          6812020 kB
SwapTotal:      16777212 kB
SwapFree:       13635544 kB
Shmem:           3742096 kB`);
    expect(m.totalBytes).toBe(127535276 * 1024);
    expect(m.usedBytes).toBe((127535276 - 8134368) * 1024);
    expect(m.swapUsedBytes).toBe((16777212 - 13635544) * 1024);
  });
});

describe("GPU", () => {
  // Captured from a GB10: unified memory reports totals as [N/A].
  const csv =
    "0, NVIDIA GB10, GPU-4e847c30-3500-f40c-2152-17cc7b272fd4, 580.173.02, 0, 0, 55, 13.46, [N/A], 2405, [N/A], [N/A]";

  test("treats [N/A] as null rather than zero", () => {
    const g = parseGpuQuery(csv)[0]!;
    expect(g.name).toBe("NVIDIA GB10");
    expect(g.temperatureC).toBe(55);
    expect(g.powerDrawW).toBe(13.46);
    expect(g.powerLimitW).toBeNull();
    expect(g.memTotalBytes).toBeNull();
    expect(g.memUsedBytes).toBeNull();
  });

  test("parses compute apps and converts MiB", () => {
    const p = parseGpuProcs("197277, VLLM::Worker_TP0, 102625")[0]!;
    expect(p.pid).toBe(197277);
    expect(p.vramBytes).toBe(102625 * 1024 * 1024);
    expect(p.type).toBe("compute");
  });

  test("enriches processes with ps detail and container id", () => {
    const procs = parseGpuProcs("197277, VLLM::Worker_TP0, 102625");
    const cid = "b41e76f04cbabc549d1c30fd219b8686f894a7a87271c3b39c75d5d67666454d";
    applyGpuProcDetail(procs, ` 197277 root     37.6 3889616  4637\n---\n197277${US}${cid}`);
    const p = procs[0]!;
    expect(p.user).toBe("root");
    expect(p.cpuPct).toBe(37.6);
    expect(p.rssBytes).toBe(3889616 * 1024);
    expect(p.elapsedSec).toBe(4637);
    expect(p.containerId).toBe(cid);
  });

  test("scrapes graphics contexts from the nvidia-smi table", () => {
    const g = parseGpuGraphics(
      "|    0   N/A  N/A            3067      G   /usr/lib/xorg/Xorg                       18MiB |"
    )[0]!;
    expect(g.pid).toBe(3067);
    expect(g.type).toBe("graphics");
    expect(g.vramBytes).toBe(18 * 1024 * 1024);
  });
});

describe("thermal", () => {
  // Four mlx5 chips share a name; they must remain distinct sensors.
  const body = `/sys/class/hwmon/hwmon0/name:acpitz
/sys/class/hwmon/hwmon2/name:mlx5
/sys/class/hwmon/hwmon3/name:mlx5
/sys/class/hwmon/hwmon0/temp1_input:57800
/sys/class/hwmon/hwmon2/temp1_input:62000
/sys/class/hwmon/hwmon3/temp1_input:61000
/sys/class/hwmon/hwmon2/temp1_label:asic
/sys/class/hwmon/hwmon3/temp1_label:asic
/sys/class/hwmon/hwmon2/temp1_crit:105000`;

  test("disambiguates repeated chip names and keeps the source dir", () => {
    const s = parseHwmon(body);
    expect(s).toHaveLength(3);
    const nics = s.filter((x) => x.kind === "nic");
    expect(nics.map((n) => n.id)).toEqual(["mlx50:temp1", "mlx51:temp1"]);
    expect(nics[0]!.source).toBe("hwmon2");
    expect(nics[0]!.tempC).toBe(62);
    expect(nics[0]!.critC).toBe(105);
  });

  test("classifies sensor kinds", () => {
    expect(parseHwmon(body).find((x) => x.source === "hwmon0")!.kind).toBe("soc");
  });

  test("rejects implausible readings", () => {
    expect(parseHwmon(`/sys/class/hwmon/hwmon0/name:x\n/sys/class/hwmon/hwmon0/temp1_input:0`)).toHaveLength(0);
  });
});

describe("fabric", () => {
  test("maps RDMA devices to their netdevs", () => {
    const m = parseFabricMap(`/sys/class/infiniband/rocep1s0f1/device/net/enp1s0f1np1
/sys/class/infiniband/roceP2p1s0f1/device/net/enP2p1s0f1np1`);
    expect(m.get("rocep1s0f1")).toBe("enp1s0f1np1");
    expect(m.get("roceP2p1s0f1")).toBe("enP2p1s0f1np1");
  });

  test("maps RDMA devices to their hwmon chip", () => {
    const m = parseFabricHwmon("/sys/class/infiniband/rocep1s0f1/device/hwmon/hwmon2");
    expect(m.get("rocep1s0f1")).toBe("hwmon2");
  });

  test("groups sysfs counters by device, keeping colons in values", () => {
    const v = parseFabricSys(`/sys/class/infiniband/rocep1s0f1/ports/1/rate:200 Gb/sec (2X NDR)
/sys/class/infiniband/rocep1s0f1/ports/1/state:4: ACTIVE
/sys/class/infiniband/rocep1s0f1/ports/1/counters/port_rcv_data:81408901908
/sys/class/infiniband/rocep1s0f1/ports/1/hw_counters/np_cnp_sent:7`).get("rocep1s0f1")!;
    expect(v.rate).toBe("200 Gb/sec (2X NDR)");
    expect(v.state).toBe("4: ACTIVE");
    expect(v.counters.get("port_rcv_data")).toBe(81408901908);
    expect(v.hwCounters.get("np_cnp_sent")).toBe(7);
  });

  test("parses negotiated rate", () => {
    expect(parseRateGbps("200 Gb/sec (2X NDR)")).toBe(200);
    expect(parseRateGbps("40 Gb/sec (4X QDR)")).toBe(40);
    expect(parseRateGbps("")).toBe(0);
  });

  test("parses per-interface ethtool RDMA counters", () => {
    const m = parseEthtool(`IF${US}enp1s0f1np1
rx_vport_unicast_bytes:5222779
rx_vport_rdma_unicast_bytes:325635607632
IF${US}enP2p1s0f1np1
rx_vport_rdma_unicast_bytes:12`);
    expect(m.get("enp1s0f1np1")!.get("rx_vport_rdma_unicast_bytes")).toBe(325635607632);
    expect(m.get("enP2p1s0f1np1")!.get("rx_vport_rdma_unicast_bytes")).toBe(12);
  });

  test("derives the network key used to pair ports across nodes", () => {
    expect(subnetOf("10.100.232.1/24")).toBe("10.100.232.0/24");
    expect(subnetOf("10.100.232.2/24")).toBe("10.100.232.0/24");
    expect(subnetOf("192.168.1.149/24")).toBe("192.168.1.0/24");
    expect(subnetOf("172.16.5.9/16")).toBe("172.16.0.0/16");
    expect(subnetOf(undefined)).toBeNull();
    expect(subnetOf("garbage")).toBeNull();
  });
});

describe("network", () => {
  test("reads rx and tx byte columns from /proc/net/dev", () => {
    const m = parseNetDev(`Inter-|   Receive                    |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets
enp1s0f1np1: 5647020   38909    0    0    0     0          0      1973 37496464   50127    0    2    0     0       0          0`);
    const v = m.get("enp1s0f1np1")!;
    expect(v.rxBytes).toBe(5647020);
    expect(v.txBytes).toBe(37496464);
  });

  test("parses ip -o -4 addr output", () => {
    const m = parseIpAddr(
      "3: enp1s0f1np1    inet 10.100.232.1/24 brd 10.100.232.255 scope global enp1s0f1np1\\       valid_lft forever"
    );
    expect(m.get("enp1s0f1np1")).toEqual(["10.100.232.1/24"]);
  });
});

describe("docker", () => {
  test("parses human-readable sizes", () => {
    expect(parseDockerSize("7.17GiB")).toBeCloseTo(7.17 * 1024 ** 3, 0);
    expect(parseDockerSize("512MB")).toBe(512e6);
    expect(parseDockerSize("nonsense")).toBe(0);
  });

  test("extracts distributed-runtime hints from container env", () => {
    const containers: DockerContainer[] = [
      { id: "abc123", name: "vllm", image: "img", state: "running", status: "Up", createdAt: 0 },
    ];
    applyDockerEnv(
      containers,
      ["abc123", "NETWORKMODE=host", "MASTER_ADDR=10.100.232.1", "MASTER_PORT=25000",
       "NCCL_IB_HCA=rocep1s0f1", "NCCL_IB_DISABLE=0", "RANK=1",
       "DSPARK_MODEL=deepseek-ai/DeepSeek-V4-Flash-0731"].join(US)
    );
    const d = containers[0]!.distributed!;
    expect(containers[0]!.networkMode).toBe("host");
    expect(d.masterAddr).toBe("10.100.232.1");
    expect(d.ncclIbHca).toBe("rocep1s0f1");
    expect(d.ncclIbDisabled).toBe(false);
    expect(d.rank).toBe("1");
    expect(d.model).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
  });

  test("flags containers that opted out of RDMA", () => {
    const containers: DockerContainer[] = [
      { id: "abc", name: "x", image: "i", state: "running", status: "Up", createdAt: 0 },
    ];
    applyDockerEnv(containers, ["abc", "NCCL_IB_DISABLE=1"].join(US));
    expect(containers[0]!.distributed!.ncclIbDisabled).toBe(true);
  });
});
