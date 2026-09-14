const ftState = { loading: false, loaded: false, data: null, error: null };
const fq = (id) => document.getElementById(id);
const fesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const fnatural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const REVISION_CHANGED = "ESTATE_REVISION_CHANGED";

async function ftApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body.detail || `File-transfer query failed (${response.status})`);
    error.code = body.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function requireEstateRevision(body, expectedRevision = null, label = "canonical estate response") {
  const revision = body?.estate?.estate_revision_id;
  if (typeof revision !== "string" || !revision) {
    const error = new Error(`${label} did not identify its canonical estate revision`);
    error.code = REVISION_CHANGED;
    throw error;
  }
  if (expectedRevision && revision !== expectedRevision) {
    const error = new Error(`Canonical estate changed during File Transfer load (${expectedRevision} → ${revision})`);
    error.code = REVISION_CHANGED;
    throw error;
  }
  return revision;
}

async function fetchAll(path, key, revisionId) {
  const items = [];
  let offset = 0;
  while (offset != null) {
    const join = path.includes("?") ? "&" : "?";
    const page = await ftApi(`${path}${join}limit=100&offset=${offset}`);
    requireEstateRevision(page, revisionId, `${key} page`);
    items.push(...(page[key] || []));
    offset = page.page?.next_offset ?? page.next_offset ?? null;
  }
  return items;
}

async function fetchEntities(type, revisionId) {
  const params = new URLSearchParams({ semantic_type: type });
  return fetchAll(`/api/v2/estate/current/entities?${params}`, "entities", revisionId);
}

async function fetchRelations(type, revisionId) {
  return fetchAll(`/api/v2/estate/current/relations?semantic_type=${encodeURIComponent(type)}`, "relations", revisionId);
}

async function fetchDetails(items, revisionId) {
  const details = await Promise.all(items.map(async (item) => {
    const data = await ftApi(`/api/v2/estate/current/entities/${encodeURIComponent(item.entity_id)}?relation_limit=100`);
    requireEstateRevision(data, revisionId, `entity detail ${item.entity_id}`);
    return data.entity;
  }));
  return details.filter(Boolean);
}

