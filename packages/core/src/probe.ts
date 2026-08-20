/**
 * The shell programs sparktop runs on each node.
 *
 * Design constraints that shaped these:
 *
 *  - One SSH exec per poll. Opening a channel per metric costs more than the
 *    metrics themselves, so everything is batched into a single script whose
 *    output is split on ASCII record separators.
 *  - Few processes. The obvious way to read sysfs is a loop of `cat`s, which
 *    costs ~100 forks and measured ~890ms per poll on a Spark. Reading whole
 *    globs with a single `grep -H .` and parsing the path prefix in TypeScript
 *    brings the same data back in a fraction of the time, which is what makes
 *    a 1s poll interval affordable.
 *  - Strictly unprivileged. DGX Spark's default user has no passwordless sudo,
 *    and every value below is readable as an ordinary user (docker included,
 *    via the `docker` group).
 *  - POSIX sh, no bashisms, no dependencies beyond coreutils, nvidia-smi,
 *    ethtool and docker. Anything optional is guarded so a missing tool
 *    degrades one section instead of failing the whole poll.
 *  - Two tiers. Values that move (GPU, CPU, memory, fabric counters) are polled
 *    fast; inventory that does not (disks, container lists, addressing) is
 *    polled slowly, because `docker stats` alone costs more than the entire
 *    fast tier.
 */

/** ASCII record separator. Delimits sections in probe output. */
export const RS = "\x1e";
/** ASCII unit separator. Delimits fields within a line. */
export const US = "\x1f";

/**
 * Fabric sysfs paths to read, spelled out one counter at a time.
 *
 * Globbing `counters/*` and `hw_counters/*` and filtering afterwards is far
 * more expensive than it looks: every hw_counter read traps into the mlx5
 * firmware, so a wildcard costs ~240 firmware reads per poll on a four-port
 * Spark and measured ~100ms. Naming the ~18 counters actually used cuts that
 * by roughly 85%.
 */
const FABRIC_PORT_FILES = ["rate", "state", "phys_state"];
const FABRIC_COUNTERS = [
  "port_rcv_data",
  "port_xmit_data",
  "port_rcv_packets",
  "port_xmit_packets",
  "port_rcv_errors",
  "port_xmit_discards",
  "link_downed",
  "link_error_recovery",
  "symbol_error",
];
const FABRIC_HW_COUNTERS = [
  "out_of_sequence",
  "packet_seq_err",
  "out_of_buffer",
  "rnr_nak_retry_err",
  "req_transport_retries_exceeded",
  "local_ack_timeout_err",
  "np_cnp_sent",
  "rp_cnp_handled",
  "np_ecn_marked_roce_packets",
];

const IB = "/sys/class/infiniband/*/ports/*";
const FABRIC_PATHS = [
  ...FABRIC_PORT_FILES.map((f) => `${IB}/${f}`),
  ...FABRIC_COUNTERS.map((f) => `${IB}/counters/${f}`),
  ...FABRIC_HW_COUNTERS.map((f) => `${IB}/hw_counters/${f}`),
].join(" ");

/**
 * Fast tier: everything that changes second to second.
 *
 * nvidia-smi is invoked exactly once and its output reused, because it is by
 * far the most expensive single command here (~150-250ms on GB10).
 */
export const FAST_PROBE = `#!/bin/sh
set -u
S() { printf '${RS}%s\\n' "$1"; }

S ts
date +%s%3N

S uptime
cat /proc/uptime /proc/loadavg 2>/dev/null

S stat
grep '^cpu' /proc/stat 2>/dev/null

S meminfo
grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|Shmem|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null

S cpufreq
grep -h . /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq 2>/dev/null

S gpu
nvidia-smi --query-gpu=index,name,uuid,driver_version,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.current.sm,memory.total,memory.used --format=csv,noheader,nounits 2>/dev/null

S gpuprocs
GPUAPPS=\$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null)
printf '%s\\n' "\$GPUAPPS"

S gpuprocdetail
GPIDS=\$(printf '%s\\n' "\$GPUAPPS" | cut -d, -f1 | tr -d ' ' | grep -E '^[0-9]+$' | tr '\\n' ' ')
if [ -n "\$GPIDS" ]; then
  ps -o pid=,user=,pcpu=,rss=,etimes= -p "\$(echo \$GPIDS | tr ' ' ',')" 2>/dev/null
  echo "---"
  for p in \$GPIDS; do
    [ -d "/proc/\$p" ] || continue
    printf '%s${US}%s\\n' "\$p" "\$(grep -o -m1 -E '[0-9a-f]{64}' "/proc/\$p/cgroup" 2>/dev/null | head -1)"
  done
fi

S hwmon
grep -H . /sys/class/hwmon/hwmon*/name /sys/class/hwmon/hwmon*/temp*_input /sys/class/hwmon/hwmon*/temp*_label /sys/class/hwmon/hwmon*/temp*_crit 2>/dev/null

S cts
# Counter timestamp, captured immediately before the byte counters below.
#
# Rates are (delta bytes / delta time), so the clock must be read next to the
# counters it describes. Timestamping at the top of the script instead makes
# delta-t the gap between script *starts* while delta-bytes spans the gap
# between counter *reads* — and since probe duration varies by 150ms or more
# poll to poll, that mismatch swings a 1s sample by several hundred percent.
date +%s%3N

S netdev
cat /proc/net/dev 2>/dev/null

S fabricmap
ls -d /sys/class/infiniband/*/device/net/* 2>/dev/null

S fabrichwmon
ls -d /sys/class/infiniband/*/device/hwmon/* 2>/dev/null

S fabricsys
grep -H . ${FABRIC_PATHS} 2>/dev/null

S carrier
grep -H . /sys/class/net/*/carrier 2>/dev/null

S ethtool
if command -v ethtool >/dev/null 2>&1; then
  for l in /sys/class/infiniband/*/device/net/*; do
    [ -e "\$l" ] || continue
    n=\${l##*/}
    [ "\$(cat /sys/class/net/\$n/carrier 2>/dev/null)" = "1" ] || continue
    printf 'IF${US}%s\\n' "\$n"
    ethtool -S "\$n" 2>/dev/null | grep -E 'vport_(rdma_)?unicast_(bytes|packets)' | tr -d ' '
  done
fi

S cte
# Closing timestamp for the counter block. The collector uses the midpoint of
# cts..cte as the instant these counters describe, so a slow read is centred
# rather than attributed to whichever end of the window it started from.
date +%s%3N
`;

