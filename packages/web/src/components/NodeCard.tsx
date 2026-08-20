/**
 * Per-node detail.
 *
 * Ordered by what you look at first when something is wrong: status, GPU and
 * memory pressure, then what is actually holding the memory, then hardware
 * detail.
 */

import { useState } from "react";
import type { HistoryPayload, NodeSnapshot } from "@sparktop/core";
import {
  fmtBps,
  fmtBytes,
  fmtDuration,
  fmtGbps,
  fmtPct,
  fmtTemp,
  fmtWatts,
  pctOf,
  shortImage,
} from "@sparktop/core";
import { Badge, Card, CoreStrip, LegendItem, Meter, Sparkline, Stat, StatusDot, tempTone, utilTone } from "./primitives";
import { TimeChart } from "./TimeChart";
import { VariantIcon } from "./VariantIcon";

export function NodeCard({
  node,
  history,
  themeKey,
  seriesIndex,
}: {
  node: NodeSnapshot;
  history: HistoryPayload | null;
  themeKey: string;
  seriesIndex: number;
}) {
  const [tab, setTab] = useState<"gpu" | "processes" | "containers" | "hardware">("gpu");
  const h = (m: string): (number | null)[] => history?.series[`${node.id}:${m}`] ?? [];

  if (node.status !== "online") {
    return (
      <Card
        title={
          <span className="flex items-center gap-2">
            {node.label}
            <span className="text-[11px] font-normal text-ink-muted">{node.host}</span>
          </span>
        }
        right={<StatusDot status={node.status} />}
      >
        <p className="text-sm text-ink-secondary">
          {node.error ?? "Not connected."}
        </p>
      </Card>
    );
  }

  const gpu = node.gpu;
  const vramPct = gpu ? pctOf(gpu.vramUsedBytes, gpu.vramTotalBytes) : 0;
  const memPct = pctOf(node.memory.usedBytes, node.memory.totalBytes);
  const fabricRx = node.fabric.ports.reduce((a, p) => a + p.rdmaRxBps + p.tcpRxBps, 0);
  const fabricTx = node.fabric.ports.reduce((a, p) => a + p.rdmaTxBps + p.tcpTxBps, 0);

  const tabs = [
    ["gpu", "Overview"],
    ["processes", `GPU processes (${gpu?.processes.length ?? 0})`],
    ["containers", `Containers (${node.docker.containers.filter((c) => c.state === "running").length})`],
    ["hardware", "Hardware"],
  ] as const;

  return (
    <Card
      title={
        <span className="flex min-w-0 items-center gap-2.5">
          {node.info.isSpark && (
            <VariantIcon
              variant={node.info.variant}
              title={node.info.variantName}
              width={44}
            />
          )}
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate">{node.label}</span>
            <span className="truncate text-[11px] font-normal text-ink-muted">
              {node.info.isSpark ? node.info.variantName : node.info.product || "Unknown hardware"}
              <span className="mx-1.5 opacity-50">·</span>
              {node.host}
            </span>
          </span>
        </span>
      }
      right={
        <div className="flex items-center gap-3">
          {/* Tabular figures and a fixed width: this value changes every second. */}
          <span
            className="tnum w-[62px] text-right text-[11px] text-ink-muted"
            title="Probe round-trip time"
          >
            {node.probeMs} ms
          </span>
          <StatusDot status={node.status} />
        </div>
      }
      className="card-lazy"
      bodyClass="p-0"
    >
      {/* Headline figures */}
      <div className="grid grid-cols-2 gap-4 border-b border-edge p-4 sm:grid-cols-4">
        <div>
          <Stat label="GPU" value={fmtPct(gpu?.utilPct ?? 0)} sub={gpu?.name ?? "—"} />
          <Meter value={gpu?.utilPct ?? 0} tone={utilTone(gpu?.utilPct ?? 0)} className="mt-2" />
        </div>
        <div>
          <Stat
            label="VRAM"
            value={gpu ? fmtBytes(gpu.vramUsedBytes) : "—"}
            sub={gpu ? `of ${fmtBytes(gpu.vramTotalBytes)}${gpu.unifiedMemory ? " unified" : ""}` : undefined}
          />
          <Meter value={vramPct} tone={utilTone(vramPct)} className="mt-2" />
        </div>
        <div>
          <Stat label="CPU" value={fmtPct(node.cpu.usagePct)} sub={`${node.cpu.cores} cores · ${node.cpu.freqMhz} MHz`} />
          <Meter value={node.cpu.usagePct} tone={utilTone(node.cpu.usagePct)} className="mt-2" />
        </div>
        <div>
          <Stat
            label="Temp"
            value={fmtTemp(node.thermal.maxC)}
            sub={`${fmtWatts(gpu?.powerDrawW)} · up ${fmtDuration(node.info.uptimeSec)}`}
          />
          <Meter value={node.thermal.maxC ?? 0} max={100} tone={tempTone(node.thermal.maxC)} className="mt-2" />
        </div>
      </div>

      {/* Trends. Each chart is a single series, so a legend box would be noise —
          the heading names it. */}
      <div className="grid gap-4 border-b border-edge p-4 sm:grid-cols-2">
        <MiniChart
          title="GPU utilisation"
          value={fmtPct(gpu?.utilPct ?? 0)}
          ts={history?.ts ?? []}
          values={h("gpu")}
          colorVar={`--series-${(seriesIndex % 4) + 1}`}
          format={(v) => `${v.toFixed(0)}%`}
          tickFormat={(v) => `${v.toFixed(0)}`}
          minRange={100}
          themeKey={themeKey}
        />
        <MiniChart
          title="Fabric traffic"
          value={`↓ ${fmtBps(fabricRx)}  ↑ ${fmtBps(fabricTx)}`}
          ts={history?.ts ?? []}
          values={h("fabricRx").map((v, i) => {
            const tx = h("fabricTx")[i];
            if (v === null || tx === null || tx === undefined) return null;
            return Math.round((v + tx) * 100) / 100;
          })}
          colorVar="--series-3"
          format={(v) => fmtGbps(v)}
          tickFormat={(v) => (v >= 1 ? `${v.toFixed(0)}G` : `${(v * 1000).toFixed(0)}M`)}
          minRange={0.5}
          themeKey={themeKey}
        />
      </div>

      <nav className="flex gap-1 overflow-x-auto border-b border-edge px-2 pt-2" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`whitespace-nowrap rounded-t-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
              tab === id
                ? "bg-surface-2 text-ink"
                : "text-ink-muted hover:bg-surface-hover hover:text-ink-secondary"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="p-4">
        {tab === "gpu" && <OverviewTab node={node} memPct={memPct} />}
        {tab === "processes" && <ProcessTab node={node} />}
        {tab === "containers" && <ContainerTab node={node} />}
        {tab === "hardware" && <HardwareTab node={node} />}
      </div>
    </Card>
  );
}

function MiniChart({
  title,
  value,
  ts,
  values,
  colorVar,
  format,
  tickFormat,
  minRange,
  themeKey,
}: {
  title: string;
  value: string;
  ts: number[];
  values: (number | null)[];
  colorVar: string;
  format: (v: number) => string;
  tickFormat?: (v: number) => string;
  minRange: number;
  themeKey: string;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{title}</h3>
        <span className="tnum text-[11px] font-semibold text-ink">{value}</span>
      </div>
      {ts.length > 1 ? (
        <TimeChart
          ts={ts}
          series={[{ label: title, colorVar, values }]}
          height={92}
          format={format}
          tickFormat={tickFormat}
          minRange={minRange}
          fill
          themeKey={themeKey}
        />
      ) : (
        <div className="flex h-[92px] items-center justify-center text-[11px] text-ink-muted">Collecting…</div>
      )}
    </div>
  );
}

function OverviewTab({ node, memPct }: { node: NodeSnapshot; memPct: number }) {
  const g = node.gpu;
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div className="space-y-3">
        <Row label="System memory" value={`${fmtBytes(node.memory.usedBytes)} / ${fmtBytes(node.memory.totalBytes)}`} />
        <Meter value={memPct} tone={utilTone(memPct)} />
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
          <Row label="Cached" value={fmtBytes(node.memory.cachedBytes)} />
          <Row label="Swap" value={`${fmtBytes(node.memory.swapUsedBytes)} / ${fmtBytes(node.memory.swapTotalBytes)}`} />
          <Row label="Load avg" value={node.cpu.loadAvg.map((n) => n.toFixed(2)).join("  ")} />
          <Row label="Processes" value={`${node.cpu.procsRunning} / ${node.cpu.procsTotal}`} />
        </div>

        {node.cpu.perCorePct.length > 0 && (
          <div className="pt-1">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                Per-core
              </span>
              <span className="tnum text-[11px] text-ink-secondary">
                {node.cpu.perCorePct.length} cores · peak{" "}
                {Math.max(...node.cpu.perCorePct).toFixed(0)}%
              </span>
            </div>
            <CoreStrip cores={node.cpu.perCorePct} />
          </div>
        )}
      </div>

      <div className="space-y-3">
        {g && (
          <>
            <Row label="Driver" value={`${g.driverVersion}${g.cudaVersion ? ` · CUDA ${g.cudaVersion}` : ""}`} />
            <Row label="SM clock" value={g.smClockMhz ? `${g.smClockMhz} MHz` : "—"} />
            <Row label="Power" value={fmtWatts(g.powerDrawW)} />
          </>
        )}
        {!g && <p className="text-[12px] text-ink-muted">No NVIDIA GPU detected on this node.</p>}
      </div>

      <div className="sm:col-span-2">
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Storage</h4>
        <div className="space-y-2">
          {node.disks.map((d) => {
            const pct = pctOf(d.usedBytes, d.totalBytes);
            return (
              <div key={d.mount} className="flex items-center gap-3 text-[12px]">
                <span className="w-28 shrink-0 truncate font-medium text-ink" title={d.device}>
                  {d.mount}
                </span>
                <Meter value={pct} tone={utilTone(pct)} className="flex-1" />
                <span className="tnum w-36 shrink-0 text-right text-ink-secondary">
                  {fmtBytes(d.usedBytes)} / {fmtBytes(d.totalBytes)} ({pct.toFixed(0)}%)
                </span>
              </div>
            );
          })}
          {!node.disks.length && <p className="text-[12px] text-ink-muted">No filesystems reported.</p>}
        </div>
      </div>
    </div>
  );
}

function ProcessTab({ node }: { node: NodeSnapshot }) {
  const procs = node.gpu?.processes ?? [];
  if (!procs.length) {
    return <p className="text-[12px] text-ink-muted">Nothing is holding GPU memory.</p>;
  }
  const total = node.gpu?.vramTotalBytes ?? 0;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-[12px]">
        <thead className="text-[11px] uppercase tracking-wide text-ink-muted">
          <tr>
            <th className="pb-2 pr-3 font-medium">PID</th>
            <th className="pb-2 pr-3 font-medium">Process</th>
            <th className="pb-2 pr-3 font-medium">Type</th>
            <th className="pb-2 pr-3 font-medium">GPU memory</th>
            <th className="pb-2 pr-3 font-medium">CPU</th>
            <th className="pb-2 pr-3 font-medium">RSS</th>
            <th className="pb-2 font-medium">Container</th>
          </tr>
        </thead>
        <tbody>
          {procs.map((p) => (
            <tr key={`${p.pid}-${p.name}`} className="border-t border-edge">
              <td className="tnum py-2 pr-3 text-ink-secondary">{p.pid}</td>
              <td className="py-2 pr-3 font-medium text-ink" title={p.command ?? p.name}>
                {p.name}
              </td>
              <td className="py-2 pr-3">
                <Badge tone={p.type === "compute" ? "accent" : "neutral"}>
                  {p.type === "compute" ? "compute" : "graphics"}
                </Badge>
              </td>
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  <span className="tnum w-20 font-medium text-ink">{fmtBytes(p.vramBytes)}</span>
                  <Meter value={pctOf(p.vramBytes, total)} className="w-16" />
                </div>
              </td>
              <td className="tnum py-2 pr-3 text-ink-secondary">
                {p.cpuPct === undefined ? "—" : `${p.cpuPct.toFixed(0)}%`}
              </td>
              <td className="tnum py-2 pr-3 text-ink-secondary">
                {p.rssBytes ? fmtBytes(p.rssBytes) : "—"}
              </td>
              <td className="py-2 text-ink-secondary">
                {p.containerName ? (
                  <span title={p.containerId}>{p.containerName}</span>
                ) : (
                  <span className="text-ink-muted">host</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {procs.some((p) => p.elapsedSec !== undefined) && (
        <p className="mt-2 text-[11px] text-ink-muted">
          Longest running: {fmtDuration(Math.max(...procs.map((p) => p.elapsedSec ?? 0)))}
        </p>
      )}
    </div>
  );
}

function ContainerTab({ node }: { node: NodeSnapshot }) {
  if (!node.docker.available) {
    return <p className="text-[12px] text-ink-muted">Docker is not reachable on this node.</p>;
  }
  const containers = [...node.docker.containers].sort(
    (a, b) => Number(b.state === "running") - Number(a.state === "running") || (b.gpuVramBytes ?? 0) - (a.gpuVramBytes ?? 0)
  );
  if (!containers.length) return <p className="text-[12px] text-ink-muted">No containers.</p>;

  return (
    <div className="space-y-2">
      {containers.map((c) => (
        <div key={c.id} className="rounded-lg border border-edge bg-surface-2 px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="h-2 w-2 flex-none rounded-full"
                style={{
                  background: c.state === "running" ? "var(--status-good)" : "var(--text-muted)",
                }}
              />
              <span className="truncate text-[12px] font-semibold text-ink">{c.name}</span>
              {c.usesGpu && <Badge tone="accent">GPU</Badge>}
              {c.networkMode === "host" && <Badge tone="neutral">host net</Badge>}
            </div>
            <span className="text-[11px] text-ink-muted">{c.status}</span>
          </div>
          <div className="mt-1 truncate text-[11px] text-ink-secondary" title={c.image}>
            {shortImage(c.image)}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-secondary">
            {c.cpuPct !== undefined && <span className="tnum">CPU {c.cpuPct.toFixed(1)}%</span>}
            {c.memUsedBytes !== undefined && (
              <span className="tnum">
                RAM {fmtBytes(c.memUsedBytes)}
                {c.memLimitBytes ? ` / ${fmtBytes(c.memLimitBytes)}` : ""}
              </span>
            )}
            {!!c.gpuVramBytes && <span className="tnum">VRAM {fmtBytes(c.gpuVramBytes)}</span>}
          </div>
          {c.distributed && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-edge pt-2">
              {c.distributed.model && <Badge tone="neutral">{c.distributed.model}</Badge>}
              {c.distributed.rank !== undefined && <Badge tone="neutral">rank {c.distributed.rank}</Badge>}
              {c.distributed.masterAddr && (
                <Badge tone="neutral" title="Distributed rendezvous address">
                  master {c.distributed.masterAddr}
                </Badge>
              )}
              {c.distributed.ncclIbHca && (
                <Badge tone="accent" title="RDMA device NCCL is pinned to">
                  {c.distributed.ncclIbHca}
                </Badge>
              )}
              {c.distributed.ncclIbDisabled && (
                <Badge tone="warning" title="NCCL_IB_DISABLE=1 — collectives fall back to TCP">
                  RDMA disabled
                </Badge>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function HardwareTab({ node }: { node: NodeSnapshot }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div className="space-y-1.5 text-[12px]">
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">System</h4>
        <Row label="Hostname" value={node.info.hostname} />
        <Row label="Model" value={node.info.isSpark ? node.info.variantName : "—"} />
        <Row label="Manufacturer" value={node.info.sysVendor ?? "—"} />
        <Row label="Product" value={node.info.product ?? "—"} />
        <Row label="Family" value={node.info.productFamily ?? "—"} />
        <Row label="OS" value={node.info.osPretty} />
        <Row label="Kernel" value={`${node.info.kernel} (${node.info.arch})`} />
        <Row label="CPU" value={node.cpu.model || "—"} />
        <Row label="Uptime" value={fmtDuration(node.info.uptimeSec)} />
      </div>

      <div>
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">Sensors</h4>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
          {node.thermal.sensors.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2">
              <span className="truncate text-ink-secondary" title={s.label}>
                {s.label}
              </span>
              <span
                className="tnum font-medium"
                style={{
                  color:
                    s.critC && s.tempC >= s.critC * 0.85
                      ? "var(--status-critical)"
                      : s.tempC >= 80
                        ? "var(--status-warning)"
                        : "var(--text-primary)",
                }}
              >
                {s.tempC.toFixed(0)}°C
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="sm:col-span-2">
        <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          Network interfaces
        </h4>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-[12px]">
            <thead className="text-[11px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="pb-1.5 pr-3 font-medium">Interface</th>
                <th className="pb-1.5 pr-3 font-medium">Address</th>
                <th className="pb-1.5 pr-3 font-medium">Speed</th>
                <th className="pb-1.5 pr-3 font-medium">RX</th>
                <th className="pb-1.5 font-medium">TX</th>
              </tr>
            </thead>
            <tbody>
              {node.network.interfaces.map((i) => {
                const port = node.fabric.ports.find((p) => p.netdev === i.name);
                return (
                  <tr key={i.name} className="border-t border-edge">
                    <td className="py-1.5 pr-3">
                      <span className="font-medium text-ink">{i.name}</span>
                      {i.isFabric && (
                        <span className="ml-1.5 align-middle">
                          <Badge tone={port?.linkUp ? "accent" : "neutral"}>fabric</Badge>
                        </span>
                      )}
                    </td>
                    <td className="tnum py-1.5 pr-3 text-ink-secondary">{i.addresses[0] ?? "—"}</td>
                    <td className="tnum py-1.5 pr-3 text-ink-secondary">
                      {i.speedMbps ? `${i.speedMbps / 1000} Gbps` : i.carrier ? "up" : "down"}
                    </td>
                    <td className="tnum py-1.5 pr-3 text-ink-secondary">
                      {port ? fmtBps(port.rdmaRxBps + port.tcpRxBps) : fmtBps(i.rxBps)}
                    </td>
                    <td className="tnum py-1.5 text-ink-secondary">
                      {port ? fmtBps(port.rdmaTxBps + port.tcpTxBps) : fmtBps(i.txBps)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {node.fabric.ports.some((p) => p.linkUp) && (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-muted">
            Fabric RX/TX come from the NIC's RDMA counters. RoCE traffic bypasses the kernel network
            stack, so the usual interface statistics under-report these ports.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="shrink-0 text-ink-muted">{label}</span>
      <span className="truncate text-right font-medium text-ink" title={value}>
        {value}
      </span>
    </div>
  );
}

export { Sparkline, LegendItem };
