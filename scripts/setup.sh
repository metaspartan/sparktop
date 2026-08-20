#!/usr/bin/env bash
#
# sparktop setup.
#
# Run this once, from anywhere that can reach your Sparks over SSH — one of the
# Sparks itself is fine. sparktop is agentless: nothing is installed on the
# nodes, so the only per-node step is authorising an SSH key, which this does
# for you.
#
#   ./scripts/setup.sh                       # finds your Sparks for you
#   ./scripts/setup.sh ubuntu@spark-a1b2.local ubuntu@spark-c3d4.local
#   ./scripts/setup.sh ubuntu@10.0.0.11 ubuntu@10.0.0.12
#   ./scripts/setup.sh --docker ubuntu@10.0.0.11 ubuntu@10.0.0.12
#   ./scripts/setup.sh --no-start ubuntu@10.0.0.11   # configure only
#
# With no arguments it asks the network which Sparks are out there over mDNS,
# so you never need to look up an IP address.
#
set -euo pipefail

# Resolve the repository root from this script's own location, so it works from
# any working directory rather than only from the checkout root.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

KEY="${SPARKTOP_KEY:-$REPO/config/id_ed25519}"
CONFIG="${SPARKTOP_CONFIG:-$REPO/config/nodes.json}"

# Under Git Bash / MSYS, $PWD is a POSIX-style path ("/c/Users/...") that the
# Bun runtime cannot open. The config is read by Bun, not by this shell, so
# paths written into it have to be native.
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}
MODE=""
NODES=()

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
info()  { printf '  %s\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --docker) MODE="docker" ;;
    --bun)    MODE="bun" ;;
    # Useful for automation and for re-running setup against an instance that
    # is already up: does everything except launch the server.
    --no-start) MODE="none" ;;
    -h|--help)
      # Print the header comment block, whatever length it has grown to, so
      # help never silently truncates when this file is edited.
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0 ;;
    -*) die "Unknown option: $arg" ;;
    *)  NODES+=("$arg") ;;
  esac
done

echo
bold "sparktop setup"
echo

# --- 1. Nodes ---------------------------------------------------------------
#
# Most people do not know their Sparks' IP addresses, and looking them up in a
# router's admin page is a miserable first step. A Spark runs avahi and
# advertises itself over mDNS, so the network can simply be asked. Names are
# used as-is rather than resolved to addresses: a name survives a DHCP lease
# changing, an address does not.
discover() {
  if command -v avahi-browse >/dev/null 2>&1; then
    # -p parses to a stable ';'-delimited form; '=' rows are fully resolved.
    avahi-browse -rpt _ssh._tcp 2>/dev/null | awk -F';' '$1 == "=" { print $7 }'
  elif command -v dns-sd >/dev/null 2>&1; then
    # dns-sd never exits on its own, so it is given a moment and then stopped.
    { dns-sd -B _ssh._tcp local & pid=$!; sleep 4; kill "$pid" 2>/dev/null; } 2>/dev/null |
      awk '/_ssh\._tcp/ && $NF != "Name" { print $NF ".local" }'
  fi | sort -u
}

# Chassis names across the eight GB10 variants. A Spark cannot be identified
# for certain without logging into it, so this only decides what to suggest —
# anything found is offered, never assumed.
SPARK_RE='^(gx10|spark|dgx|zgx|pgx|ai-?top|edgexpert|veriton|promax|pro-max)'

