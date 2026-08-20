/**
 * Durable history.
 *
 * The interesting behaviour is run bookkeeping: sessions have to survive normal
 * polling, close when a server goes away, split when it comes back after a
 * gap, and not report nonsense when counters reset underneath them.
 */

import { describe, expect, test } from "bun:test";
import { HistoryDb } from "./store.ts";
import type { ClusterSnapshot, InferenceEndpoint, NodeSnapshot } from "./types.ts";

function endpoint(over: Partial<InferenceEndpoint> = {}): InferenceEndpoint {
  // decodeTokensPerSec is canonical; the deprecated alias is mirrored so a
  // fixture that sets either one stays self-consistent.
  const decode = over.decodeTokensPerSec ?? over.generationTokensPerSec;
  const merged: Partial<InferenceEndpoint> =
    decode === undefined ? over : { ...over, decodeTokensPerSec: decode, generationTokensPerSec: decode };
  return {
    id: "n1:8888",
    nodeId: "n1",
    nodeLabel: "spark-01",
    port: 8888,
    engine: "vllm",
    engineLabel: "vLLM",
    models: ["deepseek-v4"],
    reachable: true,
    requestsRunning: 1,
    requestsWaiting: 0,
    requestsFinishedTotal: 100,
    promptTokensTotal: 5000,
    generationTokensTotal: 1000,
    kvCachePct: 12,
    decodeTokensPerSec: 40,
    prefillTokensPerSec: 10,
    generationTokensPerSec: 40,
    promptTokensPerSec: 10,
    requestsPerMin: 6,
    cachedPromptTokensTotal: null,
    promptCacheHitPct: null,
    specAcceptanceRatePct: null,
    specMeanAcceptedLength: null,
    ttftMs: null,
    interTokenLatencyMs: null,
    perRequestDecodeTokensPerSec: null,
    e2eLatencyMs: null,
    queueLatencyMs: null,
    prefillMs: null,
    decodeMs: null,
    ...merged,
  };
}

function snap(ts: number, endpoints: InferenceEndpoint[]): ClusterSnapshot {
  const node: NodeSnapshot = {
    id: "n1", label: "spark-01", host: "10.0.0.1", status: "online", error: null, ts, probeMs: 1,
    info: { hostname: "spark-01", osPretty: "", kernel: "", arch: "", product: null, sysVendor: null,
      productFamily: null, isSpark: true, variant: "asus", variantName: "ASUS Ascent GX10", vendor: "ASUS",
      uptimeSec: 1, bootTime: 0 },
    cpu: { cores: 20, model: "", usagePct: 0, perCorePct: [], loadAvg: [0, 0, 0], freqMhz: 0, procsRunning: 0, procsTotal: 0 },
    memory: { totalBytes: 1, usedBytes: 0, availableBytes: 1, freeBytes: 1, cachedBytes: 0, buffersBytes: 0, sharedBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0 },
    gpu: null, thermal: { sensors: [], maxC: null }, disks: [],
    docker: { available: false, containers: [] }, network: { interfaces: [] },
    fabric: { ports: [] }, inference: endpoints,
  };
  return {
    ts, nodes: [node],
    fabric: { links: [], segments: [], totalCapacityGbps: 0, totalTrafficGbps: 0, idlePorts: 0, totalFaults: 0 },
    jobs: [], warnings: [],
    totals: { nodes: 1, nodesOnline: 1, gpus: 0, vramTotalBytes: 0, vramUsedBytes: 0, cpuCores: 0, cpuUsagePct: 0,
      memTotalBytes: 0, memUsedBytes: 0, powerDrawW: 0, maxTempC: null, containers: 0,
      inferenceEndpoints: endpoints.length, tokensPerSec: 0, requestsRunning: 0, requestsWaiting: 0 },
  };
}

const db = () => new HistoryDb(":memory:", { sampleIntervalMs: 0 });
/*
 * Anchored near the present, because retention is relative: a fixed timestamp
 * from years ago falls outside any sensible window and every row written by a
 * test would be pruned the moment it landed.
 */
const T0 = Date.now();

