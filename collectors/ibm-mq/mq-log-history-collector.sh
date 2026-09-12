#!/usr/bin/env bash
set -uo pipefail
umask 077

COLLECTOR_VERSION="1.0.0"
FORMAT_VERSION="1"
OUTPUT_DIR="$PWD"
INVENTORY_ONLY=0
INCLUDE_FDC=1
INCLUDE_TRACE=0
INCLUDE_JOURNAL=0
INCLUDE_SYSTEM_FILES=0
SINCE_EPOCH=0
UNTIL_EPOCH=0
JOURNAL_SINCE=""
JOURNAL_UNTIL=""
MAX_BYTES=0

declare -a SEARCH_ROOTS=("/var/mqm")
declare -a EXTRA_SEARCH_ROOTS=()

action_usage() {
  cat <<'USAGE'
IBM MQ historical diagnostic-log corpus collector for OSI demo discovery

Usage:
  mq-log-history-collector.sh [options]

Options:
  --output-dir DIR          Directory for generated inventory/archive (default: current directory)
  --inventory-only          Discover readable historical evidence and estimate volume; copy nothing
  --search-root DIR         Add an operator-approved MQ log search root; may be repeated
  --since TIME              Only include files whose mtime is on/after TIME (GNU date syntax)
  --until TIME              Only include files whose mtime is on/before TIME (GNU date syntax)
  --max-bytes N             Optional total copied-file byte ceiling; 0 means unlimited (default: 0)
  --exclude-fdc             Do not collect FDC/FFST diagnostic files
  --include-trace           Include existing MQ trace files (*.TRC* / *.trc*); OFF by default
  --include-journal         Export retained systemd journal entries matching IBM MQ processes/messages
  --journal-since TIME      Optional journalctl --since value; with no value all retained matching entries are exported
  --journal-until TIME      Optional journalctl --until value
  --include-system-files    Copy broad rotated system context logs (messages/syslog/daemon/kern); OFF by default
  -h, --help                Show this help

Purpose and safety:
  - Read-only collection for offline analysis; nothing is uploaded and nothing is written to D1.
  - Collects retained diagnostic logs as files, preserving source path, mtime, size and SHA-256.
  - Does not run MQSC, enable tracing, start/stop MQ, read queue messages, or change configuration.
  - FDCs and broad system logs can contain operationally sensitive host/user/network details.
  - MQ trace can contain substantially more sensitive data and is therefore explicit opt-in only.

Recommended workflow:
  1) Run --inventory-only first on each MQ host.
  2) Review volume and access gaps.
  3) Run a full collection, normally with --include-journal.
USAGE
}

is_uint() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }
utc_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
safe_name() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

