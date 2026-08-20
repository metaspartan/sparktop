/** Formatting helpers shared by the TUI and the web UI. */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** Human byte size, base 1024. */
export function fmtBytes(n: number, digits?: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const d = digits ?? (v >= 100 || i === 0 ? 0 : 1);
  return `${v.toFixed(d)} ${BYTE_UNITS[i]}`;
}

/**
 * Network throughput, in bits per second with SI units.
 *
 * Network gear is specified in bits, so a 200 Gb/s port should read as such
 * even though the counters underneath are bytes.
 */
export function fmtBps(bytesPerSec: number): string {
  const bits = bytesPerSec * 8;
  if (!Number.isFinite(bits) || bits < 1) return "0 bps";
  const units = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"];
  let v = bits;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function fmtGbps(gbps: number): string {
  if (!Number.isFinite(gbps) || gbps <= 0) return "0 Gbps";
  if (gbps < 0.001) return `${(gbps * 1e6).toFixed(0)} Kbps`;
  if (gbps < 1) return `${(gbps * 1000).toFixed(gbps * 1000 >= 100 ? 0 : 1)} Mbps`;
  return `${gbps.toFixed(gbps >= 100 ? 0 : gbps >= 10 ? 1 : 2)} Gbps`;
}

export function fmtPct(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "0%";
  return `${n.toFixed(digits)}%`;
}

/** Compact duration, e.g. "3d 4h", "12m 5s". */
export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "-";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtTemp(c: number | null | undefined): string {
  return c === null || c === undefined || !Number.isFinite(c) ? "-" : `${c.toFixed(0)}°C`;
}

export function fmtWatts(w: number | null | undefined): string {
  return w === null || w === undefined || !Number.isFinite(w) ? "-" : `${w.toFixed(w >= 100 ? 0 : 1)} W`;
}

/** Trim a container image reference to something readable. */
export function shortImage(image: string): string {
  const noDigest = image.split("@")[0] ?? image;
  const parts = noDigest.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : noDigest;
}

/** Percentage of a total, guarding against divide-by-zero. */
export function pctOf(used: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
}
