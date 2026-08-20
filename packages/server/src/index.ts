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
  ClusterMonitor,
  HistoryStore,
  buildNodeConfig,
  configPath,
  loadConfig,
  nodesFromEnv,
  safeEqual,
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

let latest: ClusterSnapshot | null = null;

monitor.on("snapshot", (snap) => {
  latest = snap;
  history.record(snap);
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
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
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
  if (rel === "" || !(await file.exists())) file = Bun.file(join(WEB_ROOT, "index.html"));
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

    if (pathname === "/api/health") {
      return json({
        ok: true,
        version: "0.1.0",
        nodes: monitor.config.nodes.length,
        online: latest?.totals.nodesOnline ?? 0,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (pathname === "/ws") {
      if (!authorized(req)) return err("Unauthorized", 401);
      if (srv.upgrade(req, { data: { id: nextSocketId++ } })) return undefined as unknown as Response;
      return err("WebSocket upgrade failed", 400);
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

const shutdown = (): void => {
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
