<div align="center">

# sparktop

**Realtime TUI and web dashboard for multi-node NVIDIA DGX Spark clusters.**

One place to watch every Spark you own — the GPUs, the containers, the models
they are serving, and the ConnectX-7 fabric between them that ordinary network
tools report as nearly idle.

[Quick start](#quick-start) · [Why RDMA counters](#why-the-usual-network-stats-lie) · [TUI](#terminal-ui) · [API](#http-api) · [Configuration](#configuration)

[![CI](https://github.com/metaspartan/sparktop/actions/workflows/ci.yml/badge.svg)](https://github.com/metaspartan/sparktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/arch-arm64%20%7C%20amd64-informational)

</div>

---

## Quick start

You need one or more DGX Sparks reachable over SSH, and either Docker or
[Bun](https://bun.sh) 1.1+ on the machine you run this from. Nothing gets
installed on the Sparks themselves.

```bash
git clone https://github.com/metaspartan/sparktop.git && cd sparktop
./scripts/setup.sh
```

Then open <http://localhost:5757>.

**You do not need to know your Sparks' IP addresses.** Run with no arguments and
setup asks the network which ones are out there — a Spark advertises itself over
mDNS — then asks for the login user and does the rest:

```
sparktop setup

  Looking for Sparks on the network...
  ✓ Found 2: spark-a1b2.local spark-c3d4.local

  Log in as which user? (blank for 'ubuntu')
  user> ubuntu

  ✓ Generated ./config/id_ed25519
  ✓ ubuntu@spark-a1b2.local authorised
  ✓ ubuntu@spark-c3d4.local authorised

  Checking what each node reports:
  ✓ spark-a1b2 — DGX Spark · NVIDIA GB10 · 4 RDMA ports · docker
  ✓ spark-c3d4 — DGX Spark · NVIDIA GB10 · 4 RDMA ports · docker
  ✓ Wrote ./config/nodes.json
```

It authorises an SSH key on each node, asking for that node's password once and
never again, then writes the node registry and starts up.

You can also name the nodes yourself, by hostname or by address:

```bash
./scripts/setup.sh ubuntu@spark-a1b2.local ubuntu@spark-c3d4.local
```

<details>
<summary>If discovery finds nothing</summary>

mDNS does not cross subnets or most VPNs, and some networks block it. Run
`hostname` on a Spark and use that name with `.local` appended — that is what
the Spark answers to:

```bash
ubuntu@spark-a1b2.local
```

Failing that, `hostname -I` on the Spark prints its addresses, or your router's
client list will show it. Prefer the name over the address where you can: a name
survives a DHCP lease changing.
</details>

Re-running setup is safe — nodes that already trust the key are skipped. Pass
`--docker` or `--bun` to force how it runs, or `--no-start` to configure without
launching.

Prefer the terminal? `bun run tui` gives you [the same data](#terminal-ui)
without a browser.

<details>
<summary><b>Setting it up by hand</b> — Docker Compose, plain Bun, or no config file</summary>

**Docker Compose**

```bash
cp .env.example .env                       # set SPARKTOP_NODES
ssh-keygen -t ed25519 -f ./config/id_ed25519 -N ""
for h in spark-a1b2.local spark-c3d4.local; do ssh-copy-id -i ./config/id_ed25519.pub ubuntu@$h; done
SPARKTOP_COMMIT=$(git rev-parse HEAD) docker compose up -d
```

The image is multi-arch (`linux/arm64` + `linux/amd64`), so it runs on a Spark or
on anything else that can reach them.

**Without Docker** — requires [Bun](https://bun.sh) 1.1+:

```bash
bun install && bun run build:web && bun run start
```

**No config file at all.** Start with no nodes and the web UI walks you through
adding them, verifying each over SSH before it is saved. Or declare them in the
environment:

```bash
export SPARKTOP_NODES="ubuntu@spark-a1b2.local,ubuntu@spark-c3d4.local"
export SPARKTOP_SSH_KEY=/config/id_ed25519
```
</details>

> The setup script targets Linux and macOS, which is what the Sparks run. On
> Windows, use Docker Desktop or WSL.

### Nothing is installed on the Sparks

sparktop is **agentless**. It runs in one place and reads the others over SSH, so
adding a node means authorising a key — which setup does for you. Nothing is
copied to a Spark, no service runs on it, and uninstalling means deleting one
line from `~/.ssh/authorized_keys`.

It needs no privileges: no root, no passwordless sudo. The only thing worth
checking per node is that the login user is in the `docker` group, which setup
reports. Without it, everything except container metrics still works.

Non-Spark NVIDIA hosts work too — you simply get no fabric section for them.

## What it does

`sparktop` watches a fleet of DGX Sparks from one place — in the terminal, in a browser, or both — and answers the questions a per-machine tool cannot:

- **Which Sparks are cabled to which**, over which ports, and how much is moving in each direction *right now*.
- **What is holding GPU memory** — per-process VRAM, mapped back to the container that owns it.
- **What is running across more than one node** — tensor-parallel jobs are detected from container topology, with ranks and aggregate VRAM.
- **What each model is actually doing** — decode and prefill throughput, time to first token, queue depth and KV cache pressure, read from whichever engine is serving.
- **Everything you would expect**: GPU utilisation, unified memory, per-core CPU, every thermal sensor, disks, Docker containers, and network interfaces.

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

### One cable is already the whole link

DGX Spark networking is easy to misread, and `sparktop` reports it the way the
hardware actually behaves:

- **A single QSFP cable gives you the full 200GbE link.** Adding a second cable
  does not add bandwidth. ([NVIDIA: Connect Two Sparks](https://build.nvidia.com/spark/connect-two-sparks))
- That one cable **presents as two RDMA interfaces** of roughly 100 Gb/s each,
  because each port sits behind its own PCIe Gen5 x4 link. Reaching the full
  200 Gb/s means using both — `NCCL_IB_MERGE_NICS=1` — not buying more cable.
- So a two-Spark pair shows a **capacity of ~201.6 Gb/s across two links**, not
  400G. Advertised link speed is a signalling rate; `sparktop` shows the rate the
  PCIe attachment can actually sustain.

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

Every node card shows its chassis, so a mixed rack is readable at a glance. The images live in `packages/web/public/variants/<id>.webp`. Hardware that cannot be identified shows no icon rather than a stand-in — an icon that does not match the machine in the rack reads as identification. `scripts/split-variants.py` regenerates the set from your own sources.

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
sparktop │ 2/2 nodes                                                        14:25:09
fabric 1.32 Gbps/201.6G · vram 202 GB/243 GB · cpu 11% · pwr 88.5 W · temp 89°C
  · ctr 2 · tok/s 36.9 · req 1

── Nodes ────────────────────────────────────────────────────────────────────────
● spark-01 10.0.0.11 [ASUS Ascent GX10]  281ms
  GPU  ██████████████████████▊·  95% 95%                              █████
  VRAM ███████████████████▉····  83% 101 GB/122 GB                    ▇▇▇▇▇
  CPU  ██▋·····················  11% 11%                              ▂▂▂▂▂
  MEM  ██████████████████████▌·  94% 115 GB/122 GB                    █████
  temp 89°C  pwr 43.8 W  net ↓1.32 Gbps ↑1.32 Gbps  up 21h 23m

● spark-02 10.0.0.12 [ASUS Ascent GX10]  273ms
  GPU  ██████████████████████▊·  95% 95%                              █████
  VRAM ███████████████████▉····  83% 101 GB/122 GB                    ▇▇▇▇▇
  CPU  ██▋·····················  11% 11%                              ▂▂▂▂▂
  MEM  ██████████████████████▏·  92% 112 GB/122 GB                    ▇▇▇▇▇
  temp 89°C  pwr 44.6 W  net ↓1.32 Gbps ↑1.32 Gbps  up 21h 5m

── Interconnect ─────────────────────────────────────────────────────────────────
  spark-01:enp1s0f1np1    ⇄ spark-02:enp1s0f1np1    ▏······  2.64 Gbps /100.8G ✓
  spark-01:enP2p1s0f1np1  · spark-02:enP2p1s0f1np1  ·······     0 Gbps /100.8G ✓

── Inference ────────────────────────────────────────────────────────────────────
  ● spark-01:8888     vLLM      36.9 tok/s  run 1  queue 0  served 838  kv 11%
      deepseek-v4-flash-0731

── Distributed workloads ────────────────────────────────────────────────────────
  deepseek-ai/DeepSeek-V4-Flash-0731  ranks 2  vram 202 GB  traffic 2.64 Gbps
    spark-01#0  spark-02#1
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

Reported per endpoint:

| Metric | Meaning |
|---|---|
| **Decode** tok/s | Output tokens the server produces, aggregate |
| **Prefill** tok/s | Prompt tokens ingested, including cache hits |
| **TTFT** | Time to first token |
| **Per-token** | Inter-token latency, and the decode speed one request sees |
| **Queue** | Time waiting before work began |
| **End to end** | Full request latency |
| **Prefill / Decode phase** | Where a request's time actually went |
| **Prefix hit** | Prompt tokens served from cache rather than recomputed |
| **KV cache** | Cache utilisation |
| **Speculative** | Draft acceptance rate and mean accepted length, where the engine speculates |

Throughput is averaged over a ten-second window, matching what the engine
reports about itself. A one-second sample is not wrong so much as meaningless
under speculative decoding: a draft model proposes several tokens per step and
the target accepts or rejects them, so the counter jumps by a burst and then
sits still. Successive one-second readings alternate between far too high and
zero — vLLM's own logger averages over ten seconds for exactly this reason.

Latency comes from histograms, averaged over a rolling sixty-second window rather
than the server's lifetime — dividing `_sum` by `_count` gives the mean since
boot, which on a server that has handled thousands of requests barely moves and
says nothing about now. The derived ratios, prefix hit rate and speculative
acceptance, use the same window for the same reason.

When nothing completed even in that window, the lifetime average is shown but
**labelled and dimmed as such**, because a stale mean sitting beside a decode
rate of zero would otherwise read as a live measurement.

Two figures are easy to misread. **Prefill tok/s counts cached tokens**: a high
prefix-hit rate (95%+ is common with a shared system prompt) means far less work
was done than the number suggests — which is why the hit rate is shown next to
it. And **aggregate decode is not per-request speed**: a server producing
60 tok/s across four concurrent requests gives each of them about 15, which is
what a user actually experiences. Both are shown.

Where one logical server is reachable twice (behind a proxy, or on two ports) the
duplicate is folded out of cluster totals, so a tensor-parallel job — where only
rank 0 serves an API — is not double counted.

## Run history

Live metrics are held in memory for a few minutes, which answers "what is
happening" and nothing about last week. sparktop also keeps durable history in
SQLite (Bun's built-in driver — no external database):

- **Runs.** A serving session: one endpoint, one model, continuously present.
  Individual requests are not observable — engines expose counters, not a
  request log — so what is recorded is what counter deltas support honestly:
  when it started, how long it served, tokens generated, requests completed and
  peak throughput. A gap longer than five minutes ends a run rather than
  pretending it continued.
- **Samples.** Throughput and queue depth, written once a minute rather than
  once a second, because 1Hz for a month is tens of millions of rows.

Both are pruned to a retention window, so the file reaches a steady size and
stays there. Pruning is relative to the data's own clock, not the wall clock —
a host with a skewed clock would otherwise delete history that is perfectly
current by its own timeline.

| Variable | Default | Meaning |
|---|---|---|
| `SPARKTOP_DATA` | `./data/sparktop.db` | Database path, or `off` to keep the server stateless |
| `SPARKTOP_RETENTION_DAYS` | `30` | How long to keep runs and samples |
| `SPARKTOP_SAMPLE_MS` | `60000` | Sampling interval for stored throughput |

## Updates

sparktop checks for two kinds of update, both strictly read-only — it reports
that something newer exists and never pulls, restarts or writes anything:

- **sparktop itself**, by comparing the running commit against the repository
  tip, with a count of how far behind.
- **Container images**, by comparing each running container's image digest
  against what the registry currently serves. Uses `docker manifest inspect`,
  which queries the registry without downloading layers. An image pinned by
  digest is reported as such, since a pinned reference is immutable by
  definition.

Results are cached for an hour (the unauthenticated GitHub API is rate-limited,
and a registry query costs a round trip from every node). Both appear under
Settings → Updates.

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
| `SPARKTOP_COMMIT` | from git | Commit this build came from. Set as a Docker build arg, since `.git` is not in the image |
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
- **The dashboard has no auth by default**, on the assumption it sits on a trusted LAN. Set `SPARKTOP_TOKEN` to require a bearer token. `/api/health` stays reachable either way so container orchestration can probe it, but it reports only liveness to an unauthorised caller — a health probe needs to know the server is up, not how many machines you own. The container runs read-only, as a non-root user, with all capabilities dropped.
- **Reporting a vulnerability:** see [SECURITY.md](SECURITY.md).
- Dependencies are scanned with [OSV-Scanner](https://google.github.io/osv-scanner/) in CI and weekly on a schedule. Run it locally with `bun run scan`.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness. Reachable without a token so orchestration can probe it; node counts are included only for an authorised caller |
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

MIT © [Carsen Klock](https://github.com/metaspartan)
