const EXPLORE_BOUNDARY_REVISION = "20260910-3";

const boundaryState = {
  summary: null,
  restoring: false,
  neighborCache: new Map(),
};

const bq = (id) => document.getElementById(id);
const besc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const bsleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TYPE_LABELS = {
  "infra.host": "Host",
  "infra.network_endpoint": "Network endpoint",
  "app.application": "Application",
  "app.application_instance": "Application instance",
  "mq.queue_manager": "Queue manager",
  "mq.queue_manager_instance": "QM instance",
  "mq.queue": "Queue",
  "mq.channel": "Channel",
  "mq.listener": "Listener",
  "mq.cluster": "Cluster",
  "mq.topic": "Topic",
  "mq.runtime_process": "Runtime process",
};

function currentView() {
  return document.querySelector(".nav-item.active")?.dataset.view || "overview";
}

async function boundaryApi(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function typeLabel(type) {
  return TYPE_LABELS[type] || String(type || "entity").replaceAll("_", " ").replaceAll(".", " · ");
}

function canonicalTypeSignature(select) {
  return [...(select?.options || [])].some((option) => option.value.startsWith("mq.") || option.value.startsWith("app.") || option.value.startsWith("infra."));
}

function canonicalIdentitySignature(select) {
  const values = new Set([...(select?.options || [])].map((option) => option.value));
  return values.has("resolved") && values.has("ambiguous") && values.has("conflicted");
}

function canonicalSizeSignature(select) {
  const values = [...(select?.options || [])].map((option) => option.value).join(",");
  return values === "25,50,100";
}

async function ensureSummary() {
  if (boundaryState.summary) return boundaryState.summary;
  boundaryState.summary = await boundaryApi("/api/v2/estate/current/summary");
  return boundaryState.summary;
}

function desiredValue(select, urlValue, valid, fallback = "") {
  if (valid(select?.value)) return select.value;
  if (valid(urlValue)) return urlValue;
  return fallback;
}

async function restoreCanonicalExploreControls() {
  if (boundaryState.restoring || currentView() !== "inventory") return;
  const search = bq("inventorySearch");
  const type = bq("inventoryType");
  const identity = bq("inventoryServer");
  const size = bq("inventoryOwner");
  if (!search || !type || !identity || !size) return;

  boundaryState.restoring = true;
  try {
    const summary = await ensureSummary();
    if (currentView() !== "inventory") return;
    const url = new URL(window.location.href);
    const counts = summary?.entities_by_type || {};
    const canonicalTypes = Object.keys(counts).sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)));
    const typeSet = new Set(["", ...canonicalTypes]);
    const identitySet = new Set(["", "resolved", "ambiguous", "conflicted"]);
    const sizeSet = new Set(["25", "50", "100"]);

    const wantedType = desiredValue(type, url.searchParams.get("type") || "", (value) => typeSet.has(value));
    const wantedIdentity = desiredValue(identity, url.searchParams.get("identity") || "", (value) => identitySet.has(value));
    const wantedSize = desiredValue(size, url.searchParams.get("size") || "50", (value) => sizeSet.has(value), "50");

    if (!canonicalTypeSignature(type)) {
      type.innerHTML = `<option value="">All semantic types</option>${canonicalTypes.map((value) => `<option value="${besc(value)}">${besc(typeLabel(value))} (${Number(counts[value] || 0).toLocaleString()})</option>`).join("")}`;
    }
    if (!canonicalIdentitySignature(identity)) {
      identity.innerHTML = `<option value="">All identity states</option><option value="resolved">Resolved</option><option value="ambiguous">Ambiguous</option><option value="conflicted">Conflicted</option>`;
    }
    if (!canonicalSizeSignature(size)) {
      size.innerHTML = `<option value="25">25 rows</option><option value="50">50 rows</option><option value="100">100 rows</option>`;
    }

    type.value = typeSet.has(wantedType) ? wantedType : "";
    identity.value = identitySet.has(wantedIdentity) ? wantedIdentity : "";
    size.value = sizeSet.has(wantedSize) ? wantedSize : "50";
    search.placeholder = "Name or canonical identity…";

    const typeLabelEl = type.closest("label")?.querySelector("span");
    const identityLabelEl = identity.closest("label")?.querySelector("span");
    const sizeLabelEl = size.closest("label")?.querySelector("span");
    if (typeLabelEl) typeLabelEl.textContent = "Semantic type";
    if (identityLabelEl) identityLabelEl.textContent = "Identity";
    if (sizeLabelEl) sizeLabelEl.textContent = "Page size";
  } catch (error) {
    console.warn("Canonical Explore control restoration failed", error);
  } finally {
    boundaryState.restoring = false;
  }
}

