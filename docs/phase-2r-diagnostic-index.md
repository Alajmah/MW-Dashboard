# Phase 2R — IBM MQ Diagnostic Header Index

## Goal

Index retained IBM MQ First Failure Symptom Report headers for offline demo discovery without transferring the full diagnostic files.

The indexer runs on the MQ host and produces a small package containing parsed report headers, recurring signature summaries, source-file metadata and checksums. It does not run MQSC, read queue messages, enable trace, change MQ, or write to D1.

## Scan modes

Default first-report mode reads at most 512 KiB from each discovered FDC/FFST file and records the first report header:

```bash
python3 mq-diagnostic-header-index.py --output-dir ./osi-fdc-index
```

This is the recommended first pass because I/O is bounded even when a retained file is very large.

Some files contain multiple appended reports. Use the full sequential scan only in an approved low-impact window:

```bash
python3 mq-diagnostic-header-index.py --all-reports --output-dir ./osi-fdc-index
```

The all-report scan copies no diagnostic body, but it reads every byte of each discovered file. When the entire source file is read, its SHA-256 is recorded in the file inventory without a second pass.

## Discovery and outputs

The tool searches `/var/mqm`, queue-manager `DataPath` roots from `/var/mqm/mqs.ini`, and optional repeated `--root` paths. Symlinked files and directories are not followed.

The transfer package contains:

- `reports.ndjson` with the complete parsed header field map;
- `reports.csv` with selected high-value fields;
- `signature-summary.csv` grouping recurring probe/component/program/queue-manager/error/object signatures;
- `files.csv` with source path, size, mtime, reports found, bytes read, status and optional full-file SHA-256;
- `summary.json`, `manifest.properties`, and package checksums.

Useful normalized fields include date/time, UTC time, host, MQ level, queue manager, probe ID, component, program, last object name, major/minor error code, probe type/severity/description, and comments.

## Evidence semantics

A recurring diagnostic signature is discovery evidence only. It is not automatically an OSI Finding, a current-health statement, or proof of root cause. Candidate episodes still require correlation with canonical identity, topology or route context, runtime/findings, and recovery or change evidence when those claims are made.

Run first-report mode on every physical MQ host after the historical inventory pass. Use all-report mode only where appended-report enumeration is worth the additional read I/O.
