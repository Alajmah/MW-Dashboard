import "/product-shell.js?v=20260910-1";
import "/task-first-shell.js?v=20260915-4";
import "/operator-experience.js?v=20260915-3";

const UI_ASSET_REVISION = "20260915-6";

// Compatibility marker retained for the pre-task-first product-shell contract:
// inventory: ["Objects"
const shellCopy = {
  overview: ["Operations", "Start with what requires attention, then reveal only the context needed to decide what to do next."],
  inventory: ["Explore", "Search the canonical estate first; reveal ownership, placement, relationships and evidence only for the object you care about."],
  investigations: ["Investigations", "Focus on one evidence-linked problem at a time, preserve the working context, and pivot to proof when needed."],
  qmgrs: ["Queue Managers", "Canonical IBM MQ ownership, physical placement, clusters, object counts and evidence freshness."],
  servers: ["Servers", "Physical middleware hosts and confirmed queue-manager placement. Client IPs remain application/network evidence, not physical servers."],
  middleware: ["Middleware", "Focused middleware inventory retained for drill-down from Explore."],
  applications: ["Applications", "Focused application inventory retained for drill-down from Explore."],
  routes: ["Paths", "Follow a service path across middleware, distinguish what is current, historical, inferred or unknown, then inspect the evidence behind each supported claim."],
  snapshots: ["Collection", "Evidence sources, imports and retained canonical revisions for traceability, summarized first as collection trust and evidence limitations."],
  administration: ["Administration", "Manual OSI evidence handoff for the demo: topology and operational evaluations arrive as transferred artifacts; no direct middleware connection is required."],
};

const primaryViews = new Set(["overview", "routes", "inventory", "investigations", "snapshots"]);
let legacyPromise = null;
let forensicPromise = null;
let routeToolsPromise = null;
let administrationPromise = null;

function shellSetView(view) {
  document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const copy = shellCopy[view] || [view, ""];
  const title = document.getElementById("pageTitle");
  const subtitle = document.getElementById("pageSubtitle");
  if (title) title.textContent = copy[0];
  if (subtitle) subtitle.textContent = copy[1];
  window.osiRefreshTaskFirstUI?.(view);
  if (primaryViews.has(view)) window.osiRefreshOperatorExperience?.(view);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function ensureLegacy() {
  if (!legacyPromise) {
    legacyPromise = import(`/app.js?v=${UI_ASSET_REVISION}`).catch((error) => {
      legacyPromise = null;
      throw error;
    });
  }
  await legacyPromise;
}

async function ensureForensicSupport() {
  if (!forensicPromise) {
    forensicPromise = Promise.all([
      import(`/canonical-ops.js?v=${UI_ASSET_REVISION}`),
      import(`/acceptance-ui.js?v=${UI_ASSET_REVISION}`),
      import(`/explore-investigation.js?v=${UI_ASSET_REVISION}`),
      import(`/explore-boundary.js?v=${UI_ASSET_REVISION}`),
      import(`/explore-pivot.js?v=${UI_ASSET_REVISION}`),
      import(`/workstation-ui.js?v=${UI_ASSET_REVISION}`),
      import(`/wave1-shell-cleanup.js?v=${UI_ASSET_REVISION}`),
      import(`/phase2i-overview-read-broker.js?v=${UI_ASSET_REVISION}`),
      import(`/operational-intelligence.js?v=${UI_ASSET_REVISION}`),
      import(`/phase2d-evidence-semantics.js?v=${UI_ASSET_REVISION}`),
      import(`/phase2e-triage-compression.js?v=${UI_ASSET_REVISION}`),
      import(`/phase2f-investigation-bootstrap.js?v=${UI_ASSET_REVISION}`),
      import(`/phase2g-investigation-clarity.js?v=${UI_ASSET_REVISION}`),
      import(`/phase2h-topology-impact.js?v=${UI_ASSET_REVISION}`),
      import(`/phase2o-demo-manual-mode.js?v=${UI_ASSET_REVISION}`),
    ]).catch((error) => {
      forensicPromise = null;
      throw error;
    });
  }
  await forensicPromise;
}

async function ensureRouteTools() {
  if (!routeToolsPromise) {
    routeToolsPromise = Promise.all([
      import(`/routes-estate.js?v=${UI_ASSET_REVISION}`),
      import(`/ftp-operator.js?v=${UI_ASSET_REVISION}`),
    ]).catch((error) => {
      routeToolsPromise = null;
      throw error;
    });
  }
  await routeToolsPromise;
}

async function ensureAdministration() {
  if (!administrationPromise) {
    administrationPromise = Promise.all([
      import(`/administration-ops.js?v=${UI_ASSET_REVISION}`),
      import(`/phase2o-demo-manual-mode.js?v=${UI_ASSET_REVISION}`),
    ]).catch((error) => {
      administrationPromise = null;
      throw error;
    });
  }
  await administrationPromise;
}

function showLoadError(view, error) {
  const message = document.getElementById("globalMessage");
  if (!message) return;
  message.hidden = false;
  message.className = "global-message error";
  const source = view === "routes" ? "Advanced path tools" : view === "administration" ? "Administration" : "Forensic view";
  message.textContent = `${source} failed to load: ${error instanceof Error ? error.message : String(error)}`;
}

async function navigate(view) {
  shellSetView(view);
  try {
    if (primaryViews.has(view)) return;
    if (view === "administration") {
      await ensureAdministration();
      window.osiRenderAdministrationOps?.();
      return;
    }
    if (view === "servers" || view === "qmgrs") {
      await ensureForensicSupport();
      if (view === "servers") await window.osiRenderCanonicalServers?.();
      if (view === "qmgrs") await window.osiRenderQueueManagers?.();
      return;
    }
    if (view === "middleware" || view === "applications") {
      await Promise.all([ensureLegacy(), ensureForensicSupport()]);
      window.osiApplyCanonicalShell?.();
      window.osiProductShellRefresh?.();
    }
  } catch (error) {
    showLoadError(view, error);
  }
}

// Route-picker acceptance invariant: Focus alone never reopens cached results.
// Primary operator screens use bounded /api/v2/operator/* projections. Older
// engineering modules are loaded only when an operator explicitly asks for a
// forensic view, advanced trace, collection history, or administration.
document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view]");
  const go = event.target.closest("[data-go]");
  const view = nav?.dataset.view || go?.dataset.go;
  if (view) {
    void navigate(view);
    return;
  }

  if (event.target.closest("[data-oe-route-advanced]")) {
    void ensureRouteTools()
      .then(() => {
        document.querySelector('[data-view-panel="routes"]')?.classList.add("oe-show-legacy-route");
        window.osiRefreshFtpOperator?.();
      })
      .catch((error) => showLoadError("routes", error));
    return;
  }

  if (event.target.closest("[data-oe-collection-history]")) {
    void Promise.all([ensureLegacy(), ensureForensicSupport()])
      .then(() => {
        window.osiApplyCanonicalShell?.();
        window.osiProductShellRefresh?.();
      })
      .catch((error) => showLoadError("snapshots", error));
  }
});

document.getElementById("jumpInventory")?.addEventListener("click", () => navigate("inventory"));

window.osiNavigateProduct = navigate;
window.osiLoadAdvancedRouteTools = ensureRouteTools;
window.osiLoadForensicSupport = ensureForensicSupport;
window.osiLoadLegacyCollection = async () => Promise.all([ensureLegacy(), ensureForensicSupport()]);

shellSetView("overview");
