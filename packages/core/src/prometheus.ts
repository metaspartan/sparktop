/**
 * Prometheus exposition for a cluster snapshot.
 *
 * sparktop already holds everything a scrape wants, so this is a pure
 * projection of the latest snapshot rather than a second collection path — a
 * scrape never touches SSH, never blocks on a node, and cannot slow the
 * collector down. The cost is that metrics are as fresh as the last poll
 * (about a second) rather than as fresh as the scrape, which is the right
 * trade: a Prometheus server scraping every 15s does not want to trigger a
 * fleet-wide SSH round trip, and a slow node would otherwise stall the scrape.
 *
 * Names follow the convention: `sparktop_` prefix, base units (bytes, seconds,
 * ratios rather than percentages where a ratio is standard), `_total` on
 * counters. Where the underlying engine reports a percentage it is exposed as
 * a 0-1 ratio, since that is what Prometheus dashboards expect to multiply.
 */

import type { ClusterSnapshot, InferenceEndpoint, NodeSnapshot } from "./types.ts";

/**
 * Escape a label value per the exposition format: backslash, double quote and
 * newline. Hostnames and model names are operator-supplied, so this cannot be
 * skipped on the assumption that they are tame.
 */
function esc(v: string): string {
  let out = "";
  for (const ch of v) {
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else out += ch;
  }
  return out;
}

/** `{a="1",b="2"}`, or "" when there are no labels. */
function labels(pairs: [string, string | null | undefined][]): string {
  const kept = pairs.filter((p): p is [string, string] => typeof p[1] === "string" && p[1] !== "");
  if (kept.length === 0) return "";
  return `{${kept.map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}`;
}

/**
 * Accumulates lines and emits each family's HELP/TYPE exactly once.
 *
 * Prometheus rejects a duplicated HELP for the same family, which is easy to
 * trip over when a metric is written once per node inside a loop.
 */
class Exposition {
  private lines: string[] = [];
  private declared = new Set<string>();

  metric(
    name: string,
    type: "gauge" | "counter",
    help: string,
    value: number | null | undefined,
    labelPairs: [string, string | null | undefined][] = []
  ): void {
    // A missing reading is omitted rather than sent as zero: absent and "zero
    // right now" mean different things, and 0 would poison an average.
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    if (!this.declared.has(name)) {
      this.declared.add(name);
      this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    }
    this.lines.push(`${name}${labels(labelPairs)} ${value}`);
  }

  toString(): string {
    // The format requires a trailing newline.
    return this.lines.join("\n") + "\n";
  }
}

/** Percentages arrive 0-100; Prometheus convention is a 0-1 ratio. */
const ratio = (pct: number | null | undefined): number | null =>
  pct === null || pct === undefined ? null : pct / 100;

