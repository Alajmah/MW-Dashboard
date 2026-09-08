const ROUTE_ELIGIBLE_TYPES = new Set(["application", "queue"]);
const DELIVERY_RELATIONSHIPS = new Set(["PUTS_TO", "CONSUMED_BY", "ALIASES_TO"]);
const EVIDENCE_ORDER = { observed: 0, configured: 1, inferred: 2 };

const routeState = {
  topology: null,
  byId: new Map(),
  incoming: new Map(),
  outgoing: new Map(),
  qmgrByName: new Map(),
  fromId: null,
  toId: null,
};

const rq = (id) => document.getElementById(id);
const resc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rnatural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function routeIndexes(topology) {
  routeState.byId = new Map(topology.nodes.map((node) => [node.id, node]));
  routeState.incoming = new Map();
  routeState.outgoing = new Map();
  routeState.qmgrByName = new Map(topology.nodes.filter((node) => node.type === "qmgr").map((node) => [node.name, node]));
  for (const edge of topology.edges) {
    if (!routeState.outgoing.has(edge.source)) routeState.outgoing.set(edge.source, []);
    if (!routeState.incoming.has(edge.target)) routeState.incoming.set(edge.target, []);
    routeState.outgoing.get(edge.source).push(edge);
    routeState.incoming.get(edge.target).push(edge);
  }
}

function incomingNodes(nodeId, relationship) {
  return (routeState.incoming.get(nodeId) || [])
    .filter((edge) => !relationship || edge.relationship === relationship)
    .map((edge) => routeState.byId.get(edge.source))
    .filter(Boolean);
}

function outgoingNodes(nodeId, relationship) {
  return (routeState.outgoing.get(nodeId) || [])
    .filter((edge) => !relationship || edge.relationship === relationship)
    .map((edge) => routeState.byId.get(edge.target))
    .filter(Boolean);
}

function qmgrOwner(node) {
  if (!node) return null;
  if (node.type === "qmgr") return node;
  if (["queue", "channel", "listener"].includes(node.type)) return routeState.qmgrByName.get(node.scope) || null;
  for (const edge of routeState.incoming.get(node.id) || []) {
    const source = routeState.byId.get(edge.source);
    if (source?.type === "qmgr" && edge.relationship === "OWNS") return source;
  }
  return null;
}

function serverFor(node) {
  if (!node) return null;
  if (node.type === "host") return node;
  const direct = incomingNodes(node.id, "HOSTS").find((candidate) => candidate.type === "host");
  if (direct) return direct;
  const owner = qmgrOwner(node);
  if (owner && owner.id !== node.id) return serverFor(owner);
  if (node.type === "qmgr") return incomingNodes(node.id, "HOSTS").find((candidate) => candidate.type === "host") || null;
  return null;
}

function connectedQmgrNames(app) {
  if (!app || app.type !== "application") return [];
  const names = new Set();
  for (const edge of routeState.outgoing.get(app.id) || []) {
    if (edge.relationship !== "CONNECTS_VIA") continue;
    const channel = routeState.byId.get(edge.target);
    if (channel?.scope) names.add(channel.scope);
  }
  return [...names].sort(rnatural.compare);
}

function routeOwnerLabel(node) {
  const owner = qmgrOwner(node);
  if (owner) return owner.name;
  if (node?.type === "application") {
    const qmgrs = connectedQmgrNames(node);
    return qmgrs.length ? qmgrs.join(", ") : "Client workload";
  }
  return "—";
}

function routeServerLabel(node) {
  const host = serverFor(node);
  return host ? host.name : "Unknown / not collected";
}

function nodeQualifier(node) {
  if (!node) return "";
  if (node.type === "queue") {
    const kind = node.metadata?.queue_type || "queue";
    return `${kind} · ${routeOwnerLabel(node)} · ${routeServerLabel(node)}`;
  }
  if (node.type === "application") {
    const qmgrs = connectedQmgrNames(node);
    return `Application · ${routeServerLabel(node)}${qmgrs.length ? ` · ${qmgrs.join(", ")}` : ""}`;
  }
  return `${node.type} · ${routeOwnerLabel(node)} · ${routeServerLabel(node)}`;
}

function eligibleNodes() {
  if (!routeState.topology) return [];
  return routeState.topology.nodes.filter((node) => ROUTE_ELIGIBLE_TYPES.has(node.type));
}

