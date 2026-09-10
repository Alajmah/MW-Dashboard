const WAVE1_SHELL_REVISION = "20260910-1";

const cleanupState = {
  timer: null,
  controller: null,
  results: [],
  activeIndex: -1,
};

const c$ = (id) => document.getElementById(id);
const cesc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const SEARCH_TYPE_ORDER = [
  "mq.queue_manager",
  "mq.queue",
  "mq.channel",
  "mq.listener",
  "infra.host",
  "app.application",
  "app.application_instance",
  "infra.network_endpoint",
  "mq.cluster",
  "mq.topic",
  "mq.subscription",
];

const SEARCH_TYPE_LABELS = {
  "mq.queue_manager": "Queue manager",
  "mq.queue": "Queue",
  "mq.channel": "Channel",
  "mq.listener": "Listener",
  "infra.host": "Host",
  "app.application": "Application",
  "app.application_instance": "Application instance",
  "infra.network_endpoint": "Network endpoint",
  "mq.cluster": "Cluster",
  "mq.topic": "Topic",
  "mq.subscription": "Subscription",
  "mq.process_definition": "Process definition",
  "mq.runtime_process": "Runtime process",
  "mq.service": "Service",
  "mq.namelist": "Namelist",
};

function installCleanupStyles() {
  if (document.querySelector('link[data-wave1-shell-cleanup]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/wave1-shell-cleanup.css?v=${WAVE1_SHELL_REVISION}`;
  link.dataset.wave1ShellCleanup = "true";
  document.head.appendChild(link);
}

function currentView() {
  return document.querySelector(".nav-item.active")?.dataset.view || "overview";
}

function syncOverviewQueueManagerAction() {
  const heading = c$("overviewQmgrs")?.closest(".section-block")?.querySelector(".section-heading");
  const action = heading?.querySelector("button[data-go]");
  if (!action) return;
  action.dataset.go = "qmgrs";
  action.textContent = "Open Queue Managers";
}

function syncObjectBrowseAction() {
  const jump = c$("jumpInventory");
  if (!jump) return;
  const inObjects = currentView() === "inventory";
  jump.hidden = inObjects;
  jump.setAttribute("aria-hidden", inObjects ? "true" : "false");
}

function syncDevelopPlaceholder() {
  const status = document.querySelector(".nav-mission-status");
  if (!status) return;
  status.textContent = "ACE workspace — awaiting evidence source";
  status.setAttribute("role", "status");
  status.setAttribute("aria-label", "ACE workspace awaiting evidence source");
}

function syncCollectionLanguage() {
  const view = c$("view-snapshots");
  if (!view) return;
  const kicker = view.querySelector(".section-kicker");
  const heading = view.querySelector("h2");
  const copy = view.querySelector(".section-heading p:not(.section-kicker)");
  if (kicker) kicker.textContent = "Evidence history";
  if (heading) heading.textContent = "Collection revisions";
  if (copy) copy.textContent = "Evidence sources, imports, and retained revisions for canonical traceability.";
}

function syncServerBoundary() {
  const card = document.querySelector("#serversGrid .server-boundary-card");
  if (!card) return;
  const note = card.querySelector("small");
  if (note) note.textContent = "Investigate client-side evidence in Objects using Application or Network endpoint filters.";
  if (!card.querySelector("[data-open-object-browser]")) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "ghost boundary-open-objects";
    action.dataset.openObjectBrowser = "true";
    action.textContent = "Open Objects";
    action.addEventListener("click", () => window.osiNavigateProduct?.("inventory"));
    card.appendChild(action);
  }
}

function ensureSearchShortcutHint() {
  const label = c$("globalSemanticSearch")?.closest("label");
  if (!label || c$("globalSearchShortcut")) return;
  const shortcut = document.createElement("kbd");
  shortcut.id = "globalSearchShortcut";
  shortcut.textContent = navigator.platform?.toLowerCase().includes("mac") ? "⌘ K" : "Ctrl K";
  shortcut.title = "Focus global search. Slash also works when you are not typing in a field.";
  label.appendChild(shortcut);
}

function syncSearchChrome() {
  const input = c$("globalSemanticSearch");
  if (!input) return;
  input.placeholder = "Search estate…";
  input.setAttribute("aria-label", "Search the canonical middleware estate");
  ensureSearchShortcutHint();
}

function syncShellConsistency() {
  syncOverviewQueueManagerAction();
  syncObjectBrowseAction();
  syncDevelopPlaceholder();
  syncCollectionLanguage();
  syncServerBoundary();
  syncSearchChrome();
}

async function cleanupApi(path, signal) {
  const response = await fetch(path, { headers: { accept: "application/json" }, signal });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function searchTypeLabel(type) {
  return SEARCH_TYPE_LABELS[type] || String(type || "entity").replaceAll("_", " ").replaceAll(".", " · ");
}

function identityField(identityKey, field) {
  const match = String(identityKey || "").match(new RegExp(`(?:^|\\|)${field}=([^|]+)`, "i"));
  return match ? match[1] : "";
}

function propertyValue(entity, aliases) {
  const properties = entity?.properties && typeof entity.properties === "object" ? entity.properties : {};
  const normalized = new Map(Object.entries(properties).map(([key, value]) => [key.toLowerCase(), value]));
  for (const alias of aliases) {
    const value = normalized.get(String(alias).toLowerCase());
    if (Array.isArray(value) && value.length) return value.join(", ");
    if (value != null && String(value).trim()) return String(value);
  }
  return "";
}

function resultContext(entity) {
  const type = entity.semantic_type || "";
  const qmgr = identityField(entity.identity_key, "queue_manager_key")
    || identityField(entity.identity_key, "queue_manager")
    || propertyValue(entity, ["QUEUE_MANAGER", "QMGR", "QMNAME"]);
  const host = identityField(entity.identity_key, "host_key")
    || identityField(entity.identity_key, "host")
    || propertyValue(entity, ["HOST", "HOSTNAME", "COLLECTOR_HOST"]);
  const app = identityField(entity.identity_key, "application_key")
    || identityField(entity.identity_key, "application")
    || propertyValue(entity, ["APPLICATION", "APPLICATION_NAME"]);

  if (type === "mq.queue_manager") {
    const qmid = propertyValue(entity, ["QMID"]);
    return qmid ? `QMID ${qmid}` : `${Number(entity.source_count || 0)} source${Number(entity.source_count || 0) === 1 ? "" : "s"}`;
  }
  if (qmgr) return `QM ${qmgr}${host ? ` · Host ${host}` : ""}`;
  if (host) return `Host ${host}`;
  if (app) return `Application ${app}`;
  const evidence = Array.isArray(entity.evidence_classes) ? entity.evidence_classes.join(" · ") : "";
  return evidence || `${Number(entity.source_count || 0)} source${Number(entity.source_count || 0) === 1 ? "" : "s"}`;
}

function searchScore(entity, query) {
  const name = String(entity.display_name || "").toLowerCase();
  const identity = String(entity.identity_key || "").toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (identity.includes(query)) return 3;
  return 4;
}

function rankSearchResults(entities, query) {
  const typeRank = new Map(SEARCH_TYPE_ORDER.map((type, index) => [type, index]));
  return [...entities].sort((a, b) => {
    const score = searchScore(a, query) - searchScore(b, query);
    if (score) return score;
    const type = (typeRank.get(a.semantic_type) ?? 99) - (typeRank.get(b.semantic_type) ?? 99);
    if (type) return type;
    return collator.compare(a.display_name || a.identity_key || "", b.display_name || b.identity_key || "");
  }).slice(0, 12);
}

function groupedSearchHtml(results) {
  const groups = new Map();
  results.forEach((entity, index) => {
    const type = entity.semantic_type || "entity";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push({ entity, index });
  });
  return [...groups.entries()].map(([type, items]) => `
    <div class="global-search-group" role="group" aria-label="${cesc(searchTypeLabel(type))}">
      <div class="global-search-group-label">${cesc(searchTypeLabel(type))}</div>
      ${items.map(({ entity, index }) => `<button type="button" role="option" aria-selected="false" data-cleanup-global-result="${index}" data-entity-id="${cesc(entity.entity_id)}"><span><strong>${cesc(entity.display_name || entity.identity_key)}</strong><small>${cesc(searchTypeLabel(entity.semantic_type))} · ${cesc(resultContext(entity))}</small></span><i>${Number(entity.source_count || 0)} source${Number(entity.source_count || 0) === 1 ? "" : "s"}</i></button>`).join("")}
    </div>`).join("");
}

function openSearchResults() {
  const input = c$("globalSemanticSearch");
  const results = c$("globalSemanticResults");
  if (!input || !results || !results.innerHTML.trim()) return;
  results.classList.add("open");
  input.setAttribute("aria-expanded", "true");
}

function closeSearchResults() {
  c$("globalSemanticResults")?.classList.remove("open");
  c$("globalSemanticSearch")?.setAttribute("aria-expanded", "false");
  cleanupState.activeIndex = -1;
}

function paintSearchActive() {
  const buttons = [...(c$("globalSemanticResults")?.querySelectorAll("[data-cleanup-global-result]") || [])];
  buttons.forEach((button) => {
    const index = Number(button.dataset.cleanupGlobalResult);
    const active = index === cleanupState.activeIndex;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    if (active) button.scrollIntoView({ block: "nearest" });
  });
}

function selectSearchResult(index) {
  const entity = cleanupState.results[index];
  if (!entity) return;
  const input = c$("globalSemanticSearch");
  if (input) input.value = "";
  closeSearchResults();
  void window.osiOpenObjectWorkspace?.(entity.entity_id, true);
}

async function runSearch() {
  const input = c$("globalSemanticSearch");
  const results = c$("globalSemanticResults");
  const query = input?.value.trim() || "";
  cleanupState.controller?.abort();
  cleanupState.results = [];
  cleanupState.activeIndex = -1;
  if (!results || query.length < 2) {
    if (results) results.innerHTML = query ? `<div class="global-search-empty">Type at least 2 characters.</div>` : "";
    closeSearchResults();
    return;
  }

  const controller = new AbortController();
  cleanupState.controller = controller;
  results.innerHTML = `<div class="global-search-empty">Searching canonical estate…</div>`;
  openSearchResults();
  try {
    const params = new URLSearchParams({ q: query, limit: "24", offset: "0" });
    const data = await cleanupApi(`/api/v2/estate/current/entities?${params}`, controller.signal);
    if (controller.signal.aborted) return;
    cleanupState.results = rankSearchResults(data.entities || [], query.toLowerCase());
    results.innerHTML = cleanupState.results.length
      ? groupedSearchHtml(cleanupState.results)
      : `<div class="global-search-empty">No canonical entities match “${cesc(query)}”.</div>`;
    results.querySelectorAll("[data-cleanup-global-result]").forEach((button) => {
      button.addEventListener("click", () => selectSearchResult(Number(button.dataset.cleanupGlobalResult)));
    });
  } catch (error) {
    if (error?.name === "AbortError") return;
    results.innerHTML = `<div class="global-search-empty error">${cesc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

function scheduleSearch() {
  clearTimeout(cleanupState.timer);
  cleanupState.timer = setTimeout(runSearch, 130);
}

function bindSearchOverride() {
  const input = c$("globalSemanticSearch");
  if (!input || input.dataset.wave1Search === "true") return;
  input.dataset.wave1Search = "true";
  input.addEventListener("input", (event) => {
    event.stopImmediatePropagation();
    scheduleSearch();
  }, true);
  input.addEventListener("focus", (event) => {
    event.stopImmediatePropagation();
    if ((input.value || "").trim().length >= 2) scheduleSearch();
  }, true);
  input.addEventListener("keydown", (event) => {
    event.stopImmediatePropagation();
    if (event.key === "ArrowDown" && cleanupState.results.length) {
      event.preventDefault();
      cleanupState.activeIndex = (cleanupState.activeIndex + 1) % cleanupState.results.length;
      paintSearchActive();
      openSearchResults();
    } else if (event.key === "ArrowUp" && cleanupState.results.length) {
      event.preventDefault();
      cleanupState.activeIndex = (cleanupState.activeIndex - 1 + cleanupState.results.length) % cleanupState.results.length;
      paintSearchActive();
      openSearchResults();
    } else if (event.key === "Enter" && cleanupState.activeIndex >= 0) {
      event.preventDefault();
      selectSearchResult(cleanupState.activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearchResults();
    }
  }, true);
}

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
}

function bindGlobalShortcuts() {
  if (document.documentElement.dataset.wave1Shortcuts === "true") return;
  document.documentElement.dataset.wave1Shortcuts = "true";
  document.addEventListener("keydown", (event) => {
    const search = c$("globalSemanticSearch");
    if (!search) return;
    const commandK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
    const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isTypingTarget(event.target);
    if (!commandK && !slash) return;
    event.preventDefault();
    search.focus();
    search.select();
  });
}

function bindConsistencyRefresh() {
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-view], [data-go]")) setTimeout(syncShellConsistency, 0);
  });
  const serverGrid = c$("serversGrid");
  if (serverGrid) {
    const observer = new MutationObserver(() => queueMicrotask(syncServerBoundary));
    observer.observe(serverGrid, { childList: true, subtree: false });
  }
}

function initWave1Cleanup() {
  installCleanupStyles();
  syncShellConsistency();
  bindSearchOverride();
  bindGlobalShortcuts();
  bindConsistencyRefresh();
  setTimeout(syncShellConsistency, 120);
  setTimeout(syncShellConsistency, 600);
}

initWave1Cleanup();