function nodeMetrics(e: Exposition, n: NodeSnapshot): void {
  const l: [string, string | null | undefined][] = [
    ["node", n.id],
    ["instance", n.label],
  ];

  e.metric("sparktop_node_up", "gauge", "1 when the node answered its last poll.", n.status === "online" ? 1 : 0, l);
  e.metric("sparktop_node_probe_duration_seconds", "gauge", "Wall time of the last probe.", n.probeMs / 1000, l);
  if (n.status !== "online") return;

  e.metric("sparktop_node_uptime_seconds", "gauge", "Seconds since boot.", n.info.uptimeSec, l);
  e.metric("sparktop_cpu_usage_ratio", "gauge", "CPU busy, 0-1.", ratio(n.cpu.usagePct), l);
  e.metric("sparktop_cpu_cores", "gauge", "Logical cores.", n.cpu.cores, l);
  e.metric("sparktop_load1", "gauge", "One-minute load average.", n.cpu.loadAvg[0], l);
  e.metric("sparktop_memory_total_bytes", "gauge", "System memory.", n.memory.totalBytes, l);
  e.metric("sparktop_memory_used_bytes", "gauge", "System memory in use.", n.memory.usedBytes, l);

  if (n.gpu) {
    const gl: [string, string | null | undefined][] = [...l, ["gpu", n.gpu.name]];
    e.metric("sparktop_gpu_utilization_ratio", "gauge", "GPU utilisation, 0-1.", ratio(n.gpu.utilPct), gl);
    e.metric("sparktop_gpu_temperature_celsius", "gauge", "GPU temperature.", n.gpu.temperatureC, gl);
    e.metric("sparktop_gpu_power_watts", "gauge", "GPU power draw.", n.gpu.powerDrawW, gl);
    /*
     * GB10 shares one LPDDR5X pool between CPU and GPU and NVML reports the
     * framebuffer as [N/A], so these are derived. They are still the right
     * numbers to alert on; the derivation is documented in HELP so nobody
     * mistakes them for NVML's own.
     */
    e.metric("sparktop_gpu_sm_clock_hertz", "gauge", "Current SM clock.", n.gpu.smClockMhz === null ? null : n.gpu.smClockMhz * 1e6, gl);
    e.metric("sparktop_gpu_sm_clock_max_hertz", "gauge", "SM clock ceiling the part will boost to.", n.gpu.smClockMaxMhz === null ? null : n.gpu.smClockMaxMhz * 1e6, gl);
    /*
     * Exported so the silent-throttle case can be alerted on rather than only
     * watched: a rule comparing sm_clock to sm_clock_max while utilisation is
     * high and this is 0 catches a GB10 stuck by the power-delivery fault,
     * which announces itself in no other metric.
     */
    if (n.gpu.throttleReasons) {
      e.metric("sparktop_gpu_throttle_reasons", "gauge", "Count of active NVML clock-event reasons, excluding idle.", n.gpu.throttleReasons.reasons.filter((r) => r !== "idle").length, gl);
    }
    e.metric("sparktop_gpu_memory_total_bytes", "gauge", "GPU memory total. On unified-memory parts this is the shared system pool.", n.gpu.vramTotalBytes, gl);
    e.metric("sparktop_gpu_memory_used_bytes", "gauge", "GPU memory in use. On unified-memory parts this is summed from live process allocations.", n.gpu.vramUsedBytes, gl);
  }

  for (const s of n.thermal.sensors) {
    e.metric("sparktop_temperature_celsius", "gauge", "Temperature per sensor.", s.tempC, [...l, ["sensor", s.label], ["kind", s.kind]]);
  }

  for (const d of n.disks) {
    const dl: [string, string | null | undefined][] = [...l, ["mount", d.mount]];
    e.metric("sparktop_disk_total_bytes", "gauge", "Filesystem size.", d.totalBytes, dl);
    e.metric("sparktop_disk_used_bytes", "gauge", "Filesystem used.", d.usedBytes, dl);
  }

  for (const p of n.fabric.ports) {
    const pl: [string, string | null | undefined][] = [...l, ["port", p.netdev], ["ibdev", p.ibdev]];
    e.metric("sparktop_fabric_port_up", "gauge", "1 when the port has carrier.", p.linkUp ? 1 : 0, pl);
    e.metric("sparktop_fabric_port_rate_bits_per_second", "gauge", "Sustainable port rate.", p.rateGbps * 1e9, pl);
    e.metric("sparktop_fabric_rdma_received_bytes_total", "counter", "RDMA bytes received on this port.", p.rdmaRxBytes, pl);
    e.metric("sparktop_fabric_rdma_transmitted_bytes_total", "counter", "RDMA bytes transmitted on this port.", p.rdmaTxBytes, pl);
  }

  e.metric("sparktop_containers", "gauge", "Containers present.", n.docker.containers.length, l);
}

