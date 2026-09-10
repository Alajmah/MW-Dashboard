const EXPLORE_PIVOT_REVISION = "20260910-4";

const pivotState = {
  sequence: 0,
  controller: null,
};

const pq = (id) => document.getElementById(id);
const psleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function currentView() {
  return document.querySelector(".nav-item.active")?.dataset.view || "overview";
}

async function pivotApi(path, signal) {
  const response = await fetch(path, { headers: { accept: "application/json" }, signal });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

function identityField(identityKey, field) {
  const match = String(identityKey || "").match(new RegExp(`(?:^|\\|)${field}=([^|]+)`, "i"));
  return match ? match[1] : "";
}

function firstProperty(entity, keys) {
  const properties = entity?.properties && typeof entity.properties === "object" ? entity.properties : {};
  for (const key of keys) {
    const value = properties[key] ?? properties[key.toLowerCase()] ?? properties[key.toUpperCase()];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function humanEntityName(entity, fallbackName = "") {
  const display = String(entity?.display_name || "").trim();
  if (display) return display;

  const propertyName = firstProperty(entity, [
    "QUEUE_MANAGER", "QUEUE_NAME", "CHANNEL_NAME", "LISTENER_NAME", "CLUSTER_NAME",
    "APPLICATION_NAME", "PROCESS_NAME", "TOPIC_NAME", "NAME", "FQDN",
  ]);
  if (propertyName) return propertyName;

  const identity = String(entity?.identity_key || "");
  for (const field of ["name", "queue_manager", "fqdn", "application", "process", "cluster"]) {
    const value = identityField(identity, field);
    if (value) return value;
  }
  return String(fallbackName || "").trim();
}

function closeCurrentDetail() {
  const content = pq("detailContent");
  if (!content || content.hidden) return;
  const close = pq("closeDetail");
  if (close) close.click();
  else {
    content.hidden = true;
    if (pq("detailEmpty")) pq("detailEmpty").hidden = false;
  }
}

function setPivotMessage(message, kind = "info") {
  let note = pq("explorePivotMessage");
  const panel = pq("inventoryRows")?.closest(".inventory-panel");
  if (!panel) return;
  if (!note) {
    note = document.createElement("div");
    note.id = "explorePivotMessage";
    note.className = "explore-pivot-message";
    panel.prepend(note);
  }
  note.className = `explore-pivot-message ${kind}`;
  note.textContent = message;
  note.hidden = !message;
}

function tableIsLoading() {
  const loading = pq("inventoryRows")?.querySelector(".estate-detail-loading");
  return Boolean(loading && /Loading canonical entities/i.test(loading.textContent || ""));
}

async function waitForTableSettled(sequence, minimumDelay = 0, timeoutMs = 5000) {
  if (minimumDelay) await psleep(minimumDelay);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (sequence !== pivotState.sequence) return false;
    if (!tableIsLoading()) {
      await psleep(60);
      if (sequence !== pivotState.sequence) return false;
      if (!tableIsLoading()) return true;
    }
    await psleep(40);
  }
  return false;
}

async function dispatchFilter(control, eventName, value, sequence, delay = 20) {
  if (!control || control.value === value) return true;
  control.value = value;
  control.dispatchEvent(new Event(eventName, { bubbles: true }));
  return waitForTableSettled(sequence, delay);
}

async function waitForEntityRow(entityId, sequence, timeoutMs = 4500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (sequence !== pivotState.sequence) return null;
    const row = document.querySelector(`tr[data-estate-entity-id="${CSS.escape(entityId)}"]`);
    if (row) return row;
    await psleep(70);
  }
  return null;
}

async function pivotToRelationshipTarget(entityId, fallbackName = "", fallbackType = "") {
  if (!entityId || currentView() !== "inventory") return;
  const sequence = ++pivotState.sequence;
  pivotState.controller?.abort();
  const controller = new AbortController();
  pivotState.controller = controller;

  closeCurrentDetail();
  setPivotMessage("Opening related canonical entity…", "info");

  try {
    const data = await pivotApi(`/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=1`, controller.signal);
    if (sequence !== pivotState.sequence) return;
    const target = data.entity || null;
    if (!target) throw new Error("Related canonical entity was not found");

    const name = humanEntityName(target, fallbackName);
    const type = String(target.semantic_type || fallbackType || "");
    if (!name) throw new Error("Related entity has no searchable display name");

    const search = pq("inventorySearch");
    const typeSelect = pq("inventoryType");
    const identitySelect = pq("inventoryServer");
    if (!search || !typeSelect || !identitySelect) throw new Error("Explore controls are unavailable");

    // Serialize state changes. The base canonical renderer starts a request for each
    // control event, so wait for each request to settle before issuing the next.
    if (!(await dispatchFilter(identitySelect, "change", "", sequence))) throw new Error("Identity filter did not settle");

    const typeAvailable = [...typeSelect.options].some((option) => option.value === type);
    if (typeAvailable && !(await dispatchFilter(typeSelect, "change", type, sequence))) {
      throw new Error("Semantic type filter did not settle");
    }

    if (sequence !== pivotState.sequence) return;
    search.value = name;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    if (!(await waitForTableSettled(sequence, 260))) throw new Error("Related entity search did not settle");

    let row = await waitForEntityRow(entityId, sequence, 1800);
    if (!row && typeAvailable) {
      // A type-specific list can be transiently stale after a legacy view. Retry once
      // in the canonical all-types scope using the same human-facing name.
      if (!(await dispatchFilter(typeSelect, "change", "", sequence))) throw new Error("Explore scope did not settle");
      search.value = name;
      search.dispatchEvent(new Event("input", { bubbles: true }));
      if (!(await waitForTableSettled(sequence, 260))) throw new Error("Related entity retry did not settle");
      row = await waitForEntityRow(entityId, sequence, 1800);
    }

    if (sequence !== pivotState.sequence) return;
    if (!row) throw new Error(`Related entity “${name}” is not visible in the current canonical result set`);

    setPivotMessage("", "info");
    row.click();
    row.scrollIntoView({ block: "center", behavior: "auto" });
  } catch (error) {
    if (error?.name === "AbortError" || sequence !== pivotState.sequence) return;
    closeCurrentDetail();
    setPivotMessage(error instanceof Error ? error.message : String(error), "error");
  } finally {
    if (pivotState.controller === controller) pivotState.controller = null;
  }
}

function normalizeRelationshipCount() {
  const target = pq("detailRelationships");
  if (!target) return;
  const items = target.querySelectorAll("[data-neighbor-id]").length;
  if (items < 100) return;
  const summary = target.querySelector(".explore-relation-summary");
  const last = summary?.querySelector("span:last-child");
  if (last) {
    last.innerHTML = `<strong>${items}</strong> shown`;
    last.title = "Relationship detail is capped at 100 records in this view";
  }
}

function guardFailedQueryState() {
  const rows = pq("inventoryRows");
  if (!rows) return;
  const text = rows.textContent || "";
  const failed = /canonical estate query failed|request failed|estate is stale|not available/i.test(text);
  if (!failed) return;
  closeCurrentDetail();
  const count = pq("inventoryCount");
  if (count) count.textContent = "Canonical estate query failed";
}

function installPivotGuards() {
  document.addEventListener("click", (event) => {
    const relation = event.target.closest("#detailRelationships [data-neighbor-id]");
    if (!relation || currentView() !== "inventory") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void pivotToRelationshipTarget(
      relation.dataset.neighborId || "",
      relation.dataset.neighborName || "",
      relation.dataset.neighborType || "",
    );
  }, true);

  const rows = pq("inventoryRows");
  if (rows) {
    const observer = new MutationObserver(() => guardFailedQueryState());
    observer.observe(rows, { childList: true, subtree: false });
  }

  const relationships = pq("detailRelationships");
  if (relationships) {
    const observer = new MutationObserver(() => queueMicrotask(normalizeRelationshipCount));
    observer.observe(relationships, { childList: true, subtree: false });
    normalizeRelationshipCount();
  }
}

async function initExplorePivot() {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (pq("inventoryRows") && pq("inventoryType") && pq("detailRelationships")) {
      installPivotGuards();
      return;
    }
    await psleep(80);
  }
}

window.osiPivotToCanonicalEntity = pivotToRelationshipTarget;
void initExplorePivot();