while (( $# > 0 )); do
  case "$1" in
    --output-dir)
      [[ $# -ge 2 ]] || { echo "ERROR: --output-dir requires a value" >&2; exit 2; }
      OUTPUT_DIR="$2"; shift 2 ;;
    --inventory-only) INVENTORY_ONLY=1; shift ;;
    --search-root)
      [[ $# -ge 2 ]] || { echo "ERROR: --search-root requires a value" >&2; exit 2; }
      EXTRA_SEARCH_ROOTS+=("$2"); shift 2 ;;
    --since)
      [[ $# -ge 2 ]] || { echo "ERROR: --since requires a value" >&2; exit 2; }
      SINCE_EPOCH="$(date -d "$2" +%s 2>/dev/null || true)"
      [[ -n "$SINCE_EPOCH" ]] || { echo "ERROR: --since could not be parsed by date: $2" >&2; exit 2; }
      shift 2 ;;
    --until)
      [[ $# -ge 2 ]] || { echo "ERROR: --until requires a value" >&2; exit 2; }
      UNTIL_EPOCH="$(date -d "$2" +%s 2>/dev/null || true)"
      [[ -n "$UNTIL_EPOCH" ]] || { echo "ERROR: --until could not be parsed by date: $2" >&2; exit 2; }
      shift 2 ;;
    --max-bytes)
      [[ $# -ge 2 ]] || { echo "ERROR: --max-bytes requires a value" >&2; exit 2; }
      MAX_BYTES="$2"; shift 2 ;;
    --exclude-fdc) INCLUDE_FDC=0; shift ;;
    --include-trace) INCLUDE_TRACE=1; shift ;;
    --include-journal) INCLUDE_JOURNAL=1; shift ;;
    --journal-since)
      [[ $# -ge 2 ]] || { echo "ERROR: --journal-since requires a value" >&2; exit 2; }
      JOURNAL_SINCE="$2"; INCLUDE_JOURNAL=1; shift 2 ;;
    --journal-until)
      [[ $# -ge 2 ]] || { echo "ERROR: --journal-until requires a value" >&2; exit 2; }
      JOURNAL_UNTIL="$2"; INCLUDE_JOURNAL=1; shift 2 ;;
    --include-system-files) INCLUDE_SYSTEM_FILES=1; shift ;;
    -h|--help) action_usage; exit 0 ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      action_usage >&2
      exit 2 ;;
  esac
done

is_uint "$MAX_BYTES" || { echo "ERROR: --max-bytes must be an integer >= 0" >&2; exit 2; }
mkdir -p "$OUTPUT_DIR" || exit 1
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

for required in tar date hostname find stat cp sort awk sed; do
  command -v "$required" >/dev/null 2>&1 || { echo "ERROR: required command not found: $required" >&2; exit 1; }
done

HOST_SHORT="$(hostname -s 2>/dev/null || hostname)"
HOST_SAFE="$(safe_name "$HOST_SHORT")"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
BASENAME="mq-log-history-${HOST_SAFE}-${STAMP}"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/osi-mq-log-history.XXXXXX")"
ROOT="$WORK_ROOT/$BASENAME"
mkdir -p "$ROOT/meta" "$ROOT/raw/files" "$ROOT/raw/system"
STARTED_AT="$(utc_now)"

cleanup() { rm -rf "$WORK_ROOT"; }
trap cleanup EXIT

capture_cmd() {
  local base="$1"; shift
  mkdir -p "$(dirname "$base")"
  printf '%q ' "$@" > "${base}.command"
  printf '\n' >> "${base}.command"
  "$@" > "${base}.out" 2> "${base}.err"
  printf '%s\n' "$?" > "${base}.rc"
  return 0
}

printf '%s\n' "$STARTED_AT" > "$ROOT/meta/started-at-utc.txt"
capture_cmd "$ROOT/meta/hostname" hostname
capture_cmd "$ROOT/meta/hostname-fqdn" hostname -f
capture_cmd "$ROOT/meta/date-local" date '+%Y-%m-%dT%H:%M:%S%z %Z'
capture_cmd "$ROOT/meta/date-utc" date -u '+%Y-%m-%dT%H:%M:%SZ'
capture_cmd "$ROOT/meta/uname" uname -a
capture_cmd "$ROOT/meta/id" id
if command -v uptime >/dev/null 2>&1; then capture_cmd "$ROOT/meta/uptime" uptime; fi
if command -v timedatectl >/dev/null 2>&1; then capture_cmd "$ROOT/meta/timedatectl" timedatectl status; fi
if command -v dspmq >/dev/null 2>&1; then capture_cmd "$ROOT/meta/dspmq" dspmq; fi
if command -v dspmqver >/dev/null 2>&1; then capture_cmd "$ROOT/meta/dspmqver" dspmqver; fi
if command -v dspmqinst >/dev/null 2>&1; then capture_cmd "$ROOT/meta/dspmqinst" dspmqinst; fi

# Discover configured queue-manager data paths without requiring an MQSC connection.
if [[ -r /var/mqm/mqs.ini ]]; then
  cp -p /var/mqm/mqs.ini "$ROOT/meta/mqs.ini"
  while IFS= read -r configured_path; do
    [[ -n "$configured_path" ]] || continue
    SEARCH_ROOTS+=("$configured_path")
  done < <(sed -n 's/^[[:space:]]*DataPath[[:space:]]*=[[:space:]]*//p' /var/mqm/mqs.ini | sed 's/[[:space:]]*$//' | awk 'NF && !seen[$0]++')
fi
SEARCH_ROOTS+=("${EXTRA_SEARCH_ROOTS[@]}")

# Canonicalize and de-duplicate existing search roots.
declare -a ACTIVE_ROOTS=()
declare -A ROOT_SEEN=()
for root in "${SEARCH_ROOTS[@]}"; do
  [[ -d "$root" ]] || continue
  canonical="$(readlink -f "$root" 2>/dev/null || printf '%s' "$root")"
  [[ -n "${ROOT_SEEN[$canonical]:-}" ]] && continue
  ROOT_SEEN[$canonical]=1
  ACTIVE_ROOTS+=("$canonical")
done
printf '%s\n' "${ACTIVE_ROOTS[@]}" > "$ROOT/meta/search-roots.txt"

MANIFEST="$ROOT/manifest.tsv"
printf 'evidence_class\tsource_path\tsize_bytes\tmtime_utc\tarchive_path\tsha256\tstatus\n' > "$MANIFEST"

declare -A FILE_SEEN=()
TOTAL_CANDIDATE_BYTES=0
TOTAL_CANDIDATE_FILES=0
TOTAL_COPIED_BYTES=0
TOTAL_COPIED_FILES=0
TOTAL_SKIPPED_FILES=0

mtime_epoch() { stat -c '%Y' -- "$1" 2>/dev/null || printf '0'; }
size_bytes() { stat -c '%s' -- "$1" 2>/dev/null || printf '0'; }
mtime_utc() {
  local epoch
  epoch="$(mtime_epoch "$1")"
  date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf 'unknown'
}

within_window() {
  local path="$1" epoch
  epoch="$(mtime_epoch "$path")"
  (( SINCE_EPOCH == 0 || epoch >= SINCE_EPOCH )) || return 1
  (( UNTIL_EPOCH == 0 || epoch <= UNTIL_EPOCH )) || return 1
  return 0
}

classify_path() {
  local lower
  lower="${1,,}"
  if [[ "$lower" == *.fdc || "$lower" == *.fdc.* || "$lower" == *.ffst || "$lower" == *.ffst.* ]]; then
    printf 'mq_fdc'; return
  fi
  if [[ "$lower" == *.trc || "$lower" == *.trc.* ]]; then
    printf 'mq_trace'; return
  fi
  if [[ "$lower" == */errors/* || "$lower" == *amqerr* ]]; then
    printf 'mq_error_log'; return
  fi
  printf 'system_context_log'
}

record_candidate() {
  local path="$1" class canonical bytes mtime dest hash status
  [[ -f "$path" ]] || return 0
  canonical="$(readlink -f "$path" 2>/dev/null || printf '%s' "$path")"
  [[ -n "${FILE_SEEN[$canonical]:-}" ]] && return 0
  FILE_SEEN[$canonical]=1
  within_window "$canonical" || return 0

  class="$(classify_path "$canonical")"
  if [[ "$class" == "mq_fdc" && "$INCLUDE_FDC" -ne 1 ]]; then return 0; fi
  if [[ "$class" == "mq_trace" && "$INCLUDE_TRACE" -ne 1 ]]; then return 0; fi

  bytes="$(size_bytes "$canonical")"
  mtime="$(mtime_utc "$canonical")"
  dest="raw/files${canonical}"
  TOTAL_CANDIDATE_FILES=$((TOTAL_CANDIDATE_FILES + 1))
  TOTAL_CANDIDATE_BYTES=$((TOTAL_CANDIDATE_BYTES + bytes))

  if [[ ! -r "$canonical" ]]; then
    status="unreadable"
    TOTAL_SKIPPED_FILES=$((TOTAL_SKIPPED_FILES + 1))
    printf '%s\t%s\t%s\t%s\t%s\t\t%s\n' "$class" "$canonical" "$bytes" "$mtime" "$dest" "$status" >> "$MANIFEST"
    return 0
  fi

  if (( INVENTORY_ONLY == 1 )); then
    printf '%s\t%s\t%s\t%s\t%s\t\tinventory_only\n' "$class" "$canonical" "$bytes" "$mtime" "$dest" >> "$MANIFEST"
    return 0
  fi

  if (( MAX_BYTES > 0 && TOTAL_COPIED_BYTES + bytes > MAX_BYTES )); then
    TOTAL_SKIPPED_FILES=$((TOTAL_SKIPPED_FILES + 1))
    printf '%s\t%s\t%s\t%s\t%s\t\tmax_bytes_skipped\n' "$class" "$canonical" "$bytes" "$mtime" "$dest" >> "$MANIFEST"
    return 0
  fi

  mkdir -p "$ROOT/$(dirname "$dest")"
  if cp -p -- "$canonical" "$ROOT/$dest" 2> "$ROOT/meta/last-copy-error.txt"; then
    hash=""
    if command -v sha256sum >/dev/null 2>&1; then hash="$(sha256sum "$ROOT/$dest" | awk '{print $1}')"; fi
    TOTAL_COPIED_FILES=$((TOTAL_COPIED_FILES + 1))
    TOTAL_COPIED_BYTES=$((TOTAL_COPIED_BYTES + bytes))
    printf '%s\t%s\t%s\t%s\t%s\t%s\tcopied\n' "$class" "$canonical" "$bytes" "$mtime" "$dest" "$hash" >> "$MANIFEST"
  else
    TOTAL_SKIPPED_FILES=$((TOTAL_SKIPPED_FILES + 1))
    printf '%s\t%s\t%s\t%s\t%s\t\tcopy_failed\n' "$class" "$canonical" "$bytes" "$mtime" "$dest" >> "$MANIFEST"
  fi
}

# MQ diagnostic evidence: retained error logs, FDC/FFST and optional pre-existing traces.
for root in "${ACTIVE_ROOTS[@]}"; do
  while IFS= read -r -d '' path; do
    record_candidate "$path"
  done < <(find "$root" -type f \
    \( -iname 'AMQERR*.LOG*' -o -path '*/errors/*.LOG*' -o -path '*/errors/*.log*' \
       -o -iname '*.FDC' -o -iname '*.FDC.*' -o -iname '*.FFST' -o -iname '*.FFST.*' \
       -o -iname '*.TRC' -o -iname '*.TRC.*' \) -print0 2>/dev/null)
done

# Optional broad system context. These files are intentionally not on by default because they
# contain unrelated host events and can be large/sensitive. Their original bytes are preserved.
if (( INCLUDE_SYSTEM_FILES == 1 )); then
  for pattern in /var/log/messages /var/log/messages.* /var/log/syslog /var/log/syslog.* /var/log/daemon.log /var/log/daemon.log.* /var/log/kern.log /var/log/kern.log.*; do
    for path in $pattern; do
      [[ -f "$path" ]] || continue
      record_candidate "$path"
    done
  done
fi

JOURNAL_STATUS="not_requested"
if (( INCLUDE_JOURNAL == 1 )); then
  if (( INVENTORY_ONLY == 1 )); then
    JOURNAL_STATUS="inventory_only_not_exported"
  elif ! command -v journalctl >/dev/null 2>&1; then
    JOURNAL_STATUS="journalctl_unavailable"
  else
    JOURNAL_STATUS="attempted"
    journal_args=(--no-pager --output=short-iso-precise)
    [[ -n "$JOURNAL_SINCE" ]] && journal_args+=(--since "$JOURNAL_SINCE")
    [[ -n "$JOURNAL_UNTIL" ]] && journal_args+=(--until "$JOURNAL_UNTIL")
    # Prefer journalctl's own regex filtering. If unsupported, fall back to a read-only pipe.
    if journalctl --help 2>/dev/null | grep -q -- '--grep'; then
      journalctl "${journal_args[@]}" --grep='IBM MQ|AMQ[0-9]{4}[A-Z]?|amq[a-z0-9]+|runmq[a-z0-9]*|strmq[a-z0-9]*|endmq[a-z0-9]*|dspmq[a-z0-9]*' \
        > "$ROOT/raw/system/journal-mq.log" 2> "$ROOT/raw/system/journal-mq.err"
      printf '%s\n' "$?" > "$ROOT/raw/system/journal-mq.rc"
    else
      journalctl "${journal_args[@]}" 2> "$ROOT/raw/system/journal-mq.err" \
        | grep -Eai 'IBM MQ|AMQ[0-9]{4}[A-Z]?|amq[a-z0-9]+|runmq[a-z0-9]*|strmq[a-z0-9]*|endmq[a-z0-9]*|dspmq[a-z0-9]*' \
        > "$ROOT/raw/system/journal-mq.log"
      printf '%s\n' "${PIPESTATUS[0]}:${PIPESTATUS[1]}" > "$ROOT/raw/system/journal-mq.rc"
    fi
    if [[ -s "$ROOT/raw/system/journal-mq.log" ]]; then
      JOURNAL_STATUS="collected"
      if command -v sha256sum >/dev/null 2>&1; then sha256sum "$ROOT/raw/system/journal-mq.log" > "$ROOT/raw/system/journal-mq.sha256"; fi
    else
      JOURNAL_STATUS="empty_or_unreadable"
    fi
    capture_cmd "$ROOT/raw/system/journal-boots" journalctl --list-boots --no-pager
  fi
fi

COMPLETED_AT="$(utc_now)"
printf '%s\n' "$COMPLETED_AT" > "$ROOT/meta/completed-at-utc.txt"
cat > "$ROOT/manifest.properties" <<EOF_MANIFEST
format=osi-mq-log-history-raw
format_version=$FORMAT_VERSION
collector_version=$COLLECTOR_VERSION
host=$HOST_SHORT
started_at_utc=$STARTED_AT
completed_at_utc=$COMPLETED_AT
inventory_only=$INVENTORY_ONLY
include_fdc=$INCLUDE_FDC
include_trace=$INCLUDE_TRACE
include_journal=$INCLUDE_JOURNAL
include_system_files=$INCLUDE_SYSTEM_FILES
since_epoch=$SINCE_EPOCH
until_epoch=$UNTIL_EPOCH
max_bytes=$MAX_BYTES
candidate_files=$TOTAL_CANDIDATE_FILES
candidate_bytes=$TOTAL_CANDIDATE_BYTES
copied_files=$TOTAL_COPIED_FILES
copied_bytes=$TOTAL_COPIED_BYTES
skipped_files=$TOTAL_SKIPPED_FILES
journal_status=$JOURNAL_STATUS
run_as_user=$(id -un 2>/dev/null || printf unknown)
EOF_MANIFEST

cat > "$ROOT/README.txt" <<'EOF_README'
OSI IBM MQ historical diagnostic-log corpus

This package is intentionally separate from the dashboard database.
It is designed for offline discovery of patterns and evidence that may be useful in the demo phase.

Collected by default:
- retained IBM MQ AMQERR/error-directory logs under discovered MQ data roots;
- IBM MQ FDC/FFST diagnostic files unless --exclude-fdc is used;
- host/time/MQ installation context and an integrity manifest.

Optional:
- filtered systemd journal context (--include-journal);
- broad rotated system logs (--include-system-files);
- pre-existing MQ trace files (--include-trace).

Not performed:
- no queue reads/browse/get;
- no MQSC command;
- no MQ trace enablement;
- no configuration or service changes;
- no network upload;
- no D1/database persistence.

Sensitivity:
Diagnostic logs, especially FDC, system logs and trace files, can contain host names, user names,
IP addresses, object names, certificate/TLS details, paths and other operational metadata.
Review the corpus before transferring it outside the approved analysis environment.
EOF_README

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$ROOT" && find . -type f ! -name package-checksums.sha256 -print0 | sort -z | xargs -0 sha256sum > package-checksums.sha256)
fi

if (( INVENTORY_ONLY == 1 )); then
  TARGET="$OUTPUT_DIR/${BASENAME}-inventory.tar.gz"
else
  TARGET="$OUTPUT_DIR/${BASENAME}.tar.gz"
fi

tar -C "$WORK_ROOT" -czf "$TARGET" "$BASENAME"
printf 'Created: %s\n' "$TARGET"
printf 'Candidate files: %s (%s bytes)\n' "$TOTAL_CANDIDATE_FILES" "$TOTAL_CANDIDATE_BYTES"
printf 'Copied files: %s (%s bytes)\n' "$TOTAL_COPIED_FILES" "$TOTAL_COPIED_BYTES"
printf 'Skipped files: %s\n' "$TOTAL_SKIPPED_FILES"
printf 'Journal: %s\n' "$JOURNAL_STATUS"
