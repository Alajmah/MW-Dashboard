#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-dist}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
NAME="osi-mq-diagnostic-index-kit-${STAMP}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/osi-diagnostic-kit.XXXXXX")"
KIT="$TMP/$NAME"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT_DIR" "$KIT"
install -m 0750 "$ROOT/collectors/ibm-mq/mq-diagnostic-header-index.py" "$KIT/"
install -m 0640 "$ROOT/docs/phase-2r-diagnostic-index.md" "$KIT/README.md"
(
  cd "$KIT"
  sha256sum mq-diagnostic-header-index.py README.md > SHA256SUMS
)
ARCHIVE="$(cd "$OUT_DIR" && pwd)/${NAME}.tar.gz"
tar -C "$TMP" -czf "$ARCHIVE" "$NAME"
printf '%s\n' "$ARCHIVE"
