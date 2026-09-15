const TASK_FIRST_UI_REVISION = "20260915-4";

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

function applyTaskFirstStructure() {
  taskFirstStyles();
  replacePrimaryNavigation();
  refineGlobalSearch();
  ensureInvestigationPanel();
}

// Compatibility hook retained for shell callers. Task-specific data and
// operational semantics are owned by /api/v2/operator/* and rendered by
// operator-experience.js; this module only maintains structural shell affordances.
window.osiRefreshTaskFirstUI = () => applyTaskFirstStructure();

setTimeout(applyTaskFirstStructure, 0);