function searchRouteObjects(query) {
  const normalized = query.trim().toLowerCase();
  const showSystem = normalized.includes("system.");
  return eligibleNodes()
    .filter((node) => showSystem || node.type !== "queue" || !node.metadata?.system)
    .map((node) => {
      const name = node.name.toLowerCase();
      const context = nodeQualifier(node).toLowerCase();
      let score = 9;
      if (!normalized) score = node.type === "application" ? 2 : 5;
      else if (name === normalized) score = 0;
      else if (name.startsWith(normalized)) score = 1;
      else if (name.includes(normalized)) score = 2;
      else if (context.includes(normalized)) score = 3;
      return { node, score };
    })
    .filter((entry) => entry.score < 9)
    .sort((a, b) => a.score - b.score || (a.node.type === "application" ? -1 : 1) || rnatural.compare(a.node.name, b.node.name))
    .slice(0, 10)
    .map((entry) => entry.node);
}

function setRouteSelection(side, node, { quiet = false } = {}) {
  const input = rq(side === "from" ? "routeFrom" : "routeTo");
  const context = rq(side === "from" ? "routeFromContext" : "routeToContext");
  const results = rq(side === "from" ? "routeFromResults" : "routeToResults");
  routeState[`${side}Id`] = node?.id || null;
  if (node) {
    input.value = node.name;
    input.dataset.selectedId = node.id;
    context.textContent = nodeQualifier(node);
    context.classList.add("selected");
  } else {
    delete input.dataset.selectedId;
    context.textContent = side === "from" ? "Choose an application or queue" : "Choose a destination application or queue";
    context.classList.remove("selected");
  }
  results.classList.remove("open");
  if (!quiet) input.focus();
}

function renderPickerOptions(side, query) {
  const results = rq(side === "from" ? "routeFromResults" : "routeToResults");
  const matches = searchRouteObjects(query);
  if (!matches.length) {
    results.innerHTML = `<div class="route-option"><div><strong>No matching application or queue</strong><small>Try part of the name, queue manager, or server.</small></div></div>`;
    results.classList.add("open");
    return;
  }
  results.innerHTML = matches.map((node) => `
    <button class="route-option" type="button" data-route-side="${side}" data-route-id="${resc(node.id)}">
      <div><strong>${resc(node.name)}</strong><small>${resc(nodeQualifier(node))}</small></div>
      <span class="pill">${resc(node.type === "queue" ? (node.metadata?.queue_type || "queue") : "application")}</span>
    </button>`).join("");
  results.classList.add("open");
  results.querySelectorAll("[data-route-id]").forEach((button) => {
    button.addEventListener("click", () => setRouteSelection(side, routeState.byId.get(button.dataset.routeId)));
  });
}

function bindRoutePicker(side) {
  const input = rq(side === "from" ? "routeFrom" : "routeTo");
  const results = rq(side === "from" ? "routeFromResults" : "routeToResults");
  input.addEventListener("focus", () => renderPickerOptions(side, input.value));
  input.addEventListener("input", () => {
    const selected = routeState.byId.get(routeState[`${side}Id`]);
    if (!selected || input.value !== selected.name) setRouteSelection(side, null, { quiet: true });
    renderPickerOptions(side, input.value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      const first = results.querySelector("button.route-option");
      if (first) { event.preventDefault(); first.focus(); }
    }
    if (event.key === "Escape") results.classList.remove("open");
  });
}

function exactTypedNode(value) {
  const q = value.trim().toLowerCase();
  if (!q) return null;
  const matches = eligibleNodes().filter((node) => node.name.toLowerCase() === q);
  return matches.length === 1 ? matches[0] : null;
}

function edgeEvidenceRank(edge) {
  return EVIDENCE_ORDER[edge.relationship_source] ?? 9;
}

function deliveryEdgesFrom(nodeId) {
  return (routeState.outgoing.get(nodeId) || [])
    .filter((edge) => DELIVERY_RELATIONSHIPS.has(edge.relationship))
    .sort((a, b) => edgeEvidenceRank(a) - edgeEvidenceRank(b) || rnatural.compare(a.relationship, b.relationship));
}

