/**
 * Config persistence.
 *
 * The node registry lives in a JSON file so nodes can be added and removed at
 * runtime without restarting the collector. Writes are atomic (temp file plus
 * rename) so a crash mid-write cannot leave an unparseable registry behind.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig, NodeConfig, PublicNodeConfig } from "./types.ts";
import { encryptSecret, hasSecret } from "./crypto.ts";

/**
 * Defaults chosen for the machines being watched, not for the dashboard.
 *
 * A GB10 serving a model is unusually sensitive to being interrupted: the
 * inference and NCCL paths busy-poll, so a monitor that takes a slice of CPU
 * every second costs throughput out of proportion to the slice. Five seconds
 * loses nothing worth seeing — GPU load, temperature and fabric throughput do
 * not carry meaningful detail below that — and cuts the interruptions by 80%.
 *
 * A 300-sample ring at this interval holds 25 minutes of history rather than
 * five, which is more useful for spotting what happened than a denser window.
 * Set SPARKTOP_FAST_MS=1000 to go back to per-second sampling on a node that
 * is not busy.
 */
export const DEFAULT_CONFIG: AppConfig = {
  nodes: [],
  fastIntervalMs: 5_000,
  slowIntervalMs: 30_000,
  historySize: 300,
};

export function configPath(): string {
  return resolve(process.env.SPARKTOP_CONFIG ?? join(process.cwd(), "config", "nodes.json"));
}

/**
 * Intervals the old defaults wrote into every config file.
 *
 * A config written by an earlier version carries these whether or not anyone
 * chose them, and a stored value beats a new default — so without this every
 * existing install would keep polling once a second forever, which is exactly
 * the load the new defaults exist to avoid. A value equal to the old default is
 * treated as "never chosen" and moves; anything else is a deliberate setting
 * and is left alone.
 */
const SUPERSEDED_INTERVALS = { fastIntervalMs: 1000, slowIntervalMs: 10_000 };

export async function loadConfig(path = configPath()): Promise<AppConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AppConfig>;
    const merged: AppConfig = {
      ...DEFAULT_CONFIG,
      ...parsed,
      nodes: (parsed.nodes ?? []).map(normalizeNode),
    };
    for (const key of ["fastIntervalMs", "slowIntervalMs"] as const) {
      if (parsed[key] === SUPERSEDED_INTERVALS[key]) merged[key] = DEFAULT_CONFIG[key];
    }
    return merged;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw new Error(`Failed to read config at ${path}: ${(err as Error).message}`);
  }
}

export async function saveConfig(cfg: AppConfig, path = configPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

function normalizeNode(n: Partial<NodeConfig>): NodeConfig {
  return {
    id: n.id ?? randomUUID(),
    ...(n.label !== undefined ? { label: n.label } : {}),
    host: n.host ?? "",
    port: n.port ?? 22,
    username: n.username ?? "root",
    ...(n.privateKeyPath !== undefined ? { privateKeyPath: n.privateKeyPath } : {}),
    ...(n.passphraseEnc !== undefined ? { passphraseEnc: n.passphraseEnc } : {}),
    ...(n.passwordEnc !== undefined ? { passwordEnc: n.passwordEnc } : {}),
    ...(n.intervalMs !== undefined ? { intervalMs: n.intervalMs } : {}),
    enabled: n.enabled ?? true,
    addedAt: n.addedAt ?? Date.now(),
  };
}

export interface NodeInput {
  label?: string;
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  /** Plaintext; encrypted before it touches disk. */
  password?: string;
  passphrase?: string;
  enabled?: boolean;
}

export function buildNodeConfig(input: NodeInput, id: string = randomUUID()): NodeConfig {
  if (!input.host?.trim()) throw new Error("host is required");
  if (!input.username?.trim()) throw new Error("username is required");
  if (!input.privateKeyPath && !input.password) {
    throw new Error("Either privateKeyPath or password is required");
  }
  if ((input.password || input.passphrase) && !hasSecret()) {
    throw new Error(
      "SPARKTOP_SECRET must be set before storing a password or passphrase. " +
        "Generate one with: openssl rand -hex 32"
    );
  }
  return {
    id,
    ...(input.label ? { label: input.label } : {}),
    host: input.host.trim(),
    port: input.port ?? 22,
    username: input.username.trim(),
    ...(input.privateKeyPath ? { privateKeyPath: input.privateKeyPath } : {}),
    ...(input.password ? { passwordEnc: encryptSecret(input.password) } : {}),
    ...(input.passphrase ? { passphraseEnc: encryptSecret(input.passphrase) } : {}),
    enabled: input.enabled ?? true,
    addedAt: Date.now(),
  };
}

/** Strip all secret material before sending config to a client. */
export function toPublicNode(n: NodeConfig): PublicNodeConfig {
  return {
    id: n.id,
    ...(n.label !== undefined ? { label: n.label } : {}),
    host: n.host,
    port: n.port,
    username: n.username,
    authMethod: n.privateKeyPath ? "key" : n.passwordEnc ? "password" : "none",
    enabled: n.enabled,
    addedAt: n.addedAt,
  };
}

/**
 * Seed nodes from the environment, for container deployments that would rather
 * not mount a config file.
 *
 * Format: SPARKTOP_NODES="user@host:port,user@host" with SPARKTOP_SSH_KEY
 * pointing at a shared private key.
 */
export function nodesFromEnv(): NodeConfig[] {
  const spec = process.env.SPARKTOP_NODES?.trim();
  if (!spec) return [];
  const keyPath = process.env.SPARKTOP_SSH_KEY?.trim();
  const password = process.env.SPARKTOP_SSH_PASSWORD?.trim();
  return spec.split(",").map((entry, i) => {
    const s = entry.trim();
    const at = s.lastIndexOf("@");
    const username = at > 0 ? s.slice(0, at) : (process.env.SPARKTOP_SSH_USER ?? "root");
    const hostPart = at > 0 ? s.slice(at + 1) : s;
    const [host = hostPart, portStr] = hostPart.split(":");
    return buildNodeConfig(
      {
        host,
        port: portStr ? Number(portStr) : 22,
        username,
        ...(keyPath ? { privateKeyPath: keyPath } : {}),
        ...(!keyPath && password ? { password } : {}),
      },
      `env-${i}-${host}`
    );
  });
}
