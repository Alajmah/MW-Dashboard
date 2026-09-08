const MAX_GRAPH_NODES = 120;
const MAX_GRAPH_EDGES = 260;
const MAX_TABLE_ROWS = 600;
const FOCUS_DEPTH = 2;

const state = {
  topology: null,
  snapshots: [],
  query: "",
  type: "",
  evidence: new Set(["observed", "configured", "inferred"]),
  selectedId: null,
  focusSelected: false,
};

const typeOrder = ["host", "application", "datapower_service", "qmgr", "queue", "channel", "listener", "ace_flow", "ftp_endpoint", "other"];
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function setUploadStatus(message, kind = "") {
  const el = $("uploadStatus");
  el.textContent = message;
  el.className = `status-line ${kind}`;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function humanDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function ageLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function sortedNodes(nodes) {
  return [...nodes].sort((a, b) => {
    const ai = typeOrder.indexOf(a.type);
    const bi = typeOrder.indexOf(b.type);
    const orderA = ai === -1 ? 999 : ai;
    const orderB = bi === -1 ? 999 : bi;
    return orderA - orderB || natural.compare(a.name, b.name);
  });
}

function evidenceEdges(topology = state.topology) {
  if (!topology) return [];
  return topology.edges.filter((edge) => state.evidence.has(edge.relationship_source));
}

function nodeSearchText(node) {
  return [node.name, node.type, node.environment, node.scope, node.status, JSON.stringify(node.metadata || {})]
    .filter(Boolean).join(" ").toLowerCase();
}

function filteredNodes() {
  if (!state.topology) return [];
  const query = state.query.toLowerCase();
  return sortedNodes(state.topology.nodes.filter((node) => {
    if (state.type && node.type !== state.type) return false;
    return !query || nodeSearchText(node).includes(query);
  }));
}

function neighbors(rootId, depth = FOCUS_DEPTH) {
  if (!state.topology) return new Set();
  const selected = new Set([rootId]);
  let frontier = new Set([rootId]);
  const edges = evidenceEdges();
  for (let i = 0; i < depth && frontier.size; i++) {
    const next = new Set();
    for (const edge of edges) {
      if (frontier.has(edge.source) && !selected.has(edge.target)) next.add(edge.target);
      if (frontier.has(edge.target) && !selected.has(edge.source)) next.add(edge.source);
    }
    next.forEach((id) => selected.add(id));
    frontier = next;
  }
  return selected;
}

function graphSelection() {
  if (!state.topology) return { nodes: [], edges: [], totalNodes: 0, totalEdges: 0, focused: false };
  const filtered = filteredNodes();
  let candidates = filtered;
  let focused = false;

  if (state.focusSelected && state.selectedId) {
    const ids = neighbors(state.selectedId);
    candidates = sortedNodes(state.topology.nodes.filter((node) => ids.has(node.id)));
    focused = true;
  }

  const nodes = candidates.slice(0, MAX_GRAPH_NODES);
  const ids = new Set(nodes.map((node) => node.id));
  const allEdges = evidenceEdges().filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const edges = allEdges.slice(0, MAX_GRAPH_EDGES);
  return { nodes, edges, totalNodes: candidates.length, totalEdges: allEdges.length, focused };
}

function renderStats(topology) {
  const counts = new Map();
  topology.nodes.forEach((node) => counts.set(node.type, (counts.get(node.type) || 0) + 1));
  const observed = topology.edges.filter((edge) => edge.relationship_source === "observed").length;
  const cards = [
    ["Objects", topology.nodes.length, "current snapshot"],
    ["Relationships", topology.edges.length, `${observed} observed`],
    ["Queue managers", counts.get("qmgr") || 0, "local + discovered"],
    ["Queues", counts.get("queue") || 0, "all queue types"],
    ["Applications", counts.get("application") || 0, "observed/configured"],
    ["Hosts & endpoints", counts.get("host") || 0, "addressable systems"],
  ];
  $("stats").innerHTML = cards.map(([label, value, note]) => `
    <article class="stat"><span>${escapeHtml(label)}</span><strong>${Number(value).toLocaleString()}</strong><small>${escapeHtml(note)}</small></article>
  `).join("");
}

function populateTypeFilter(topology) {
  const types = [...new Set(topology.nodes.map((node) => node.type))].sort((a, b) => natural.compare(a, b));
  $("typeFilter").innerHTML = `<option value="">All object types</option>${types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type.replaceAll("_", " "))}</option>`).join("")}`;
}

function statusClass(status) {
  return String(status || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function renderRows() {
  const nodes = filteredNodes();
  $("filteredCount").textContent = `${nodes.length.toLocaleString()} object${nodes.length === 1 ? "" : "s"}`;
  $("resultsTitle").textContent = state.query || state.type ? "Filtered objects" : "Topology objects";
  const visible = nodes.slice(0, MAX_TABLE_ROWS);
  $("resultCount").textContent = nodes.length > MAX_TABLE_ROWS
    ? `Showing ${MAX_TABLE_ROWS.toLocaleString()} of ${nodes.length.toLocaleString()}`
    : `${nodes.length.toLocaleString()} object${nodes.length === 1 ? "" : "s"}`;
  $("resultRows").innerHTML = visible.map((node) => `
    <tr data-node-id="${escapeHtml(node.id)}" tabindex="0" class="${state.selectedId === node.id ? "selected" : ""}">
      <td><span class="type-pill">${escapeHtml(node.type)}</span></td>
      <td><strong>${escapeHtml(node.name)}</strong></td>
      <td>${escapeHtml(node.environment || "—")}</td>
      <td>${escapeHtml(node.scope || "—")}</td>
      <td><span class="status-pill ${escapeHtml(statusClass(node.status))}">${escapeHtml(node.status || "—")}</span></td>
    </tr>`).join("");

  $("resultRows").querySelectorAll("tr[data-node-id]").forEach((row) => {
    const select = () => selectNode(row.dataset.nodeId, true);
    row.addEventListener("click", select);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
    });
  });
}

function renderGraph() {
  const svg = $("graph");
  const empty = $("emptyState");
  if (!state.topology || !state.topology.nodes.length) {
    svg.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const { nodes, edges, totalNodes, totalEdges, focused } = graphSelection();
  if (!nodes.length) {
    svg.innerHTML = "";
    empty.hidden = false;
    empty.innerHTML = `<strong>No matching objects</strong><span>Adjust the search or object type filter.</span>`;
    $("graphLimit").textContent = "";
    return;
  }

  $("showOverview").hidden = !focused;
  $("graphTitle").textContent = focused && state.selectedId ? "Focused neighborhood" : "Topology overview";
  $("graphHint").textContent = focused ? `${FOCUS_DEPTH}-hop neighborhood around the selected object.` : "Select an object to inspect its neighborhood.";
  const limits = [];
  if (totalNodes > nodes.length) limits.push(`${nodes.length}/${totalNodes} objects`);
  if (totalEdges > edges.length) limits.push(`${edges.length}/${totalEdges} relationships`);
  $("graphLimit").textContent = limits.length ? `Graph limited to ${limits.join(" · ")}` : `${nodes.length} objects · ${edges.length} relationships`;

  const groups = new Map();
  nodes.forEach((node) => {
    if (!groups.has(node.type)) groups.set(node.type, []);
    groups.get(node.type).push(node);
  });
  const orderedTypes = [...groups.keys()].sort((a, b) => {
    const ai = typeOrder.indexOf(a), bi = typeOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || natural.compare(a, b);
  });
  const width = Math.max(1050, orderedTypes.length * 205);
  const maxRows = Math.max(...[...groups.values()].map((group) => group.length));
  const height = Math.max(500, maxRows * 68 + 110);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const positions = new Map();
  orderedTypes.forEach((type, col) => {
    const group = groups.get(type);
    const x = 112 + col * ((width - 224) / Math.max(orderedTypes.length - 1, 1));
    group.forEach((node, row) => positions.set(node.id, { x, y: 86 + row * 68 }));
  });

  const incident = new Set();
  if (state.selectedId) {
    edges.forEach((edge) => { if (edge.source === state.selectedId || edge.target === state.selectedId) incident.add(edge.id); });
  }

  const defs = `<defs>
    <marker id="arrowObserved" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#64d7a4" opacity=".7"/></marker>
    <marker id="arrowConfigured" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#d0a7ff" opacity=".7"/></marker>
    <marker id="arrowInferred" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#f4bd67" opacity=".6"/></marker>
  </defs>`;

  const labels = orderedTypes.map((type, col) => {
    const x = 112 + col * ((width - 224) / Math.max(orderedTypes.length - 1, 1));
    return `<text class="graph-column-label" text-anchor="middle" x="${x}" y="34">${escapeHtml(type.replaceAll("_", " "))} · ${groups.get(type).length}</text>`;
  }).join("");

  const edgeSvg = edges.map((edge) => {
    const a = positions.get(edge.source), b = positions.get(edge.target);
    if (!a || !b) return "";
    const highlight = incident.has(edge.id) ? " highlight" : "";
    return `<line class="edge ${escapeHtml(edge.relationship_source)}${highlight}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"><title>${escapeHtml(edge.relationship)} · ${escapeHtml(edge.relationship_source)} · confidence ${escapeHtml(edge.confidence)}</title></line>`;
  }).join("");

  const nodeSvg = nodes.map((node) => {
    const p = positions.get(node.id);
    const name = node.name.length > 23 ? `${node.name.slice(0, 21)}…` : node.name;
    return `<g class="graph-node ${state.selectedId === node.id ? "selected" : ""}" data-node-id="${escapeHtml(node.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button">
      <rect x="-75" y="-22" width="150" height="44" rx="9"></rect>
      <text text-anchor="middle" y="-2">${escapeHtml(name)}</text>
      <text class="node-type" text-anchor="middle" y="13">${escapeHtml(node.type)}</text>
      <title>${escapeHtml(node.name)} · ${escapeHtml(node.type)} · ${escapeHtml(node.scope)}</title>
    </g>`;
  }).join("");

  svg.innerHTML = `${defs}${labels}${edgeSvg}${nodeSvg}`;
  svg.querySelectorAll(".graph-node[data-node-id]").forEach((node) => {
    const select = () => selectNode(node.dataset.nodeId, true);
    node.addEventListener("click", select);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
    });
  });
}

function connectedRelationships(nodeId) {
  if (!state.topology) return [];
  const byId = new Map(state.topology.nodes.map((node) => [node.id, node]));
  return evidenceEdges().filter((edge) => edge.source === nodeId || edge.target === nodeId).map((edge) => {
    const outgoing = edge.source === nodeId;
    const otherId = outgoing ? edge.target : edge.source;
    return { edge, outgoing, other: byId.get(otherId), otherId };
  }).sort((a, b) => natural.compare(a.edge.relationship, b.edge.relationship) || natural.compare(a.other?.name || "", b.other?.name || ""));
}

function renderDetail() {
  if (!state.topology || !state.selectedId) {
    $("detailEmpty").hidden = false;
    $("detailContent").hidden = true;
    return;
  }
  const node = state.topology.nodes.find((item) => item.id === state.selectedId);
  if (!node) return clearSelection();
  $("detailEmpty").hidden = true;
  $("detailContent").hidden = false;
  $("detailType").textContent = node.type;
  $("detailName").textContent = node.name;
  $("detailContext").textContent = `${node.environment || "default"} · ${node.scope || "global"}`;

  const relationships = connectedRelationships(node.id);
  const facts = [
    ["Status", node.status || "—"],
    ["Relationships", relationships.length],
    ["Environment", node.environment || "—"],
    ["Scope", node.scope || "—"],
  ];
  $("detailFacts").innerHTML = facts.map(([label, value]) => `<div class="fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  $("relationshipCount").textContent = relationships.length.toLocaleString();
  $("relationshipList").innerHTML = relationships.length ? relationships.slice(0, 100).map(({ edge, outgoing, other, otherId }) => `
    <div class="relationship" data-node-id="${escapeHtml(otherId)}" tabindex="0">
      <div class="relationship-arrow">${outgoing ? "→" : "←"}</div>
      <div>
        <strong>${escapeHtml(other?.name || otherId)}</strong>
        <small><span>${escapeHtml(edge.relationship)}</span><span class="evidence-pill ${escapeHtml(edge.relationship_source)}">${escapeHtml(edge.relationship_source)}</span><span>${Math.round(Number(edge.confidence ?? 1) * 100)}%</span></small>
      </div>
    </div>`).join("") : `<p class="quiet">No relationships match the active evidence filters.</p>`;

  $("relationshipList").querySelectorAll(".relationship[data-node-id]").forEach((row) => {
    const select = () => selectNode(row.dataset.nodeId, true);
    row.addEventListener("click", select);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
  });

  const metadata = Object.entries(node.metadata || {}).sort(([a], [b]) => natural.compare(a, b));
  $("metadataList").innerHTML = metadata.length ? metadata.map(([key, value]) => `
    <div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</dd></div>
  `).join("") : `<div><dt>Metadata</dt><dd>None supplied</dd></div>`;
}

