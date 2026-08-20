/**
 * Update checks: sparktop itself, and the images your containers run.
 *
 * Both are strictly read-only. Nothing here pulls, restarts or writes anything
 * — it reports that something newer exists and leaves the decision alone. That
 * matters more than usual for the image check, since acting on it interrupts a
 * machine that is probably serving.
 */

import type { Client } from "ssh2";
import { run } from "./control.ts";

export interface SparktopUpdate {
  checkedAt: number;
  /** The commit this build is running, when known. */
  currentCommit: string | null;
  latestCommit: string | null;
  /** True only when both are known and differ. */
  updateAvailable: boolean;
  /** How far behind, when the API could tell us. */
  behindBy: number | null;
  latestMessage: string | null;
  latestUrl: string | null;
  error: string | null;
}

export interface ImageUpdate {
  nodeId: string;
  container: string;
  image: string;
  /** Digest of the image the container is running. */
  localDigest: string | null;
  /** Digest the registry currently serves for that tag. */
  remoteDigest: string | null;
  updateAvailable: boolean;
  error: string | null;
}

const REPO = process.env.SPARKTOP_REPO ?? "metaspartan/sparktop";

/**
 * The commit this process is running.
 *
 * Baked in at build time for a container, or read from git in a checkout.
 * Returns null rather than guessing, so "unknown" is reported honestly instead
 * of producing a false "up to date".
 */
export async function currentCommit(): Promise<string | null> {
  const fromEnv = process.env.SPARKTOP_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Ask GitHub whether the tracked branch has moved on.
 *
 * Unauthenticated, so it is subject to a low rate limit — checked hourly at
 * most, and any failure is reported rather than retried aggressively.
 */
export async function checkSparktopUpdate(timeoutMs = 10_000): Promise<SparktopUpdate> {
  const base: SparktopUpdate = {
    checkedAt: Date.now(),
    currentCommit: await currentCommit(),
    latestCommit: null,
    updateAvailable: false,
    behindBy: null,
    latestMessage: null,
    latestUrl: null,
    error: null,
  };

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/HEAD`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "sparktop" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ...base, error: `GitHub responded ${res.status}` };
    const body = (await res.json()) as { sha?: string; html_url?: string; commit?: { message?: string } };
    const latest = body.sha ?? null;
    const behind = base.currentCommit && latest ? await commitsBehind(base.currentCommit, latest, timeoutMs) : null;
    return {
      ...base,
      latestCommit: latest,
      latestMessage: body.commit?.message?.split("\n")[0] ?? null,
      latestUrl: body.html_url ?? null,
      updateAvailable: Boolean(base.currentCommit && latest && base.currentCommit !== latest),
      behindBy: behind,
    };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

/** How many commits separate the running build from the tip. */
async function commitsBehind(from: string, to: string, timeoutMs: number): Promise<number | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/compare/${from}...${to}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "sparktop" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ahead_by?: number };
    return typeof body.ahead_by === "number" ? body.ahead_by : null;
  } catch {
    return null;
  }
}

/**
 * Compare a container's image against what the registry now serves.
 *
 * `docker manifest inspect` queries the registry without downloading layers,
 * which is what makes this safe to run against a node that is busy. A digest
 * pin can never have an update by definition, so it is skipped rather than
 * reported as current.
 */
export async function checkImageUpdate(
  client: Client,
  nodeId: string,
  container: string,
  image: string
): Promise<ImageUpdate> {
  const base: ImageUpdate = {
    nodeId,
    container,
    image,
    localDigest: null,
    remoteDigest: null,
    updateAvailable: false,
    error: null,
  };

  // Pinned by digest: there is nothing to compare, the reference is immutable.
  if (image.includes("@sha256:")) {
    return { ...base, localDigest: image.split("@")[1] ?? null, error: "Pinned to a digest" };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/]*(:[a-zA-Z0-9._-]+)?$/.test(image)) {
    return { ...base, error: "Unsupported image reference" };
  }

  try {
    const local = await run(
      client,
      `docker image inspect ${image} --format '{{index .RepoDigests 0}}' 2>/dev/null`,
      30_000
    );
    const localDigest = local.ok ? (local.stdout.split("@")[1] ?? null) : null;

    const remote = await run(
      client,
      `docker manifest inspect ${image} 2>/dev/null | grep -m1 -oE '"digest": *"sha256:[a-f0-9]{64}"' | grep -oE 'sha256:[a-f0-9]{64}'`,
      60_000
    );
    const remoteDigest = remote.ok && remote.stdout ? remote.stdout.split("\n")[0]!.trim() : null;

    if (!remoteDigest) {
      return { ...base, localDigest, error: "Registry did not return a manifest (private, or not logged in)" };
    }
    return {
      ...base,
      localDigest,
      remoteDigest,
      // Only claim an update when both sides are known; unknown is not "stale".
      updateAvailable: Boolean(localDigest && remoteDigest && localDigest !== remoteDigest),
    };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}
