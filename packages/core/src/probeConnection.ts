/**
 * One-shot connection test used by onboarding.
 *
 * Opens a short-lived SSH session, reports what it found, and closes. Kept
 * separate from NodeCollector because that class is built around a long-lived
 * connection with retry and polling — none of which is wanted when the user is
 * still typing credentials into a form.
 */

import { readFile } from "node:fs/promises";
import { Client, type ConnectConfig } from "ssh2";
import { RS } from "./probe.ts";
import { splitSections } from "./parse.ts";
import type { NodeInput } from "./config.ts";

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
  hostname?: string;
  os?: string;
  arch?: string;
  gpu?: string;
  isSpark?: boolean;
  /** Active RDMA-capable ports found, i.e. the interconnect. */
  fabricPorts?: number;
  dockerAvailable?: boolean;
  /** Round-trip time of the check, ms. */
  latencyMs?: number;
  /** Non-fatal notes, e.g. docker present but not usable by this user. */
  notes?: string[];
}

/** Small script: enough to prove access and show the user what was detected. */
const CHECK = `#!/bin/sh
S() { printf '${RS}%s\\n' "$1"; }
S host
hostname 2>/dev/null
uname -m 2>/dev/null
(grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d'"' -f2) || echo ""
cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null || echo ""
S gpu
nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo ""
S fabric
for l in /sys/class/infiniband/*/device/net/*; do
  [ -e "$l" ] || continue
  n=\${l##*/}
  [ "$(cat /sys/class/net/$n/carrier 2>/dev/null)" = "1" ] && echo "$n"
done
S docker
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then echo OK; else echo DENIED; fi
else
  echo MISSING
fi
`;

export async function testNodeConnection(input: NodeInput, timeoutMs = 15_000): Promise<ConnectionTestResult> {
  if (!input.host?.trim()) return { ok: false, error: "Host is required" };
  if (!input.username?.trim()) return { ok: false, error: "Username is required" };
  if (!input.privateKeyPath && !input.password) {
    return { ok: false, error: "Provide either a private key path or a password" };
  }

  const cfg: ConnectConfig = {
    host: input.host.trim(),
    port: input.port ?? 22,
    username: input.username.trim(),
    readyTimeout: timeoutMs,
  };

  if (input.privateKeyPath) {
    try {
      cfg.privateKey = await readFile(input.privateKeyPath);
    } catch (e) {
      return { ok: false, error: `Cannot read private key at ${input.privateKeyPath}: ${(e as Error).message}` };
    }
    if (input.passphrase) cfg.passphrase = input.passphrase;
  } else if (input.password) {
    cfg.password = input.password;
  }

  const started = Date.now();

  return new Promise<ConnectionTestResult>((resolve) => {
    const client = new Client();
    let settled = false;
    const finish = (r: ConnectionTestResult) => {
      if (settled) return;
      settled = true;
      client.end();
      resolve(r);
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `Timed out after ${timeoutMs / 1000}s` }),
      timeoutMs + 2000
    );

    client.on("ready", () => {
      client.exec(CHECK, (execErr, stream) => {
        if (execErr) {
          clearTimeout(timer);
          return finish({ ok: false, error: execErr.message });
        }
        let out = "";
        stream.on("data", (d: Buffer) => (out += d.toString()));
        stream.stderr.resume();
        stream.on("close", () => {
          clearTimeout(timer);
          const s = splitSections(out);
          const hostLines = (s.host ?? "").split("\n").map((x) => x.trim());
          const gpu = (s.gpu ?? "").trim().split("\n")[0] ?? "";
          const product = hostLines[3] ?? "";
          const hostname = hostLines[0] ?? "";
          const fabricPorts = (s.fabric ?? "").split("\n").filter((x) => x.trim()).length;
          const dockerState = (s.docker ?? "").trim();

          const notes: string[] = [];
          if (dockerState === "DENIED") {
            notes.push(
              `${input.username} cannot use Docker on this host. Add the user to the docker group ` +
                `to see containers: sudo usermod -aG docker ${input.username}`
            );
          } else if (dockerState === "MISSING") {
            notes.push("Docker is not installed, so container metrics will be unavailable.");
          }
          if (!gpu) notes.push("No NVIDIA GPU detected — GPU metrics will be empty.");
          if (fabricPorts === 0) {
            notes.push("No cabled RDMA ports found, so no interconnect links will be shown for this node.");
          }

          finish({
            ok: true,
            hostname,
            arch: hostLines[1] ?? "",
            os: hostLines[2] ?? "",
            gpu,
            isSpark: /spark|gx10|gb10/i.test(`${product} ${gpu} ${hostname}`),
            fabricPorts,
            dockerAvailable: dockerState === "OK",
            latencyMs: Date.now() - started,
            ...(notes.length ? { notes } : {}),
          });
        });
      });
    });

    client.on("error", (e) => {
      clearTimeout(timer);
      // ssh2's messages are terse; translate the common ones.
      const msg = e.message || String(e);
      const friendly = /All configured authentication methods failed/i.test(msg)
        ? "Authentication failed. Check the username, and that the key is authorised on the node."
        : /ECONNREFUSED/i.test(msg)
          ? "Connection refused. Is SSH running on that host and port?"
          : /EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/i.test(msg)
            ? "Host unreachable. Check the address and that it is on the network."
            : /ENOTFOUND/i.test(msg)
              ? "Host not found. Check the hostname or use an IP address."
              : msg;
      finish({ ok: false, error: friendly });
    });

    try {
      client.connect(cfg);
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: (e as Error).message });
    }
  });
}
