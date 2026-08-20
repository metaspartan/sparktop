/**
 * Durable history, on Bun's built-in SQLite.
 *
 * Everything else in sparktop is in-memory and bounded to a few minutes, which
 * is right for a live dashboard and useless for "what was serving last Tuesday".
 * This keeps two things instead:
 *
 *  - **Runs.** A serving session — one endpoint, one model, continuously
 *    present. Individual requests are not observable (engines expose counters,
 *    not a request log), but a session's start, end, tokens generated and
 *    requests completed all fall out of counter deltas.
 *  - **Samples.** Throughput over time, downsampled so a month costs megabytes
 *    rather than gigabytes.
 *
 * Storage is deliberately modest: samples are written at a coarse interval and
 * both tables are pruned to a retention window, so the file reaches a steady
 * size and stays there.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ClusterSnapshot, InferenceEndpoint } from "./types.ts";

/** One sample per this interval. 1Hz for a month would be tens of millions of rows. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
export const DEFAULT_RETENTION_DAYS = 30;
/** A gap longer than this ends a run rather than bridging it. */
const RUN_GAP_MS = 5 * 60_000;

export interface RunRecord {
  id: number;
  nodeId: string;
  nodeLabel: string;
  endpointId: string;
  port: number;
  engine: string;
  model: string;
  startedAt: number;
  lastSeenAt: number;
  /** Null while still running. */
  endedAt: number | null;
  /** Tokens generated during this run, from counter deltas. */
  tokensGenerated: number;
  promptTokens: number;
  requestsServed: number;
  peakTokensPerSec: number;
  durationSec: number;
}

export interface SamplePoint {
  ts: number;
  endpointId: string;
  tokensPerSec: number;
  requestsRunning: number;
  kvCachePct: number | null;
}

export function storePath(): string {
  return resolve(process.env.SPARKTOP_DATA ?? join(process.cwd(), "data", "sparktop.db"));
}

export class HistoryDb {
  private db: Database;
  private lastSampleAt = 0;
  private lastPruneAt = 0;