function inferenceMetrics(e: Exposition, ep: InferenceEndpoint): void {
  if (!ep.reachable) {
    e.metric("sparktop_inference_up", "gauge", "1 when the inference endpoint answered.", 0, [
      ["node", ep.nodeId],
      ["instance", ep.nodeLabel],
      ["port", String(ep.port)],
    ]);
    return;
  }
  const l: [string, string | null | undefined][] = [
    ["node", ep.nodeId],
    ["instance", ep.nodeLabel],
    ["port", String(ep.port)],
    ["engine", ep.engine],
    // One label per endpoint, so a multi-model server reports its first served
    // model rather than exploding the label set into a new time series per
    // combination.
    ["model", ep.models[0]],
  ];

  e.metric("sparktop_inference_up", "gauge", "1 when the inference endpoint answered.", 1, l);
  e.metric("sparktop_inference_requests_running", "gauge", "Requests generating now.", ep.requestsRunning, l);
  e.metric("sparktop_inference_requests_waiting", "gauge", "Requests queued.", ep.requestsWaiting, l);
  e.metric("sparktop_inference_requests_total", "counter", "Requests completed since the engine started.", ep.requestsFinishedTotal, l);
  e.metric("sparktop_inference_prompt_tokens_total", "counter", "Prompt tokens accepted, cache hits included.", ep.promptTokensTotal, l);
  e.metric("sparktop_inference_generation_tokens_total", "counter", "Output tokens produced.", ep.generationTokensTotal, l);
  e.metric("sparktop_inference_cached_prompt_tokens_total", "counter", "Prompt tokens served from the prefix cache.", ep.cachedPromptTokensTotal, l);

  e.metric("sparktop_inference_decode_tokens_per_second", "gauge", "Output tokens per second, aggregate.", ep.decodeTokensPerSec, l);
  e.metric("sparktop_inference_prefill_tokens_per_second", "gauge", "Prompt tokens accepted per second, cache hits included.", ep.prefillTokensPerSec, l);
  e.metric("sparktop_inference_prefill_computed_tokens_per_second", "gauge", "Prompt tokens that reached the model, per second.", ep.prefillComputedTokensPerSec, l);
  e.metric("sparktop_inference_kv_cache_ratio", "gauge", "KV cache utilisation, 0-1.", ratio(ep.kvCachePct), l);
  e.metric("sparktop_inference_prefix_cache_hit_ratio", "gauge", "Prompt tokens served from cache, 0-1.", ratio(ep.promptCacheHitPct), l);
  e.metric("sparktop_inference_spec_acceptance_ratio", "gauge", "Speculative draft tokens accepted, 0-1.", ratio(ep.specAcceptanceRatePct), l);

  /*
   * Latency is exported only when it describes the recent window. A lifetime
   * average would be indistinguishable from a live one once scraped, and would
   * sit flat in a graph looking like a real measurement.
   */
  if (ep.latencyBasis === "window") {
    e.metric("sparktop_inference_ttft_seconds", "gauge", "Mean time to first token over the last minute.", ep.ttftMs === null ? null : ep.ttftMs / 1000, l);
    e.metric("sparktop_inference_inter_token_latency_seconds", "gauge", "Mean inter-token latency over the last minute.", ep.interTokenLatencyMs === null ? null : ep.interTokenLatencyMs / 1000, l);
    e.metric("sparktop_inference_e2e_latency_seconds", "gauge", "Mean end-to-end request latency over the last minute.", ep.e2eLatencyMs === null ? null : ep.e2eLatencyMs / 1000, l);
    e.metric("sparktop_inference_queue_latency_seconds", "gauge", "Mean queue wait over the last minute.", ep.queueLatencyMs === null ? null : ep.queueLatencyMs / 1000, l);
  }
}

/** Render a snapshot as a Prometheus exposition body. */
export function renderPrometheus(snap: ClusterSnapshot): string {
  const e = new Exposition();

  e.metric("sparktop_nodes", "gauge", "Nodes configured.", snap.totals.nodes);
  e.metric("sparktop_nodes_online", "gauge", "Nodes answering.", snap.totals.nodesOnline);
  e.metric("sparktop_snapshot_timestamp_seconds", "gauge", "When the exported snapshot was collected.", snap.ts / 1000);

  for (const n of snap.nodes) nodeMetrics(e, n);
  for (const n of snap.nodes) for (const ep of n.inference ?? []) inferenceMetrics(e, ep);

  for (const l of snap.fabric.links) {
    const ll: [string, string | null | undefined][] = [
      ["link", l.id],
      ["a", l.a.nodeLabel],
      ["b", l.b.nodeLabel],
    ];
    e.metric("sparktop_fabric_link_up", "gauge", "1 when both ends of the link have carrier.", l.up ? 1 : 0, ll);
    e.metric("sparktop_fabric_link_confirmed", "gauge", "1 when traffic corroborated the pairing.", l.confirmed ? 1 : 0, ll);
    e.metric("sparktop_fabric_link_rate_bits_per_second", "gauge", "Sustainable link rate.", l.rateGbps * 1e9, ll);
    e.metric("sparktop_fabric_link_throughput_bits_per_second", "gauge", "Current throughput, per direction.", l.aToBGbps * 1e9, [...ll, ["direction", "a_to_b"]]);
    e.metric("sparktop_fabric_link_throughput_bits_per_second", "gauge", "Current throughput, per direction.", l.bToAGbps * 1e9, [...ll, ["direction", "b_to_a"]]);
  }

  e.metric("sparktop_fabric_capacity_bits_per_second", "gauge", "Sum of link capacity.", snap.fabric.totalCapacityGbps * 1e9);
  e.metric("sparktop_fabric_traffic_bits_per_second", "gauge", "Sum of link throughput.", snap.fabric.totalTrafficGbps * 1e9);

  return e.toString();
}

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