function ensureFileTransferScaffold() {
  if (!document.querySelector('link[data-osi-filetransfer-css]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/filetransfer-view.css?v=20260914-2";
    link.dataset.osiFiletransferCss = "true";
    document.head.appendChild(link);
  }

  if (!document.querySelector('[data-view="filetransfer"]')) {
    const nav = document.createElement("button");
    nav.className = "nav-item";
    nav.dataset.view = "filetransfer";
    nav.textContent = "File Transfer";
    const routes = document.querySelector('[data-view="routes"]');
    routes?.parentElement?.insertBefore(nav, routes);
  }

  if (!document.querySelector('[data-view-panel="filetransfer"]')) {
    const section = document.createElement("section");
    section.id = "view-filetransfer";
    section.className = "view";
    section.dataset.viewPanel = "filetransfer";
    section.innerHTML = `
      <section class="panel ft-hero">
        <div>
          <p class="section-kicker">File transfer fabric</p>
          <h2>EFT, DMZ Gateway and MQ Managed File Transfer</h2>
          <p>One operator view of ingress Sites, DMZ listener paths, peer-notification connectivity, MFT queue-manager dependencies, storage anchors and explicit evidence gaps.</p>
        </div>
        <div class="ft-hero-actions">
          <span class="ft-contract"><i></i>Evidence-backed topology</span>
          <button id="ftRefresh" class="ghost" type="button">Refresh</button>
        </div>
      </section>
      <div id="ftStats" class="stats ft-stats"></div>
      <section class="section-block">
        <div class="section-heading"><div><p class="section-kicker">Transfer paths</p><h2>Qualified inbound Site paths</h2><p>Each lane preserves topology inference separately from transfer completion.</p></div><span id="ftRouteCount"></span></div>
        <div id="ftFabric" class="ft-fabric"></div>
      </section>
      <section class="section-block ft-two-col">
        <div class="panel">
          <div class="section-heading compact-heading"><div><p class="section-kicker">EFT Sites</p><h2>Site coverage</h2></div></div>
          <div id="ftSites" class="ft-list"></div>
        </div>
        <div class="panel">
          <div class="section-heading compact-heading"><div><p class="section-kicker">DMZ ↔ EFT runtime</p><h2>Peer notification channels</h2></div></div>
          <div id="ftPnc" class="ft-list"></div>
        </div>
      </section>
      <section class="section-block ft-two-col">
        <div class="panel">
          <div class="section-heading compact-heading"><div><p class="section-kicker">MQ integration</p><h2>Managed File Transfer agents</h2></div></div>
          <div id="ftMft" class="ft-list"></div>
        </div>
        <div class="panel">
          <div class="section-heading compact-heading"><div><p class="section-kicker">Transfer storage</p><h2>Observed filesystem anchors</h2></div></div>
          <div id="ftStorage" class="ft-list"></div>
        </div>
      </section>
      <section class="section-block panel">
        <div class="section-heading compact-heading"><div><p class="section-kicker">Evidence gaps</p><h2>Unresolved Site mappings</h2><p>Missing evidence is retained as unknown, not promoted into a route.</p></div></div>
        <div id="ftUnresolved" class="ft-list"></div>
      </section>`;
    const routesView = document.querySelector('[data-view-panel="routes"]');
    routesView?.parentElement?.insertBefore(section, routesView);
  }

  const refresh = fq("ftRefresh");
  if (refresh && refresh.dataset.bound !== "true") {
    refresh.dataset.bound = "true";
    refresh.addEventListener("click", () => renderFileTransfer({ force: true }));
  }
}

function evidenceChips(values) {
  const list = Array.isArray(values) ? values : [];
  return list.length ? list.map((value) => `<span class="ft-chip ${fesc(value)}">${fesc(value)}</span>`).join("") : `<span class="ft-chip">evidence unknown</span>`;
}

function property(entity, key, fallback = null) {
  return entity?.properties && Object.prototype.hasOwnProperty.call(entity.properties, key) ? entity.properties[key] : fallback;
}

function serverBySourceKey(servers, key) {
  return servers.find((server) => property(server, "source_key") === key) || null;
}

function siteStateLabel(site) {
  const state = property(site, "site_started", null);
  if (state === true) return "Site started";
  if (state === false) return "Site stopped";
  return "Site state unknown";
}

async function loadFileTransferDataOnce() {
  const summary = await ftApi("/api/v2/estate/current/summary");
  const revisionId = requireEstateRevision(summary, null, "estate summary");

  const [serverRows, endpointRows, flowRows, applicationRows, routeRelations, connectRelations, allUnresolved] = await Promise.all([
    fetchEntities("filetransfer.server", revisionId),
    fetchEntities("filetransfer.endpoint", revisionId),
    fetchEntities("filetransfer.flow", revisionId),
    fetchEntities("app.application_instance", revisionId),
    fetchRelations("integration.routes_to", revisionId),
    fetchRelations("network.connects_to", revisionId),
    fetchAll("/api/v2/estate/current/unresolved?semantic_type=filetransfer.endpoint", "unresolved", revisionId),
  ]);

  const [servers, endpoints, flows, applicationInstances] = await Promise.all([
    fetchDetails(serverRows, revisionId),
    fetchDetails(endpointRows, revisionId),
    fetchDetails(flowRows, revisionId),
    fetchDetails(applicationRows, revisionId),
  ]);
  const mftAgents = applicationInstances.filter((item) => property(item, "component_class") === "ibm_mq_mft_agent");

  const entityById = new Map([...servers, ...endpoints, ...flows, ...mftAgents].map((item) => [item.entity_id, item]));
  const pncFlowIds = new Set(flows.filter((flow) => property(flow, "flow_kind") === "eft_dmz_pnc").map((flow) => flow.entity_id));
  const pncTargetIds = connectRelations
    .filter((rel) => pncFlowIds.has(rel.source_entity_id))
    .map((rel) => rel.target_entity_id)
    .filter((id, index, list) => list.indexOf(id) === index);
  const pncTargets = await fetchDetails(pncTargetIds.map((entity_id) => ({ entity_id })), revisionId);
  pncTargets.forEach((item) => entityById.set(item.entity_id, item));

  const siteIds = new Set(endpoints.filter((item) => property(item, "endpoint_kind") === "eft_site").map((item) => item.entity_id));
  const unresolved = allUnresolved.filter((item) => siteIds.has(item.source_entity_id));

  const finalSummary = await ftApi("/api/v2/estate/current/summary");
  requireEstateRevision(finalSummary, revisionId, "final estate summary");

  return {
    summary: finalSummary,
    revisionId,
    servers,
    endpoints,
    flows,
    mftAgents,
    routeRelations,
    connectRelations,
    unresolved,
    entityById,
  };
}

async function loadFileTransferData() {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await loadFileTransferDataOnce();
    } catch (error) {
      lastError = error;
      const retryable = error?.code === REVISION_CHANGED || error?.code === "ESTATE_STALE";
      if (!retryable || attempt === 3) throw error;
    }
  }
  throw lastError || new Error("File Transfer canonical estate load failed");
}

