interface Env {
  DB: D1Database;
  EVIDENCE: R2Bucket;
  ASSETS: Fetcher;
}

type RelationshipSource = "observed" | "configured" | "inferred";
type JsonMap = Record<string, unknown>;

interface TopologyNodeInput {
  id?: string;
  type: string;
  name: string;
  environment?: string;
  scope?: string;
  status?: string | null;
  metadata?: JsonMap;
}

interface TopologyEdgeInput {
  id?: string;
  source: string;
  relationship: string;
  target: string;
  relationship_source: RelationshipSource;
  confidence?: number;
  evidence?: string | null;
  metadata?: JsonMap;
}

interface DiscoveryInfo {
  collector: string;
  collector_version?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  source_host?: string | null;
  notes?: string[];
}

interface TopologySnapshotInput {
  schema_version?: string;
  snapshot_id?: string;
  created_at?: string;
  environment?: string;
  discovery: DiscoveryInfo;
  nodes: TopologyNodeInput[];
  edges: TopologyEdgeInput[];
}

interface TopologyNode extends Required<Pick<TopologyNodeInput, "id" | "type" | "name" | "environment" | "scope" | "metadata">> {
  status: string | null;
}

interface TopologyEdge extends Required<Pick<TopologyEdgeInput, "id" | "source" | "relationship" | "target" | "relationship_source" | "confidence" | "metadata">> {
  evidence: string | null;
}

interface TopologySnapshot {
  schema_version: string;
  snapshot_id: string;
  created_at: string;
  environment: string;
  discovery: DiscoveryInfo;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: jsonHeaders });
}

function asObject(value: unknown, label: string): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  return value as JsonMap;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function stableNodeId(type: string, environment: string, scope: string, name: string): Promise<string> {
  return `n_${(await sha256Hex(`${type}|${environment}|${scope}|${name}`)).slice(0, 20)}`;
}

async function stableEdgeId(source: string, relationship: string, target: string): Promise<string> {
  return `e_${(await sha256Hex(`${source}|${relationship}|${target}`)).slice(0, 20)}`;
}

