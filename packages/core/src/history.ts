/**
 * Fixed-size time series buffers.
 *
 * One shared timeline, many value series. Every series is written on every tick
 * — with NaN standing in for "no reading" — so all of them stay index-aligned
 * with the timestamp array. That alignment is a hard requirement for charting:
 * a node that is briefly offline must leave a gap in its own line, not shift
 * its remaining samples onto the wrong times.
 *
 * Sharing one timestamp array also keeps the payload small, since a dozen
 * series no longer each carry a copy of it.
 */

import type { ClusterSnapshot, HistoryPayload } from "./types.ts";

class Ring {
  private buf: Float64Array;
  private head = 0;
  private len = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  /** Consecutive empty samples, used to retire a series that has gone silent. */
  private blank = 0;

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.len < this.capacity) this.len++;
    this.blank = Number.isNaN(v) ? this.blank + 1 : 0;
  }

  /** True once every retained sample is empty, so the series holds nothing. */
  get isEmpty(): boolean {
    return this.blank >= this.len && this.len >= this.capacity;
  }

  /** Oldest-first copy. NaN becomes null so charts render a gap. */
  toArray(): (number | null)[] {
    const out: (number | null)[] = new Array(this.len);
    const start = (this.head - this.len + this.capacity) % this.capacity;
    for (let i = 0; i < this.len; i++) {
      const v = this.buf[(start + i) % this.capacity]!;
      out[i] = Number.isNaN(v) ? null : v;
    }
    return out;
  }

  get length(): number {
    return this.len;
  }
}

/** Per-node metrics kept for charting. */
const NODE_METRICS = ["cpu", "mem", "gpu", "vram", "temp", "power", "fabricRx", "fabricTx"] as const;

/**
 * Derive one tick's worth of chart values from a snapshot.
 *
 * Shared by the server's buffer and the browser's, so both extend the same
 * series the same way. The server sends its backlog once on connect and the
 * client appends from the snapshot stream after that — re-sending the whole
 * history every second would be wasteful, and letting the client compute its
 * own values would risk the two drifting apart.
 *
 * NaN means "no reading at this instant" and becomes a gap in the chart.
 */
export function historySample(snap: ClusterSnapshot): Record<string, number> {
  const out: Record<string, number> = {};

  for (const n of snap.nodes) {
    const key = (m: (typeof NODE_METRICS)[number]) => `${n.id}:${m}`;
    if (n.status !== "online") {
      for (const m of NODE_METRICS) out[key(m)] = NaN;
      continue;
    }
    out[key("cpu")] = n.cpu.usagePct;
    out[key("mem")] = n.memory.totalBytes > 0 ? (n.memory.usedBytes / n.memory.totalBytes) * 100 : 0;
    out[key("gpu")] = n.gpu?.utilPct ?? 0;
    out[key("vram")] =
      n.gpu && n.gpu.vramTotalBytes > 0 ? (n.gpu.vramUsedBytes / n.gpu.vramTotalBytes) * 100 : 0;
    out[key("temp")] = n.thermal.maxC ?? NaN;
    out[key("power")] = n.gpu?.powerDrawW ?? NaN;

    let rx = 0;
    let tx = 0;
    for (const port of n.fabric.ports) {
      rx += ((port.rdmaRxBps + port.tcpRxBps) * 8) / 1e9;
      tx += ((port.rdmaTxBps + port.tcpTxBps) * 8) / 1e9;
    }
    out[key("fabricRx")] = Math.round(rx * 100) / 100;
    out[key("fabricTx")] = Math.round(tx * 100) / 100;
  }

  out["cluster:traffic"] = snap.fabric.totalTrafficGbps;
  out["cluster:cpu"] = snap.totals.cpuUsagePct;
  out["cluster:vram"] =
    snap.totals.vramTotalBytes > 0 ? (snap.totals.vramUsedBytes / snap.totals.vramTotalBytes) * 100 : 0;
  out["cluster:power"] = snap.totals.powerDrawW;

  for (const l of snap.fabric.links) {
    out[`link:${l.id}:ab`] = l.aToBGbps;
    out[`link:${l.id}:ba`] = l.bToAGbps;
  }

  for (const n of snap.nodes) {
    for (const e of n.inference ?? []) {
      // NaN, not 0, before the first delta exists — an unknown rate is a gap.
      out[`infer:${e.id}:tokens`] = e.generationTokensPerSec ?? NaN;
      out[`infer:${e.id}:running`] = e.requestsRunning ?? NaN;
      /*
       * Input and output kept apart.
       *
       * They answer different questions and move on different scales: output is
       * what a user waits for, input is what the machine had to read first, and
       * on a long agentic conversation the second is orders of magnitude larger.
       * Both ingested and computed prompt rates are kept, because the gap
       * between them is the prefix cache doing its job.
       */
      out[`infer:${e.id}:prefill`] = e.prefillTokensPerSec ?? NaN;
      out[`infer:${e.id}:computed`] = e.prefillComputedTokensPerSec ?? NaN;
      out[`infer:${e.id}:queued`] = e.requestsWaiting ?? NaN;
      // Cumulative counters, so a window can be read as a token count rather
      // than integrated from a rate.
      out[`infer:${e.id}:genTotal`] = e.generationTokensTotal ?? NaN;
      out[`infer:${e.id}:promptTotal`] = e.promptTokensTotal ?? NaN;
      out[`infer:${e.id}:cachedTotal`] = e.cachedPromptTokensTotal ?? NaN;
      out[`infer:${e.id}:ttft`] = e.latencyBasis === "window" && e.ttftMs !== null ? e.ttftMs : NaN;
    }
  }

  /*
   * Cluster-wide token rates, so a chart does not have to sum a varying number
   * of endpoint series to answer "what is the fleet producing".
   */
  out["cluster:tokensOut"] = snap.totals.tokensPerSec;
  out["cluster:tokensIn"] = snap.totals.promptTokensPerSec;
  out["cluster:tokensComputed"] = snap.totals.promptComputedTokensPerSec;
  out["cluster:genTotal"] = snap.totals.generationTokensTotal;
  out["cluster:promptTotal"] = snap.totals.promptTokensTotal;
  out["cluster:cachedTotal"] = snap.totals.cachedPromptTokensTotal;

  return out;
}

