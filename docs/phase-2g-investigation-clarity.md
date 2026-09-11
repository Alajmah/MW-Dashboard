# Phase 2G — Investigation Clarity

Phase 2G improves the operator-facing investigation workspace without changing IBM MQ collection, evaluator rules, persistence, thresholds, or lifecycle semantics.

## Purpose

Phase 2F established the direct investigation path:

`Overview → canonical object workspace → Findings / Monitor / Relationships / Configuration / Evidence`

Phase 2G makes each tab answer a distinct operator question while preserving the evidence boundaries already established by Findings v1.

## Summary

Summary is a factual synopsis, not a new diagnosis engine. It separates:

- **What changed?** — arithmetic projection of persisted observations such as first/last queue depth and oldest-message age.
- **Why was this raised?** — evaluator-owned finding summaries only.
- **What can OSI conclude?** — existence and count of stored samples/findings in the active operational evaluation.
- **What is not concluded?** — evaluator-owned boundaries such as `sla_breach=not_asserted` and `impact=not_established` when present.

The browser does not add thresholds, business SLAs, service-impact claims, or new causal rules.

## Findings

Finding evidence is structured as rows with sample, observed time, evidence source, and supporting signal names. Long raw evidence paths remain available but no longer collide with sample identifiers.

## Monitor and tab semantics

The Monitor tab remains the Phase 2F five-sample factual sequence. The badge now reports the number of **samples**, not the number of individual persisted metric observations. Evidence uses the same sample-oriented count.

## Relationships

Relationship cards resolve neighbor canonical entity IDs through the canonical entity API so the primary label is the human-readable entity name and semantic type. Canonical IDs remain visible as secondary provenance.

No relationship is invented: only relations returned by the canonical estate API are displayed.

## Configuration

Queue configuration is grouped for scanning:

- Queue behavior
- Capacity
- Cluster
- Ownership

The complete canonical property set remains available in the expandable **Raw MQ attributes** section.

## Evidence

The default Evidence projection is object-first. Each collector sample shows:

- persisted object-level signal values;
- exact queue evidence references used by observations/findings;
- the sample timestamp.

Queue-manager-wide collection coverage is retained under an expandable **Collection context** section instead of dominating the primary proof view.

Canonical provenance remains a separate proof block.

## Navigation

The full investigation workspace keeps **Back** as the primary escape action. The redundant close control is suppressed while **Locate in Objects** remains as an explicit secondary navigation action.

## Boundaries

Phase 2G introduces no Prometheus, Grafana, OpenTelemetry, Loki, third-party monitoring runtime, MQ mutation, active tracing, reset command, collection daemon, remediation, freshness SLA, health threshold, or browser-side finding rule.
