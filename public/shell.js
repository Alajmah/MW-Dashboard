import "/product-shell.js?v=20260910-1";
import "/canonical-ops.js?v=20260910-4";
import "/acceptance-ui.js?v=20260910-4";
import "/explore-investigation.js?v=20260910-4";
import "/explore-boundary.js?v=20260910-4";
import "/explore-pivot.js?v=20260910-4";
import "/workstation-ui.js?v=20260910-1";
import "/wave1-shell-cleanup.js?v=20260910-1";
import "/operational-intelligence.js?v=20260910-1";
import "/phase2d-evidence-semantics.js?v=20260911-1";
import "/phase2e-triage-compression.js?v=20260911-1";
import "/phase2f-investigation-bootstrap.js?v=20260911-1";
import "/phase2g-investigation-clarity.js?v=20260911-1";
import "/administration-ops.js?v=20260911-1";

const UI_ASSET_REVISION = "20260911-5";

const shellCopy = {
  overview: ["Overview", "Evidence-backed operational attention across the current canonical middleware estate."],
  inventory: ["Objects", "Search and investigate canonical middleware objects with explicit ownership, placement and evidence context."],
  qmgrs: ["Queue Managers", "Canonical IBM MQ ownership, physical placement, clusters, object counts and evidence freshness."],
  servers: ["Servers", "Physical middleware hosts and confirmed queue-manager placement. Client IPs remain application/network evidence, not physical servers."],
  middleware: ["Middleware", "Legacy snapshot view retained while middleware-specific canonical projections are migrated."],
  applications: ["Applications", "Legacy snapshot view retained while application-specific canonical projections are migrated."],
  routes: ["Routes", "Trace canonical delivery semantics, runtime queue access and MQ transport while keeping access evidence distinct from actual PUT/GET activity."],
  snapshots: ["Collection", "Evidence sources, imports and retained canonical revisions for traceability."],
  administration: ["Administration", "Protected ingestion for canonical topology sources and OSI operational evaluations."],
};

let legacyPromise = null;
let canonicalRoutesPromise = null;

function shellSetView(view) {
  document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  const copy = shellCopy[view] || [view, ""];
  const title = document.getElementById("pageTitle");
  const subtitle = document.getElementById("pageSubtitle");
  if (title) title.textContent = copy[0];
  if (subtitle) subtitle.textContent = copy[1];
  window.osiApplyCanonicalShell?.();
  window.osiRefreshWorkstationUI?.();
  window.osiProductShellRefresh?.();
  window.osiRefreshOperationalIntelligence?.();
  window.osiRefreshEvidenceSemantics?.();
  window.osiRefreshTriageCompression?.();
  if (view === "administration") window.osiRenderAdministrationOps?.();
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

async function ensureCanonicalRoutes() {
  if (!canonicalRoutesPromise) {
    canonicalRoutesPromise = import(`/routes-estate.js?v=${UI_ASSET_REVISION}`).catch((error) => {
      canonicalRoutesPromise = null;
      throw error;
    });
  }
  await canonicalRoutesPromise;
}

function legacyView(view) {
  return ["middleware", "applications", "snapshots"].includes(view);
}

async function navigate(view) {
  shellSetView(view);
  try {
    if (view === "routes") {
      await ensureCanonicalRoutes();
      return;
    }
    if (view === "servers") {
      await window.osiRenderCanonicalServers?.();
      return;
    }
    if (view === "qmgrs") {
      await window.osiRenderQueueManagers?.();
      return;
    }
    if (view === "inventory") {
      await window.osiRestoreCanonicalExploreControls?.();
      window.osiProductShellRefresh?.();
      window.osiRefreshOperationalIntelligence?.();
      window.osiRefreshEvidenceSemantics?.();
      window.osiRefreshTriageCompression?.();
      return;
    }
    if (view === "administration") {
      window.osiRenderAdministrationOps?.();
      return;
    }
    if (legacyView(view)) {
      await ensureLegacy();
      window.osiApplyCanonicalShell?.();
      window.osiProductShellRefresh?.();
    }
  } catch (error) {
    const message = document.getElementById("globalMessage");
    if (message) {
      message.hidden = false;
      message.className = "global-message error";
      const source = view === "routes" ? "Canonical route" : view === "servers" ? "Canonical server" : view === "qmgrs" ? "Canonical queue manager" : view === "administration" ? "Administration" : "Legacy view";
      message.textContent = `${source} failed to load: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => navigate(button.dataset.view));
});
document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => navigate(button.dataset.go));
});
document.getElementById("jumpInventory")?.addEventListener("click", () => navigate("inventory"));

// This document-level listener runs after any later direct listeners installed by
// the legacy module, so canonical screens remain authoritative even after a legacy
// module has been loaded during the same browser session.
document.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
  if (["overview", "inventory", "routes", "servers", "qmgrs", "administration"].includes(view)) {
    shellSetView(view);
    if (view === "servers") setTimeout(() => window.osiRenderCanonicalServers?.(), 0);
    if (view === "qmgrs") setTimeout(() => window.osiRenderQueueManagers?.(), 0);
    if (view === "overview") {
      setTimeout(() => window.osiRenderQmgrLedger?.(), 0);
      setTimeout(() => window.osiRefreshOperationalIntelligence?.(), 80);
      setTimeout(() => window.osiRefreshEvidenceSemantics?.(), 220);
      setTimeout(() => window.osiRefreshTriageCompression?.(), 360);
    }
    if (view === "inventory") {
      setTimeout(() => window.osiRestoreCanonicalExploreControls?.(), 0);
      setTimeout(() => window.osiRestoreCanonicalExploreControls?.(), 120);
      setTimeout(() => window.osiRefreshWorkstationUI?.(), 160);
      setTimeout(() => window.osiProductShellRefresh?.(), 180);
      setTimeout(() => window.osiRefreshOperationalIntelligence?.(), 200);
      setTimeout(() => window.osiRefreshEvidenceSemantics?.(), 240);
      setTimeout(() => window.osiRefreshTriageCompression?.(), 300);
    }
    if (view === "routes") setTimeout(() => window.osiRefreshWorkstationUI?.(), 120);
    if (view === "administration") setTimeout(() => window.osiRenderAdministrationOps?.(), 0);
  }
});

window.osiNavigateProduct = navigate;
shellSetView("overview");