export class HistoryStore {
  private ts: number[] = [];
  private series = new Map<string, Ring>();
  /** Series written during the current tick, so the rest can be filled with NaN. */
  private written = new Set<string>();

  constructor(private readonly capacity = 300) {}

  private ring(key: string): Ring {
    let r = this.series.get(key);
    if (!r) {
      r = new Ring(this.capacity);
      /*
       * Back-fill a series that appears late so it stays index-aligned with the
       * shared timeline. `this.ts` deliberately does not yet include the
       * current tick — it is appended at the end of record() — so its length is
       * exactly the number of past samples this series missed.
       */
      for (let i = 0; i < this.ts.length; i++) r.push(NaN);
      this.series.set(key, r);
    }
    return r;
  }

  private put(key: string, value: number): void {
    this.ring(key).push(value);
    this.written.add(key);
  }

  record(snap: ClusterSnapshot): void {
    this.written.clear();

    for (const [key, value] of Object.entries(historySample(snap))) this.put(key, value);

    // Anything not written this tick (a removed node, a link that vanished)
    // still advances, so every series matches the timeline length exactly.
    for (const [key, ring] of this.series) {
      if (!this.written.has(key)) ring.push(NaN);
    }

    /*
     * Retire series that have scrolled entirely empty.
     *
     * Series are created on demand — one per node metric, per link, per
     * inference endpoint — and a cluster that churns nodes or restarts servers
     * would otherwise accumulate ring buffers for things that no longer exist.
     * Waiting until the whole window is blank means a brief outage keeps its
     * history and its gap, while something genuinely gone is reclaimed.
     */
    for (const [key, ring] of this.series) {
      if (ring.isEmpty) this.series.delete(key);
    }

    // Appended last, so `ring()` above could use its length as the count of
    // samples a newly created series had missed.
    this.ts.push(snap.ts);
    if (this.ts.length > this.capacity) this.ts.shift();
  }

  /** Approximate retained bytes, for the diagnostics endpoint. */
  get approxBytes(): number {
    // One Float64Array of `capacity` per series, plus the shared timeline.
    return this.series.size * this.capacity * 8 + this.ts.length * 8;
  }

  payload(): HistoryPayload {
    const series: Record<string, (number | null)[]> = {};
    for (const [k, r] of this.series) series[k] = r.toArray();
    return { ts: [...this.ts], series };
  }

  /**
   * Drop series that can no longer receive samples.
   *
   * Series are created on demand, so without this a cluster that churns nodes,
   * links or inference endpoints would accumulate ring buffers forever. Keys
   * are namespaced by kind: `<nodeId>:<metric>`, `cluster:*`, `link:<id>:*` and
   * `infer:<nodeId>:<port>:*`.
   */
  prune(validNodeIds: Set<string>, validKeys?: Set<string>): void {
    for (const key of this.series.keys()) {
      const parts = key.split(":");
      const prefix = parts[0]!;
      if (prefix === "cluster") continue;
      if (prefix === "link" || prefix === "infer") {
        // `infer:<nodeId>:<port>:<metric>` — the node id is the second field.
        if (prefix === "infer" && parts[1] && !validNodeIds.has(parts[1])) this.series.delete(key);
        else if (validKeys && !validKeys.has(key)) this.series.delete(key);
        continue;
      }
      if (!validNodeIds.has(prefix)) this.series.delete(key);
    }
  }

  /** Number of retained series, for diagnostics and memory bounds. */
  get seriesCount(): number {
    return this.series.size;
  }
}
