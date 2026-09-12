#!/usr/bin/env bash
set -euo pipefail

PORT="${PHASE2N_PORT:-8791}"
BASE="http://127.0.0.1:${PORT}"
SECRET="phase2n-test-secret-0123456789abcdef"
KEY_ID="phase2n-key"
SOURCE_ID="mq-phase2n.example"

npx wrangler d1 migrations apply DB --local >/tmp/phase2n-migrate.log
npx wrangler d1 execute DB --local --command "
INSERT INTO semantic_estate_revision
(estate_revision_id, source_set_hash, source_revision_ids_json, built_at, activated_at, status, is_current,
 expected_entity_count, expected_relation_count, expected_unresolved_count, quality_json)
VALUES ('estate_phase2n', 'phase2n', '[]', '2026-09-12T08:00:00Z', '2026-09-12T08:00:00Z', 'ACTIVE', 1, 2, 0, 0, '{}');
INSERT INTO semantic_estate_entity
(estate_revision_id, entity_id, semantic_type, identity_rule, identity_key, identity_state, display_name,
 observed_at, properties_json, evidence_classes_json, source_ids_json, source_observations_json, evidence_count, source_count)
VALUES
('estate_phase2n', 'cent_000000000000000000000001', 'mq.queue_manager', 'qmid', 'QMID-PHASE2N', 'resolved', 'QM2N',
 '2026-09-12T08:00:00Z', '{\"QMID\":\"QMID-PHASE2N\"}', '[\"observed\"]', '[\"fixture\"]', '[]', 1, 1),
('estate_phase2n', 'cent_000000000000000000000002', 'mq.queue', 'rule_2', 'queue_manager_key=qm2n|name=q.phase2n', 'resolved', 'Q.PHASE2N',
 '2026-09-12T08:00:00Z', '{}', '[\"observed\"]', '[\"fixture\"]', '[]', 1, 1);
" >/tmp/phase2n-seed.log

npx wrangler dev --local --port "$PORT" \
  --var TELEMETRY_INGEST_ENABLED:true \
  --var "TELEMETRY_INGEST_KEYS_JSON:{\"keys\":[{\"key_id\":\"${KEY_ID}\",\"source_id\":\"${SOURCE_ID}\",\"secret\":\"${SECRET}\",\"status\":\"active\"}]}" \
  >/tmp/phase2n-wrangler.log 2>&1 &
WRANGLER_PID=$!
trap 'kill "$WRANGLER_PID" 2>/dev/null || true; wait "$WRANGLER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl --silent --fail "$BASE/api/v2/telemetry/status" >/tmp/phase2n-status.json 2>/dev/null; then
    break
  fi
  sleep 0.5
done

grep -Fq '"database_ready": true' /tmp/phase2n-status.json
grep -Fq '"ingress_enabled": true' /tmp/phase2n-status.json

PYTHONPATH=collectors/ibm-mq/observer PHASE2N_BASE="$BASE" PHASE2N_SECRET="$SECRET" PHASE2N_KEY_ID="$KEY_ID" python3 - <<'PY'
import json
import os
import time
from telemetry_delivery import canonical_json_bytes, post_payload, signed_headers

base = os.environ["PHASE2N_BASE"]
secret = os.environ["PHASE2N_SECRET"]
key_id = os.environ["PHASE2N_KEY_ID"]
source_id = "mq-phase2n.example"
source_host = "mq-phase2n"

def observation(obs_id, name, value):
    return {
        "observation_id": obs_id,
        "entity": {
            "semantic_type": "mq.queue",
            "display_name": name,
            "identity_hints": {
                "queue_manager_name": "QM2N",
                "queue_manager_qmid": "QMID-PHASE2N",
                "name": name,
            },
        },
        "observation_type": "mq.queue.depth.current",
        "observed_at": "2026-09-12T08:00:00Z",
        "value": value,
        "unit": "messages",
        "source": {
            "source_id": source_id,
            "source_host": source_host,
            "queue_manager": "QM2N",
            "collection_method": "mqsc:DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
            "command": "DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
            "evidence_class": "observed",
            "evidence_ref": f"telemetry://phase2n/{name}",
            "sample_id": "sample-0001",
        },
        "quality": {"coverage": "point_in_time", "freshness": "sampled"},
    }

