const TASK_FIRST_UI_REVISION = "20260915-5";
const INSPECTION_CONTEXT_KEY = "osi.inspection.context.v1";

const taskEsc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

function normalizeInspectionContext(raw) {
  const context = raw && typeof raw === "object" ? raw : {};
  const finding = context.finding?.id ? { id: String(context.finding.id), label: String(context.finding.label || context.finding.id) } : null;
  const entity = context.entity?.id ? { id: String(context.entity.id), label: String(context.entity.label || context.entity.id) } : null;
  const path = context.path && (Number.isInteger(context.path.index) || context.path.label)
    ? { index: Number.isInteger(context.path.index) ? context.path.index : null, label: String(context.path.label || "Selected path") }
    : null;
  const available = { finding, entity, path };
  const primary = available[context.primary] ? context.primary : finding ? "finding" : entity ? "entity" : path ? "path" : null;
  return { version: 1, primary, finding, entity, path };
}

function readInspectionContext() {
  try {
    return normalizeInspectionContext(JSON.parse(sessionStorage.getItem(INSPECTION_CONTEXT_KEY) || "null"));
  } catch {
    return normalizeInspectionContext(null);
  }
}

let inspectionContext = readInspectionContext();

function inspectionContextEmpty(context = inspectionContext) {
  return !context.finding && !context.entity && !context.path;
}

function persistInspectionContext() {
  try {
    if (inspectionContextEmpty()) sessionStorage.removeItem(INSPECTION_CONTEXT_KEY);
    else sessionStorage.setItem(INSPECTION_CONTEXT_KEY, JSON.stringify(inspectionContext));
  } catch {}
  window.dispatchEvent(new CustomEvent("osi:inspection-context", { detail: { ...inspectionContext } }));
}

function updateInspectionContext(kind, anchor, makePrimary = true) {
  if (!["finding", "entity", "path"].includes(kind) || !anchor) return;
  inspectionContext = normalizeInspectionContext({
    ...inspectionContext,
    [kind]: anchor,
    primary: makePrimary ? kind : inspectionContext.primary,
  });
  persistInspectionContext();
  renderInspectionContext();
}

function clearInspectionContext() {
  inspectionContext = normalizeInspectionContext(null);
  persistInspectionContext();
  renderInspectionContext();
}