if [ ${#NODES[@]} -eq 0 ]; then
  FOUND=()
  if command -v avahi-browse >/dev/null 2>&1 || command -v dns-sd >/dev/null 2>&1; then
    info "Looking for Sparks on the network..."
    while IFS= read -r h; do
      [ -n "$h" ] && FOUND+=("$h")
    done < <(discover | grep -Ei "$SPARK_RE" || true)
  fi

  if [ ${#FOUND[@]} -gt 0 ]; then
    ok "Found ${#FOUND[@]}: ${FOUND[*]}"
    echo
    info "Log in as which user? (blank for '$(id -un)')"
    printf '  user> '
    read -r duser || duser=""
    [ -z "$duser" ] && duser="$(id -un)"
    for h in "${FOUND[@]}"; do NODES+=("$duser@$h"); done
    echo
    info "Using: ${NODES[*]}"
    info "Press enter to accept, or Ctrl-C to start over and enter them by hand."
    read -r _ || true
  else
    echo
    info "Enter each Spark as user@host, one per line. Blank line when done."
    info "Not sure of the address? Run 'hostname' on the Spark and use"
    info "that name with '.local' — for example ubuntu@spark-a1b2.local"
    while true; do
      printf '  node> '
      read -r line || break
      [ -z "$line" ] && break
      NODES+=("$line")
    done
  fi
fi
[ ${#NODES[@]} -eq 0 ] && die "No nodes given."

for n in "${NODES[@]}"; do
  case "$n" in
    *@*) ;;
    *) die "Expected user@host, got: $n" ;;
  esac
done
ok "${#NODES[@]} node(s): ${NODES[*]}"

# --- 2. SSH key -------------------------------------------------------------
# A dedicated key rather than reusing an existing one: it is mounted into a
# container, and its only purpose is read-only metric collection.
mkdir -p "$(dirname "$KEY")"
if [ -f "$KEY" ]; then
  ok "Using existing key $KEY"
else
  ssh-keygen -t ed25519 -N "" -C "sparktop" -f "$KEY" >/dev/null
  ok "Generated $KEY"
fi

# --- 3. Authorise it on each node ------------------------------------------
echo
info "Authorising the key on each node. You will be asked for each node's"
info "password once — after this, sparktop uses the key and never a password."
echo
for n in "${NODES[@]}"; do
  if ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        -o ConnectTimeout=8 "$n" true 2>/dev/null; then
    ok "$n already trusts this key"
    continue
  fi
  if command -v ssh-copy-id >/dev/null 2>&1; then
    ssh-copy-id -i "$KEY.pub" -o StrictHostKeyChecking=accept-new "$n" >/dev/null 2>&1 \
      && ok "$n authorised" \
      || warn "$n could not be set up automatically — run: ssh-copy-id -i $KEY.pub $n"
  else
    # Busybox and macOS installs sometimes lack ssh-copy-id.
    ssh -o StrictHostKeyChecking=accept-new "$n" \
      "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys" \
      < "$KEY.pub" && ok "$n authorised" || warn "$n could not be set up automatically"
  fi
done

# --- 4. Verify --------------------------------------------------------------
echo
info "Checking what each node reports:"
REACHABLE=0
for n in "${NODES[@]}"; do
  out=$(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=8 "$n" '
    printf "%s|" "$(hostname)"
    printf "%s|" "$(cat /sys/devices/virtual/dmi/id/product_family 2>/dev/null || echo unknown)"
    printf "%s|" "$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)"
    printf "%s|" "$(ls -d /sys/class/infiniband/*/device/net/* 2>/dev/null | wc -l)"
    docker info >/dev/null 2>&1 && printf "docker" || printf "no-docker"
  ' 2>/dev/null) || { warn "$n unreachable"; continue; }

  IFS='|' read -r host family gpu ports docker <<<"$out"
  REACHABLE=$((REACHABLE + 1))
  ok "$host — ${family:-unknown} · ${gpu:-no GPU} · ${ports} RDMA ports · ${docker}"
  [ "$docker" = "no-docker" ] && warn "  container metrics need this user in the docker group"
done
[ "$REACHABLE" -eq 0 ] && die "No nodes reachable. Fix the errors above and re-run."

# --- 5. Write the registry --------------------------------------------------
# The key path is consumed by the Bun runtime, not by this shell, so it has to
# be written in the form that runtime can open.
KEY_NATIVE="$(native_path "$KEY")"
mkdir -p "$(dirname "$CONFIG")"
{
  printf '{\n  "nodes": [\n'
  i=0
  for n in "${NODES[@]}"; do
    user="${n%@*}"; hostport="${n#*@}"
    host="${hostport%%:*}"; port="22"
    [ "$hostport" != "$host" ] && port="${hostport#*:}"
    [ $i -gt 0 ] && printf ',\n'
    printf '    {"id": "%s", "host": "%s", "port": %s, "username": "%s", "privateKeyPath": "%s", "enabled": true, "addedAt": 0}' \
      "$host" "$host" "$port" "$user" "$KEY_NATIVE"
    i=$((i + 1))
  done
  printf '\n  ],\n  "fastIntervalMs": 1000,\n  "slowIntervalMs": 10000,\n  "historySize": 300\n}\n'
} > "$CONFIG"
chmod 600 "$CONFIG"
ok "Wrote $CONFIG"

# --- 6. Start ---------------------------------------------------------------
if [ "$MODE" = "none" ]; then
  echo
  ok "Configured. Start it with: docker compose up -d   (or: bun run start)"
  exit 0
fi

if [ -z "$MODE" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then MODE="docker"
  elif command -v bun >/dev/null 2>&1; then MODE="bun"
  else
    echo
    warn "Neither Docker nor Bun found. Install one, then:"
    info "  docker compose up -d      # or"
    info "  bun install && bun run build:web && bun run start"
    exit 0
  fi
fi

echo
bold "Starting sparktop ($MODE)"
if [ "$MODE" = "docker" ]; then
  SPARKTOP_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo '')" docker compose up -d --build
else
  bun install >/dev/null
  bun run build:web >/dev/null
  echo
  ok "Ready. Starting the server — Ctrl-C to stop."
  exec bun run start
fi

echo
ok "sparktop is running at http://localhost:${SPARKTOP_PORT:-5757}"
info "Terminal view: bun run tui"
