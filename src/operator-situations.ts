type JsonMap = Record<string, any>;

function severityRank(value: unknown): number {
  const severity = String(value || "").toLowerCase();
  if (severity === "critical") return 0;
  if (severity === "warning") return 1;
  return 2;
}

function lastSeenMillis(value: unknown): number {
  const time = new Date(String(value || "")).getTime();
  return Number.isFinite(time) ? time : 0;
}

const ACTIVE_FINDING_CTE = `WITH ranked AS (
  SELECT f.finding_id, f.rule_id, f.entity_id, f.semantic_type, f.display_name, f.severity,
         f.summary, f.diagnosis, f.first_seen, f.last_seen, f.coverage_state,
         COALESCE(s.status, 'OPEN') AS status,
         ROW_NUMBER() OVER (
           PARTITION BY f.finding_id
           ORDER BY f.last_seen DESC, r.evaluated_at DESC, r.evaluation_revision_id DESC
         ) AS occurrence_rank
    FROM operational_finding_occurrence f
    JOIN operational_evaluation_revision r ON r.evaluation_revision_id = f.evaluation_revision_id
    LEFT JOIN operational_finding_state s ON s.finding_id = f.finding_id
   WHERE r.is_current = 1
     AND COALESCE(s.status, 'OPEN') IN ('OPEN','ACKNOWLEDGED')
), active AS (
  SELECT finding_id, rule_id, entity_id, semantic_type, display_name, severity,
         summary, diagnosis, first_seen, last_seen, coverage_state, status
    FROM ranked
   WHERE occurrence_rank = 1
)`;

export interface OperationalSituationPage {
  total: number;
  items: JsonMap[];
}

export async function activeSituationCount(db: D1Database): Promise<number> {
  const row = await db.prepare(
    `${ACTIVE_FINDING_CTE}
     SELECT COUNT(DISTINCT entity_id) AS count FROM active`
  ).first<JsonMap>();
  return Number(row?.count || 0);
}

async function situationRows(db: D1Database, limit: number, offset: number): Promise<JsonMap[]> {
  const result = await db.prepare(
    `${ACTIVE_FINDING_CTE},
     representative AS (
       SELECT active.*,
              ROW_NUMBER() OVER (
                PARTITION BY entity_id
                ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                         last_seen DESC, finding_id
              ) AS entity_rank
         FROM active
     ), situations AS (
       SELECT entity_id,
              COUNT(*) AS finding_count,
              SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open_findings,
              SUM(CASE WHEN status = 'ACKNOWLEDGED' THEN 1 ELSE 0 END) AS acknowledged_findings,
              MIN(first_seen) AS first_seen,
              MAX(last_seen) AS last_seen,
              MIN(CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END) AS severity_rank
         FROM active
        GROUP BY entity_id
     )
     SELECT s.entity_id, s.finding_count, s.open_findings, s.acknowledged_findings,
            s.first_seen, s.last_seen, s.severity_rank,
            r.finding_id AS focus_finding_id, r.rule_id AS focus_rule_id,
            r.semantic_type, r.display_name, r.severity, r.summary, r.diagnosis, r.coverage_state
       FROM situations s
       JOIN representative r ON r.entity_id = s.entity_id AND r.entity_rank = 1
      ORDER BY s.severity_rank, s.last_seen DESC, lower(r.display_name), s.entity_id
      LIMIT ? OFFSET ?`
  ).bind(limit, offset).all<JsonMap>();
  return result.results ?? [];
}

async function findingsForEntities(db: D1Database, entityIds: string[]): Promise<JsonMap[]> {
  if (!entityIds.length) return [];
  const placeholders = entityIds.map(() => "?").join(",");
  const result = await db.prepare(
    `${ACTIVE_FINDING_CTE}
     SELECT finding_id, rule_id, entity_id, semantic_type, display_name, severity,
            summary, diagnosis, first_seen, last_seen, coverage_state, status
       FROM active
      WHERE entity_id IN (${placeholders})
      ORDER BY entity_id,
               CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
               last_seen DESC, finding_id`
  ).bind(...entityIds).all<JsonMap>();
  return result.results ?? [];
}

function projectMechanisms(findings: JsonMap[]): JsonMap[] {
  const byRule = new Map<string, JsonMap[]>();
  for (const finding of findings) {
    const ruleId = String(finding.rule_id || "unclassified");
    const group = byRule.get(ruleId) || [];
    group.push(finding);
    byRule.set(ruleId, group);
  }
  return [...byRule.entries()].map(([ruleId, group]) => {
    group.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || lastSeenMillis(b.last_seen) - lastSeenMillis(a.last_seen));
    const lead = group[0] || {};
    return {
      rule_id: ruleId,
      severity: lead.severity ?? "info",
      summary: lead.summary ?? lead.diagnosis ?? ruleId,
      finding_count: group.length,
      finding_ids: group.map((item) => item.finding_id),
      last_seen: group.reduce((latest, item) => lastSeenMillis(item.last_seen) > lastSeenMillis(latest) ? item.last_seen : latest, lead.last_seen),
    };
  }).sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || lastSeenMillis(b.last_seen) - lastSeenMillis(a.last_seen));
}

export async function activeSituationPage(db: D1Database, limit: number, offset: number): Promise<OperationalSituationPage> {
  const [total, rows] = await Promise.all([
    activeSituationCount(db),
    situationRows(db, limit, offset),
  ]);
  const entityIds = rows.map((row) => String(row.entity_id || "")).filter(Boolean);
  const findings = await findingsForEntities(db, entityIds);
  const byEntity = new Map<string, JsonMap[]>();
  for (const finding of findings) {
    const entityId = String(finding.entity_id || "");
    const group = byEntity.get(entityId) || [];
    group.push(finding);
    byEntity.set(entityId, group);
  }
  const items = rows.map((row) => {
    const entityId = String(row.entity_id || "");
    const entityFindings = byEntity.get(entityId) || [];
    const mechanisms = projectMechanisms(entityFindings);
    return {
      situation_key: `entity:${entityId}`,
      entity_id: entityId,
      semantic_type: row.semantic_type ?? null,
      display_name: row.display_name ?? entityId,
      severity: row.severity ?? "info",
      coverage_state: row.coverage_state ?? "unknown",
      finding_count: Number(row.finding_count || entityFindings.length),
      open_findings: Number(row.open_findings || 0),
      acknowledged_findings: Number(row.acknowledged_findings || 0),
      first_seen: row.first_seen ?? null,
      last_seen: row.last_seen ?? null,
      focus_finding_id: row.focus_finding_id ?? entityFindings[0]?.finding_id ?? null,
      mechanisms,
      findings: entityFindings,
    };
  });
  return { total, items };
}