function renderStats(data) {
  const sites = data.endpoints.filter((item) => property(item, "endpoint_kind") === "eft_site");
  const storage = data.endpoints.filter((item) => property(item, "endpoint_kind") === "filesystem_path");
  const qualified = data.routeRelations.filter((rel) => {
    const flow = data.entityById.get(rel.source_entity_id);
    return property(flow, "flow_kind") === "eft_inbound_site_path";
  });
  const backend = data.servers.filter((item) => property(item, "role") === "eft_backend").length;
  const gateways = data.servers.filter((item) => property(item, "role") === "dmz_gateway").length;
  const stats = [
    ["EFT backends", backend, "logical server tier"],
    ["DMZ Gateways", gateways, "separate runtime nodes"],
    ["EFT Sites", sites.length, "current canonical Sites"],
    ["Qualified paths", qualified.length, "inferred topology paths"],
    ["Unresolved", data.unresolved.length, "explicit Site gaps"],
    ["MFT agents", data.mftAgents.length, `${storage.length} storage anchors`],
  ];
  fq("ftStats").innerHTML = stats.map(([label, value, note]) => `<article class="stat"><span>${fesc(label)}</span><strong>${Number(value).toLocaleString()}</strong><small>${fesc(note)}</small></article>`).join("");
}

function renderFabric(data) {
  const routes = data.routeRelations
    .map((rel) => ({ rel, flow: data.entityById.get(rel.source_entity_id), site: data.entityById.get(rel.target_entity_id) }))
    .filter((item) => item.flow && item.site && property(item.flow, "flow_kind") === "eft_inbound_site_path")
    .sort((a, b) => fnatural.compare(a.site.display_name || "", b.site.display_name || ""));

  fq("ftRouteCount").textContent = `${routes.length} qualified path${routes.length === 1 ? "" : "s"}`;
  fq("ftFabric").innerHTML = routes.length ? routes.map(({ rel, flow, site }) => {
    const conn = data.connectRelations.find((item) => item.source_entity_id === flow.entity_id && property(data.entityById.get(item.target_entity_id), "endpoint_kind") === "client_listener");
    const listener = conn ? data.entityById.get(conn.target_entity_id) : null;
    const gateway = serverBySourceKey(data.servers, property(flow, "gateway_server_key"));
    const eft = serverBySourceKey(data.servers, property(site, "server_key"));
    const historical = property(flow, "site_access_time_scope") === "historical";
    return `<article class="ft-route-lane">
      <div class="ft-route-title"><div><span>Inbound Site path</span><strong>${fesc(site.display_name)}</strong></div><div>${evidenceChips(rel.evidence_classes)}</div></div>
      <div class="ft-route-steps">
        <div class="ft-step"><span>Client listener</span><strong>${fesc(listener?.display_name || property(flow, "listener") || "Unknown")}</strong><small>${listener ? "observed endpoint" : "listener evidence unavailable"}</small></div>
        <div class="ft-arrow">→</div>
        <div class="ft-step"><span>DMZ Gateway</span><strong>${fesc(gateway?.display_name || property(flow, "gateway_server_key") || "Unknown")}</strong><small>${fesc(property(gateway, "physical_host", "physical host unknown"))}</small></div>
        <div class="ft-arrow">→</div>
        <div class="ft-step"><span>EFT Site</span><strong>${fesc(site.display_name)}</strong><small>${fesc(siteStateLabel(site))}</small></div>
        <div class="ft-arrow">→</div>
        <div class="ft-step"><span>EFT backend</span><strong>${fesc(eft?.display_name || "Globalscape EFT")}</strong><small>${fesc(property(eft, "physical_host", "placement unknown"))}</small></div>
      </div>
      <div class="ft-route-proof"><span class="ft-chip inferred">inferred topology</span><span class="ft-chip observed">${historical ? "historical Site access" : "Site-access evidence"}</span><span class="ft-chip observed">current listener evidence</span><span class="ft-chip">transfer completion not proven</span></div>
    </article>`;
  }).join("") : `<div class="route-empty">No qualified file-transfer Site paths are present in the current canonical estate.</div>`;
}

