/**
 * Prometheus exposition.
 *
 * The format is unforgiving in specific ways — a repeated HELP for one family
 * is a parse error, an unescaped quote in a label silently corrupts the series
 * — so the tests target those rather than the happy path alone.
 */

import { describe, expect, test } from "bun:test";
import { renderPrometheus } from "./prometheus.ts";
import type { ClusterSnapshot, NodeSnapshot } from "./types.ts";

function node(over: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    id: "n1",
    label: "spark-01",
    host: "10.0.0.1",
    status: "online",
    error: null,
    ts: 1000,
    probeMs: 250,
    info: {
      hostname: "spark-01", osPretty: "", kernel: "", arch: "aarch64", product: null, sysVendor: null,
      productFamily: null, isSpark: true, variant: "asus", variantName: "ASUS Ascent GX10", vendor: "ASUS",
      uptimeSec: 3600, bootTime: 0,
    },
    cpu: { cores: 20, model: "", usagePct: 50, perCorePct: [], loadAvg: [1.5, 1, 1], freqMhz: 0, procsRunning: 0, procsTotal: 0 },
    memory: { totalBytes: 100, usedBytes: 40, availableBytes: 60, freeBytes: 60, cachedBytes: 0, buffersBytes: 0, sharedBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0 },
    gpu: null,
    thermal: { sensors: [], maxC: null },
    disks: [],
    docker: { available: true, containers: [] },
    network: { interfaces: [] },
    fabric: { ports: [] },
    inference: [],
    ...over,
  };
}

function snap(nodes: NodeSnapshot[]): ClusterSnapshot {
  return {
    ts: 1_700_000_000_000,
    nodes,
    fabric: { links: [], segments: [], totalCapacityGbps: 201.6, totalTrafficGbps: 1.5, idlePorts: 0, totalFaults: 0 },
    jobs: [],
    warnings: [],
    totals: {
      nodes: nodes.length, nodesOnline: nodes.filter((n) => n.status === "online").length, gpus: 0,
      vramTotalBytes: 0, vramUsedBytes: 0, cpuCores: 0, cpuUsagePct: 0, memTotalBytes: 0, memUsedBytes: 0,
      powerDrawW: 0, maxTempC: null, containers: 0, inferenceEndpoints: 0, tokensPerSec: 0, promptTokensPerSec: 0, promptComputedTokensPerSec: 0, generationTokensTotal: 0, promptTokensTotal: 0, cachedPromptTokensTotal: 0,
      requestsRunning: 0, requestsWaiting: 0,
    },
  };
}

/** Every line that is not a comment, as [name+labels, value]. */
const samples = (body: string) =>
  body.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => {
    const i = l.lastIndexOf(" ");
    return [l.slice(0, i), l.slice(i + 1)] as const;
  });

describe("exposition format", () => {
  test("declares each family's HELP and TYPE exactly once across many nodes", () => {
    const body = renderPrometheus(snap([node(), node({ id: "n2", label: "spark-02" }), node({ id: "n3", label: "spark-03" })]));
    const helps = body.split("\n").filter((l) => l.startsWith("# HELP sparktop_cpu_usage_ratio"));
    const types = body.split("\n").filter((l) => l.startsWith("# TYPE sparktop_cpu_usage_ratio"));
    expect(helps).toHaveLength(1);
    expect(types).toHaveLength(1);
    // But one sample per node.
    expect(samples(body).filter(([k]) => k.startsWith("sparktop_cpu_usage_ratio"))).toHaveLength(3);
  });

  test("ends with a newline, as the format requires", () => {
    expect(renderPrometheus(snap([node()]))).toEndWith("\n");
  });

  test("escapes quotes and backslashes in label values", () => {
    // A hostname is operator-supplied and can contain anything.
    const body = renderPrometheus(snap([node({ label: 'we"ird\\host' })]));
    expect(body).toContain('instance="we\\"ird\\\\host"');
  });

  test("converts percentages to 0-1 ratios", () => {
    const body = renderPrometheus(snap([node()]));
    const cpu = samples(body).find(([k]) => k.startsWith("sparktop_cpu_usage_ratio"));
    expect(cpu![1]).toBe("0.5");
  });

  test("reports seconds, not milliseconds", () => {
    const body = renderPrometheus(snap([node({ probeMs: 250 })]));
    const probe = samples(body).find(([k]) => k.startsWith("sparktop_node_probe_duration_seconds"));
    expect(probe![1]).toBe("0.25");
  });
});

describe("absent readings", () => {
  test("omits a metric rather than reporting zero for it", () => {
    // Null temperature must not become 0°C, which would read as a cold GPU.
    const body = renderPrometheus(snap([node({ thermal: { sensors: [], maxC: null } })]));
    expect(body).not.toContain("sparktop_temperature_celsius");
  });

  test("still reports an offline node as down, with nothing else", () => {
    const body = renderPrometheus(snap([node({ status: "offline" })]));
    expect(body).toContain("sparktop_node_up");
    expect(samples(body).find(([k]) => k.startsWith("sparktop_node_up"))![1]).toBe("0");
    // No CPU reading is claimed for a node that did not answer.
    expect(body).not.toContain("sparktop_cpu_usage_ratio");
  });
});

describe("inference", () => {
  const endpoint = (over: Record<string, unknown> = {}) =>
    ({
      id: "n1:8888", nodeId: "n1", nodeLabel: "spark-01", port: 8888, engine: "vllm", engineLabel: "vLLM",
      models: ["deepseek-v4"], reachable: true, requestsRunning: 2, requestsWaiting: 0, requestsFinishedTotal: 10,
      promptTokensTotal: 100, generationTokensTotal: 50, kvCachePct: 25, decodeTokensPerSec: 40,
      prefillTokensPerSec: 5000, prefillComputedTokensPerSec: 130, generationTokensPerSec: 40,
      promptTokensPerSec: 5000, requestsPerMin: 6, cachedPromptTokensTotal: 90, promptCacheHitPct: 90,
      specAcceptanceRatePct: null, specMeanAcceptedLength: null, latencyBasis: "window", ttftMs: 2500,
      interTokenLatencyMs: 100, perRequestDecodeTokensPerSec: 10, e2eLatencyMs: 9000, queueLatencyMs: 0,
      prefillMs: null, decodeMs: null, ...over,
    }) as never;

  test("exports both the ingested and the computed prefill rate", () => {
    const body = renderPrometheus(snap([node({ inference: [endpoint()] })]));
    const s = samples(body);
    expect(s.find(([k]) => k.startsWith("sparktop_inference_prefill_tokens_per_second"))![1]).toBe("5000");
    expect(s.find(([k]) => k.startsWith("sparktop_inference_prefill_computed_tokens_per_second"))![1]).toBe("130");
  });

  test("suppresses latency that is only a lifetime average", () => {
    // Exporting it would put a flat, hours-old mean on a graph that reads as live.
    const body = renderPrometheus(snap([node({ inference: [endpoint({ latencyBasis: "lifetime" })] })]));
    expect(body).not.toContain("sparktop_inference_ttft_seconds");
  });

  test("marks an unreachable endpoint down without inventing readings", () => {
    const body = renderPrometheus(snap([node({ inference: [endpoint({ reachable: false })] })]));
    expect(samples(body).find(([k]) => k.startsWith("sparktop_inference_up"))![1]).toBe("0");
    expect(body).not.toContain("sparktop_inference_decode_tokens_per_second");
  });
});