describe("runs", () => {
  test("opens one run and keeps it open across polls", () => {
    const s = db();
    s.record(snap(T0, [endpoint({ generationTokensTotal: 1000 })]));
    s.record(snap(T0 + 1000, [endpoint({ generationTokensTotal: 1400 })]));
    s.record(snap(T0 + 2000, [endpoint({ generationTokensTotal: 1900 })]));

    const runs = s.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.endedAt).toBeNull();
    // Tokens are the delta across the session, not the lifetime counter.
    expect(runs[0]!.tokensGenerated).toBe(900);
    expect(runs[0]!.model).toBe("deepseek-v4");
    s.close();
  });

  test("tracks peak throughput", () => {
    const s = db();
    s.record(snap(T0, [endpoint({ generationTokensPerSec: 40 })]));
    s.record(snap(T0 + 1000, [endpoint({ generationTokensPerSec: 91.5 })]));
    s.record(snap(T0 + 2000, [endpoint({ generationTokensPerSec: 12 })]));
    expect(s.runs()[0]!.peakTokensPerSec).toBeCloseTo(91.5, 1);
    s.close();
  });

  test("closes a run when the endpoint stops reporting", () => {
    const s = db();
    s.record(snap(T0, [endpoint()]));
    // Six minutes later with nothing serving: past the gap threshold.
    s.record(snap(T0 + 6 * 60_000, []));
    const runs = s.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.endedAt).toBe(T0);
    s.close();
  });

  test("starts a new run after a long gap rather than bridging it", () => {
    const s = db();
    s.record(snap(T0, [endpoint()]));
    s.record(snap(T0 + 20 * 60_000, [endpoint()]));
    const runs = s.runs();
    expect(runs).toHaveLength(2);
    // The older one is closed at its last sighting, not at the new start.
    expect(runs.find((r) => r.startedAt === T0)!.endedAt).toBe(T0);
    s.close();
  });

  test("separates runs per model on the same endpoint", () => {
    const s = db();
    s.record(snap(T0, [endpoint({ models: ["model-a"] })]));
    s.record(snap(T0 + 1000, [endpoint({ models: ["model-b"] })]));
    expect(s.runs().map((r) => r.model).sort()).toEqual(["model-a", "model-b"]);
    s.close();
  });

  test("keeps runs separate per node in a multi-node cluster", () => {
    const s = db();
    s.record(
      snap(T0, [
        endpoint({ id: "n1:8888", nodeId: "n1", nodeLabel: "spark-01" }),
        endpoint({ id: "n2:8888", nodeId: "n2", nodeLabel: "spark-02" }),
        endpoint({ id: "n3:9000", nodeId: "n3", nodeLabel: "spark-03", port: 9000 }),
      ])
    );
    expect(s.runs()).toHaveLength(3);
    expect(new Set(s.runs().map((r) => r.nodeId))).toEqual(new Set(["n1", "n2", "n3"]));
    s.close();
  });

  test("reports zero rather than a negative total when counters reset", () => {
    const s = db();
    s.record(snap(T0, [endpoint({ generationTokensTotal: 50_000 })]));
    // The server restarted: its counter went back to near zero.
    s.record(snap(T0 + 1000, [endpoint({ generationTokensTotal: 12 })]));
    expect(s.runs()[0]!.tokensGenerated).toBe(0);
    s.close();
  });

  test("ignores an endpoint that is not responding", () => {
    const s = db();
    s.record(snap(T0, [endpoint({ reachable: false })]));
    expect(s.runs()).toHaveLength(0);
    s.close();
  });
});

describe("samples", () => {
  test("throttles writes to the sample interval", () => {
    const s = new HistoryDb(":memory:", { sampleIntervalMs: 60_000 });
    for (let i = 0; i < 120; i++) s.record(snap(T0 + i * 1000, [endpoint()]));
    // Two minutes of 1Hz snapshots must not become 120 rows.
    const n = s.samples(0).length;
    expect(n).toBeLessThanOrEqual(3);
    expect(n).toBeGreaterThan(0);
    s.close();
  });

  test("filters by endpoint", () => {
    const s = db();
    s.record(snap(T0, [endpoint({ id: "n1:8888" }), endpoint({ id: "n2:8888", nodeId: "n2" })]));
    expect(s.samples(0, "n2:8888").every((x) => x.endpointId === "n2:8888")).toBe(true);
    expect(s.samples(0)).toHaveLength(2);
    s.close();
  });
});

describe("pruning", () => {
  test("prunes against the data's clock, not the wall clock", () => {
    // Timestamps far from wall-clock time must still be retained, so a host
    // with a wrong clock does not erase its own current history.
    const s = new HistoryDb(":memory:", { sampleIntervalMs: 0, retentionDays: 30 });
    const skewed = Date.now() + 400 * 86_400_000; // a year into the future
    s.record(snap(skewed, [endpoint()]));
    expect(s.samples(0)).toHaveLength(1);
    expect(s.runs()).toHaveLength(1);
    s.close();
  });

  test("drops samples and closed runs past the window", () => {
    const s = new HistoryDb(":memory:", { sampleIntervalMs: 0, retentionDays: 1 });
    const old = T0 - 5 * 86_400_000;
    s.record(snap(old, [endpoint()]));
    s.record(snap(old + 6 * 60_000, [])); // closes the run at `old`
    expect(s.samples(0)).toHaveLength(1);

    // A current snapshot triggers the hourly prune, which is now well past the
    // one-day window relative to that snapshot's own clock.
    s.record(snap(T0, [endpoint()]));

    const samples = s.samples(0);
    expect(samples).toHaveLength(1);
    expect(samples[0]!.ts).toBe(T0); // the stale one went, the fresh one stayed
    expect(s.runs().some((r) => r.startedAt === old)).toBe(false);
    s.close();
  });

  test("reports what a prune removed", () => {
    const s = new HistoryDb(":memory:", { sampleIntervalMs: 0, retentionDays: 1 });
    const old = T0 - 10 * 86_400_000;
    s.record(snap(old, [endpoint()]));
    s.record(snap(old + 6 * 60_000, []));
    const removed = s.prune(T0);
    expect(removed.samples).toBe(1);
    expect(removed.runs).toBe(1);
    s.close();
  });

  test("never prunes an open run, however old", () => {
    const s = new HistoryDb(":memory:", { sampleIntervalMs: 0, retentionDays: 1 });
    s.record(snap(T0 - 90 * 86_400_000, [endpoint()]));
    expect(s.prune(T0).runs).toBe(0);
    expect(s.runs()).toHaveLength(1);
    s.close();
  });
});

describe("summary", () => {
  test("totals tokens and requests across runs", () => {
    const s = db();
    s.record(snap(T0, [endpoint({ generationTokensTotal: 1000, requestsFinishedTotal: 100 })]));
    s.record(snap(T0 + 1000, [endpoint({ generationTokensTotal: 3000, requestsFinishedTotal: 140 })]));
    const sum = s.summary(0);
    expect(sum.tokensGenerated).toBe(2000);
    expect(sum.requestsServed).toBe(40);
    expect(sum.models).toEqual(["deepseek-v4"]);
    s.close();
  });
});