function findDeliveryRoute(startId, targetId) {
  if (startId === targetId) return { start: routeState.byId.get(startId), steps: [] };
  const queue = [startId];
  const seen = new Set([startId]);
  const previous = new Map();
  while (queue.length) {
    const current = queue.shift();
    if (current === targetId) break;
    for (const edge of deliveryEdgesFrom(current)) {
      if (!routeState.byId.has(edge.target) || seen.has(edge.target)) continue;
      seen.add(edge.target);
      previous.set(edge.target, { from: current, edge });
      queue.push(edge.target);
    }
  }
  if (!seen.has(targetId)) return null;
  const steps = [];
  let cursor = targetId;
  while (cursor !== startId) {
    const item = previous.get(cursor);
    if (!item) return null;
    steps.push({ node: routeState.byId.get(cursor), edge: item.edge });
    cursor = item.from;
  }
  steps.reverse();
  return { start: routeState.byId.get(startId), steps };
}

function transportFor(queueNode, logicalEdge) {
  if (!queueNode || queueNode.type !== "queue" || queueNode.metadata?.queue_type !== "QREMOTE" || logicalEdge?.relationship !== "ALIASES_TO") return [];
  const transports = [];
  for (const routeEdge of (routeState.outgoing.get(queueNode.id) || []).filter((edge) => edge.relationship === "ROUTES_TO")) {
    const xmitq = routeState.byId.get(routeEdge.target);
    for (const txEdge of (routeState.outgoing.get(xmitq?.id) || []).filter((edge) => edge.relationship === "TRANSMITS_VIA")) {
      const channel = routeState.byId.get(txEdge.target);
      const connectEdge = (routeState.outgoing.get(channel?.id) || []).find((edge) => edge.relationship === "CONNECTS_TO");
      const endpointEdge = (routeState.outgoing.get(channel?.id) || []).find((edge) => edge.relationship === "USES_ENDPOINT");
      const remoteQmgr = connectEdge ? routeState.byId.get(connectEdge.target) : null;
      const endpoint = endpointEdge ? routeState.byId.get(endpointEdge.target) : null;
      const endpointFor = endpoint ? (routeState.outgoing.get(endpoint.id) || []).find((edge) => edge.relationship === "ENDPOINT_FOR") : null;
      const endpointQmgr = endpointFor ? routeState.byId.get(endpointFor.target) : null;
      transports.push({
        xmitq,
        channel,
        endpoint,
        remoteQmgr: remoteQmgr || endpointQmgr,
        edges: [routeEdge, txEdge, connectEdge, endpointEdge, endpointFor].filter(Boolean),
      });
    }
  }
  if (!transports.length && (queueNode.metadata?.xmitq || queueNode.metadata?.rqmname)) {
    transports.push({
      xmitq: queueNode.metadata?.xmitq ? { name: queueNode.metadata.xmitq, type: "queue" } : null,
      channel: null,
      endpoint: null,
      remoteQmgr: queueNode.metadata?.rqmname ? { name: queueNode.metadata.rqmname, type: "qmgr" } : null,
      edges: [],
    });
  }
  return transports;
}

function relationshipCopy(edge, fromNode) {
  if (edge.relationship === "PUTS_TO") return "puts message to";
  if (edge.relationship === "CONSUMED_BY") return "is consumed by";
  if (edge.relationship === "ALIASES_TO" && fromNode?.metadata?.queue_type === "QREMOTE") return "resolves to remote target";
  if (edge.relationship === "ALIASES_TO") return "resolves alias to";
  return edge.relationship.replaceAll("_", " ").toLowerCase();
}

function evidenceCounts(edges) {
  const counts = { observed: 0, configured: 0, inferred: 0 };
  for (const edge of edges) counts[edge.relationship_source] = (counts[edge.relationship_source] || 0) + 1;
  return counts;
}

function routeWarnings(nodes, transports) {
  const warnings = [];
  const unresolved = new Set();
  for (const node of nodes) {
    if (!["application", "queue", "qmgr"].includes(node.type)) continue;
    const owner = qmgrOwner(node);
    if (node.type === "application") {
      if (!serverFor(node)) unresolved.add(node.name);
    } else if (owner && !serverFor(owner)) unresolved.add(owner.name);
  }
  for (const transport of transports.flat()) {
    if (transport.remoteQmgr && routeState.byId.has(transport.remoteQmgr.id) && !serverFor(transport.remoteQmgr)) unresolved.add(transport.remoteQmgr.name);
  }
  if (unresolved.size) warnings.push(`<strong>Physical placement is incomplete</strong> for ${[...unresolved].map(resc).join(", ")}. A route can be logically supported while the peer server is still uncollected.`);
  if (nodes.some((node) => node.type === "queue" && node.metadata?.queue_type === "REMOTE_TARGET")) warnings.push(`<strong>Remote target queue is reference evidence.</strong> Its existence is configured from another queue manager until a collector from the owning peer confirms it.`);
  return warnings;
}

