/**
 * Inference run history.
 *
 * A run is a serving session: one endpoint, one model, continuously present.
 * Individual requests are not observable — engines expose counters, not a
 * request log — so what is recorded is what can be derived honestly from
 * counter deltas: when it started, how long it served, how many tokens it
 * generated and how many requests it completed.
 */

import { useCallback, useEffect, useState } from "react";
import { fmtDuration } from "@sparktop/core";
import { Badge, Card, Stat } from "./primitives";

interface RunRecord {
  id: number;
  nodeId: string;
  nodeLabel: string;
  port: number;
  engine: string;
  model: string;
  startedAt: number;
  endedAt: number | null;
  tokensGenerated: number;
  promptTokens: number;
  requestsServed: number;
  peakTokensPerSec: number;
  durationSec: number;
}

interface RunsPayload {
  runs: RunRecord[];
  summary: { tokensGenerated: number; requestsServed: number; runs: number; models: string[] } | null;
  stats?: { sizeBytes: number; samples: number; runs: number; oldestMs: number | null };
  disabled: boolean;
}

const WINDOWS = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
] as const;

const compact = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

const when = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function RunsView() {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<RunsPayload | null>(null);

  const load = useCallback(async (d: number) => {
    try {
      const r = await fetch(`/api/runs?days=${d}&limit=100`);
      setData((await r.json()) as RunsPayload);
    } catch {
      setData({ runs: [], summary: null, disabled: false });
    }
  }, []);

  useEffect(() => {
    void load(days);
    // Runs change on the scale of minutes, not seconds; polling harder would
    // just re-query SQLite for the same rows.
    const t = setInterval(() => void load(days), 30_000);
    return () => clearInterval(t);
  }, [days, load]);

  if (!data) {
    return (
      <Card title="Run history">
        <p className="text-[12px] text-ink-muted">Loading…</p>
      </Card>
    );
  }

  if (data.disabled) {
    return (
      <Card title="Run history">
        <p className="text-[12px] leading-relaxed text-ink-muted">
          Persisted history is turned off (<code className="rounded bg-surface-2 px-1">SPARKTOP_DATA=off</code>).
        </p>
      </Card>
    );
  }

  const s = data.summary;

  return (
    <Card
      title="Run history"
      right={
        <div className="flex items-center gap-2">
          {data.stats && (
            <span className="text-[11px] text-ink-muted" title={`${data.stats.samples} samples, ${data.stats.runs} runs on disk`}>
              {(data.stats.sizeBytes / 1024 / 1024).toFixed(1)} MB
            </span>
          )}
          <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                onClick={() => setDays(w.days)}
                className={`cursor-pointer rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                  days === w.days
                    ? "bg-[color:var(--accent)] font-medium text-white"
                    : "text-ink-secondary hover:bg-surface-hover"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      }
      bodyClass="p-0"
    >
      {s && (
        <div className="grid grid-cols-2 gap-4 border-b border-edge p-4 sm:grid-cols-4">
          <Stat label="Tokens generated" value={compact(s.tokensGenerated)} sub={`last ${days}d`} />
          <Stat label="Requests served" value={compact(s.requestsServed)} sub={`across ${s.runs} runs`} />
          <Stat label="Models" value={String(s.models.length)} sub={s.models.slice(0, 2).join(", ") || "—"} />
          <Stat
            label="Peak"
            value={`${Math.max(0, ...data.runs.map((r) => r.peakTokensPerSec)).toFixed(0)}`}
            sub="tokens/sec"
          />
        </div>
      )}

      {data.runs.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-ink-muted">
          No runs recorded yet. A run is logged once an inference server has been serving for a poll or two.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[12px]">
            <thead className="bg-surface-2 text-[11px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Model</th>
                <th className="px-3 py-2 font-medium">Node</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">Tokens</th>
                <th className="px-3 py-2 font-medium">Requests</th>
                <th className="px-3 py-2 font-medium">Peak</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} className="border-t border-edge hover:bg-surface-hover">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-ink" title={r.model}>
                        {r.model}
                      </span>
                      {r.endedAt === null && <Badge tone="good">live</Badge>}
                    </div>
                    <div className="text-[11px] text-ink-muted">{r.engine}</div>
                  </td>
                  <td className="px-3 py-2 text-ink-secondary">
                    {r.nodeLabel}
                    <span className="text-ink-muted">:{r.port}</span>
                  </td>
                  <td className="tnum px-3 py-2 text-ink-secondary">{when(r.startedAt)}</td>
                  <td className="tnum px-3 py-2 text-ink-secondary">{fmtDuration(r.durationSec)}</td>
                  <td className="tnum px-3 py-2 font-medium text-ink">{compact(r.tokensGenerated)}</td>
                  <td className="tnum px-3 py-2 text-ink-secondary">{compact(r.requestsServed)}</td>
                  <td className="tnum px-3 py-2 text-ink-secondary">{r.peakTokensPerSec.toFixed(0)}/s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

interface UpdatePayload {
  sparktop: {
    currentCommit: string | null;
    latestCommit: string | null;
    updateAvailable: boolean;
    behindBy: number | null;
    latestMessage: string | null;
    latestUrl: string | null;
    error: string | null;
  };
  images: {
    nodeId: string;
    container: string;
    image: string;
    updateAvailable: boolean;
    error: string | null;
  }[];
}

/** Update status, shown in Settings rather than as an alert. */
export function UpdatePanel() {
  const [data, setData] = useState<UpdatePayload | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setChecking(true);
    try {
      const r = await fetch(`/api/updates${refresh ? "?refresh=1" : ""}`);
      setData((await r.json()) as UpdatePayload);
    } catch {
      /* leave the previous result in place */
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sp = data?.sparktop;
  const staleImages = (data?.images ?? []).filter((i) => i.updateAvailable);

  return (
    <div className="space-y-2 text-[12px]">
      <div className="rounded-lg border border-edge bg-surface-2 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-ink">sparktop</span>
          {sp?.updateAvailable ? (
            <Badge tone="accent">
              {sp.behindBy ? `${sp.behindBy} commits behind` : "update available"}
            </Badge>
          ) : (
            <Badge tone="good">up to date</Badge>
          )}
        </div>
        {sp?.currentCommit && (
          <div className="mt-0.5 font-mono text-[11px] text-ink-muted">{sp.currentCommit.slice(0, 8)}</div>
        )}
        {sp?.updateAvailable && sp.latestMessage && (
          <p className="mt-1 text-[11px] leading-relaxed text-ink-secondary">
            Latest: {sp.latestMessage}
            {sp.latestUrl && (
              <>
                {" "}
                <a
                  href={sp.latestUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline"
                  style={{ color: "var(--accent)" }}
                >
                  view
                </a>
              </>
            )}
          </p>
        )}
        {sp?.error && <p className="mt-1 text-[11px] text-ink-muted">{sp.error}</p>}
      </div>

      <div className="rounded-lg border border-edge bg-surface-2 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-ink">Container images</span>
          {staleImages.length ? (
            <Badge tone="warning">{staleImages.length} newer</Badge>
          ) : (
            <Badge tone="good">current</Badge>
          )}
        </div>
        <ul className="mt-1 space-y-0.5">
          {(data?.images ?? []).map((i) => (
            <li key={`${i.nodeId}-${i.container}-${i.image}`} className="truncate text-[11px] text-ink-secondary">
              <span className="text-ink-muted">{i.container}</span>{" "}
              {i.updateAvailable ? (
                <span style={{ color: "var(--status-warning)" }}>newer image available</span>
              ) : (
                <span className="text-ink-muted">{i.error ?? "current"}</span>
              )}
            </li>
          ))}
          {!data?.images.length && <li className="text-[11px] text-ink-muted">No running containers.</li>}
        </ul>
      </div>

      <button
        onClick={() => void load(true)}
        disabled={checking}
        className="cursor-pointer rounded-md border border-edge bg-surface-2 px-2.5 py-1 text-[12px] text-ink-secondary hover:bg-surface-hover hover:text-ink disabled:opacity-50"
      >
        {checking ? "Checking…" : "Check now"}
      </button>
    </div>
  );
}