function renderSites(data) {
  const unresolvedBySource = new Map(data.unresolved.map((item) => [item.source_entity_id, item]));
  const sites = data.endpoints.filter((item) => property(item, "endpoint_kind") === "eft_site").sort((a, b) => fnatural.compare(a.display_name || "", b.display_name || ""));
  fq("ftSites").innerHTML = sites.map((site) => {
    const gap = unresolvedBySource.get(site.entity_id);
    const qualified = property(site, "listener_resolution") === "qualified-inferred";
    return `<div class="ft-row"><div class="ft-row-main"><strong>${fesc(site.display_name)}</strong><small>${fesc(siteStateLabel(site))} · ${qualified ? "listener path qualified" : "listener unresolved"}</small></div><div class="ft-row-right"><span class="ft-chip ${gap ? "warn" : "good"}">${gap ? "unresolved" : "mapped"}</span>${evidenceChips(site.evidence_classes)}</div></div>`;
  }).join("") || `<div class="route-empty">No EFT Sites are present.</div>`;
}

function renderPnc(data) {
  const pncFlows = data.flows.filter((item) => property(item, "flow_kind") === "eft_dmz_pnc").sort((a, b) => fnatural.compare(a.display_name || "", b.display_name || ""));
  fq("ftPnc").innerHTML = pncFlows.map((flow) => {
    const conn = data.connectRelations.find((rel) => rel.source_entity_id === flow.entity_id);
    const endpoint = conn ? data.entityById.get(conn.target_entity_id) : null;
    const gateway = serverBySourceKey(data.servers, property(flow, "target_gateway_server_key"));
    const sources = Array.isArray(property(flow, "corroboration_sources", [])) ? property(flow, "corroboration_sources", []) : [];
    const sourceKinds = [...new Set(sources.map((item) => item?.source_kind).filter(Boolean))];
    return `<div class="ft-row ft-row-stack"><div class="ft-row-main"><strong>${fesc(flow.display_name)}</strong><small>${fesc(gateway?.display_name || property(flow, "target_gateway_server_key") || "Gateway")} · ${fesc(endpoint?.display_name || "network endpoint")}</small></div><div class="ft-row-right"><span class="ft-chip observed">runtime observed</span>${sourceKinds.map((kind) => `<span class="ft-chip">${fesc(kind)}</span>`).join("")}</div></div>`;
  }).join("") || `<div class="route-empty">No current PNC bridge evidence is present.</div>`;
}

