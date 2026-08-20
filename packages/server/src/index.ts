/**
 * sparktop server: collects from every configured node and serves the web UI.
 *
 * Runs on Bun's native HTTP/WebSocket server. Snapshots are pushed to clients
 * as they are produced rather than polled, so the UI's update rate is the
 * collector's rate with no extra latency.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheus,
  ClusterMonitor,
  HistoryDb,
  HistoryStore,
  checkImageUpdate,
  checkSparktopUpdate,
  buildNodeConfig,
  configPath,
  loadConfig,
  nodesFromEnv,
  safeEqual,
  applyImageSwap,
  containerAction,
  controlEnabled,
  listImages,
  planImageSwap,
  pullImage,
  saveConfig,
  testNodeConnection,
  toPublicNode,
  type AppConfig,
  type ClusterSnapshot,
  type NodeInput,
  type ServerMessage,
} from "@sparktop/core";

const PORT = Number(process.env.SPARKTOP_PORT ?? 5757);
const HOST = process.env.SPARKTOP_HOST ?? "0.0.0.0";
/** When set, all API and WebSocket access requires this bearer token. */
const API_TOKEN = process.env.SPARKTOP_TOKEN ?? "";
/** Static assets, produced by `bun run build:web`. */
const WEB_ROOT = resolve(process.env.SPARKTOP_WEB_ROOT ?? join(import.meta.dir, "..", "..", "web", "dist"));
/*
 * Read from the manifest rather than repeated as a literal, so a release bump
 * cannot leave the running server reporting the previous version.
 */
