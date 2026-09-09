const shellCopy = {
  overview: ["Overview", "Canonical operational view of physical placement, logical ownership, evidence quality and unresolved gaps."],
  inventory: ["Explore", "Search the canonical semantic estate with server-side pagination and explicit ownership, placement and evidence context."],
  servers: ["Servers", "Legacy snapshot view retained while server-specific canonical projections are migrated."],
  middleware: ["Middleware", "Legacy snapshot view retained while middleware-specific canonical projections are migrated."],
  applications: ["Applications", "Legacy snapshot view retained while application-specific canonical projections are migrated."],
  routes: ["Routes", "Trace evidence-backed message delivery paths. Route migration to the canonical estate is the next data-plane slice."],
  snapshots: ["Snapshots", "Legacy discovery snapshot history retained for traceability."],
  administration: ["Administration", "Manual topology ingestion and activation."],
};

let legacyPromise = null;
let routesPromise = null;

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

async function ensureLegacy(view) {
  if (!legacyPromise) {
    legacyPromise = import("/app.js").catch((error) => {
      legacyPromise = null;
      throw error;
    });
  }
  await legacyPromise;
  if (view === "routes" && !routesPromise) {
    routesPromise = import("/routes-v2.js").catch((error) => {
      routesPromise = null;
      throw error;
    });
    await routesPromise;
  }
}

function legacyView(view) {
  return ["servers", "middleware", "applications", "routes", "snapshots", "administration"].includes(view);
}

async function navigate(view) {
  shellSetView(view);
  if (!legacyView(view)) return;
  try {
    await ensureLegacy(view);
  } catch (error) {
    const message = document.getElementById("globalMessage");
    if (message) {
      message.hidden = false;
      message.className = "global-message error";
      message.textContent = `Legacy view failed to load: ${error instanceof Error ? error.message : String(error)}`;
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
// to Overview or Explore after a legacy view has been opened.
document.addEventListener("click", (event) => {
  const view = event.target.closest("[data-view]")?.dataset.view || event.target.closest("[data-go]")?.dataset.go;
  if (view === "overview" || view === "inventory") shellSetView(view);
});

shellSetView("overview");
