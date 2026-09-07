const state = { topology: null, results: [] };
const typeOrder = ["host", "application", "datapower_service", "qmgr", "queue", "channel", "ace_flow", "ftp_endpoint", "other"];

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

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

function renderStats(topology) {
  const counts = new Map();
  topology.nodes.forEach((node) => counts.set(node.type, (counts.get(node.type) || 0) + 1));
  const cards = [
    ["Nodes", topology.nodes.length],
    ["Relationships", topology.edges.length],
    ["Queue managers", counts.get("qmgr") || 0],
    ["Queues", counts.get("queue") || 0],
    ["Applications", counts.get("application") || 0],
    ["Hosts", counts.get("host") || 0],
  ];
  $("stats").innerHTML = cards.map(([label, value]) => `<article class="stat"><span>${escapeHtml(label)}</span><strong>${value}</strong></article>`).join("");
}

function renderRows(nodes, title = "Topology objects") {
  $("resultsTitle").textContent = title;
  $("resultCount").textContent = `${nodes.length} object${nodes.length === 1 ? "" : "s"}`;
  $("resultRows").innerHTML = nodes.slice(0, 500).map((node) => `
    <tr data-node-id="${escapeHtml(node.id)}">
      <td><span class="type-pill">${escapeHtml(node.type)}</span></td>
      <td><strong>${escapeHtml(node.name)}</strong></td>
      <td>${escapeHtml(node.environment)}</td>
      <td>${escapeHtml(node.scope)}</td>
      <td>${escapeHtml(node.status || "—")}</td>
    </tr>`).join("");
}

function renderGraph(topology) {
  const svg = $("graph");
  const empty = $("emptyState");
  if (!topology.nodes.length) {
    svg.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const nodes = topology.nodes.slice(0, 120);
  const nodeSet = new Set(nodes.map((n) => n.id));
  const edges = topology.edges.filter((e) => nodeSet.has(e.source) && nodeSet.has(e.target)).slice(0, 240);
  const groups = new Map();
  nodes.forEach((node) => {
    if (!groups.has(node.type)) groups.set(node.type, []);
    groups.get(node.type).push(node);
  });
  const orderedTypes = [...groups.keys()].sort((a, b) => {
    const ai = typeOrder.indexOf(a); const bi = typeOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.localeCompare(b);
  });
  const width = Math.max(1100, orderedTypes.length * 220);
  const maxRows = Math.max(...[...groups.values()].map((group) => group.length));
  const height = Math.max(460, maxRows * 78 + 100);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const positions = new Map();
  orderedTypes.forEach((type, col) => {
    const group = groups.get(type);
    const x = 120 + col * ((width - 240) / Math.max(orderedTypes.length - 1, 1));
    group.forEach((node, row) => positions.set(node.id, { x, y: 80 + row * 78 }));
  });

  const edgeSvg = edges.map((edge) => {
    const a = positions.get(edge.source); const b = positions.get(edge.target);
    if (!a || !b) return "";
    return `<line class="edge ${escapeHtml(edge.relationship_source)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"><title>${escapeHtml(edge.relationship)} · ${escapeHtml(edge.relationship_source)}</title></line>`;
  }).join("");

  const nodeSvg = nodes.map((node) => {
    const p = positions.get(node.id);
    const name = node.name.length > 24 ? `${node.name.slice(0, 22)}…` : node.name;
    return `<g class="graph-node" transform="translate(${p.x},${p.y})">
      <rect x="-78" y="-24" width="156" height="48" rx="9"></rect>
      <text text-anchor="middle" y="-3">${escapeHtml(name)}</text>
      <text class="node-type" text-anchor="middle" y="14">${escapeHtml(node.type)}</text>
      <title>${escapeHtml(node.name)} · ${escapeHtml(node.type)} · ${escapeHtml(node.scope)}</title>
    </g>`;
  }).join("");

  svg.innerHTML = `${edgeSvg}${nodeSvg}`;
}

function renderTopology(topology) {
  state.topology = topology;
  state.results = topology.nodes;
  $("snapshotBadge").textContent = topology.snapshot_id;
  $("topologyMeta").textContent = `Environment: ${topology.environment} · Created: ${new Date(topology.created_at).toLocaleString()} · ${topology.discovery.collector}`;
  renderStats(topology);
  renderGraph(topology);
  renderRows(topology.nodes);
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

$("uploadForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("topologyFile").files[0];
  if (!file) return;
  setUploadStatus(`Validating and importing ${file.name}…`, "working");
  try {
    const result = await api("/api/v1/topology/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: file,
    });
    setUploadStatus(`Activated ${result.snapshot_id}: ${result.node_count} nodes, ${result.edge_count} relationships.`, "success");
    $("topologyFile").value = "";
    await loadCurrent();
  } catch (error) {
    setUploadStatus(`Import rejected: ${error.message}. Existing topology was preserved.`, "error");
  }
});

$("searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const q = $("searchInput").value.trim();
  if (!q) return;
  try {
    const result = await api(`/api/v1/topology/search?q=${encodeURIComponent(q)}`);
    state.results = result.results;
    renderRows(result.results, `Search: ${q}`);
  } catch (error) {
    setUploadStatus(error.message, "error");
  }
});

$("clearSearch").addEventListener("click", () => {
  $("searchInput").value = "";
  if (state.topology) renderRows(state.topology.nodes);
});

loadCurrent();
