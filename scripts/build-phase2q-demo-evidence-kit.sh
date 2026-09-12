#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-dist}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
NAME="osi-demo-evidence-kit-${STAMP}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/osi-demo-kit.XXXXXX")"
KIT="$TMP/$NAME"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT_DIR" "$KIT/source-host/mq" "$KIT/source-host/ace" "$KIT/workstation" "$KIT/docs"

install -m 0750 "$ROOT/collectors/ibm-mq/mq-topology-collector.sh" "$KIT/source-host/mq/"
install -m 0750 "$ROOT/collectors/ibm-mq/mq-log-history-collector.sh" "$KIT/source-host/mq/"
install -m 0750 "$ROOT/collectors/ibm-ace/ace-log-history-collector.sh" "$KIT/source-host/ace/"
install -m 0750 "$ROOT/collectors/ibm-mq/analyze_mq_log_history.py" "$KIT/workstation/"
install -m 0750 "$ROOT/collectors/analyze_enterprise_log_history.py" "$KIT/workstation/"
install -m 0750 "$ROOT/scripts/phase2q_campaign_index.py" "$KIT/workstation/"
install -m 0640 "$ROOT/docs/phase-2p-historical-log-corpus.md" "$KIT/docs/"
install -m 0640 "$ROOT/docs/phase-2q-demo-evidence-qualification.md" "$KIT/docs/"

cat > "$KIT/README.txt" <<'EOF'
OSI demo evidence kit

Purpose
-------
Collect and qualify manually transferred demo evidence without direct middleware connectivity.
Raw historical corpora and derived analyses stay outside the dashboard database.

Source host
-----------
MQ:
  mq-topology-collector.sh
  mq-log-history-collector.sh
ACE:
  ace-log-history-collector.sh

DataPower remains manual-export only. Do not add appliance credentials or direct collection for the demo.

Workstation
-----------
  analyze_mq_log_history.py
  analyze_enterprise_log_history.py
  phase2q_campaign_index.py

Recommended sequence
--------------------
1. Inventory historical logs on every MQ/ACE host before copying them.
2. Review size/access gaps.
3. Run approved full collections and DataPower manual exports.
4. Transfer evidence through the approved manual mechanism.
5. Analyze each corpus offline.
6. Build campaign-index.json with phase2q_campaign_index.py.
7. Qualify demo episodes only after operator corroboration.

Boundaries
----------
- no D1 writes;
- no direct middleware-to-Cloudflare requirement;
- no queue payload collection;
- no trace is enabled by these tools;
- MQ recovery/transaction logs are not part of the default historical corpus;
- analyzer ranking is discovery evidence, not an OSI Finding or proof of causality.
EOF

(
  cd "$KIT"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
)

ARCHIVE="$(cd "$OUT_DIR" && pwd)/${NAME}.tar.gz"
tar -C "$TMP" -czf "$ARCHIVE" "$NAME"
printf '%s\n' "$ARCHIVE"
