#!/usr/bin/env bash
set -uo pipefail

VERSION="1.0.0"
OUTPUT_DIR="$PWD"
INVENTORY_ONLY=0
INCLUDE_SYSLOG=0
INCLUDE_JOURNAL=0
MAX_BYTES=0
declare -a ROOTS=()

usage() {
  cat <<'EOF'
IBM ACE historical log corpus collector for OSI demo discovery

Usage:
  ace-log-history-collector.sh [options]

Options:
  --root DIR             ACE work/log root to inspect; may be repeated
  --inventory-only       Inventory evidence without copying source files
  --include-syslog       Include retained syslog/messages files when readable
  --include-journal      Export filtered journal entries for ACE-related services/processes
  --max-bytes N          Stop copying after N bytes (0 = no limit)
  --output-dir DIR       Destination for generated .tar.gz
  -h, --help             Show this help

The collector is read-only. It does not start/stop integration nodes or servers,
enable tracing, change ACE configuration, or connect to message flows.
EOF
}

is_uint() { [[ "${1:-}" =~ ^[0-9]+$ ]]; }
while (( $# > 0 )); do
  case "$1" in
    --root) [[ $# -ge 2 ]] || exit 2; ROOTS+=("$2"); shift 2 ;;
    --inventory-only) INVENTORY_ONLY=1; shift ;;
    --include-syslog) INCLUDE_SYSLOG=1; shift ;;
    --include-journal) INCLUDE_JOURNAL=1; shift ;;
    --max-bytes) [[ $# -ge 2 ]] || exit 2; MAX_BYTES="$2"; shift 2 ;;
    --output-dir) [[ $# -ge 2 ]] || exit 2; OUTPUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
is_uint "$MAX_BYTES" || { echo "ERROR: --max-bytes must be an integer" >&2; exit 2; }
mkdir -p "$OUTPUT_DIR" || exit 1
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

safe_name() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
utc_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
HOST="$(hostname -s 2>/dev/null || hostname)"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
NAME="ace-log-history-$(safe_name "$HOST")-$STAMP"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/osi-ace-log.XXXXXX")"
ROOT="$TMP/$NAME"
mkdir -p "$ROOT/meta" "$ROOT/raw/files" "$ROOT/raw/system"
trap 'rm -rf "$TMP"' EXIT

if (( ${#ROOTS[@]} == 0 )); then
  for candidate in /var/mqsi /var/ace /opt/IBM/ace-*; do
    [[ -d "$candidate" ]] && ROOTS+=("$candidate")
  done
fi

printf 'evidence_class\tsource_path\tsize_bytes\tmtime_epoch\tarchive_path\tsha256\tstatus\n' > "$ROOT/manifest.tsv"
printf '%s\n' "${ROOTS[@]}" > "$ROOT/meta/search-roots.txt"
hostname > "$ROOT/meta/hostname.txt" 2>/dev/null || true
date -u > "$ROOT/meta/date-utc.txt" 2>/dev/null || true
if command -v mqsilist >/dev/null 2>&1; then mqsilist > "$ROOT/meta/mqsilist.out" 2> "$ROOT/meta/mqsilist.err" || true; fi
if command -v IntegrationServer >/dev/null 2>&1; then IntegrationServer --version > "$ROOT/meta/integrationserver-version.out" 2>&1 || true; fi

copied=0
files_seen=0
copy_one() {
  local class="$1" src="$2"
  [[ -f "$src" ]] || return 0
  files_seen=$((files_seen+1))
  local size mtime rel sha status dst
  size="$(stat -c '%s' "$src" 2>/dev/null || printf 0)"
  mtime="$(stat -c '%Y' "$src" 2>/dev/null || printf 0)"
  rel="${src#/}"; rel="${rel//../_}"
  dst="raw/files/$rel"
  sha=""; status="inventoried"
  if (( INVENTORY_ONLY == 0 )); then
    if (( MAX_BYTES > 0 && copied + size > MAX_BYTES )); then
      status="skipped_max_bytes"
    elif [[ ! -r "$src" ]]; then
      status="unreadable"
    else
      mkdir -p "$ROOT/$(dirname "$dst")"
      if cp -p -- "$src" "$ROOT/$dst" 2>/dev/null; then
        status="copied"; copied=$((copied+size))
        command -v sha256sum >/dev/null 2>&1 && sha="$(sha256sum "$ROOT/$dst" | awk '{print $1}')"
      else
        status="copy_failed"
      fi
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$class" "$src" "$size" "$mtime" "$dst" "$sha" "$status" >> "$ROOT/manifest.tsv"
}

for base in "${ROOTS[@]}"; do
  [[ -d "$base" ]] || continue
  while IFS= read -r -d '' file; do
    lower="${file,,}"
    class="ace_other_log"
    case "$lower" in
      *activity*log*) class="ace_activity_log" ;;
      *admin*log*) class="ace_admin_log" ;;
      *stdout*|*.stdout|*stdout.*) class="ace_stdout" ;;
      *stderr*|*.stderr|*stderr.*) class="ace_stderr" ;;
      *trace*|*.trc|*.trace*) class="ace_trace_existing" ;;
      *.log|*.log.*|*.txt) class="ace_log" ;;
    esac
    copy_one "$class" "$file"
  done < <(find "$base" -type f \( -iname '*.log' -o -iname '*.log.*' -o -iname '*activity*' -o -iname '*stdout*' -o -iname '*stderr*' -o -iname '*trace*' -o -iname '*.trc' \) -print0 2>/dev/null)
done

if (( INCLUDE_SYSLOG == 1 )); then
  for pattern in /var/log/messages* /var/log/syslog* /var/log/daemon.log*; do
    for file in $pattern; do [[ -f "$file" ]] && copy_one "system_log" "$file"; done
  done
fi

if (( INCLUDE_JOURNAL == 1 )) && command -v journalctl >/dev/null 2>&1; then
  journalctl --no-pager 2>/dev/null | grep -Ei 'app connect|integrationserver|integration node|message broker|mqsi|bip[0-9]{4}' > "$ROOT/raw/system/journal-ace-filtered.log" || true
fi

cat > "$ROOT/manifest.properties" <<EOF
format=osi-ace-log-history
format_version=1
collector_version=$VERSION
host=$HOST
created_at_utc=$(utc_now)
inventory_only=$INVENTORY_ONLY
files_seen=$files_seen
bytes_copied=$copied
include_syslog=$INCLUDE_SYSLOG
include_journal=$INCLUDE_JOURNAL
EOF

cat > "$ROOT/README.txt" <<'EOF'
Read-only IBM App Connect Enterprise historical diagnostic corpus for offline OSI demo analysis.
Sources can include retained stdout/stderr, ACE log/activity/admin artifacts, pre-existing trace files,
and optional Linux syslog/journal context. The collector does not enable trace or modify ACE.
EOF

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$ROOT" && find . -type f ! -name package-checksums.sha256 -print0 | sort -z | xargs -0 sha256sum > package-checksums.sha256)
fi
ARCHIVE="$OUTPUT_DIR/$NAME.tar.gz"
tar -C "$TMP" -czf "$ARCHIVE" "$NAME"
printf 'Created: %s\nFiles inventoried: %s\nBytes copied: %s\n' "$ARCHIVE" "$files_seen" "$copied"