function nodeCard(node, index) {
  const owner = routeOwnerLabel(node);
  const server = routeServerLabel(node);
  const detail = node.type === "queue" ? (node.metadata?.queue_type || "queue") : node.type;
  return `<div class="journey-node">
    <div class="journey-index">${index}</div>
    <article class="journey-card">
      <div class="journey-card-head"><div><span class="route-type">${resc(detail)}</span><h3>${resc(node.name)}</h3></div><span class="pill">${resc(node.status || "status n/a")}</span></div>
      <div class="journey-context"><span>Logical owner <strong>${resc(owner)}</strong></span><span>Server <strong>${resc(server)}</strong></span></div>
    </article>
  </div>`;
}

function transportHtml(transports) {
  return transports.map((transport) => {
    const items = [
      transport.xmitq ? ["Transmit queue", transport.xmitq.name] : null,
      transport.channel ? ["Sender channel", transport.channel.name] : null,
      transport.endpoint ? ["Endpoint", transport.endpoint.name] : null,
      transport.remoteQmgr ? ["Remote QM", transport.remoteQmgr.name] : null,
    ].filter(Boolean);
    if (!items.length) return "";
    const counts = evidenceCounts(transport.edges);
    const evidence = counts.observed ? `${counts.observed} observed` : counts.configured ? `${counts.configured} configured` : "configured reference";
    return `<div class="transport-detail">
      <div class="transport-head"><strong>MQ transport detail</strong><small>${resc(evidence)}</small></div>
      <div class="transport-chain">${items.map(([label, value], index) => `${index ? `<span class="transport-arrow">→</span>` : ""}<div class="transport-item"><span>${resc(label)}</span><strong>${resc(value)}</strong></div>`).join("")}</div>
      <div class="transport-note">The logical QREMOTE target and the network transport are shown separately so the shortest delivery path does not hide the XMITQ / sender-channel evidence.</div>
    </div>`;
  }).join("");
}

function renderRouteFound(result) {
  const nodes = [result.start, ...result.steps.map((step) => step.node)];
  const allTransport = [];
  const transportByStep = new Map();
  result.steps.forEach((step, index) => {
    const from = index === 0 ? result.start : result.steps[index - 1].node;
    const transports = transportFor(from, step.edge);
    transportByStep.set(index, transports);
    allTransport.push(...transports);
  });
  const logicalEdges = result.steps.map((step) => step.edge);
  const transportEdges = allTransport.flatMap((transport) => transport.edges);
  const counts = evidenceCounts([...logicalEdges, ...transportEdges]);
  const warnings = routeWarnings(nodes, [allTransport]);
  const placementGaps = new Set(nodes.filter((node) => ["application", "queue", "qmgr"].includes(node.type) && routeServerLabel(node) === "Unknown / not collected").map((node) => routeOwnerLabel(node) || node.name));
  const evidenceMode = counts.inferred ? "Mixed / inferred" : counts.configured ? "Observed + configured" : "Observed";

  rq("routeTitle").textContent = `${nodes[0].name} → ${nodes[nodes.length - 1].name}`;
  rq("routeMeta").textContent = `${result.steps.length} delivery hop${result.steps.length === 1 ? "" : "s"}`;

  let journey = nodeCard(result.start, 1);
  result.steps.forEach((step, index) => {
    const from = index === 0 ? result.start : result.steps[index - 1].node;
    journey += `<div class="journey-transition"><div class="journey-rail"></div><div class="journey-transition-body"><span class="evidence-badge ${resc(step.edge.relationship_source)}">${resc(step.edge.relationship_source)}</span><span>${resc(relationshipCopy(step.edge, from))}</span></div></div>`;
    const transport = transportByStep.get(index) || [];
    if (transport.length) journey += transportHtml(transport);
    journey += nodeCard(step.node, index + 2);
  });

  const statusClass = warnings.length ? "warn" : "good";
  const statusText = warnings.length ? "Route found · gaps" : counts.configured || counts.inferred ? "Route found" : "Observed route";
  rq("routeResult").className = "route-result-shell";
  rq("routeResult").innerHTML = `
    <div class="route-health">
      <div class="route-health-card ${statusClass}"><span>Result</span><strong>${resc(statusText)}</strong><small>Destination reached by supported delivery relationships</small></div>
      <div class="route-health-card info"><span>Evidence</span><strong>${resc(evidenceMode)}</strong><small>${counts.observed} observed · ${counts.configured} configured · ${counts.inferred} inferred</small></div>
      <div class="route-health-card"><span>Delivery</span><strong>${result.steps.length} hop${result.steps.length === 1 ? "" : "s"}</strong><small>${allTransport.length} MQ transport expansion${allTransport.length === 1 ? "" : "s"}</small></div>
      <div class="route-health-card ${placementGaps.size ? "warn" : "good"}"><span>Placement</span><strong>${placementGaps.size ? `${placementGaps.size} gap${placementGaps.size === 1 ? "" : "s"}` : "Confirmed"}</strong><small>${placementGaps.size ? "Peer collectors can resolve physical hosts" : "Known route objects have server placement"}</small></div>
    </div>
    <div class="route-journey">${journey}</div>
    ${warnings.length ? `<div class="route-warnings"><h3>Coverage notes</h3>${warnings.map((warning) => `<div class="route-warning"><i></i><span>${warning}</span></div>`).join("")}</div>` : ""}
  `;
}

