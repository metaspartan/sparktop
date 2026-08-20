#!/usr/bin/env bun
/**
 * sparktop TUI.
 *
 * Runs the same collector the server does, so the terminal view needs no server
 * — point it at a config file (or SPARKTOP_NODES) and it connects directly. It
 * can also attach to a running sparktop server with --server, which is cheaper
 * when several people are watching the same cluster.
 */

import {
  ClusterMonitor,
  loadConfig,
  configPath,
  nodesFromEnv,
  type AppConfig,
  type ClusterSnapshot,
} from "@sparktop/core";
import { screen } from "./ansi.ts";
import { footer, render, type RenderState, type View } from "./render.ts";

const args = process.argv.slice(2);
const has = (f: string): boolean => args.includes(f);
const val = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

if (has("--help") || has("-h")) {
  console.log(`sparktop — terminal dashboard for DGX Spark clusters

Usage:
  sparktop [options]

Options:
  --server <url>   Attach to a running sparktop server instead of collecting
                   directly (e.g. --server http://localhost:5757)
  --config <path>  Path to nodes.json (default: ./config/nodes.json,
                   or $SPARKTOP_CONFIG)
  --interval <ms>  Fast poll interval when collecting directly (default 1000)
  --once           Print a single frame and exit. Implied when stdout is not a
                   TTY, so \`sparktop | less\` and cron jobs behave sensibly.
  -h, --help       Show this help

Environment:
  SPARKTOP_NODES       user@host[:port],user@host  — nodes without a config file
  SPARKTOP_SSH_KEY     private key used for those nodes
  SPARKTOP_SSH_PASSWORD  password auth (requires SPARKTOP_SECRET)
  SPARKTOP_SECRET      key for encrypting stored credentials
  NO_COLOR             disable colour

Keys:
  o/f/p/c  switch view      ←/→  select node      space  pause      q  quit`);
  process.exit(0);
}

const HISTORY_LEN = 120;

const state: RenderState = {
  view: "overview",
  selected: -1,
  width: process.stdout.columns ?? 100,
  height: process.stdout.rows ?? 30,
  paused: false,
  history: new Map(),
};

/*
 * Held in an object rather than a bare `let`: the only writer is an async
 * callback, so TypeScript's control-flow analysis would otherwise narrow the
 * variable to `null` at every read site.
 */
const store: { snapshot: ClusterSnapshot | null } = { snapshot: null };
let dirty = true;

function recordHistory(snap: ClusterSnapshot): void {
  const push = (key: string, v: number) => {
    const arr = state.history.get(key) ?? [];
    arr.push(v);
    if (arr.length > HISTORY_LEN) arr.shift();
    state.history.set(key, arr);
  };
  for (const n of snap.nodes) {
    if (n.status !== "online") continue;
    push(`${n.id}:gpu`, n.gpu?.utilPct ?? 0);
    push(
      `${n.id}:vram`,
      n.gpu && n.gpu.vramTotalBytes > 0 ? (n.gpu.vramUsedBytes / n.gpu.vramTotalBytes) * 100 : 0
    );
    push(`${n.id}:cpu`, n.cpu.usagePct);
    push(
      `${n.id}:mem`,
      n.memory.totalBytes > 0 ? (n.memory.usedBytes / n.memory.totalBytes) * 100 : 0
    );
  }
}

function onSnapshot(snap: ClusterSnapshot): void {
  if (state.paused) return;
  store.snapshot = snap;
  recordHistory(snap);
  dirty = true;
}

// ---------------------------------------------------------------------------
// Data source
// ---------------------------------------------------------------------------

let stopSource: () => void = () => {};

const serverUrl = val("--server");
if (serverUrl) {
  const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;

  const connect = (): void => {
    if (closed) return;
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      attempt = 0;
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type: string; data: ClusterSnapshot };
        if (msg.type === "snapshot") onSnapshot(msg.data);
      } catch {
        // Ignore malformed frames.
      }
    };
    ws.onclose = () => {
      if (closed) return;
      setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(attempt++, 4)));
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  stopSource = () => {
    closed = true;
    ws?.close();
  };
} else {
  const cfg: AppConfig = await loadConfig(val("--config") ?? configPath());
  const envNodes = nodesFromEnv();
  if (envNodes.length) {
    const seen = new Set(envNodes.map((n) => `${n.username}@${n.host}:${n.port}`));
    cfg.nodes = cfg.nodes.filter((n) => !seen.has(`${n.username}@${n.host}:${n.port}`)).concat(envNodes);
  }
  const interval = val("--interval");
  if (interval) cfg.fastIntervalMs = Number(interval);

  const monitor = new ClusterMonitor(cfg);
  monitor.on("snapshot", onSnapshot);
  monitor.start();
  stopSource = () => monitor.stop();
}

