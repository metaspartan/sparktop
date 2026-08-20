/**
 * Live cluster feed.
 *
 * The socket is the only data path once connected; the REST endpoints exist for
 * scripting and for the initial paint if the socket is slow. Reconnects use
 * backoff so a restarted server does not get hammered.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClusterSnapshot, HistoryPayload, PublicNodeConfig, ServerMessage } from "@sparktop/core";

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
      } else if (msg.type === "history") {
        setHistory(normalizeHistory(msg.data));
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
