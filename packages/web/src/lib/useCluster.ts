/**
 * Live cluster feed.
 *
 * The socket is the only data path once connected; the REST endpoints exist for
 * scripting and for the initial paint if the socket is slow. Reconnects use
 * backoff so a restarted server does not get hammered.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClusterSnapshot, HistoryPayload, PublicNodeConfig, ServerMessage } from "@sparktop/core";
import { historySample } from "@sparktop/core";

/** Samples retained in the browser. Matches the server's default backlog. */
const HISTORY_CAPACITY = 300;

/**
 * Extend the local history with one snapshot.
 *
 * The server sends its backlog once, on connect; every tick after that arrives
 * as a snapshot, and the charts advance from here. Without this the graphs
 * would freeze at whatever was buffered when the page loaded while the rest of
 * the dashboard kept updating.
 *
 * Returns a new object because React state must not be mutated in place.
 */
function appendSample(prev: HistoryPayload | null, snap: ClusterSnapshot): HistoryPayload {
  const base: HistoryPayload = prev ?? { ts: [], series: {} };
  // A duplicate or out-of-order snapshot would corrupt the timeline.
  const last = base.ts[base.ts.length - 1];
  if (last !== undefined && snap.ts <= last) return base;

  const sample = historySample(snap);
  const ts = [...base.ts, snap.ts];
  const overflow = Math.max(0, ts.length - HISTORY_CAPACITY);
  const trimmedTs = overflow ? ts.slice(overflow) : ts;
  const priorLength = base.ts.length;

  const series: HistoryPayload["series"] = {};
  const keys = new Set([...Object.keys(base.series), ...Object.keys(sample)]);
  for (const key of keys) {
    // Back-fill a series that appears late so it stays index-aligned.
    const existing = base.series[key] ?? new Array<number | null>(priorLength).fill(null);
    const value = sample[key];
    const next = [...existing, value === undefined || Number.isNaN(value) ? null : value];
    series[key] = overflow ? next.slice(overflow) : next;
  }
  return { ts: trimmedTs, series };
}

export type ConnState = "connecting" | "open" | "closed";

export interface ClusterFeed {
  snapshot: ClusterSnapshot | null;
  history: HistoryPayload | null;
  nodes: PublicNodeConfig[];
  conn: ConnState;
  /** Milliseconds since the last snapshot arrived. */
  staleMs: number;
  /** Server-side poll cadence, shown in settings. */
  intervals: { fast: number; slow: number };
  refreshConfig: () => void;
}

/**
 * Coerce an incoming history payload into the shape the charts expect.
 *
 * A browser tab can outlive a server restart, and an upgraded server may speak
 * a different payload version than the page that is already open. Rather than
 * letting a mismatch throw somewhere deep in a chart component, anything that
 * is not a well-formed series is dropped here.
 */
function normalizeHistory(raw: unknown): HistoryPayload {
  const empty: HistoryPayload = { ts: [], series: {} };
  if (!raw || typeof raw !== "object") return empty;
  const p = raw as Partial<HistoryPayload>;
  if (!Array.isArray(p.ts)) return empty;

  const series: HistoryPayload["series"] = {};
  for (const [key, value] of Object.entries(p.series ?? {})) {
    // Only keep series that are arrays and match the timeline exactly.
    if (Array.isArray(value) && value.length === p.ts.length) {
      series[key] = value as (number | null)[];
    }
  }
  return { ts: p.ts, series };
}

export function useCluster(): ClusterFeed {
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [nodes, setNodes] = useState<PublicNodeConfig[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [staleMs, setStaleMs] = useState(0);
  const [intervals, setIntervals] = useState({ fast: 1000, slow: 10_000 });

  const lastAt = useRef(Date.now());
  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const closedRef = useRef(false);

  const connect = useCallback(() => {
    if (closedRef.current) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    wsRef.current = ws;
    setConn("connecting");

    ws.onopen = () => {
      attemptRef.current = 0;
      setConn("open");
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "snapshot") {
        lastAt.current = Date.now();
        setSnapshot(msg.data);
        // Charts advance from the live stream, in step with everything else.
        setHistory((h) => appendSample(h, msg.data));
      } else if (msg.type === "history") {
        // The server's backlog is authoritative on arrival; live snapshots
        // extend it from there. Keep whichever has more depth, so a reconnect
        // does not discard samples collected while the socket was down.
        setHistory((h) => {
          const incoming = normalizeHistory(msg.data);
          return (h?.ts.length ?? 0) > incoming.ts.length ? h : incoming;
        });
      } else if (msg.type === "config") {
        setNodes(msg.data.nodes);
        setIntervals({ fast: msg.data.fastIntervalMs, slow: msg.data.slowIntervalMs });
      }
    };

    ws.onclose = () => {
      setConn("closed");
      if (closedRef.current) return;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(attemptRef.current++, 4));
      setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    closedRef.current = false;
    connect();
    return () => {
      closedRef.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

  // Drives the "data is stale" indicator without re-rendering on every frame.
  useEffect(() => {
    const t = setInterval(() => setStaleMs(Date.now() - lastAt.current), 500);
    return () => clearInterval(t);
  }, []);

  const refreshConfig = useCallback(() => {
    void fetch("/api/config")
      .then((r) => r.json())
      .then((d: { nodes: PublicNodeConfig[] }) => setNodes(d.nodes))
      .catch(() => {});
  }, []);

  return { snapshot, history, nodes, conn, staleMs, intervals, refreshConfig };
}