function selectNode(nodeId, focus = false) {
  state.selectedId = nodeId;
  if (focus) state.focusSelected = true;
  renderRows();
  renderDetail();
  renderGraph();
}

function clearSelection() {
  state.selectedId = null;
  state.focusSelected = false;
  renderRows();
  renderDetail();
  renderGraph();
}

function renderTopology(topology) {
  state.topology = topology;
  state.selectedId = null;
  state.focusSelected = false;
  $("snapshotBadge").textContent = topology.snapshot_id;
  $("snapshotBadge").closest(".snapshot-state").classList.add("active");
  const created = humanDate(topology.created_at);
  const age = ageLabel(topology.created_at);
  $("topologyMeta").textContent = `${topology.environment} · ${created}${age ? ` (${age})` : ""} · collector: ${topology.discovery?.collector || "unknown"}`;
  renderStats(topology);
  populateTypeFilter(topology);
  renderRows();
  renderDetail();
  renderGraph();
}

function renderSnapshots() {
  const items = state.snapshots || [];
  $("snapshotCount").textContent = `${items.length} recent`;
  if (!items.length) {
    $("snapshotList").innerHTML = `<div class="snapshot-row"><span>No snapshots recorded yet.</span></div>`;
    return;
  }
  $("snapshotList").innerHTML = items.map((item) => `
    <div class="snapshot-row ${item.is_active ? "active" : ""}">
      <strong title="${escapeHtml(item.snapshot_id)}">${escapeHtml(item.snapshot_id)}</strong>
      <span>${escapeHtml(humanDate(item.imported_at || item.created_at))}</span>
      <span>${Number(item.node_count || 0).toLocaleString()} objects</span>
      <span>${Number(item.edge_count || 0).toLocaleString()} relationships</span>
      <span class="${item.is_active ? "snapshot-active" : ""}">${item.is_active ? "Active" : escapeHtml(item.status || "Stored")}</span>
    </div>`).join("");
}

