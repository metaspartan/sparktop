<div align="center">

# sparktop

**Realtime TUI and web dashboard for multi-node NVIDIA DGX Spark clusters.**

Built for GB10. Sees the 200G ConnectX-7 interconnect that ordinary tools miss.

[Quick start](#quick-start) · [Why RDMA counters](#why-the-usual-network-stats-lie) · [TUI](#terminal-ui) · [API](#http-api) · [Configuration](#configuration)

[![CI](https://github.com/metaspartan/sparktop/actions/workflows/ci.yml/badge.svg)](https://github.com/metaspartan/sparktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/arch-arm64%20%7C%20amd64-informational)

</div>

---

## What it does

`sparktop` watches a fleet of DGX Sparks from one place — in the terminal, in a browser, or both — and answers the questions a per-machine tool cannot:

- **Which Sparks are cabled to which**, over which ports, and how much is moving in each direction *right now*.
- **What is holding GPU memory** — per-process VRAM, mapped back to the container that owns it.
- **What is running across more than one node** — tensor-parallel jobs are detected from container topology, with ranks and aggregate VRAM.
- **Everything you would expect**: GPU utilisation, unified memory, per-core CPU, every thermal sensor, disks, Docker containers, and network interfaces.

It is **agentless**. Nothing is installed on the Sparks; `sparktop` connects over SSH and reads sysfs, `nvidia-smi`, `ethtool` and `docker` as an ordinary user. No root, no passwordless sudo, no daemon on the nodes.

## Why the usual network stats lie

This is the reason `sparktop` exists.

NCCL moves data between Sparks over **RoCE**, which bypasses the kernel network stack entirely. `/proc/net/dev`, `ifconfig`, `ip -s link`, and every dashboard built on them therefore report almost nothing on the interconnect. Measured on a live pair mid-job:

| Source | Bytes reported on `enp1s0f1np1` |
|---|---|
| `/proc/net/dev` (what most tools read) | **5.6 MB** |
| `rx_vport_rdma_unicast_bytes` (what actually moved) | **325 GB** |

Four orders of magnitude. `sparktop` reads the NIC's RDMA vport counters via `ethtool -S`, falling back to the InfiniBand port counters in `/sys/class/infiniband` (which count 4-octet words, not bytes — a detail that silently produces a 4× error if missed).

### Verified topology

Nothing on a Spark reports "this cable reaches that machine". `sparktop` infers pairing from IPv4 addressing — two ports on one subnet, on two different nodes — and then **proves** it against traffic: on a real link, A's transmit counter and B's receive counter move together. Links that corroborate are marked `verified`. A pairing that shares a subnet but whose counters disagree is flagged instead of quietly trusted.

Where three or more ports share a subnet there is a switch in the middle, and per-peer traffic genuinely cannot be attributed from NIC counters. `sparktop` says so rather than inventing links.

### What it will not tell you

Some notes on DGX Spark networking, since the hardware is easy to misread:

- **One QSFP cable already gives you the full 200GbE link.** Adding a second cable does not increase bandwidth. ([NVIDIA: Connect Two Sparks](https://build.nvidia.com/spark/connect-two-sparks))
- On GB10 that single cable **presents as two RDMA interfaces** of roughly 100 Gb/s each. Reaching the full link speed means using both — `NCCL_IB_MERGE_NICS=1` — not adding hardware.
- `sparktop` will never suggest that more cables means more bandwidth.

## Hardware variants

GB10 ships as NVIDIA's Founders Edition plus seven NVIDIA-certified partner workstations. `sparktop` identifies which one each node is and shows it on the card, so a mixed fleet is readable at a glance:

| Variant | Manufacturer | Typical DMI `product_name` |
|---|---|---|
| NVIDIA DGX Spark (Founders Edition) | NVIDIA | `DGX Spark` |
| ASUS Ascent GX10 | ASUSTeK | `GX10` |
| Dell Pro Max with GB10 | Dell | `Pro Max` |
| HP ZGX Nano AI Station | HP | `ZGX Nano G1n` |
| Lenovo ThinkStation PGX | Lenovo | `PGX` |
| MSI EdgeXpert | Micro-Star | `MS-C931` |
| GIGABYTE AI TOP ATOM | GIGABYTE | `AI TOP ATOM` |
| Acer Veriton GN100 | Acer | `GN100` |

Detection reads DMI rather than guessing from hostnames. `product_family` reports `DGX Spark` on **every** variant regardless of who built the chassis, which makes it the reliable signal; `sys_vendor` then names the manufacturer. An ASUS unit reports:

```
sys_vendor      ASUSTeK COMPUTER INC.
product_name    GX10
product_family  DGX Spark
```

Every node card shows its chassis, so a mixed rack is readable at a glance. The images live in `packages/web/public/variants/<id>.webp`; any variant without one falls back to a drawn vector icon, so the UI still distinguishes hardware if you strip them. `scripts/split-variants.py` regenerates them from your own sources.

## Requirements

- One or more DGX Spark (GB10) machines, reachable over SSH. Non-Spark NVIDIA
  hosts work too — you simply get no fabric section for them.
- An SSH user on each node. No root and no passwordless sudo required; add the
  user to the `docker` group if you want container metrics.
- To run sparktop itself: Docker, or [Bun](https://bun.sh) 1.1+.

## Quick start

### Docker Compose (recommended)

```bash
git clone https://github.com/metaspartan/sparktop.git
cd sparktop
cp .env.example .env
```

Put an SSH key where the container can read it, and authorise it on each Spark:

```bash
ssh-keygen -t ed25519 -f ./config/id_ed25519 -N ""
for h in 10.0.0.11 10.0.0.12; do ssh-copy-id -i ./config/id_ed25519.pub ubuntu@$h; done
```

Set `SPARKTOP_NODES` in `.env`, then:

```bash
docker compose up -d
```

Open <http://localhost:5757>. The image is multi-arch (`linux/arm64` + `linux/amd64`), so it runs on a Spark itself or on any other machine that can reach them.

If you would rather not touch a config file, start it with no nodes and the web UI walks you through adding them — each one is verified over SSH before it is saved.

### Without Docker

Requires [Bun](https://bun.sh) 1.1+.

```bash
bun install
bun run build:web
bun run start
```

## Terminal UI

The TUI runs the same collector, so it needs no server:

```bash
bun run tui
```

Or attach it to a running instance, which is cheaper when several people are watching:

```bash
bun packages/tui/src/index.ts --server http://localhost:5757
```

```
sparktop │ 2/2 nodes                                              21:12:18
fabric 16.3 Gbps/800G · vram 200 GB/243 GB · cpu 18% · pwr 132 W · temp 89°C

── Nodes ──────────────────────────────────────────────────────────────────
● spark-01 10.0.0.11 [ASUS Ascent GX10]  225ms
  GPU  ██████████████████████▊·  96%   96%                          ███
  VRAM ███████████████████▊····  82%   100 GB/122 GB                ▇▇▇
  CPU  ███▍····················  18%   18%                          ▁▂▂
  temp 89°C  pwr 65.8 W  net ↓8.15 Gbps ↑8.15 Gbps  up 5h 1m

── Interconnect ───────────────────────────────────────────────────────────
  spark-01:enp1s0f1np1    ⇄ spark-02:enp1s0f1np1    ▏···  16.3 Gbps /200G ✓
  spark-01:enP2p1s0f1np1  · spark-02:enP2p1s0f1np1  ····      0 Gbps /200G ✓
```

Keys: `o` overview · `f` fabric · `p` processes · `c` containers · `←/→` select node · `space` pause · `q` quit.

Piping to a file or a pager prints one frame and exits, so `sparktop --once` works in scripts and cron.

## How it works

```
┌──────────────┐   SSH    ┌──────────────┐
│  sparktop    │─────────▶│  DGX Spark   │  sysfs · nvidia-smi
│  collector   │◀─────────│  (no agent)  │  ethtool · docker
└──────┬───────┘          └──────────────┘
       │  ClusterSnapshot (~1/s)
       ├──────────────▶ WebSocket ──▶ web dashboard
       └──────────────▶ direct    ──▶ TUI
```

Each node gets one long-lived SSH connection. Every poll runs a **single batched shell script** whose output is split on ASCII record separators — one round trip for the whole machine, not one per metric.

Two tiers, because they have very different costs:

| Tier | Interval | Contents |
|---|---|---|
| Fast | 1 s | GPU, CPU, memory, thermals, RDMA and network counters |
| Slow | 10 s | Docker inventory, disks, addressing, hardware detail |

The probe scripts are tuned for it. Reading sysfs with a loop of `cat` costs ~100 forks and measured **890 ms** per poll on a Spark; reading whole globs with one `grep -H .` and parsing paths in TypeScript, plus naming the ~18 RDMA counters actually used instead of globbing them (every `hw_counters` read traps into NIC firmware), brings the same data back in **~150 ms**.

Rates come from monotonic counters divided by measured wall time, not by the nominal interval, so a late poll does not distort throughput.

### GB10 specifics

- **Unified memory.** CPU and GPU share one LPDDR5X pool, and NVML reports framebuffer total/used as `[N/A]`. `sparktop` uses the system pool for the total and sums live NVML process allocations for the used figure, marking the value as derived rather than pretending NVML supplied it.
- **Heterogeneous CPU.** `lscpu` reports several models for the Cortex-X925 / A725 clusters; all are shown.
- **NIC temperatures** are attributed to the right port through `/sys/class/infiniband/<dev>/device/hwmon`, since a Spark exposes four identically named `mlx5` chips.

## Inference monitoring

sparktop finds the inference server on each node and reports tokens/sec,
requests in flight, queue depth, requests served and KV cache pressure. It is
not told what is running: every locally-bound port is probed and identified from
what it answers with.

| Engine | Detected by |
|---|---|
| vLLM | `vllm:` metrics |
| SGLang | `sglang:` metrics |
| llama.cpp | `llamacpp:` metrics |
| TGI | `tgi_` metrics |
| Triton / TensorRT-LLM | `nv_inference_` metrics |
| Ollama | `/api/ps` |
| Anything OpenAI-compatible | `/v1/models` |

Probing runs on the node, because these servers usually bind `127.0.0.1` where
the sparktop host cannot reach them. Discovery happens in the slow tier and the
fast probe is then rebuilt to scrape only the ports found, with the response
filtered node-side to the engine's own metric families — a vLLM body is ~32KB
and most of it is Python instrumentation nobody reads.

Token rates come from cumulative counters divided by measured wall time. Where
one logical server is reachable twice (behind a proxy, or on two ports) the
duplicate is folded out of cluster totals, so a tensor-parallel job — where only
rank 0 serves an API — is not double counted.

## Controls

Container lifecycle and image swapping, **disabled by default**:

```bash
SPARKTOP_ENABLE_CONTROL=1 bun run start
```

The dashboard is unauthenticated by default. That is reasonable for reading
metrics and not for stopping containers, so the capability is opt-in rather than
merely confirm-on-click. Set `SPARKTOP_TOKEN` as well if the dashboard is
reachable by anyone you would not hand a shell.

What it does:

- **Start / stop / restart** a container, with a configurable stop timeout so a
  graceful shutdown is not turned into a kill.
- **Change image.** Pick from the images already on the node or name any
  reference to pull.

Nothing destructive happens on one click. Every action produces the exact
commands first and requires a second confirmation. Container names and image
references are validated against strict patterns before they reach a command
line — they are never escaped and interpolated.

Image swaps respect docker compose. Where compose owns a container, sparktop
recreates the service through compose with a generated override rather than
by hand, because a manual recreate leaves compose's view stale and the next
`compose up` would revert it. That override lives in `/tmp` and is not
persistent: update your compose file to make a swap permanent. For containers
started by hand, sparktop prints the steps and declines to run them, since
reconstructing a `docker run` from `inspect` output is lossy and the machine is
usually serving traffic.

## Configuration

Everything is optional; nodes can also be managed at runtime through the API or the setup UI.

| Variable | Default | Meaning |
|---|---|---|
| `SPARKTOP_NODES` | — | `user@host[:port],user@host` |
| `SPARKTOP_SSH_KEY` | — | Private key for those nodes |
| `SPARKTOP_SSH_PASSWORD` | — | Password auth (needs `SPARKTOP_SECRET`) |
| `SPARKTOP_SECRET` | — | Key for encrypting stored credentials |
| `SPARKTOP_TOKEN` | — | If set, API and WebSocket require this bearer token |
| `SPARKTOP_ENABLE_CONTROL` | — | `1` allows container start/stop/restart and image swaps |
| `SPARKTOP_PORT` | `5757` | Listen port |
| `SPARKTOP_HOST` | `0.0.0.0` | Bind address |
| `SPARKTOP_CONFIG` | `./config/nodes.json` | Node registry path |
| `SPARKTOP_FAST_MS` | `1000` | Fast tier interval |
| `SPARKTOP_SLOW_MS` | `10000` | Slow tier interval |
| `NO_COLOR` | — | Disable TUI colour |

### Security

- **SSH keys are preferred.** Password auth is supported for nodes where installing a key is inconvenient; passwords are sealed with AES-256-GCM under a key derived from `SPARKTOP_SECRET` before touching disk, and `config/nodes.json` is gitignored and written `0600`.
  This protects the config file, not the running process — anything that can read the environment can decrypt. It is strictly better than plaintext, not a substitute for keys.
- **`sparktop` needs no privileges on the nodes.** Every value it reads is available to an unprivileged user. Docker metrics need the login user in the `docker` group; without it everything else still works.
- **The dashboard has no auth by default**, on the assumption it sits on a trusted LAN. Set `SPARKTOP_TOKEN` to require a bearer token. The container runs read-only, as a non-root user, with all capabilities dropped.
- Dependencies are scanned with [OSV-Scanner](https://google.github.io/osv-scanner/) in CI and weekly on a schedule. Run it locally with `bun run scan`.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness and node counts |
| `GET` | `/api/snapshot` | Latest `ClusterSnapshot` |
| `GET` | `/api/history` | Chart history (shared timeline + series) |
| `GET` | `/api/config` | Nodes with all secrets stripped |
| `POST` | `/api/nodes` | Add a node; polling starts immediately |
| `POST` | `/api/nodes/test` | Dry-run a connection without saving |
| `PATCH` | `/api/nodes/:id` | Edit a node |
| `DELETE` | `/api/nodes/:id` | Remove a node |
| `WS` | `/ws` | Snapshot stream |

```bash
curl -X POST http://localhost:5757/api/nodes \
  -H 'content-type: application/json' \
  -d '{"host":"10.0.0.11","username":"ubuntu","privateKeyPath":"/config/id_ed25519"}'
```

Adding, editing and removing nodes all take effect without a restart.

## Development

```bash
bun install
bun run dev        # server with reload on :5757
bun run dev:web    # Vite dev server on :5173, proxying to the above
bun test           # unit tests
bun run typecheck
bun run scan       # OSV dependency scan
```

```
packages/
  core/    types, SSH collector, probe scripts, parsers, topology analysis
  server/  Bun HTTP + WebSocket server
  web/     React 19 + Vite + Tailwind v4 + uPlot dashboard
  tui/     dependency-free ANSI terminal UI
```

The dependency tree is deliberately small: `ssh2` is the only runtime dependency of the collector, and the TUI has none.

## Contributing

Issues and pull requests are welcome. Before opening a PR:

```bash
bun run typecheck && bun test && bun run scan
```

If you are adding a metric, put the parsing in `packages/core/src/parse.ts` with
a test built from real probe output — the existing tests use values captured
verbatim from hardware, which is what makes them worth having.

## Acknowledgements

Inspired by [sparkDash](https://github.com/MiaAI-Lab/sparkDash), which covers single- and multi-unit Spark monitoring. `sparktop` focuses on the interconnect between Sparks — verified topology, RDMA throughput, and cross-node job detection.

## License

MIT © [metaspartan](https://github.com/metaspartan)