function taskFirstStyles() {
  if (document.querySelector('link[data-task-first-shell]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/task-first-shell.css?v=${TASK_FIRST_UI_REVISION}`;
  link.dataset.taskFirstShell = "true";
  document.head.appendChild(link);
}

function replacePrimaryNavigation() {
  const nav = document.querySelector(".nav");
  if (!nav) return;
  const expected = [
    ["overview", "Operations"],
    ["routes", "Paths"],
    ["inventory", "Explore"],
    ["investigations", "Investigations"],
    ["snapshots", "Collection"],
  ];
  const current = [...nav.querySelectorAll("[data-view]")].map((item) => item.dataset.view).join("|");
  if (current !== expected.map(([view]) => view).join("|")) {
    nav.innerHTML = expected
      .map(([view, label], index) => `<button class="nav-item${index === 0 ? " active" : ""}" data-view="${view}">${label}</button>`)
      .join("");
  }
  const brandSubtitle = document.querySelector(".brand span");
  if (brandSubtitle) brandSubtitle.textContent = "Operational Intelligence";
}

function refineGlobalSearch() {
  document.querySelector(".task-global-search")?.remove();
  const input = document.getElementById("globalSemanticSearch");
  if (!input) return;
  input.placeholder = "Search objects, services, hosts, queues…";
  input.setAttribute("aria-label", "Search canonical estate");
  input.title = "Search canonical estate (/)";
}

function ensureInvestigationPanel() {
  if (document.querySelector('[data-view-panel="investigations"]')) return;
  const main = document.getElementById("mainContent");
  if (!main) return;
  const panel = document.createElement("section");
  panel.id = "view-investigations";
  panel.className = "view";
  panel.dataset.viewPanel = "investigations";
  const collection = document.querySelector('[data-view-panel="snapshots"]');
  if (collection) main.insertBefore(panel, collection);
  else main.appendChild(panel);
}

function ensureInspectionContextHost() {
  const main = document.getElementById("mainContent");
  if (!main) return null;
  let host = document.getElementById("taskInspectionContext");
  if (host) return host;
  host = document.createElement("section");
  host.id = "taskInspectionContext";
  host.className = "task-inspection-context";
  host.hidden = true;
  host.setAttribute("aria-live", "polite");
  const message = document.getElementById("globalMessage");
  if (message) message.insertAdjacentElement("afterend", host);
  else main.querySelector(".topbar")?.insertAdjacentElement("afterend", host);
  return host;
}

function currentTaskView() {
  return document.querySelector('.view.active[data-view-panel]')?.dataset.viewPanel || "overview";
}

function contextPrimaryAnchor() {
  return inspectionContext[inspectionContext.primary] || inspectionContext.finding || inspectionContext.entity || inspectionContext.path;
}

function contextPrimaryLabel() {
  const anchor = contextPrimaryAnchor();
  if (!anchor) return "";
  if (inspectionContext.primary === "finding") return `Finding · ${anchor.label}`;
  if (inspectionContext.primary === "entity") return `Object · ${anchor.label}`;
  if (inspectionContext.primary === "path") return `Path · ${anchor.label}`;
  return anchor.label || "Inspection focus";
}

function contextJumpButton(kind, label, targetView) {
  const anchor = inspectionContext[kind];
  if (!anchor) return "";
  const active = currentTaskView() === targetView ? " active" : "";
  return `<button type="button" class="task-context-jump${active}" data-task-context-jump="${kind}">${taskEsc(label)}</button>`;
}

function renderInspectionContext() {
  const host = ensureInspectionContextHost();
  if (!host) return;
  if (inspectionContextEmpty()) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  host.innerHTML = `<div class="task-context-copy"><span>Inspection context</span><strong>${taskEsc(contextPrimaryLabel())}</strong><small>Session focus; availability is revalidated when opened. This navigation state is not evidence.</small></div><div class="task-context-actions">${contextJumpButton("finding", "Investigation", "investigations")}${contextJumpButton("path", "Path", "routes")}${contextJumpButton("entity", "Object", "inventory")}<button type="button" class="task-context-clear" data-task-context-clear>Clear</button></div>`;
}

function labelWithin(element, fallback) {
  const label = element?.querySelector?.("strong")?.textContent?.trim();
  return label || fallback;
}

function waitForPathRestore(anchor, attempt = 0) {
  const select = document.getElementById("oePathSelect");
  if (!select || select.disabled || !select.options.length || select.options[0]?.textContent?.includes("Loading")) {
    if (attempt < 30) setTimeout(() => waitForPathRestore(anchor, attempt + 1), 100);
    return;
  }
  const options = [...select.options];
  const exactIndex = anchor.index != null ? options.find((option) => Number(option.value) === Number(anchor.index)) : null;
  const matchingLabel = options.find((option) => option.textContent.trim() === anchor.label);
  const option = matchingLabel || exactIndex;
  if (!option) return;
  select.value = option.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function syntheticOperatorClick(attribute, value) {
  const button = document.createElement("button");
  button.type = "button";
  button.hidden = true;
  button.setAttribute(attribute, value);
  document.body.appendChild(button);
  button.click();
  button.remove();
}

function restoreInspectionAnchor(kind) {
  const anchor = inspectionContext[kind];
  if (!anchor || !window.osiNavigateProduct) return;
  if (kind === "finding") {
    try { sessionStorage.setItem("osi.oe.focus", anchor.id); } catch {}
    window.osiNavigateProduct("investigations");
    setTimeout(() => syntheticOperatorClick("data-oe-finding", anchor.id), 40);
    return;
  }
  if (kind === "entity") {
    window.osiNavigateProduct("inventory");
    setTimeout(() => syntheticOperatorClick("data-oe-inspect-entity", anchor.id), 40);
    return;
  }
  window.osiNavigateProduct("routes");
  setTimeout(() => waitForPathRestore(anchor), 60);
}

function captureInspectionClick(event) {
  const jump = event.target.closest?.("[data-task-context-jump]");
  if (jump) {
    event.preventDefault();
    event.stopPropagation();
    restoreInspectionAnchor(jump.dataset.taskContextJump);
    return;
  }
  if (event.target.closest?.("[data-task-context-clear]")) {
    event.preventDefault();
    event.stopPropagation();
    clearInspectionContext();
    return;
  }

  const finding = event.target.closest?.("[data-oe-finding]");
  if (finding?.dataset.oeFinding) {
    updateInspectionContext("finding", { id: finding.dataset.oeFinding, label: labelWithin(finding, finding.dataset.oeFinding) });
    return;
  }
  const directEntity = event.target.closest?.("[data-oe-entity]");
  if (directEntity?.dataset.oeEntity) {
    updateInspectionContext("entity", { id: directEntity.dataset.oeEntity, label: labelWithin(directEntity, directEntity.dataset.oeEntity) });
    return;
  }
  const inspectEntity = event.target.closest?.("[data-oe-inspect-entity]");
  if (inspectEntity?.dataset.oeInspectEntity) {
    const previous = inspectionContext.entity?.id === inspectEntity.dataset.oeInspectEntity ? inspectionContext.entity.label : null;
    updateInspectionContext("entity", { id: inspectEntity.dataset.oeInspectEntity, label: previous || inspectEntity.dataset.oeInspectEntity });
    return;
  }
  const overviewPath = event.target.closest?.("[data-oe-overview-path]");
  if (overviewPath) {
    const index = Number(overviewPath.dataset.oeOverviewPath || 0);
    updateInspectionContext("path", { index: Number.isFinite(index) ? index : null, label: labelWithin(overviewPath, "Selected path") });
  }
}

function captureInspectionChange(event) {
  if (event.target?.id !== "oePathSelect") return;
  const select = event.target;
  const option = select.options[select.selectedIndex];
  const index = Number(select.value);
  updateInspectionContext("path", {
    index: Number.isFinite(index) ? index : null,
    label: option?.textContent?.trim() || "Selected path",
  });
}

function applyTaskFirstStructure() {
  taskFirstStyles();
  replacePrimaryNavigation();
  refineGlobalSearch();
  ensureInvestigationPanel();
  renderInspectionContext();
}

// Shared inspection context is browser-session navigation state only. It carries
// known finding/entity/path anchors across pivots without deriving relationships,
// changing canonical meaning, or turning a UI selection into evidence.
document.addEventListener("click", captureInspectionClick, true);
document.addEventListener("change", captureInspectionChange, true);

window.osiGetInspectionContext = () => JSON.parse(JSON.stringify(inspectionContext));
window.osiSetInspectionContext = (kind, anchor, makePrimary = true) => updateInspectionContext(kind, anchor, makePrimary);
window.osiClearInspectionContext = clearInspectionContext;

// Compatibility hook retained for shell callers. Task-specific data and
// operational semantics are owned by /api/v2/operator/* and rendered by
// operator-experience.js; this module maintains structural shell affordances and
// session-scoped inspection navigation only.
window.osiRefreshTaskFirstUI = () => applyTaskFirstStructure();

setTimeout(applyTaskFirstStructure, 0);