async function loadCurrent() {
  try {
    const topology = await api("/api/v1/topology/current");
    renderTopology(topology);
  } catch (error) {
    if (String(error.message).includes("No active topology")) return;
    setUploadStatus(error.message, "error");
  }
}

async function loadSnapshots() {
  try {
    const result = await api("/api/v1/snapshots?limit=8");
    state.snapshots = result.snapshots || [];
    renderSnapshots();
  } catch (error) {
    $("snapshotList").innerHTML = `<div class="snapshot-row"><span>Could not load snapshot history: ${escapeHtml(error.message)}</span></div>`;
  }
}

function applyFilters() {
  state.query = $("searchInput").value.trim();
  state.type = $("typeFilter").value;
  state.focusSelected = false;
  renderRows();
  renderGraph();
}

$("searchInput").addEventListener("input", applyFilters);
$("typeFilter").addEventListener("change", applyFilters);
[["showObserved", "observed"], ["showConfigured", "configured"], ["showInferred", "inferred"]].forEach(([id, source]) => {
  $(id).addEventListener("change", (event) => {
    event.target.checked ? state.evidence.add(source) : state.evidence.delete(source);
    renderGraph();
    renderDetail();
  });
});

$("clearFilters").addEventListener("click", () => {
  $("searchInput").value = "";
  $("typeFilter").value = "";
  ["showObserved", "showConfigured", "showInferred"].forEach((id) => { $(id).checked = true; });
  state.query = "";
  state.type = "";
  state.evidence = new Set(["observed", "configured", "inferred"]);
  state.focusSelected = false;
  renderRows(); renderGraph(); renderDetail();
});