async function normalizeSnapshot(raw: unknown): Promise<TopologySnapshot> {
  const input = asObject(raw, "snapshot") as unknown as TopologySnapshotInput;
  if (!input.discovery || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) {
    throw new HttpError(400, "snapshot requires discovery, nodes, and edges");
  }

  const discoveryObj = asObject(input.discovery, "discovery");
  const discovery: DiscoveryInfo = {
    ...input.discovery,
    collector: requiredString(discoveryObj.collector, "discovery.collector"),
    notes: Array.isArray(input.discovery.notes) ? input.discovery.notes.map(String) : [],
  };

  const environment = optionalString(input.environment, "default");
  const nodes: TopologyNode[] = [];
  const nodeIds = new Set<string>();

  for (let i = 0; i < input.nodes.length; i++) {
    const rawNode = asObject(input.nodes[i], `nodes[${i}]`) as unknown as TopologyNodeInput;
    const type = requiredString(rawNode.type, `nodes[${i}].type`);
    const name = requiredString(rawNode.name, `nodes[${i}].name`);
    const nodeEnvironment = optionalString(rawNode.environment, environment);
    const scope = optionalString(rawNode.scope, "global");
    const id = rawNode.id ? requiredString(rawNode.id, `nodes[${i}].id`) : await stableNodeId(type, nodeEnvironment, scope, name);
    if (nodeIds.has(id)) throw new HttpError(400, `duplicate node id: ${id}`);
    nodeIds.add(id);
    nodes.push({
      id,
      type,
      name,
      environment: nodeEnvironment,
      scope,
      status: typeof rawNode.status === "string" ? rawNode.status : null,
      metadata: rawNode.metadata && typeof rawNode.metadata === "object" && !Array.isArray(rawNode.metadata) ? rawNode.metadata : {},
    });
  }

  const edges: TopologyEdge[] = [];
  const edgeIds = new Set<string>();
  const allowedSources = new Set<RelationshipSource>(["observed", "configured", "inferred"]);

  for (let i = 0; i < input.edges.length; i++) {
    const rawEdge = asObject(input.edges[i], `edges[${i}]`) as unknown as TopologyEdgeInput;
    const source = requiredString(rawEdge.source, `edges[${i}].source`);
    const relationship = requiredString(rawEdge.relationship, `edges[${i}].relationship`);
    const target = requiredString(rawEdge.target, `edges[${i}].target`);
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      throw new HttpError(400, `dangling edge at edges[${i}]: ${source} -> ${target}`);
    }
    if (!allowedSources.has(rawEdge.relationship_source)) {
      throw new HttpError(400, `edges[${i}].relationship_source must be observed, configured, or inferred`);
    }
    const confidence = rawEdge.confidence ?? 1;
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
      throw new HttpError(400, `edges[${i}].confidence must be between 0 and 1`);
    }
    const id = rawEdge.id ? requiredString(rawEdge.id, `edges[${i}].id`) : await stableEdgeId(source, relationship, target);
    if (edgeIds.has(id)) throw new HttpError(400, `duplicate edge id: ${id}`);
    edgeIds.add(id);
    edges.push({
      id,
      source,
      relationship,
      target,
      relationship_source: rawEdge.relationship_source,
      confidence,
      evidence: typeof rawEdge.evidence === "string" ? rawEdge.evidence : null,
      metadata: rawEdge.metadata && typeof rawEdge.metadata === "object" && !Array.isArray(rawEdge.metadata) ? rawEdge.metadata : {},
    });
  }

  const createdAt = input.created_at ? new Date(input.created_at) : new Date();
  if (Number.isNaN(createdAt.getTime())) throw new HttpError(400, "created_at must be a valid date/time");
  const created_at = createdAt.toISOString();
  const schema_version = optionalString(input.schema_version, "1.0");
  const digestSource = [...nodeIds, ...edgeIds].sort().join("|");
  const digest = (await sha256Hex(digestSource)).slice(0, 10);
  const stamp = created_at.replace(/[-:.]/g, "").replace("000Z", "Z");
  const snapshot_id = input.snapshot_id ? requiredString(input.snapshot_id, "snapshot_id") : `snap_${stamp}_${digest}`;

  return { schema_version, snapshot_id, created_at, environment, discovery, nodes, edges };
}

async function activeSnapshotId(db: D1Database): Promise<string | null> {
  const row = await db.prepare(
    "SELECT snapshot_id FROM topology_snapshot WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1"
  ).first<{ snapshot_id: string }>();
  return row?.snapshot_id ?? null;
}

async function snapshotExists(db: D1Database, snapshotId: string): Promise<boolean> {
  const row = await db.prepare("SELECT snapshot_id FROM topology_snapshot WHERE snapshot_id = ? LIMIT 1")
    .bind(snapshotId)
    .first();
  return Boolean(row);
}

async function runBatchChunks(db: D1Database, statements: D1PreparedStatement[], size = 100): Promise<void> {
  for (let i = 0; i < statements.length; i += size) {
    await db.batch(statements.slice(i, i + size));
  }
}