batch = {
    "schema_version": "osi.telemetry.batch/v1",
    "run": {
        "run_id": "telemetry_phase2n_smoke",
        "observer": "osi-mq-observer",
        "observer_version": "0.2.0",
        "profile": "baseline",
        "started_at": "2026-09-12T08:00:00Z",
        "completed_at": "2026-09-12T08:00:01Z",
        "sample_count": 1,
        "sample_interval_seconds": 60,
        "source": {"kind": "ibm_mq_host", "source_id": source_id, "source_host": source_host},
    },
    "coverage": [{
        "scope_type": "queue_manager",
        "scope_key": "QM2N",
        "observation_family": "queue_status",
        "sample_id": "sample-0001",
        "observed_at": "2026-09-12T08:00:00Z",
        "state": "point_in_time",
        "collection_method": "mqsc:DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
        "command": "DISPLAY QSTATUS(*) TYPE(QUEUE) ALL",
        "evidence_ref": "telemetry://phase2n/QM2N/queue_status",
        "error": None,
    }],
    "observations": [
        observation("tobs_000000000000000000000001", "Q.PHASE2N", 7),
        observation("tobs_000000000000000000000002", "Q.UNKNOWN", 9),
    ],
}

payload = canonical_json_bytes(batch)
headers = signed_headers(payload, key_id, secret, str(int(time.time())))
endpoint = base + "/api/v2/telemetry/ingest"
first = post_payload(endpoint, payload, headers, 10)
assert first.status == 202, (first.status, first.body)
ack = json.loads(first.body)
assert ack["status"] == "accepted", ack
assert ack["delivery_id"] == headers["X-OSI-Delivery-Id"], ack

headers2 = signed_headers(payload, key_id, secret, str(int(time.time())))
second = post_payload(endpoint, payload, headers2, 10)
assert second.status == 200, (second.status, second.body)
ack2 = json.loads(second.body)
assert ack2["status"] == "duplicate", ack2
print(json.dumps({"accepted": first.status, "duplicate": second.status, "delivery_id": ack["delivery_id"]}))
PY

npx wrangler d1 execute DB --local --json --command "
SELECT status, observation_count, resolved_count, quarantine_count FROM telemetry_delivery_ledger;
SELECT accepted_delivery_count, resolved_observation_count, quarantined_observation_count FROM telemetry_source_state;
SELECT entity_id, observation_type, value_json FROM telemetry_latest_observation;
SELECT reason, display_name FROM telemetry_quarantine;
" >/tmp/phase2n-db.json

python3 - <<'PY'
import json
from pathlib import Path
raw = json.loads(Path('/tmp/phase2n-db.json').read_text())
rows = []
def visit(value):
    if isinstance(value, dict):
        if isinstance(value.get('results'), list): rows.extend(value['results'])
        for item in value.values(): visit(item)
    elif isinstance(value, list):
        for item in value: visit(item)
visit(raw)
assert any(r.get('status') == 'ACCEPTED' and r.get('resolved_count') == 1 and r.get('quarantine_count') == 1 for r in rows), rows
assert any(r.get('accepted_delivery_count') == 1 and r.get('resolved_observation_count') == 1 and r.get('quarantined_observation_count') == 1 for r in rows), rows
assert any(r.get('entity_id') == 'cent_000000000000000000000002' and r.get('value_json') == '7' for r in rows), rows
assert any(r.get('reason') == 'scoped_identity_not_found' and r.get('display_name') == 'Q.UNKNOWN' for r in rows), rows
print(json.dumps({'phase2n_local_persistence': 'ok', 'rows_seen': len(rows)}))
PY