function renderMft(data) {
  const agents = [...data.mftAgents].sort((a, b) => fnatural.compare(a.display_name || "", b.display_name || ""));
  fq("ftMft").innerHTML = agents.map((agent) => {
    const agentQm = property(agent, "agent_queue_manager", "Unknown");
    const coordinationQm = property(agent, "coordination_queue_manager", "Unknown");
    return `<div class="ft-row ft-row-stack">
      <div class="ft-row-main"><strong>${fesc(agent.display_name)}</strong><small>Runs on EFT host · completed MFT transfer not proven</small></div>
      <div class="ft-dependency-line" aria-label="Configured MFT queue-manager dependencies">
        <div class="ft-dependency-branch"><span>MFT agent</span><strong>${fesc(agent.display_name)}</strong><b>→</b><span>Agent QM</span><strong>${fesc(agentQm)}</strong></div>
        <div class="ft-dependency-branch"><span>MFT agent</span><strong>${fesc(agent.display_name)}</strong><b>→</b><span>Coordination QM</span><strong>${fesc(coordinationQm)}</strong></div>
      </div>
      <div class="ft-row-right">${evidenceChips(agent.evidence_classes)}<span class="ft-chip configured">configured MQ dependencies</span></div>
    </div>`;
  }).join("") || `<div class="route-empty">No IBM MQ MFT agent anchors are present.</div>`;
}

function renderStorage(data) {
  const paths = data.endpoints.filter((item) => property(item, "endpoint_kind") === "filesystem_path").sort((a, b) => fnatural.compare(a.display_name || "", b.display_name || ""));
  fq("ftStorage").innerHTML = paths.map((path) => `<div class="ft-row"><div class="ft-row-main"><strong class="ft-mono">${fesc(path.display_name)}</strong><small>${fesc(property(path, "backing_volume", "volume unknown"))} · ${fesc(property(path, "backing_filesystem", "filesystem unknown"))}</small></div><div class="ft-row-right"><span class="ft-chip observed">path observed</span><span class="ft-chip ${property(path, "nfs_relationship") === "unresolved" ? "warn" : ""}">NFS ${fesc(property(path, "nfs_relationship", "unknown"))}</span></div></div>`).join("") || `<div class="route-empty">No transfer storage anchors are present.</div>`;
}

function renderUnresolved(data) {
  fq("ftUnresolved").innerHTML = data.unresolved.length ? data.unresolved.map((gap) => {
    const site = data.entityById.get(gap.source_entity_id);
    return `<div class="ft-gap"><div><span>Unresolved listener mapping</span><strong>${fesc(site?.display_name || gap.vendor_value || "File-transfer Site")}</strong><p>${fesc(gap.reason || "No current listener/gateway mapping is supported by the supplied evidence.")}</p></div><div><span class="ft-chip warn">unknown remains unknown</span></div></div>`;
  }).join("") : `<div class="ft-gap good"><div><strong>No unresolved Site mappings</strong><p>All current Sites have an evidence-backed listener mapping.</p></div></div>`;
}

function renderAll(data) {
  renderStats(data);
  renderFabric(data);
  renderSites(data);
  renderPnc(data);
  renderMft(data);
  renderStorage(data);
  renderUnresolved(data);
}

function renderLoadError(error) {
  const message = fesc(error?.message || "Canonical file-transfer topology is unavailable");
  fq("ftStats").innerHTML = `<article class="stat ft-error-stat"><span>File Transfer</span><strong>Unavailable</strong><small>${message}</small></article>`;
  fq("ftRouteCount").textContent = "Unavailable";
  const errorPanel = `<div class="route-empty ft-error-state">${message}. No cached estate is being shown.</div>`;
  ["ftFabric", "ftSites", "ftPnc", "ftMft", "ftStorage", "ftUnresolved"].forEach((id) => { if (fq(id)) fq(id).innerHTML = errorPanel; });
}

async function renderFileTransfer({ force = false } = {}) {
  ensureFileTransferScaffold();
  if (ftState.loading) return;
  if (ftState.loaded && !force) {
    renderAll(ftState.data);
    return;
  }
  ftState.loading = true;
  fq("ftFabric").innerHTML = `<div class="route-empty">Loading canonical file-transfer topology…</div>`;
  try {
    const data = await loadFileTransferData();
    ftState.data = data;
    ftState.loaded = true;
    ftState.error = null;
    renderAll(data);
  } catch (error) {
    ftState.loaded = false;
    ftState.data = null;
    ftState.error = error;
    renderLoadError(error);
  } finally {
    ftState.loading = false;
  }
}

ensureFileTransferScaffold();
window.osiRenderFileTransfer = renderFileTransfer;