async function saveAndActivate(env: Env, snapshot: TopologySnapshot): Promise<{ previous_snapshot_id: string | null }> {
  if (await snapshotExists(env.DB, snapshot.snapshot_id)) {
    throw new HttpError(409, `snapshot already exists: ${snapshot.snapshot_id}`);
  }

  const previous = await activeSnapshotId(env.DB);
  const evidenceKey = `snapshots/${snapshot.snapshot_id}/topology.json`;
  const serialized = JSON.stringify(snapshot, null, 2);
  await env.EVIDENCE.put(evidenceKey, serialized, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { snapshot_id: snapshot.snapshot_id, environment: snapshot.environment },
  });

  await env.DB.prepare(
    `INSERT INTO topology_snapshot
      (snapshot_id, schema_version, created_at, imported_at, environment, status, is_active,
       node_count, edge_count, discovery_json, evidence_key)
     VALUES (?, ?, ?, ?, ?, 'STAGING', 0, ?, ?, ?, ?)`
  ).bind(
    snapshot.snapshot_id,
    snapshot.schema_version,
    snapshot.created_at,
    new Date().toISOString(),
    snapshot.environment,
    snapshot.nodes.length,
    snapshot.edges.length,
    JSON.stringify(snapshot.discovery),
    evidenceKey,
  ).run();

  try {
    const nodeStatements = snapshot.nodes.map((node) => env.DB.prepare(
      `INSERT INTO topology_node
       (snapshot_id, node_id, node_type, name, environment, scope, status, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(snapshot.snapshot_id, node.id, node.type, node.name, node.environment, node.scope, node.status, JSON.stringify(node.metadata)));

    const edgeStatements = snapshot.edges.map((edge) => env.DB.prepare(
      `INSERT INTO topology_edge
       (snapshot_id, edge_id, source_node_id, relationship_type, target_node_id,
        relationship_source, confidence, evidence, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      snapshot.snapshot_id,
      edge.id,
      edge.source,
      edge.relationship,
      edge.target,
      edge.relationship_source,
      edge.confidence,
      edge.evidence,
      JSON.stringify(edge.metadata),
    ));

    await runBatchChunks(env.DB, nodeStatements);
    await runBatchChunks(env.DB, edgeStatements);

    const nodeCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM topology_node WHERE snapshot_id = ?")
      .bind(snapshot.snapshot_id).first<{ count: number }>();
    const edgeCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM topology_edge WHERE snapshot_id = ?")
      .bind(snapshot.snapshot_id).first<{ count: number }>();
    if (Number(nodeCount?.count ?? -1) !== snapshot.nodes.length || Number(edgeCount?.count ?? -1) !== snapshot.edges.length) {
      throw new Error("persisted topology counts do not match validated snapshot");
    }

    await env.DB.batch([
      env.DB.prepare("UPDATE topology_snapshot SET is_active = 0 WHERE is_active = 1"),
      env.DB.prepare("UPDATE topology_snapshot SET status = 'SUCCESS', is_active = 1 WHERE snapshot_id = ?")
        .bind(snapshot.snapshot_id),
    ]);
  } catch (error) {
    await env.DB.prepare("UPDATE topology_snapshot SET status = 'FAILED', is_active = 0 WHERE snapshot_id = ?")
      .bind(snapshot.snapshot_id).run();
    throw error;
  }

  return { previous_snapshot_id: previous };
}

async function loadSnapshot(db: D1Database, snapshotId?: string | null): Promise<unknown | null> {
  const sid = snapshotId ?? await activeSnapshotId(db);
  if (!sid) return null;
  const snapshot = await db.prepare("SELECT * FROM topology_snapshot WHERE snapshot_id = ?").bind(sid).first<Record<string, unknown>>();
  if (!snapshot) return null;
  const nodes = await db.prepare("SELECT * FROM topology_node WHERE snapshot_id = ? ORDER BY node_type, name").bind(sid).all<Record<string, unknown>>();
  const edges = await db.prepare("SELECT * FROM topology_edge WHERE snapshot_id = ? ORDER BY relationship_type").bind(sid).all<Record<string, unknown>>();

  return {
    schema_version: snapshot.schema_version,
    snapshot_id: sid,
    created_at: snapshot.created_at,
    environment: snapshot.environment,
    active: Boolean(snapshot.is_active),
    status: snapshot.status,
    discovery: JSON.parse(String(snapshot.discovery_json)),
    nodes: nodes.results.map((row) => ({
      id: row.node_id,
      type: row.node_type,
      name: row.name,
      environment: row.environment,
      scope: row.scope,
      status: row.status,
      metadata: JSON.parse(String(row.metadata_json)),
    })),
    edges: edges.results.map((row) => ({
      id: row.edge_id,
      source: row.source_node_id,
      relationship: row.relationship_type,
      target: row.target_node_id,
      relationship_source: row.relationship_source,
      confidence: row.confidence,
      evidence: row.evidence,
      metadata: JSON.parse(String(row.metadata_json)),
    })),
  };
}