const VERSION: string = await (async () => {
  try {
    const pkg = await Bun.file(join(import.meta.dir, "..", "..", "..", "package.json")).json();
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

/** Last rendered scrape body, keyed by the snapshot it came from. */
let metricsCache: { ts: number; body: string } = { ts: -1, body: "" };

const cfgPath = configPath();
const config: AppConfig = await loadConfig(cfgPath);

/*
 * Env-declared nodes are additive and win on host collision, so a container can
 * be pointed at a cluster with SPARKTOP_NODES without a config file, while a
 * mounted config still works.
 */
const envNodes = nodesFromEnv();
if (envNodes.length) {
  const envHosts = new Set(envNodes.map((n) => `${n.username}@${n.host}:${n.port}`));
  config.nodes = config.nodes.filter((n) => !envHosts.has(`${n.username}@${n.host}:${n.port}`)).concat(envNodes);
}

if (process.env.SPARKTOP_FAST_MS) config.fastIntervalMs = Number(process.env.SPARKTOP_FAST_MS);
if (process.env.SPARKTOP_SLOW_MS) config.slowIntervalMs = Number(process.env.SPARKTOP_SLOW_MS);

const history = new HistoryStore(config.historySize);
const monitor = new ClusterMonitor(config);

/*
 * Durable history, alongside the in-memory ring.
 *
 * The ring backs the live charts and holds minutes; this holds weeks of run
 * sessions and downsampled throughput. Disabled with SPARKTOP_DATA=off for
 * deployments that would rather keep the container stateless.
 */
const durable =
  process.env.SPARKTOP_DATA === "off"
    ? null
    : new HistoryDb(undefined, {
        ...(process.env.SPARKTOP_RETENTION_DAYS
          ? { retentionDays: Number(process.env.SPARKTOP_RETENTION_DAYS) }
          : {}),
        ...(process.env.SPARKTOP_SAMPLE_MS ? { sampleIntervalMs: Number(process.env.SPARKTOP_SAMPLE_MS) } : {}),
      });

let latest: ClusterSnapshot | null = null;

monitor.on("snapshot", (snap) => {
  latest = snap;
  history.record(snap);
  try {
    durable?.record(snap);
  } catch (e) {
    // A failing disk must not take the live dashboard down with it.
    console.error("sparktop: history write failed:", (e as Error).message);
  }
  broadcast({ type: "snapshot", data: snap });
});

monitor.start();

// ---------------------------------------------------------------------------
// WebSocket fan-out
// ---------------------------------------------------------------------------

interface SocketData {
  id: number;
}

let nextSocketId = 1;
const sockets = new Set<Bun.ServerWebSocket<SocketData>>();

function broadcast(msg: ServerMessage): void {
  if (!sockets.size) return;
  const payload = JSON.stringify(msg);
  for (const ws of sockets) {
    // A slow or dead client must not stall the collector.
    try {
      ws.send(payload);
    } catch {
      sockets.delete(ws);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const err = (message: string, status = 400): Response => json({ error: message }, status);

function authorized(req: Request): boolean {
  if (!API_TOKEN) return true;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const url = new URL(req.url);
  const token = bearer || (url.searchParams.get("token") ?? "");
  return token.length > 0 && safeEqual(token, API_TOKEN);
}

async function persist(): Promise<void> {
  // Env-provided nodes are ephemeral by design and are not written back.
  const persistable = { ...monitor.config, nodes: monitor.config.nodes.filter((n) => !n.id.startsWith("env-")) };
  await saveConfig(persistable, cfgPath);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Serve the built SPA, falling back to index.html for client-side routes. */
async function serveStatic(pathname: string): Promise<Response> {
  if (!existsSync(WEB_ROOT)) {
    return new Response(
      "sparktop web UI is not built.\n\nRun: bun run build:web\n\nThe API and WebSocket endpoints are available regardless.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
  // Reject traversal before touching the filesystem.
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = resolve(WEB_ROOT, rel);
  if (!target.startsWith(WEB_ROOT)) return new Response("Forbidden", { status: 403 });

  let file = Bun.file(target);
  if (!(await file.exists())) {
    /*
     * Only client-side routes fall back to the shell. A request that names a
     * file extension is asking for an asset, and answering it with index.html
     * returns HTML under a 200 — so a missing image decodes as garbage instead
     * of failing cleanly, and a missing script fails somewhere far from the
     * cause.
     */
    if (rel !== "" && /\.[a-z0-9]{2,5}$/i.test(rel)) {
      return new Response("Not found", { status: 404 });
    }
    file = Bun.file(join(WEB_ROOT, "index.html"));
  }
  if (!(await file.exists())) return new Response("Not found", { status: 404 });

  const ext = (file.name ?? "").slice((file.name ?? "").lastIndexOf("."));
  const headers: Record<string, string> = { "content-type": MIME[ext] ?? "application/octet-stream" };
  // Vite emits content-hashed asset names, so they are safe to cache hard.
  headers["cache-control"] = rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return new Response(file, { headers });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve<SocketData, never>({
  port: PORT,
  hostname: HOST,
  idleTimeout: 60,

  async fetch(req, srv) {
    const url = new URL(req.url);
    const { pathname } = url;

    /*
     * Health stays reachable without a token so container orchestration can
     * probe it, but it only describes the fleet to a caller that proved it is
     * allowed to know. An unauthenticated prober needs liveness; it does not
     * need to learn how many machines exist and how many are reachable.
     */
    if (pathname === "/api/health") {
      const live = { ok: true, version: VERSION, uptimeSec: Math.round(process.uptime()) };
      if (!authorized(req)) return json(live);
      return json({
        ...live,
        nodes: monitor.config.nodes.length,
        online: latest?.totals.nodesOnline ?? 0,
      });
    }

    if (pathname === "/ws") {
      if (!authorized(req)) return err("Unauthorized", 401);
      if (srv.upgrade(req, { data: { id: nextSocketId++ } })) return undefined as unknown as Response;
      return err("WebSocket upgrade failed", 400);
    }

    /*
     * Prometheus scrape.
     *
     * Rendered from the snapshot the collector already produced, so a scrape
     * costs one string build and never an SSH round trip. The result is cached
     * against the snapshot's timestamp: several Prometheus servers, or one
     * scraping faster than the poll interval, then share a single render
     * instead of repeating it per request.
     */
    if (pathname === "/metrics" && req.method === "GET") {
      if (!authorized(req)) return err("Unauthorized", 401);
      const snap = latest ?? monitor.snapshot;
      if (metricsCache.ts !== snap.ts) {
        metricsCache = { ts: snap.ts, body: renderPrometheus(snap) };
      }
      return new Response(metricsCache.body, {
        headers: { "content-type": PROMETHEUS_CONTENT_TYPE, "cache-control": "no-store" },
      });
    }

    if (pathname.startsWith("/api/")) {
      if (!authorized(req)) return err("Unauthorized", 401);

      if (pathname === "/api/snapshot" && req.method === "GET") {
        return json(latest ?? monitor.snapshot);
      }

      if (pathname === "/api/history" && req.method === "GET") {
        return json(history.payload());
      }

      if (pathname === "/api/config" && req.method === "GET") {
        return json({
          nodes: monitor.config.nodes.map(toPublicNode),
          fastIntervalMs: monitor.config.fastIntervalMs,
          slowIntervalMs: monitor.config.slowIntervalMs,
        });
      }

      if (pathname === "/api/nodes" && req.method === "GET") {
        return json(monitor.config.nodes.map(toPublicNode));
      }

      /*
       * Dry-run a connection before it is saved.
       *
       * Onboarding is the step most likely to fail (wrong key path, wrong user,
       * host unreachable), and finding out through a node that silently sits in
       * "error" is a poor first experience. This reports the real SSH error and,
       * on success, what was found on the far end.
       */
      if (pathname === "/api/nodes/test" && req.method === "POST") {
        let input: NodeInput;
        try {
          input = (await req.json()) as NodeInput;
        } catch {
          return err("Invalid JSON body");
        }
        try {
          return json(await testNodeConnection(input));
        } catch (e) {
          return json({ ok: false, error: (e as Error).message });
        }
      }

      if (pathname === "/api/nodes" && req.method === "POST") {
        let input: NodeInput;
        try {
          input = (await req.json()) as NodeInput;
        } catch {
          return err("Invalid JSON body");
        }
        try {
          const node = buildNodeConfig(input);
          monitor.addNode(node);
          await persist();
          broadcastConfig();
          return json(toPublicNode(node), 201);
        } catch (e) {
          return err((e as Error).message);
        }
      }

      /*
       * Control plane.
       *
       * These are the only routes that change a node, and they are gated by
       * SPARKTOP_ENABLE_CONTROL. The dashboard is unauthenticated by default,
       * which is acceptable for reading metrics and not for stopping
       * containers, so the capability is opt-in rather than merely
       * confirm-on-click.
       */
      if (pathname === "/api/control" && req.method === "GET") {
        return json({ enabled: controlEnabled(), tokenRequired: API_TOKEN !== "" });
      }

      const ctrl = /^\/api\/nodes\/([^/]+)\/(images|container|swap)$/.exec(pathname);
      if (ctrl?.[1] && ctrl[2]) {
        const nodeId = decodeURIComponent(ctrl[1]);
        const collector = monitor.collector(nodeId);
        if (!collector) return err("No such node", 404);

        try {
          if (ctrl[2] === "images" && req.method === "GET") {
            // Read-only, so it stays available even with control disabled:
            // seeing what is on a node is not a change to it.
            return json({ images: await collector.withClient((c) => listImages(c)) });
          }

          if (ctrl[2] === "container" && req.method === "POST") {
            const body = (await req.json()) as {
              container?: string;
              action?: "start" | "stop" | "restart";
              dryRun?: boolean;
              timeoutSec?: number;
            };
            if (!body.container) return err("container is required");
            if (body.action !== "start" && body.action !== "stop" && body.action !== "restart") {
              return err("action must be start, stop or restart");
            }
            const res = await collector.withClient((c) =>
              containerAction(c, body.container!, body.action!, {
                ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
                ...(body.timeoutSec !== undefined ? { timeoutSec: body.timeoutSec } : {}),
              })
            );
            return json(res, res.ok ? 200 : 500);
          }

          if (ctrl[2] === "swap" && req.method === "POST") {
            const body = (await req.json()) as {
              container?: string;
              image?: string;
              apply?: boolean;
              pullOnly?: boolean;
            };
            if (!body.container || !body.image) return err("container and image are required");

            if (body.pullOnly) {
              const res = await collector.withClient((c) => pullImage(c, body.image!));
              return json(res, res.ok ? 200 : 500);
            }

            // A plan is always produced first; applying is a separate, explicit
            // request, so the destructive step is never a side effect of asking
            // what it would do.
            const plan = await collector.withClient((c) => planImageSwap(c, body.container!, body.image!));
            if (!body.apply) return json({ plan, applied: false });

            const res = await collector.withClient((c) => applyImageSwap(c, plan));
            return json({ plan, applied: res.ok, result: res }, res.ok ? 200 : 500);
          }
        } catch (e) {
          const msg = (e as Error).message;
          const name = (e as Error).name;
          const status = name === "ControlDisabledError" ? 403 : name === "InvalidTargetError" ? 400 : 500;
          return json({ error: msg }, status);
        }
        return err("Method not allowed", 405);
      }

      /*
       * Persisted history: serving sessions and downsampled throughput.
       */
      if (pathname === "/api/runs" && req.method === "GET") {
        if (!durable) return json({ runs: [], summary: null, disabled: true });
        const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 50) || 50);
        const sinceDays = Number(url.searchParams.get("days") ?? 7) || 7;
        return json({
          runs: durable.runs(limit),
          summary: durable.summary(Date.now() - sinceDays * 86_400_000),
          stats: durable.stats(),
          disabled: false,
        });
      }

      if (pathname === "/api/runs/samples" && req.method === "GET") {
        if (!durable) return json({ samples: [] });
        const sinceDays = Number(url.searchParams.get("days") ?? 1) || 1;
        const endpoint = url.searchParams.get("endpoint") ?? undefined;
        return json({ samples: durable.samples(Date.now() - sinceDays * 86_400_000, endpoint) });
      }

      /*
       * Update checks. Read-only: they report that something newer exists and
       * never act on it.
       */
      if (pathname === "/api/updates" && req.method === "GET") {
        const force = url.searchParams.get("refresh") === "1";
        return json(await updateState(force));
      }

      const nodeMatch = /^\/api\/nodes\/([^/]+)$/.exec(pathname);
      if (nodeMatch?.[1]) {
        const id = decodeURIComponent(nodeMatch[1]);
        if (req.method === "DELETE") {
          if (!monitor.removeNode(id)) return err("No such node", 404);
          await persist();
          broadcastConfig();
          return json({ ok: true });
        }
        if (req.method === "PATCH") {
          const existing = monitor.config.nodes.find((n) => n.id === id);
          if (!existing) return err("No such node", 404);
          let patch: Partial<NodeInput>;
          try {
            patch = (await req.json()) as Partial<NodeInput>;
          } catch {
            return err("Invalid JSON body");
          }
          try {
            const merged = buildNodeConfig(
              {
                host: patch.host ?? existing.host,
                port: patch.port ?? existing.port,
                username: patch.username ?? existing.username,
                ...(patch.label !== undefined ? { label: patch.label } : existing.label ? { label: existing.label } : {}),
                ...(patch.privateKeyPath !== undefined
                  ? { privateKeyPath: patch.privateKeyPath }
                  : existing.privateKeyPath
                    ? { privateKeyPath: existing.privateKeyPath }
                    : {}),
                ...(patch.password ? { password: patch.password } : {}),
                enabled: patch.enabled ?? existing.enabled,
              },
              id
            );
            // Preserve the stored secret when the caller did not supply a new one.
            if (!patch.password && existing.passwordEnc) merged.passwordEnc = existing.passwordEnc;
            monitor.addNode(merged);
            await persist();
            broadcastConfig();
            return json(toPublicNode(merged));
          } catch (e) {
            return err((e as Error).message);
          }
        }
      }

      return err("Not found", 404);
    }

    return serveStatic(pathname);
  },

  websocket: {
    open(ws) {
      sockets.add(ws);
      // Prime the client so it renders immediately instead of on next tick.
      const snap = latest ?? monitor.snapshot;
      ws.send(JSON.stringify({ type: "snapshot", data: snap } satisfies ServerMessage));
      ws.send(JSON.stringify({ type: "history", data: history.payload() } satisfies ServerMessage));
      ws.send(
        JSON.stringify({
          type: "config",
          data: {
            nodes: monitor.config.nodes.map(toPublicNode),
            fastIntervalMs: monitor.config.fastIntervalMs,
            slowIntervalMs: monitor.config.slowIntervalMs,
          },
        } satisfies ServerMessage)
      );
    },
    message(ws, raw) {
      try {
        const msg = JSON.parse(String(raw)) as { type?: string };
        if (msg.type === "getHistory") {
          ws.send(JSON.stringify({ type: "history", data: history.payload() } satisfies ServerMessage));
        }
      } catch {
        // Malformed client frames are ignored rather than closing the socket.
      }
    },
    close(ws) {
      sockets.delete(ws);
    },
  },
});

function broadcastConfig(): void {
  history.prune(new Set(monitor.config.nodes.map((n) => n.id)));
  broadcast({
    type: "config",
    data: {
      nodes: monitor.config.nodes.map(toPublicNode),
      fastIntervalMs: monitor.config.fastIntervalMs,
      slowIntervalMs: monitor.config.slowIntervalMs,
    },
  });
}

/*
 * Update state, cached.
 *
 * The GitHub API is rate-limited unauthenticated and a registry query costs a
 * round trip from every node, so results are held for an hour unless a refresh
 * is asked for explicitly.
 */
let updateCache: { at: number; data: unknown } | null = null;

async function updateState(force: boolean): Promise<unknown> {
  const HOUR = 3_600_000;
  if (!force && updateCache && Date.now() - updateCache.at < HOUR) return updateCache.data;

  const sparktop = await checkSparktopUpdate();

  // Image checks touch each node, so only ask about running containers, and
  // only once per distinct image.
  const images: unknown[] = [];
  for (const node of latest?.nodes ?? []) {
    if (node.status !== "online") continue;
    const collector = monitor.collector(node.id);
    if (!collector) continue;
    const seen = new Set<string>();
    for (const c of node.docker.containers) {
      if (c.state !== "running" || seen.has(c.image)) continue;
      seen.add(c.image);
      try {
        images.push(await collector.withClient((cl) => checkImageUpdate(cl, node.id, c.name, c.image)));
      } catch (e) {
        images.push({
          nodeId: node.id, container: c.name, image: c.image,
          localDigest: null, remoteDigest: null, updateAvailable: false, error: (e as Error).message,
        });
      }
    }
  }

  const data = { sparktop, images, checkedAt: Date.now() };
  updateCache = { at: Date.now(), data };
  return data;
}

const shutdown = (): void => {
  durable?.close();
  monitor.stop();
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`sparktop server listening on http://${HOST}:${PORT}`);
console.log(`  config:  ${cfgPath}`);
console.log(`  nodes:   ${config.nodes.length} (${config.nodes.map((n) => n.host).join(", ") || "none configured"})`);
console.log(`  web ui:  ${existsSync(WEB_ROOT) ? WEB_ROOT : "not built (run: bun run build:web)"}`);
if (!API_TOKEN) console.log("  auth:    disabled (set SPARKTOP_TOKEN to require a bearer token)");
