/**
 * History alignment.
 *
 * Every series must stay exactly index-aligned with the shared timeline. A
 * chart reads `series[k][i]` as the value at `ts[i]`, so a single off-by-one
 * silently shifts every line against the clock.
 */

import { describe, expect, test } from "bun:test";
import { HistoryStore } from "./history.ts";
import type { ClusterSnapshot, NodeSnapshot } from "./types.ts";

function node(id: string, status: NodeSnapshot["status"] = "online"): NodeSnapshot {
  return {
    id, label: id, host: "10.0.0.1", status, error: null, ts: 0, probeMs: 1,
    info: { hostname: id, osPretty: "", kernel: "", arch: "", product: null, sysVendor: null, productFamily: null, isSpark: true, variant: "unknown" as const, variantName: "DGX Spark", vendor: "Unknown", uptimeSec: 1, bootTime: 0 },
    cpu: { cores: 20, model: "", usagePct: 50, perCorePct: [], loadAvg: [0, 0, 0], freqMhz: 0, procsRunning: 0, procsTotal: 0 },
    memory: { totalBytes: 100, usedBytes: 50, availableBytes: 50, freeBytes: 0, cachedBytes: 0, buffersBytes: 0, sharedBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0 },
    gpu: null,
    thermal: { sensors: [], maxC: 60 },
    disks: [],
    docker: { available: false, containers: [] },
    network: { interfaces: [] },
    fabric: { ports: [] },
    inference: [],
  };
}

const snap = (nodes: NodeSnapshot[], ts: number): ClusterSnapshot => ({
  ts, nodes,
  fabric: { links: [], segments: [], totalCapacityGbps: 0, totalTrafficGbps: 0, idlePorts: 0, totalFaults: 0 },
  jobs: [], warnings: [],
  totals: {
    nodes: nodes.length, nodesOnline: nodes.filter((n) => n.status === "online").length, gpus: 0,
    vramTotalBytes: 0, vramUsedBytes: 0, cpuCores: 0, cpuUsagePct: 0,
    memTotalBytes: 0, memUsedBytes: 0, powerDrawW: 0, maxTempC: null, containers: 0,
    inferenceEndpoints: 0, tokensPerSec: 0, requestsRunning: 0, requestsWaiting: 0,
  },
});

/** Every series is the same length as the timeline. */
function expectAligned(store: HistoryStore): number {
  const p = store.payload();
  for (const [key, values] of Object.entries(p.series)) {
    expect(`${key}:${values.length}`).toBe(`${key}:${p.ts.length}`);
  }
  return p.ts.length;
}

describe("HistoryStore", () => {
  test("keeps every series aligned with the timeline", () => {
    const s = new HistoryStore(100);
    for (let i = 0; i < 5; i++) s.record(snap([node("a"), node("b")], 1000 + i));
    expect(expectAligned(s)).toBe(5);
  });

  test("back-fills a node that joins later", () => {
    const s = new HistoryStore(100);
    for (let i = 0; i < 4; i++) s.record(snap([node("a")], 1000 + i));
    // b appears on the fifth tick and must not shift its samples earlier in time.
    for (let i = 4; i < 7; i++) s.record(snap([node("a"), node("b")], 1000 + i));

    const p = s.payload();
    expect(p.ts).toHaveLength(7);
    expectAligned(s);
    const b = p.series["b:cpu"]!;
    expect(b.slice(0, 4)).toEqual([null, null, null, null]);
    expect(b.slice(4)).toEqual([50, 50, 50]);
  });

  test("records a gap rather than a zero while a node is offline", () => {
    const s = new HistoryStore(100);
    s.record(snap([node("a")], 1));
    s.record(snap([node("a", "error")], 2));
    s.record(snap([node("a")], 3));
    expect(s.payload().series["a:cpu"]).toEqual([50, null, 50]);
  });

  test("stays aligned after the buffer wraps", () => {
    const s = new HistoryStore(10);
    for (let i = 0; i < 40; i++) s.record(snap([node("a")], 1000 + i));
    const p = s.payload();
    expect(p.ts).toHaveLength(10);
    expectAligned(s);
    // Oldest-first, ending at the most recent sample.
    expect(p.ts[9]).toBe(1039);
  });

  test("keeps a departed node aligned until it is pruned", () => {
    const s = new HistoryStore(100);
    s.record(snap([node("a"), node("b")], 1));
    s.record(snap([node("a")], 2));
    expectAligned(s);
    expect(s.payload().series["b:cpu"]).toEqual([50, null]);

    s.prune(new Set(["a"]));
    expect(s.payload().series["b:cpu"]).toBeUndefined();
    expect(s.payload().series["a:cpu"]).toBeDefined();
  });
});