async function searchTopology(db: D1Database, query: string, limit: number): Promise<unknown[]> {
  const sid = await activeSnapshotId(db);
  if (!sid) return [];
  const like = `%${query}%`;
  const result = await db.prepare(
    `SELECT node_id, node_type, name, environment, scope, status, metadata_json
     FROM topology_node
     WHERE snapshot_id = ? AND (name LIKE ? OR metadata_json LIKE ?)
     ORDER BY node_type, name LIMIT ?`
  ).bind(sid, like, like, limit).all<Record<string, unknown>>();
  return result.results.map((row) => ({
    id: row.node_id,
    type: row.node_type,
    name: row.name,
    environment: row.environment,
    scope: row.scope,
    status: row.status,
    metadata: JSON.parse(String(row.metadata_json)),
  }));
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/health") {
    try {
      return json({ status: "ok", active_snapshot_id: await activeSnapshotId(env.DB) });
    } catch (error) {
      return json({ status: "degraded", message: "Database is not initialized", detail: String(error) }, 503);
    }
  }

  if (request.method === "GET" && path === "/api/v1/topology/current") {
    const topology = await loadSnapshot(env.DB);
    return topology ? json(topology) : json({ detail: "No active topology snapshot" }, 404);
  }

  if (request.method === "GET" && path === "/api/v1/topology/search") {
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) throw new HttpError(400, "q is required");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
    return json({ query: q, results: await searchTopology(env.DB, q, limit) });
  }

  if (request.method === "GET" && path === "/api/v1/snapshots") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 100);
    const result = await env.DB.prepare(
      `SELECT snapshot_id, created_at, imported_at, environment, status, is_active, node_count, edge_count, evidence_key
       FROM topology_snapshot ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();
    return json({ snapshots: result.results });
  }

  if (request.method === "POST" && path === "/api/v1/topology/import") {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new HttpError(415, "Upload a normalized topology JSON document with Content-Type: application/json");
    }
    const raw = await request.json();
    const snapshot = await normalizeSnapshot(raw);
    const previous = await saveAndActivate(env, snapshot);
    return json({
      status: "SUCCESS",
      snapshot_id: snapshot.snapshot_id,
      previous_snapshot_id: previous.previous_snapshot_id,
      node_count: snapshot.nodes.length,
      edge_count: snapshot.edges.length,
      message: "Snapshot validated, stored as evidence, indexed, and activated.",
    }, 201);
  }

  const subgraphMatch = path.match(/^\/api\/v1\/topology\/subgraph\/([^/]+)$/);
  if (request.method === "GET" && subgraphMatch) {
    const topology = await loadSnapshot(env.DB) as any;
    if (!topology) throw new HttpError(404, "No active topology snapshot");
    const nodeId = decodeURIComponent(subgraphMatch[1]);
    const depth = Math.min(Math.max(Number(url.searchParams.get("depth") ?? 1), 0), 6);
    const byId = new Map(topology.nodes.map((node: any) => [node.id, node]));
    if (!byId.has(nodeId)) throw new HttpError(404, "Node not found");
    const selected = new Set<string>([nodeId]);
    let frontier = new Set<string>([nodeId]);
    for (let i = 0; i < depth && frontier.size; i++) {
      const next = new Set<string>();
      for (const edge of topology.edges) {
        if (frontier.has(edge.source)) next.add(edge.target);
        if (frontier.has(edge.target)) next.add(edge.source);
      }
      for (const id of selected) next.delete(id);
      next.forEach((id) => selected.add(id));
      frontier = next;
    }
    return json({
      snapshot_id: topology.snapshot_id,
      root: nodeId,
      depth,
      nodes: topology.nodes.filter((node: any) => selected.has(node.id)),
      edges: topology.edges.filter((edge: any) => selected.has(edge.source) && selected.has(edge.target)),
    });
  }

  return json({ detail: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health" || path.startsWith("/api/")) {
        return await handleApi(request, env);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ detail: error.message, errors: error.details ?? null }, error.status);
      }
      console.error(error);
      return json({ detail: "Internal server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
