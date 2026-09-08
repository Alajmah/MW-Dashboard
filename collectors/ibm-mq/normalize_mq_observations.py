#!/usr/bin/env python3
"""Canonical IBM MQ ObservationBundle v2 normalizer entrypoint.

The topology/evidence implementation lives in the private implementation module.
This entrypoint owns MQSC command-outcome classification so valid empty wildcard
enumerations are not confused with collection failures.
"""

import re

import _normalize_mq_observations_impl as _impl
from _normalize_mq_observations_impl import *  # noqa: F401,F403
from mq_cluster_semantics import enrich as enrich_cluster_semantics

NORMALIZER_VERSION = "3.1.0"
_impl.NORMALIZER_VERSION = NORMALIZER_VERSION

MQ_MESSAGE_RE = re.compile(r"\b(AMQ\d{4}[A-Z]):\s*([^\r\n]*)", re.IGNORECASE)
EMPTY_ENUMERATION_CODES = frozenset({"AMQ8147E", "AMQ8933I"})


def _mqsc_command(archive, base):
    rel = base + ".mqsc"
    if not _impl.archive_has(archive, rel):
        return ""
    return archive.text(rel, False).strip()


def _is_wildcard_display(command):
    normalized = " ".join((command or "").upper().split())
    return normalized.startswith("DISPLAY ") and "(*)" in normalized


def _empty_enumeration(archive, base, rc, messages):
    """Return empty-result metadata only for known wildcard-enumeration outcomes.

    IBM MQ's runmqsc can return RC 10 for a syntactically valid DISPLAY wildcard
    when there are no matching objects/status records. We only normalize the
    specific real-estate outcomes already observed and require the original MQSC
    to be a wildcard DISPLAY. Unknown RC 10 results remain failures.
    """
    if rc != 10:
        return None
    command = _mqsc_command(archive, base)
    if not _is_wildcard_display(command):
        return None
    if not messages:
        return None

    codes = {code.upper() for code, _text in messages}
    if not codes.issubset(EMPTY_ENUMERATION_CODES):
        return None
    if not all("not found" in text.lower() for _code, text in messages):
        return None

    return {
        "empty_result": True,
        "empty_result_reason": "no_matching_objects",
        "mqsc_command": command,
        "mq_message_codes": sorted(codes),
    }


def command_health(archive, base, success_mode):
    out_rel = base + ".out"
    err_rel = base + ".err"
    rc = _impl.read_rc(archive, base)
    if rc is None and not _impl.archive_has(archive, out_rel):
        return {
            "mode": "not_collected",
            "evidence_ref": out_rel,
            "error": "command evidence missing",
            "properties": {"command_base": base},
        }

    out = archive.text(out_rel, False)
    err = archive.text(err_rel, False)
    combined = out + "\n" + err
    messages = [(code.upper(), text.strip()) for code, text in MQ_MESSAGE_RE.findall(combined)]
    error_codes = sorted({code for code, _text in messages if code.endswith("E")})

    empty = _empty_enumeration(archive, base, rc, messages)
    if empty:
        return {
            "mode": success_mode,
            "evidence_ref": out_rel,
            "error": None,
            "properties": {
                "command_base": base,
                "process_rc": rc,
                **empty,
            },
        }

    if rc not in (None, 0) or error_codes:
        details = []
        if rc not in (None, 0):
            details.append(f"process rc={rc}")
        if error_codes:
            details.append("MQ errors=" + ",".join(error_codes))
        return {
            "mode": "failed",
            "evidence_ref": out_rel,
            "error": "; ".join(details) or "command failed",
            "properties": {
                "command_base": base,
                "process_rc": rc,
                "mq_error_codes": error_codes,
                "mq_message_codes": sorted({code for code, _text in messages}),
            },
        }

    return {
        "mode": success_mode,
        "evidence_ref": out_rel,
        "error": None,
        "properties": {
            "command_base": base,
            "process_rc": rc if rc is not None else 0,
            "mq_message_codes": sorted({code for code, _text in messages}),
        },
    }


# All implementation functions resolve command_health through the implementation
# module's globals. Replace that binding once, before normalize/main can run.
_impl.command_health = command_health


def normalize(archive_path, environment=None):
    bundle = _impl.normalize(archive_path, environment)
    archive = _impl.Archive(archive_path)
    try:
        enrich_cluster_semantics(bundle, archive, _impl)
        bundle["run"]["normalizer_version"] = NORMALIZER_VERSION
        return bundle
    finally:
        archive.tf.close()


def main():
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Normalize a raw IBM MQ collector archive directly to ObservationBundle v2")
    parser.add_argument("archive", help="mq-topology-*.tar.gz raw collector archive")
    parser.add_argument("-o", "--output", default="mq-observation-bundle-v2.json")
    parser.add_argument("--environment")
    args = parser.parse_args()

    bundle = normalize(args.archive, args.environment)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(bundle, fh, indent=2, sort_keys=False)
        fh.write("\n")
    print(json.dumps({
        "output": args.output,
        "schema_version": bundle["schema_version"],
        "run_id": bundle["run"]["run_id"],
        "environment": bundle["run"]["environment"],
        "normalizer_version": bundle["run"].get("normalizer_version"),
        "coverage": len(bundle["coverage"]),
        "entities": len(bundle["entities"]),
        "relations": len(bundle["relations"]),
        "unresolved_references": len(bundle["unresolved_references"]),
    }, indent=2))


if __name__ == "__main__":
    main()