// ---------------------------------------------------------------------------
// Terminal lifecycle
// ---------------------------------------------------------------------------

const out = process.stdout;

/*
 * One-shot mode. Piping into a pager or capturing output in a script should
 * produce plain text, not an alternate-screen session that immediately exits,
 * so a non-TTY stdout implies --once.
 */
if (has("--once") || !out.isTTY) {
  const deadline = Date.now() + 30_000;
  /*
   * Wait for a frame worth printing, not merely the first one.
   *
   * The slow tier supplies disks and containers, and inference endpoints need a
   * further fast poll after that tier discovers them — so a one-shot render
   * that stops at the first snapshot reports a machine with no storage, no
   * containers and no engines. Waiting for disks to appear is the cheapest
   * signal that the slow tier has landed.
   */
  const ready = () => {
    const nodes = store.snapshot?.nodes.filter((n) => n.status === "online") ?? [];
    return nodes.length > 0 && nodes.every((n) => n.disks.length > 0);
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (ready()) {
      // Two more fast polls: one to scrape endpoints the slow tier just
      // discovered, and one so their token counters have a delta to rate.
      await new Promise((r) => setTimeout(r, 2600));
      break;
    }
  }
  state.width = out.columns ?? 120;
  state.height = 9999;
  const lines = render(store.snapshot, state);
  out.write(lines.join("\n") + "\n");
  stopSource();
  process.exit(store.snapshot?.nodes.some((n) => n.status === "online") ? 0 : 1);
}

function cleanup(): void {
  stopSource();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  out.write(screen.showCursor + screen.altOff);
}

function quit(): void {
  cleanup();
  process.exit(0);
}

process.on("SIGINT", quit);
process.on("SIGTERM", quit);
process.on("exit", cleanup);
process.on("uncaughtException", (err) => {
  cleanup();
  console.error("sparktop: unexpected error\n", err);
  process.exit(1);
});

out.write(screen.altOn + screen.hideCursor + screen.clear);

out.on("resize", () => {
  state.width = out.columns ?? 100;
  state.height = out.rows ?? 30;
  dirty = true;
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (buf) => {
    const s = buf.toString();
    const nodeCount = store.snapshot?.nodes.length ?? 0;
    // Ctrl-C and Ctrl-D.
    if (s === "\x03" || s === "\x04" || s === "q") return quit();

    const views: Record<string, View> = { o: "overview", f: "fabric", p: "processes", c: "containers" };
    if (views[s]) {
      state.view = views[s]!;
    } else if (s === " ") {
      state.paused = !state.paused;
    } else if (s === "\x1b[C" || s === "l") {
      // Right: cycle forward through nodes, wrapping back to "all".
      state.selected = state.selected + 1 >= nodeCount ? -1 : state.selected + 1;
    } else if (s === "\x1b[D" || s === "h") {
      state.selected = state.selected - 1 < -1 ? nodeCount - 1 : state.selected - 1;
    } else if (/^[1-9]$/.test(s)) {
      const i = Number(s) - 1;
      state.selected = i < nodeCount ? i : state.selected;
    } else if (s === "\t") {
      const order: View[] = ["overview", "fabric", "processes", "containers"];
      state.view = order[(order.indexOf(state.view) + 1) % order.length]!;
    } else {
      return;
    }
    dirty = true;
  });
}

/**
 * Frame loop.
 *
 * Redraws only when something changed, and repaints by rewriting each line with
 * an erase-to-end rather than clearing the screen, which is what keeps the
 * output from flickering.
 */
function draw(): void {
  if (!dirty) return;
  dirty = false;

  const H = state.height;
  const body = render(store.snapshot, state).slice(0, Math.max(0, H - 2));
  const chunks: string[] = [screen.home];

  for (const line of body) chunks.push(line, screen.clearLine, "\n");
  // Pad so stale content below the new frame is erased.
  for (let i = body.length; i < H - 2; i++) chunks.push(screen.clearLine, "\n");
  chunks.push(footer(state, state.width, store.snapshot?.nodes.length ?? 0), screen.clearLine);

  out.write(chunks.join(""));
}

setInterval(draw, 100);
draw();
