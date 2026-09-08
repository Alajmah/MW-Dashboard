#!/usr/bin/env bash
set -uo pipefail

COLLECTOR_VERSION="1.0.0"
FORMAT_VERSION="1"
SAMPLES=1
INTERVAL_SECONDS=0
OUTPUT_DIR="$PWD"
declare -a REQUESTED_QMGRS=()

usage() {
  cat <<'USAGE'
IBM MQ topology collector for MW-Dashboard

Usage:
  mq-topology-collector.sh [SAMPLES [INTERVAL_SECONDS]]
  mq-topology-collector.sh [options]

Options:
  --samples N          Runtime samples to collect (default: 1)
  --interval SEC       Seconds between runtime samples (default: 0)
  --output-dir DIR     Directory for the generated .tar.gz (default: current directory)
  --qmgr NAME          Collect only the named queue manager; may be repeated
  -h, --help           Show this help

Compatibility:
  "mq-topology-collector.sh 5 60" means 5 runtime samples, 60 seconds apart.

The collector is read-only. It does not stop/start queue managers, channels, listeners,
or applications, and it does not read message payloads.
USAGE
}

is_uint() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }

if (( $# > 0 )) && is_uint "$1"; then
  SAMPLES="$1"
  shift
  if (( $# > 0 )) && is_uint "$1"; then
    INTERVAL_SECONDS="$1"
    shift
  fi
fi

while (( $# > 0 )); do
  case "$1" in
    --samples)
      [[ $# -ge 2 ]] || { echo "ERROR: --samples requires a value" >&2; exit 2; }
      SAMPLES="$2"; shift 2 ;;
    --interval)
      [[ $# -ge 2 ]] || { echo "ERROR: --interval requires a value" >&2; exit 2; }
      INTERVAL_SECONDS="$2"; shift 2 ;;
    --output-dir)
      [[ $# -ge 2 ]] || { echo "ERROR: --output-dir requires a value" >&2; exit 2; }
      OUTPUT_DIR="$2"; shift 2 ;;
    --qmgr)
      [[ $# -ge 2 ]] || { echo "ERROR: --qmgr requires a value" >&2; exit 2; }
      REQUESTED_QMGRS+=("$2"); shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2 ;;
  esac
done

is_uint "$SAMPLES" && (( SAMPLES >= 1 )) || { echo "ERROR: samples must be an integer >= 1" >&2; exit 2; }
is_uint "$INTERVAL_SECONDS" || { echo "ERROR: interval must be an integer >= 0" >&2; exit 2; }
mkdir -p "$OUTPUT_DIR" || exit 1
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

for required in tar date hostname; do
  command -v "$required" >/dev/null 2>&1 || { echo "ERROR: required command not found: $required" >&2; exit 1; }
done

if ! command -v dspmq >/dev/null 2>&1; then
  echo "ERROR: dspmq is not in PATH. Run this as an IBM MQ administrative user with the MQ bin directory in PATH." >&2
  exit 1
fi
if ! command -v runmqsc >/dev/null 2>&1; then
  echo "ERROR: runmqsc is not in PATH. Run this as an IBM MQ administrative user with the MQ bin directory in PATH." >&2
  exit 1
fi

safe_name() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

utc_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

HOST_SHORT="$(hostname -s 2>/dev/null || hostname)"
HOST_SAFE="$(safe_name "$HOST_SHORT")"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
ARCHIVE_BASENAME="mq-topology-${HOST_SAFE}-${STAMP}"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mw-mq-topology.XXXXXX")"
ROOT="$WORK_ROOT/$ARCHIVE_BASENAME"
mkdir -p "$ROOT/host" "$ROOT/mq" "$ROOT/qmgr"
STARTED_AT="$(utc_now)"

cleanup() { rm -rf "$WORK_ROOT"; }
trap cleanup EXIT

capture_cmd() {
  local base="$1"; shift
  mkdir -p "$(dirname "$base")"
  printf '%q ' "$@" > "${base}.command"
  printf '\n' >> "${base}.command"
  "$@" > "${base}.out" 2> "${base}.err"
  local rc=$?
  printf '%s\n' "$rc" > "${base}.rc"
  return 0
}

run_mqsc() {
  local qmgr="$1"
  local base="$2"
  local commands="$3"
  mkdir -p "$(dirname "$base")"
  printf '%s\n' "$commands" > "${base}.mqsc"
  printf '%s\n' "$commands" | runmqsc "$qmgr" > "${base}.out" 2> "${base}.err"
  local rc=$?
  printf '%s\n' "$rc" > "${base}.rc"
  return 0
}

# Host evidence. Avoid environment dumps, process command lines, key material, and message payloads.
printf '%s\n' "$STARTED_AT" > "$ROOT/host/started-at-utc.txt"
capture_cmd "$ROOT/host/hostname" hostname
capture_cmd "$ROOT/host/hostname-fqdn" hostname -f
capture_cmd "$ROOT/host/uname" uname -a
if [[ -r /etc/os-release ]]; then cp /etc/os-release "$ROOT/host/os-release.txt"; fi
if command -v ip >/dev/null 2>&1; then
  capture_cmd "$ROOT/host/ip-addresses" ip -o addr show
  capture_cmd "$ROOT/host/ip-routes" ip route show
fi
capture_cmd "$ROOT/host/id" id

# MQ installation and queue-manager inventory.
capture_cmd "$ROOT/mq/dspmq" dspmq
if command -v dspmqver >/dev/null 2>&1; then capture_cmd "$ROOT/mq/dspmqver" dspmqver; fi
if command -v dspmqinst >/dev/null 2>&1; then capture_cmd "$ROOT/mq/dspmqinst" dspmqinst; fi

mapfile -t DISCOVERED_QMGRS < <(sed -n 's/.*QMNAME(\([^)]*\)).*/\1/p' "$ROOT/mq/dspmq.out" | awk 'NF && !seen[$0]++')
if (( ${#DISCOVERED_QMGRS[@]} == 0 )); then
  echo "ERROR: dspmq returned no queue managers; archive will contain host/MQ installation evidence only." >&2
fi

declare -a QMGRS=()
if (( ${#REQUESTED_QMGRS[@]} > 0 )); then
  for requested in "${REQUESTED_QMGRS[@]}"; do
    found=0
    for q in "${DISCOVERED_QMGRS[@]}"; do
      if [[ "$q" == "$requested" ]]; then found=1; break; fi
    done
    if (( found == 0 )); then
      echo "WARNING: requested queue manager '$requested' was not reported by dspmq; attempting collection anyway." >&2
    fi
    QMGRS+=("$requested")
  done
else
  QMGRS=("${DISCOVERED_QMGRS[@]}")
fi

printf 'index\tqueue_manager\n' > "$ROOT/qmgrs.tsv"

CONFIG_COMMANDS=(
  "qmgr|DISPLAY QMGR ALL"
  "queues-local|DISPLAY QLOCAL(*) ALL"
  "queues-remote|DISPLAY QREMOTE(*) ALL"
  "queues-alias|DISPLAY QALIAS(*) ALL"
  "queues-model|DISPLAY QMODEL(*) ALL"
  "queues-cluster|DISPLAY QCLUSTER(*) ALL"
  "channels|DISPLAY CHANNEL(*) ALL"
  "listeners|DISPLAY LISTENER(*) ALL"
  "processes|DISPLAY PROCESS(*) ALL"
  "namelists|DISPLAY NAMELIST(*) ALL"
  "services|DISPLAY SERVICE(*) ALL"
  "topics|DISPLAY TOPIC(*) ALL"
  "subscriptions|DISPLAY SUB(*) ALL"
)

RUNTIME_COMMANDS=(
  "qmgr-status|DISPLAY QMSTATUS ALL"
  "channel-status|DISPLAY CHSTATUS(*) ALL"
  "listener-status|DISPLAY LSSTATUS(*) ALL"
  "queue-status|DISPLAY QSTATUS(*) TYPE(QUEUE) ALL"
  "queue-handles|DISPLAY QSTATUS(*) TYPE(HANDLE) ALL"
  "connections|DISPLAY CONN(*) TYPE(CONN) ALL"
  "connection-handles|DISPLAY CONN(*) TYPE(HANDLE) ALL"
  "application-status|DISPLAY APSTATUS(*) ALL"
  "cluster-qmgrs|DISPLAY CLUSQMGR(*) ALL"
)

idx=0
for qmgr in "${QMGRS[@]}"; do
  idx=$((idx + 1))
  qsafe="$(safe_name "$qmgr")"
  qid="$(printf '%03d_%s' "$idx" "$qsafe")"
  qroot="$ROOT/qmgr/$qid"
  mkdir -p "$qroot/config" "$qroot/runtime"
  printf '%s\t%s\n' "$qid" "$qmgr" >> "$ROOT/qmgrs.tsv"
  printf '%s\n' "$qmgr" > "$qroot/name.txt"

  # Selected configuration only: enough for topology while avoiding AUTHINFO/CHLAUTH/authority exports.
  for spec in "${CONFIG_COMMANDS[@]}"; do
    label="${spec%%|*}"
    command_text="${spec#*|}"
    run_mqsc "$qmgr" "$qroot/config/$label" "$command_text"
  done
done

for ((sample=1; sample<=SAMPLES; sample++)); do
  sample_stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  sample_id="$(printf 'sample_%03d_%s' "$sample" "$sample_stamp")"
  for ((i=0; i<${#QMGRS[@]}; i++)); do
    qmgr="${QMGRS[$i]}"
    qsafe="$(safe_name "$qmgr")"
    qid="$(printf '%03d_%s' "$((i + 1))" "$qsafe")"
    qroot="$ROOT/qmgr/$qid"
    sroot="$qroot/runtime/$sample_id"
    mkdir -p "$sroot"
    printf '%s\n' "$(utc_now)" > "$sroot/captured-at-utc.txt"
    for spec in "${RUNTIME_COMMANDS[@]}"; do
      label="${spec%%|*}"
      command_text="${spec#*|}"
      run_mqsc "$qmgr" "$sroot/$label" "$command_text"
    done
  done

  if (( sample < SAMPLES && INTERVAL_SECONDS > 0 )); then
    sleep "$INTERVAL_SECONDS"
  fi
done

COMPLETED_AT="$(utc_now)"
printf '%s\n' "$COMPLETED_AT" > "$ROOT/host/completed-at-utc.txt"

cat > "$ROOT/manifest.properties" <<EOF_MANIFEST
format=osi-mq-topology-raw
format_version=$FORMAT_VERSION
collector_version=$COLLECTOR_VERSION
host=$HOST_SHORT
started_at_utc=$STARTED_AT
completed_at_utc=$COMPLETED_AT
samples=$SAMPLES
interval_seconds=$INTERVAL_SECONDS
queue_manager_count=${#QMGRS[@]}
run_as_user=$(id -un 2>/dev/null || printf unknown)
EOF_MANIFEST

cat > "$ROOT/README.txt" <<'EOF_README'
This is a read-only raw IBM MQ topology evidence package for MW-Dashboard.

Important:
- No message payloads are collected.
- No environment-variable dump, key/certificate file, authority export, AUTHINFO, or CHLAUTH export is collected.
- MQSC command failures are preserved as .err/.rc files and do not abort the archive.
- Static definitions and runtime observations are kept separate so downstream normalization can distinguish configured and observed relationships.
EOF_README

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$ROOT" && find . -type f ! -name checksums.sha256 -print0 | sort -z | xargs -0 sha256sum > checksums.sha256)
fi

ARCHIVE="$OUTPUT_DIR/${ARCHIVE_BASENAME}.tar.gz"
tar -C "$WORK_ROOT" -czf "$ARCHIVE" "$ARCHIVE_BASENAME"

printf 'Created: %s\n' "$ARCHIVE"
printf 'Queue managers: %s\n' "${#QMGRS[@]}"
printf 'Runtime samples: %s (interval %ss)\n' "$SAMPLES" "$INTERVAL_SECONDS"