/**
 * Slow tier: inventory and anything expensive.
 *
 * `docker stats --no-stream` is the costly call here (it samples for roughly a
 * second), so it is deliberately kept out of the fast path and bounded with a
 * timeout.
 */
export const SLOW_PROBE = `#!/bin/sh
set -u
S() { printf '${RS}%s\\n' "$1"; }

S host
hostname 2>/dev/null
uname -r 2>/dev/null
uname -m 2>/dev/null
(grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d'"' -f2) || echo ""
# DMI identifies the chassis vendor. product_family reads "DGX Spark" on every
# variant, which is what makes Spark detection reliable across all eight OEMs.
for f in product_name sys_vendor product_family product_version board_name; do
  v=\$(cat "/sys/devices/virtual/dmi/id/\$f" 2>/dev/null)
  printf '%s\\n' "\${v:-}"
done

S cpuinfo
nproc 2>/dev/null
# aarch64 /proc/cpuinfo has no "model name", and a GB10 is heterogeneous, so
# lscpu may report several. Emit every distinct one and let the parser join
# them; an empty result here is normal on some kernels.
CPUM=\$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')
if [ -z "\$CPUM" ]; then
  CPUM=\$(lscpu 2>/dev/null | grep 'Model name' | cut -d: -f2- | sed 's/^ *//')
fi
printf '%s\\n' "\$CPUM"

S cudaversion
nvidia-smi --query 2>/dev/null | grep -m1 'CUDA Version' | cut -d: -f2- | tr -d ' '

S gpugraphics
nvidia-smi 2>/dev/null | sed -n '/Processes:/,\$p' | grep -E '^\\|[[:space:]]+[0-9]+[[:space:]]' || true

S disks
df -PB1 2>/dev/null | tail -n +2 | grep -E '^/dev/' || true

S addr
ip -o -4 addr show 2>/dev/null || true

S netinfo
for i in /sys/class/net/*; do
  n=\${i##*/}
  [ "\$n" = "lo" ] && continue
  printf '%s${US}%s${US}%s${US}%s${US}%s\\n' "\$n" \\
    "\$(cat "\$i/speed" 2>/dev/null)" "\$(cat "\$i/carrier" 2>/dev/null)" \\
    "\$(cat "\$i/operstate" 2>/dev/null)" "\$(cat "\$i/address" 2>/dev/null)"
done

S fabricmap
ls -d /sys/class/infiniband/*/device/net/* 2>/dev/null

S docker
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo OK
  docker ps -a --no-trunc --format '{{.ID}}${US}{{.Names}}${US}{{.Image}}${US}{{.State}}${US}{{.Status}}${US}{{.CreatedAt}}' 2>/dev/null
else
  echo NO
fi

S dockerstats
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  timeout 10 docker stats --no-stream --format '{{.ID}}${US}{{.CPUPerc}}${US}{{.MemUsage}}' 2>/dev/null || true
fi

S dockerenv
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  for c in \$(docker ps -q --no-trunc 2>/dev/null); do
    envs=\$(docker inspect "\$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | \\
      grep -E '^(MASTER_ADDR|MASTER_PORT|NCCL_SOCKET_IFNAME|NCCL_IB_HCA|NCCL_IB_DISABLE|NCCL_IB_MERGE_NICS|UCX_NET_DEVICES|WORLD_SIZE|RANK|NODE_RANK|VLLM_HOST_IP|DSPARK_MODEL|MODEL|MODEL_NAME)=' | tr '\\n' '${US}')
    printf '%s${US}NETWORKMODE=%s${US}%s\\n' "\$c" \\
      "\$(docker inspect "\$c" --format '{{.HostConfig.NetworkMode}}' 2>/dev/null)" "\$envs"
  done
fi
`;