  constructor(
    path = storePath(),
    private readonly opts: { sampleIntervalMs?: number; retentionDays?: number } = {}
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    /*
     * WAL keeps readers from blocking the collector's writes, and NORMAL
     * synchronous is the right trade for metrics: a torn tail after a power cut
     * costs a minute of samples, not correctness of anything that matters.
     */
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL,
        node_label TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        port INTEGER NOT NULL,
        engine TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        ended_at INTEGER,
        start_gen_tokens REAL,
        last_gen_tokens REAL,
        start_prompt_tokens REAL,
        last_prompt_tokens REAL,
        start_requests REAL,
        last_requests REAL,
        peak_tokens_per_sec REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS runs_open ON runs (endpoint_id, model, ended_at);
      CREATE INDEX IF NOT EXISTS runs_time ON runs (started_at DESC);

      CREATE TABLE IF NOT EXISTS samples (
        ts INTEGER NOT NULL,
        endpoint_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        tokens_per_sec REAL NOT NULL,
        requests_running INTEGER NOT NULL,
        kv_cache_pct REAL
      );
      CREATE INDEX IF NOT EXISTS samples_time ON samples (ts DESC);
      CREATE INDEX IF NOT EXISTS samples_endpoint ON samples (endpoint_id, ts DESC);
    `);
  }

  /**
   * Fold a snapshot into the store.
   *
   * Runs are updated every call so a crash loses at most one interval of
   * counters; samples are throttled, since that is where the row count lives.
   */
  record(snap: ClusterSnapshot): void {
    const endpoints = snap.nodes.flatMap((n) => (n.status === "online" ? (n.inference ?? []) : []));
    this.updateRuns(snap.ts, endpoints);

    const interval = this.opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    if (snap.ts - this.lastSampleAt >= interval) {
      this.lastSampleAt = snap.ts;
      this.writeSamples(snap.ts, endpoints);
    }

    /*
     * Prune against the data's own clock, not the wall clock.
     *
     * Retention is "the last N days of what was recorded". Using Date.now()
     * instead compares stored timestamps to an unrelated reference, so a host
     * whose clock is wrong or jumps forward silently deletes history that is
     * perfectly current by its own timeline. Hourly is far more often than
     * needed to hold the file at a steady size.
     */
    if (snap.ts - this.lastPruneAt >= 3_600_000) {
      this.lastPruneAt = snap.ts;
      this.prune(snap.ts);
    }
  }

  private updateRuns(ts: number, endpoints: InferenceEndpoint[]): void {
    const openStmt = this.db.query<{ id: number; last_seen_at: number; peak_tokens_per_sec: number }, [string, string]>(
      `SELECT id, last_seen_at, peak_tokens_per_sec FROM runs
       WHERE endpoint_id = ? AND model = ? AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`
    );
    const insert = this.db.query(
      `INSERT INTO runs (node_id, node_label, endpoint_id, port, engine, model, started_at, last_seen_at,
                         start_gen_tokens, last_gen_tokens, start_prompt_tokens, last_prompt_tokens,
                         start_requests, last_requests, peak_tokens_per_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const update = this.db.query(
      `UPDATE runs SET last_seen_at = ?, last_gen_tokens = ?, last_prompt_tokens = ?,
                       last_requests = ?, peak_tokens_per_sec = ?, node_label = ?
       WHERE id = ?`
    );

    const seen = new Set<string>();
    for (const e of endpoints) {
      if (!e.reachable) continue;
      // An engine serving nothing still counts as a run of the empty model, so
      // uptime is visible even before the first request.
      const models = e.models.length ? e.models : ["(none)"];
      for (const model of models) {
        seen.add(`${e.id}|${model}`);
        const open = openStmt.get(e.id, model);
        const tps = e.generationTokensPerSec ?? 0;

        if (open && ts - open.last_seen_at <= RUN_GAP_MS) {
          update.run(
            ts,
            e.generationTokensTotal,
            e.promptTokensTotal,
            e.requestsFinishedTotal,
            Math.max(open.peak_tokens_per_sec, tps),
            e.nodeLabel,
            open.id
          );
        } else {
          // Either brand new, or resuming after a gap long enough that calling
          // it the same run would be a lie about continuity.
          if (open) this.closeRun(open.id, open.last_seen_at);
          insert.run(
            e.nodeId,
            e.nodeLabel,
            e.id,
            e.port,
            e.engine,
            model,
            ts,
            ts,
            e.generationTokensTotal,
            e.generationTokensTotal,
            e.promptTokensTotal,
            e.promptTokensTotal,
            e.requestsFinishedTotal,
            e.requestsFinishedTotal,
            tps
          );
        }
      }
    }

    // Close anything that has stopped reporting.
    const stale = this.db
      .query<{ id: number; endpoint_id: string; model: string; last_seen_at: number }, [number]>(
        `SELECT id, endpoint_id, model, last_seen_at FROM runs WHERE ended_at IS NULL AND last_seen_at < ?`
      )
      .all(ts - RUN_GAP_MS);
    for (const row of stale) {
      if (!seen.has(`${row.endpoint_id}|${row.model}`)) this.closeRun(row.id, row.last_seen_at);
    }
  }

  private closeRun(id: number, endedAt: number): void {
    this.db.query(`UPDATE runs SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(endedAt, id);
  }

  private writeSamples(ts: number, endpoints: InferenceEndpoint[]): void {
    const insert = this.db.query(
      `INSERT INTO samples (ts, endpoint_id, node_id, tokens_per_sec, requests_running, kv_cache_pct)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    // One transaction: a dozen endpoints should be one fsync, not a dozen.
    this.db.transaction(() => {
      for (const e of endpoints) {
        if (!e.reachable) continue;
        insert.run(ts, e.id, e.nodeId, e.generationTokensPerSec ?? 0, e.requestsRunning ?? 0, e.kvCachePct);
      }
    })();
  }

  /** Delete anything past the retention window. */
  prune(now = Date.now()): { samples: number; runs: number } {
    const days = this.opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const cutoff = now - days * 86_400_000;
    const samples = this.db.query(`DELETE FROM samples WHERE ts < ?`).run(cutoff).changes;
    // Only closed runs are prunable; an open one is still happening however old.
    const runs = this.db
      .query(`DELETE FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?`)
      .run(cutoff).changes;
    return { samples, runs };
  }

  /** Reclaim file space after a large prune. */
  vacuum(): void {
    this.db.exec("VACUUM");
  }

  runs(limit = 50): RunRecord[] {
    const rows = this.db
      .query<
        {
          id: number; node_id: string; node_label: string; endpoint_id: string; port: number;
          engine: string; model: string; started_at: number; last_seen_at: number; ended_at: number | null;
          start_gen_tokens: number | null; last_gen_tokens: number | null;
          start_prompt_tokens: number | null; last_prompt_tokens: number | null;
          start_requests: number | null; last_requests: number | null; peak_tokens_per_sec: number;
        },
        [number]
      >(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit);

    // Counters reset when a server restarts, so a negative delta means the
    // baseline is gone; report zero rather than a negative total.
    const delta = (a: number | null, b: number | null): number =>
      a === null || b === null || b < a ? 0 : Math.round(b - a);

    return rows.map((r) => ({
      id: r.id,
      nodeId: r.node_id,
      nodeLabel: r.node_label,
      endpointId: r.endpoint_id,
      port: r.port,
      engine: r.engine,
      model: r.model,
      startedAt: r.started_at,
      lastSeenAt: r.last_seen_at,
      endedAt: r.ended_at,
      tokensGenerated: delta(r.start_gen_tokens, r.last_gen_tokens),
      promptTokens: delta(r.start_prompt_tokens, r.last_prompt_tokens),
      requestsServed: delta(r.start_requests, r.last_requests),
      peakTokensPerSec: Math.round(r.peak_tokens_per_sec * 10) / 10,
      durationSec: Math.max(0, Math.round(((r.ended_at ?? r.last_seen_at) - r.started_at) / 1000)),
    }));
  }

  /** Samples since a cutoff, oldest first, for charting a long window. */
  samples(sinceMs: number, endpointId?: string): SamplePoint[] {
    const rows = endpointId
      ? this.db
          .query<
            { ts: number; endpoint_id: string; tokens_per_sec: number; requests_running: number; kv_cache_pct: number | null },
            [number, string]
          >(`SELECT ts, endpoint_id, tokens_per_sec, requests_running, kv_cache_pct FROM samples
             WHERE ts >= ? AND endpoint_id = ? ORDER BY ts ASC`)
          .all(sinceMs, endpointId)
      : this.db
          .query<
            { ts: number; endpoint_id: string; tokens_per_sec: number; requests_running: number; kv_cache_pct: number | null },
            [number]
          >(`SELECT ts, endpoint_id, tokens_per_sec, requests_running, kv_cache_pct FROM samples
             WHERE ts >= ? ORDER BY ts ASC`)
          .all(sinceMs);

    return rows.map((r) => ({
      ts: r.ts,
      endpointId: r.endpoint_id,
      tokensPerSec: r.tokens_per_sec,
      requestsRunning: r.requests_running,
      kvCachePct: r.kv_cache_pct,
    }));
  }

  /** Totals over a window, for the panel header. */
  summary(sinceMs: number): { tokensGenerated: number; requestsServed: number; runs: number; models: string[] } {
    const r = this.db
      .query<{ tokens: number | null; reqs: number | null; n: number }, [number]>(
        `SELECT
           SUM(CASE WHEN last_gen_tokens >= start_gen_tokens THEN last_gen_tokens - start_gen_tokens ELSE 0 END) AS tokens,
           SUM(CASE WHEN last_requests >= start_requests THEN last_requests - start_requests ELSE 0 END) AS reqs,
           COUNT(*) AS n
         FROM runs WHERE last_seen_at >= ?`
      )
      .get(sinceMs);
    const models = this.db
      .query<{ model: string }, [number]>(
        `SELECT DISTINCT model FROM runs WHERE last_seen_at >= ? AND model != '(none)' ORDER BY model`
      )
      .all(sinceMs)
      .map((x) => x.model);
    return {
      tokensGenerated: Math.round(r?.tokens ?? 0),
      requestsServed: Math.round(r?.reqs ?? 0),
      runs: r?.n ?? 0,
      models,
    };
  }

  stats(): { sizeBytes: number; samples: number; runs: number; oldestMs: number | null } {
    // PRAGMA results come back keyed by the pragma's own name; aliasing them
    // with AS is not supported, so read the field they actually carry.
    const page = this.db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
    const size = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
    const samples = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM samples").get()?.n ?? 0;
    const runs = this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()?.n ?? 0;
    const oldest = this.db.query<{ t: number | null }, []>("SELECT MIN(ts) AS t FROM samples").get()?.t ?? null;
    return { sizeBytes: page * size, samples, runs, oldestMs: oldest };
  }

  close(): void {
    this.db.close();
  }
}