async function loadNeighbor(entityId) {
  if (!entityId) return null;
  if (boundaryState.neighborCache.has(entityId)) return boundaryState.neighborCache.get(entityId);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = await boundaryApi(`/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=1`);
      const entity = data.entity || null;
      if (entity) boundaryState.neighborCache.set(entityId, entity);
      return entity;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await bsleep(120);
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function resolveOpaqueRelationshipNeighbors() {
  if (currentView() !== "inventory") return;
  const buttons = [...document.querySelectorAll("#detailRelationships [data-neighbor-id]")];
  const pending = buttons.filter((button) => {
    const name = button.querySelector(".explore-rel-copy strong")?.textContent?.trim() || "";
    return !name || name.startsWith("cent_");
  });
  if (!pending.length) return;

  const queue = [...pending];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const button = queue.shift();
      if (!button?.isConnected) continue;
      const id = button.dataset.neighborId || "";
      try {
        const entity = await loadNeighbor(id);
        if (!entity || !button.isConnected) continue;
        const name = entity.display_name || entity.identity_key || id;
        const type = entity.semantic_type || button.dataset.neighborType || "entity";
        const strong = button.querySelector(".explore-rel-copy strong");
        const small = button.querySelector(".explore-rel-copy small");
        if (strong) strong.textContent = name;
        if (small) {
          const evidence = small.textContent?.includes(" · ") ? small.textContent.split(" · ").slice(1).join(" · ") : "evidence";
          small.textContent = `${typeLabel(type)} · ${evidence}`;
        }
        button.dataset.neighborName = name;
        button.dataset.neighborType = type;
      } catch {}
    }
  });
  await Promise.all(workers);
}

function watchCanonicalControls() {
  ["inventoryType", "inventoryServer", "inventoryOwner"].forEach((id) => {
    const select = bq(id);
    if (!select) return;
    const observer = new MutationObserver(() => {
      if (!boundaryState.restoring) queueMicrotask(() => restoreCanonicalExploreControls());
    });
    observer.observe(select, { childList: true, subtree: false });
  });
}

function watchRelationships() {
  const target = bq("detailRelationships");
  if (!target) return;
  const observer = new MutationObserver(() => setTimeout(resolveOpaqueRelationshipNeighbors, 0));
  observer.observe(target, { childList: true, subtree: false });
  resolveOpaqueRelationshipNeighbors();
}

function bindNavigationRestoration() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-view], [data-go]");
    const view = target?.dataset.view || target?.dataset.go;
    if (view === "inventory") {
      setTimeout(restoreCanonicalExploreControls, 0);
      setTimeout(restoreCanonicalExploreControls, 120);
    }
  }, true);
  window.addEventListener("popstate", () => setTimeout(restoreCanonicalExploreControls, 0));
}

async function initExploreBoundary() {
  await ensureSummary().catch(() => null);
  watchCanonicalControls();
  watchRelationships();
  bindNavigationRestoration();
  await restoreCanonicalExploreControls();
}

window.osiRestoreCanonicalExploreControls = restoreCanonicalExploreControls;
window.osiResolveOpaqueRelationshipNeighbors = resolveOpaqueRelationshipNeighbors;

initExploreBoundary();
