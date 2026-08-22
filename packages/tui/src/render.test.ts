/**
 * Frame composition.
 *
 * The property that matters is that a frame fits its terminal. Truncation
 * hides whatever happens to be last, which is how a short window lost the
 * interconnect and inference panels entirely.
 */

import { describe, expect, test } from "bun:test";
import { render, type RenderState } from "./render.ts";
import type { ClusterSnapshot, NodeSnapshot } from "@sparktop/core";

function node(id: string, label: string): NodeSnapshot {
  return {
    id, label, host: "10.0.0.1", status: "online", error: null, ts: 1, probeMs: 200,
    info: {
      hostname: label, osPretty: "", kernel: "", arch: "aarch64", product: null, sysVendor: null,
      productFamily: null, isSpark: true, variant: "asus", variantName: "ASUS Ascent GX10",
      vendor: "ASUS", uptimeSec: 3600, bootTime: 0,
    },
    cpu: {
      cores: 20, model: "", usagePct: 12,
      perCorePct: Array.from({ length: 20 }, (_, i) => i * 3),
      loadAvg: [1, 1, 1], freqMhz: 3900, procsRunning: 1, procsTotal: 900,
    },
    memory: {
      totalBytes: 130e9, usedBytes: 115e9, availableBytes: 15e9, freeBytes: 15e9,
      cachedBytes: 0, buffersBytes: 0, sharedBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0,
    },
    gpu: {
      name: "NVIDIA GB10", uuid: "u", driverVersion: "580", cudaVersion: "13", unifiedMemory: true,
      utilPct: 96, memUtilPct: null, temperatureC: 61, powerDrawW: 53, powerLimitW: 140,
      smClockMhz: 2405, smClockMaxMhz: 3003, throttleReasons: { mask: "0x0", reasons: [] },
      vramTotalBytes: 122e9, vramUsedBytes: 101e9, vramUsedIsDerived: true,
      processes: [],
    },
    thermal: { sensors: [], maxC: 61 },
    disks: [{ device: "/dev/nvme0n1p2", mount: "/", totalBytes: 915e9, usedBytes: 221e9, availableBytes: 694e9 }],
    docker: { available: true, containers: [] },
    network: { interfaces: [] },
    fabric: { ports: [] },
    inference: [],
  };
}

function snapshot(nodeCount: number): ClusterSnapshot {
  const nodes = Array.from({ length: nodeCount }, (_, i) => node(`n${i}`, `gx10-000${i}`));
  return {
    ts: Date.now(), nodes,
    fabric: {
      links: [], segments: [], totalCapacityGbps: 201.6, totalTrafficGbps: 1.3,
      idlePorts: 0, totalFaults: 0,
    },
    jobs: [], warnings: [],
    totals: {
      nodes: nodeCount, nodesOnline: nodeCount, gpus: nodeCount,
      vramTotalBytes: 122e9 * nodeCount, vramUsedBytes: 101e9 * nodeCount,
      cpuCores: 20 * nodeCount, cpuUsagePct: 12, memTotalBytes: 130e9 * nodeCount,
      memUsedBytes: 115e9 * nodeCount, powerDrawW: 53 * nodeCount, maxTempC: 61,
      containers: 0, inferenceEndpoints: 0, tokensPerSec: 0, promptTokensPerSec: 0, promptComputedTokensPerSec: 0, generationTokensTotal: 0, promptTokensTotal: 0, cachedPromptTokensTotal: 0, requestsRunning: 0, requestsWaiting: 0,
    },
  };
}

const state = (width: number, height: number): RenderState => ({
  view: "overview", selected: -1, width, height, paused: false, history: new Map(),
});

const SIZES: [number, number][] = [
  [60, 20], [80, 24], [80, 16], [80, 12], [100, 30], [120, 30],
  [120, 45], [140, 60], [190, 80], [200, 100],
];

describe("overview fits the terminal", () => {
  test.each(SIZES)("at %ix%i", (w, h) => {
    for (const count of [1, 2, 4]) {
      const lines = render(snapshot(count), state(w, h));
      // The frame loop reserves two rows; below a floor it cannot win, and the
      // ladder bottoms out rather than looping forever.
      const budget = Math.max(8, h - 2);
      expect(lines.length).toBeLessThanOrEqual(budget);
    }
  });

  test.each(SIZES)("never exceeds the width at %ix%i", (w, h) => {
    const lines = render(snapshot(2), state(w, h));
    for (const l of lines) {
      expect(l.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(w);
    }
  });
});

describe("what survives when space runs out", () => {
  test("still names every node on a small window", () => {
    const lines = render(snapshot(3), state(80, 16)).join("\n");
    for (const label of ["gx10-0000", "gx10-0001", "gx10-0002"]) {
      expect(lines).toContain(label);
    }
  });

  test("uses the extra room a large window gives it", () => {
    const small = render(snapshot(2), state(120, 30)).length;
    const large = render(snapshot(2), state(120, 60)).length;
    expect(large).toBeGreaterThan(small);
  });

  test("keeps the header at every size", () => {
    for (const [w, h] of SIZES) {
      expect(render(snapshot(2), state(w, h))[0]).toContain("sparktop");
    }
  });
});
