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

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.len < this.capacity) this.len++;
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

    for (const n of snap.nodes) {
      const p = (m: (typeof NODE_METRICS)[number], v: number) => this.put(`${n.id}:${m}`, v);
      if (n.status !== "online") {
        // Keep the series present but empty for this tick: the chart shows a
        // gap rather than a misleading zero or a shifted line.
        for (const m of NODE_METRICS) p(m, NaN);
        continue;
      }
      p("cpu", n.cpu.usagePct);
      p("mem", n.memory.totalBytes > 0 ? (n.memory.usedBytes / n.memory.totalBytes) * 100 : 0);
      p("gpu", n.gpu?.utilPct ?? 0);
      p("vram", n.gpu && n.gpu.vramTotalBytes > 0 ? (n.gpu.vramUsedBytes / n.gpu.vramTotalBytes) * 100 : 0);
      p("temp", n.thermal.maxC ?? NaN);
      p("power", n.gpu?.powerDrawW ?? NaN);

      let rx = 0;
      let tx = 0;
      for (const port of n.fabric.ports) {
        rx += ((port.rdmaRxBps + port.tcpRxBps) * 8) / 1e9;
        tx += ((port.rdmaTxBps + port.tcpTxBps) * 8) / 1e9;
      }
      p("fabricRx", Math.round(rx * 100) / 100);
      p("fabricTx", Math.round(tx * 100) / 100);
    }

    this.put("cluster:traffic", snap.fabric.totalTrafficGbps);
    this.put("cluster:cpu", snap.totals.cpuUsagePct);
    this.put(
      "cluster:vram",
      snap.totals.vramTotalBytes > 0 ? (snap.totals.vramUsedBytes / snap.totals.vramTotalBytes) * 100 : 0
    );
    this.put("cluster:power", snap.totals.powerDrawW);

    for (const l of snap.fabric.links) {
      this.put(`link:${l.id}:ab`, l.aToBGbps);
      this.put(`link:${l.id}:ba`, l.bToAGbps);
    }

    // Anything not written this tick (a removed node, a link that vanished)
    // still advances, so every series matches the timeline length exactly.
    for (const [key, ring] of this.series) {
      if (!this.written.has(key)) ring.push(NaN);
    }

    // Appended last, so `ring()` above could use its length as the count of
    // samples a newly created series had missed.
    this.ts.push(snap.ts);
    if (this.ts.length > this.capacity) this.ts.shift();
  }

  payload(): HistoryPayload {
    const series: Record<string, (number | null)[]> = {};
    for (const [k, r] of this.series) series[k] = r.toArray();
    return { ts: [...this.ts], series };
  }

  /** Drop series belonging to nodes that no longer exist. */
  prune(validNodeIds: Set<string>): void {
    for (const key of this.series.keys()) {
      const prefix = key.split(":")[0]!;
      if (prefix === "cluster" || prefix === "link") continue;
      if (!validNodeIds.has(prefix)) this.series.delete(key);
    }
  }
}