function reachableFrom(sourceId) {
  const queue = [sourceId];
  const seen = new Set([sourceId]);
  while (queue.length) {
    const current = queue.shift();
    for (const edge of deliveryEdgesFrom(current)) {
      if (!seen.has(edge.target)) { seen.add(edge.target); queue.push(edge.target); }
    }
  }
  return seen;
}

function renderNoRoute(source, target, title = "No supported delivery route found") {
  const reachable = source ? reachableFrom(source.id) : new Set();
  const sourceEdges = source ? deliveryEdgesFrom(source.id) : [];
  const targetEdges = target ? (routeState.incoming.get(target.id) || []).filter((edge) => DELIVERY_RELATIONSHIPS.has(edge.relationship)) : [];
  const frontier = [...reachable]
    .map((id) => routeState.byId.get(id))
    .filter(Boolean)
    .filter((node) => node.id !== source?.id && deliveryEdgesFrom(node.id).length === 0)
    .slice(0, 8);

  let sourceNote = `${sourceEdges.length} downstream delivery relationship${sourceEdges.length === 1 ? "" : "s"} from the selected source.`;
  if (source?.type === "application" && !sourceEdges.some((edge) => edge.relationship === "PUTS_TO")) sourceNote = "No observed PUTS_TO evidence exists for this application in the current snapshot.";
  let targetNote = `${targetEdges.length} incoming delivery relationship${targetEdges.length === 1 ? "" : "s"} into the selected destination.`;
  if (target?.type === "application" && !targetEdges.some((edge) => edge.relationship === "CONSUMED_BY")) targetNote = "No observed queue consumption evidence reaches this application in the current snapshot.";

  rq("routeTitle").textContent = title;
  rq("routeMeta").textContent = "Current evidence";
  rq("routeResult").className = "route-diagnostic";
  rq("routeResult").innerHTML = `
    <div class="route-diagnostic-intro"><h3>We cannot prove this end-to-end delivery yet</h3><p>This means the current snapshot does not contain a directed delivery chain from the selected source to destination. It does not prove the systems are disconnected.</p></div>
    <div class="route-diagnostic-grid">
      <div class="diagnostic-card"><span>Source evidence</span><strong>${resc(source?.name || "Not selected")}</strong><p>${resc(sourceNote)}</p></div>
      <div class="diagnostic-card"><span>Destination evidence</span><strong>${resc(target?.name || "Not selected")}</strong><p>${resc(targetNote)}</p></div>
      <div class="diagnostic-card"><span>Likely next evidence</span><strong>${target && routeServerLabel(target) === "Unknown / not collected" ? "Collect destination peer" : "Check intermediate middleware"}</strong><p>${target && routeServerLabel(target) === "Unknown / not collected" ? "The destination owner has no confirmed physical server in this snapshot." : "ACE, DataPower, another MQ server, or an unobserved application step may be outside the current evidence set."}</p></div>
    </div>
    ${frontier.length ? `<div class="route-frontier"><span>Farthest provable objects from the source</span><div class="frontier-list">${frontier.map((node) => `<span class="frontier-chip">${resc(node.name)} · ${resc(node.type)}</span>`).join("")}</div></div>` : ""}
  `;
}

