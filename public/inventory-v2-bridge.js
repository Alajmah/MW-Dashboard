const rows = document.getElementById("inventoryRows");
let inventoryV2RefreshScheduled = false;

function requestInventoryV2Refresh() {
  if (inventoryV2RefreshScheduled) return;
  inventoryV2RefreshScheduled = true;
  setTimeout(() => {
    inventoryV2RefreshScheduled = false;
    document.getElementById("inventorySearch")?.dispatchEvent(new Event("input", { bubbles: true }));
  }, 0);
}

if (rows) {
  new MutationObserver(() => {
    if (rows.querySelector("tr[data-node-id]") && !rows.querySelector("tr[data-inv-node-id]")) {
      requestInventoryV2Refresh();
    }
  }).observe(rows, { childList: true });
}

document.addEventListener("click", event => {
  if (event.target.closest('[data-view="inventory"], #jumpInventory')) requestInventoryV2Refresh();
});

if (!document.querySelector('link[href="/semantic-ux.css"]')) {
  const semanticStyles = document.createElement("link");
  semanticStyles.rel = "stylesheet";
  semanticStyles.href = "/semantic-ux.css";
  document.head.appendChild(semanticStyles);
}

import("/semantic-ux.js").catch(error => console.error("Semantic UX layer failed to load", error));
