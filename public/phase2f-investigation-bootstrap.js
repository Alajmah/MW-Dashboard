import "/phase2f-investigation-workbench.js?v=20260911-1";

const baseOpenObjectWorkspace = window.osiOpenObjectWorkspace;
let lastEnhancedEntity = "";
let enhancementTimer = null;

async function fetchCanonical(entityId) {
  const response = await fetch(`/api/v2/estate/current/entities/${encodeURIComponent(entityId)}?relation_limit=100`, { headers: { accept: "application/json" } });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
  return body;
}

async function enhanceEntity(entityId, { force = false } = {}) {
  if (!entityId || typeof window.osiEnhanceObjectWorkspace !== "function") return;
  if (!force && lastEnhancedEntity === entityId) return;
  const canonical = await fetchCanonical(entityId);
  if (document.getElementById("objectWorkspace")?.hidden) return;
  lastEnhancedEntity = entityId;
  await window.osiEnhanceObjectWorkspace(canonical);
}

if (typeof baseOpenObjectWorkspace === "function") {
  window.osiOpenObjectWorkspace = async (entityId, pushHistory = true) => {
    await baseOpenObjectWorkspace(entityId, pushHistory);
    try { await enhanceEntity(entityId, { force: true }); } catch (error) { console.warn("Phase 2F investigation enhancement failed", error); }
  };
  window.osiOpenInvestigationWorkspace = window.osiOpenObjectWorkspace;
}

function scheduleWorkspaceEnhancement() {
  clearTimeout(enhancementTimer);
  enhancementTimer = setTimeout(async () => {
    const workspace = document.getElementById("objectWorkspace");
    if (!workspace || workspace.hidden) { lastEnhancedEntity = ""; return; }
    const entityId = new URL(window.location.href).searchParams.get("entity") || "";
    if (!entityId) return;
    try { await enhanceEntity(entityId); } catch (error) { console.warn("Phase 2F workspace observer failed", error); }
  }, 180);
}

function observeWorkspace() {
  const workspace = document.getElementById("objectWorkspace");
  if (!workspace) { setTimeout(observeWorkspace, 180); return; }
  new MutationObserver(scheduleWorkspaceEnhancement).observe(workspace, { attributes: true, attributeFilter: ["hidden"] });
  scheduleWorkspaceEnhancement();
}

window.addEventListener("popstate", scheduleWorkspaceEnhancement);
observeWorkspace();