function runSelectedRoute() {
  let source = routeState.byId.get(routeState.fromId);
  let target = routeState.byId.get(routeState.toId);
  if (!source) {
    source = exactTypedNode(rq("routeFrom").value);
    if (source) setRouteSelection("from", source, { quiet: true });
  }
  if (!target) {
    target = exactTypedNode(rq("routeTo").value);
    if (target) setRouteSelection("to", target, { quiet: true });
  }
  if (!source || !target) {
    renderNoRoute(source, target, "Choose unambiguous route endpoints");
    return;
  }
  if (source.id === target.id) {
    renderNoRoute(source, target, "Source and destination are the same object");
    return;
  }
  const result = findDeliveryRoute(source.id, target.id);
  if (!result) renderNoRoute(source, target);
  else renderRouteFound(result);
}

function renderQuickRoutes() {
  const candidates = [];
  const seen = new Set();
  for (const edge of routeState.topology.edges) {
    if (!["PUTS_TO", "ALIASES_TO"].includes(edge.relationship)) continue;
    const source = routeState.byId.get(edge.source);
    const target = routeState.byId.get(edge.target);
    if (!source || !target || !ROUTE_ELIGIBLE_TYPES.has(source.type) || !ROUTE_ELIGIBLE_TYPES.has(target.type)) continue;
    if (source.metadata?.system || target.metadata?.system) continue;
    if (edge.relationship === "ALIASES_TO" && source.metadata?.queue_type !== "QREMOTE") continue;
    const key = `${source.id}|${target.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ source, target, edge });
    if (candidates.length >= 5) break;
  }
  rq("routeSuggestions").innerHTML = candidates.length
    ? `<span>Known evidence:</span>${candidates.map((candidate) => `<button class="route-example" type="button" data-route-from="${resc(candidate.source.id)}" data-route-to="${resc(candidate.target.id)}">${resc(candidate.source.name)} → ${resc(candidate.target.name)}</button>`).join("")}`
    : `<span>No suggested traces in this snapshot.</span>`;
  rq("routeSuggestions").querySelectorAll("[data-route-from]").forEach((button) => {
    button.addEventListener("click", () => {
      setRouteSelection("from", routeState.byId.get(button.dataset.routeFrom), { quiet: true });
      setRouteSelection("to", routeState.byId.get(button.dataset.routeTo), { quiet: true });
      runSelectedRoute();
    });
  });
}

function swapRouteEndpoints() {
  const source = routeState.byId.get(routeState.fromId);
  const target = routeState.byId.get(routeState.toId);
  const fromText = rq("routeFrom").value;
  const toText = rq("routeTo").value;
  if (target) setRouteSelection("from", target, { quiet: true }); else { setRouteSelection("from", null, { quiet: true }); rq("routeFrom").value = toText; }
  if (source) setRouteSelection("to", source, { quiet: true }); else { setRouteSelection("to", null, { quiet: true }); rq("routeTo").value = fromText; }
  if (routeState.fromId && routeState.toId) runSelectedRoute();
}

async function initRoutesV2() {
  const form = rq("routeForm");
  if (!form || !rq("routeFromResults") || !rq("routeToResults")) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    runSelectedRoute();
  }, true);
  rq("routeSwap").addEventListener("click", swapRouteEndpoints);
  bindRoutePicker("from");
  bindRoutePicker("to");
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".route-picker")) {
      rq("routeFromResults").classList.remove("open");
      rq("routeToResults").classList.remove("open");
    }
  });
  try {
    const response = await fetch("/api/v1/topology/current");
    if (!response.ok) throw new Error(`Topology unavailable (${response.status})`);
    routeState.topology = await response.json();
    routeIndexes(routeState.topology);
    setRouteSelection("from", null, { quiet: true });
    setRouteSelection("to", null, { quiet: true });
    renderQuickRoutes();
  } catch (error) {
    rq("routeResult").className = "route-diagnostic";
    rq("routeResult").innerHTML = `<div class="route-diagnostic-intro"><h3>Route evidence is unavailable</h3><p>${resc(error.message)}</p></div>`;
  }
}

initRoutesV2();