$("showOverview").addEventListener("click", () => {
  state.focusSelected = false;
  renderGraph();
});
$("closeDetail").addEventListener("click", clearSelection);
$("jumpImport").addEventListener("click", () => {
  $("importSection").open = true;
  $("importSection").scrollIntoView({ behavior: "smooth", block: "start" });
});

$("topologyFile").addEventListener("change", () => {
  const file = $("topologyFile").files[0];
  $("fileHint").textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB` : "No file selected";
});

$("uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("topologyFile").files[0];
  if (!file) return;
  const button = $("uploadButton");
  button.disabled = true;
  setUploadStatus(`Validating and importing ${file.name}…`, "working");
  try {
    const result = await api("/api/v1/topology/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: file,
    });
    setUploadStatus(`Activated ${result.snapshot_id}: ${Number(result.node_count).toLocaleString()} objects, ${Number(result.edge_count).toLocaleString()} relationships.`, "success");
    $("topologyFile").value = "";
    $("fileHint").textContent = "No file selected";
    await Promise.all([loadCurrent(), loadSnapshots()]);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    setUploadStatus(`Import rejected: ${error.message}. Existing topology was preserved.`, "error");
  } finally {
    button.disabled = false;
  }
});

Promise.all([loadCurrent(), loadSnapshots()]);
