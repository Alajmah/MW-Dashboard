const shellCopy = {
  overview: ["Overview", "Canonical operational view of physical placement, logical ownership, evidence quality and unresolved gaps."],
  inventory: ["Explore", "Search the canonical semantic estate with server-side pagination and explicit ownership, placement and evidence context."],
  servers: ["Servers", "Legacy snapshot view retained while server-specific canonical projections are migrated."],
  middleware: ["Middleware", "Legacy snapshot view retained while middleware-specific canonical projections are migrated."],
  applications: ["Applications", "Legacy snapshot view retained while application-specific canonical projections are migrated."],
  routes: ["Routes", "Trace canonical delivery semantics, runtime queue access and MQ transport while keeping access evidence distinct from actual PUT/GET activity."],
  snapshots: ["Snapshots", "Legacy discovery snapshot history retained for traceability."],
  administration: ["Administration", "Manual topology ingestion and activation."],
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
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function ensureLegacy() {
  if (!legacyPromise) {
    legacyPromise = import("/app.js").catch((error) => {
      legacyPromise = null;
      throw error;
    });
  }
  await legacyPromise;
}

async function ensureCanonicalRoutes() {
  if (!canonicalRoutesPromise) {
    canonicalRoutesPromise = import("/routes-estate.js").catch((error) => {
      canonicalRoutesPromise = null;
      throw error;
    });
  }
  await canonicalRoutesPromise;
}

function legacyView(view) {
  return ["servers", "middleware", "applications", "snapshots", "administration"].includes(view);
}

async function navigate(view) {
  shellSetView(view);
  try {
    if (view === "routes") {
      await ensureCanonicalRoutes();
      return;
    }
    if (legacyView(view)) await ensureLegacy();
  } catch (error) {
    const message = document.getElementById("globalMessage");
    if (message) {
      message.hidden = false;
      message.className = "global-message error";
      message.textContent = `${view === "routes" ? "Canonical route" : "Legacy view"} failed to load: ${error instanceof Error ? error.message : String(error)}`;
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
// the legacy module, so canonical view copy remains authoritative when returning
// to Overview, Explore, or Routes after a legacy view has been opened.
document.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
  if (view === "overview" || view === "inventory" || view === "routes") shellSetView(view);
});

shellSetView("overview");
