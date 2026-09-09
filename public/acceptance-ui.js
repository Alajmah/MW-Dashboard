const pickerState = { from: -1, to: -1 };

function ensureAcceptanceStyles() {
  if (document.getElementById("acceptanceUiCss")) return;
  const link = document.createElement("link");
  link.id = "acceptanceUiCss";
  link.rel = "stylesheet";
  link.href = "/acceptance-ui.css";
  document.head.appendChild(link);
}

function pickerSide(input) {
  if (input?.id === "routeFrom") return "from";
  if (input?.id === "routeTo") return "to";
  return null;
}

function pickerElements(side) {
  const input = document.getElementById(side === "from" ? "routeFrom" : "routeTo");
  const results = document.getElementById(side === "from" ? "routeFromResults" : "routeToResults");
  return { input, results };
}

function suggestionButtons(side) {
  return [...(pickerElements(side).results?.querySelectorAll("[data-route-entity]") || [])];
}

function syncExpanded(side) {
  const { input, results } = pickerElements(side);
  if (!input || !results) return;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", results.id);
  input.setAttribute("aria-expanded", results.classList.contains("open") ? "true" : "false");
  results.setAttribute("role", "listbox");
}

function setPickerActive(side, nextIndex) {
  const buttons = suggestionButtons(side);
  if (!buttons.length) {
    pickerState[side] = -1;
    return;
  }
  const index = Math.max(0, Math.min(buttons.length - 1, nextIndex));
  pickerState[side] = index;
  buttons.forEach((button, buttonIndex) => {
    const active = buttonIndex === index;
    button.classList.toggle("keyboard-active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.setAttribute("role", "option");
    if (active) button.scrollIntoView({ block: "nearest" });
  });
}

function resetPickerActive(side) {
  pickerState[side] = -1;
  suggestionButtons(side).forEach((button) => {
    button.classList.remove("keyboard-active");
    button.setAttribute("aria-selected", "false");
    button.setAttribute("role", "option");
    const name = button.querySelector("strong")?.textContent?.trim();
    if (name) button.title = name;
  });
}

function closePicker(side) {
  const { input, results } = pickerElements(side);
  results?.classList.remove("open");
  input?.setAttribute("aria-expanded", "false");
  resetPickerActive(side);
}

function selectPickerButton(side, button) {
  if (!button) return;
  button.click();
  const { input } = pickerElements(side);
  requestAnimationFrame(() => {
    if (!input) return;
    input.scrollLeft = 0;
    try { input.setSelectionRange(0, 0); } catch {}
    input.setAttribute("aria-expanded", "false");
  });
}

function bindRouteComboboxes() {
  for (const side of ["from", "to"]) {
    const { input, results } = pickerElements(side);
    if (!input || !results || input.dataset.acceptanceBound === "true") continue;
    input.dataset.acceptanceBound = "true";
    syncExpanded(side);

    const observer = new MutationObserver(() => {
      resetPickerActive(side);
      syncExpanded(side);
    });
    observer.observe(results, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

    input.addEventListener("input", () => resetPickerActive(side));
    input.addEventListener("keydown", (event) => {
      const buttons = suggestionButtons(side);
      const open = results.classList.contains("open");
      if (event.key === "ArrowDown") {
        if (!buttons.length) return;
        event.preventDefault();
        if (!open) results.classList.add("open");
        setPickerActive(side, pickerState[side] < 0 ? 0 : pickerState[side] + 1);
        syncExpanded(side);
        return;
      }
      if (event.key === "ArrowUp") {
        if (!buttons.length) return;
        event.preventDefault();
        if (!open) results.classList.add("open");
        setPickerActive(side, pickerState[side] < 0 ? buttons.length - 1 : pickerState[side] - 1);
        syncExpanded(side);
        return;
      }
      if (event.key === "Enter" && open && buttons.length) {
        event.preventDefault();
        const index = pickerState[side] < 0 ? 0 : pickerState[side];
        selectPickerButton(side, buttons[index]);
        return;
      }
      if (event.key === "Escape" && open) {
        event.preventDefault();
        closePicker(side);
      }
    });

    results.addEventListener("pointermove", (event) => {
      const button = event.target.closest("[data-route-entity]");
      if (!button) return;
      const buttons = suggestionButtons(side);
      const index = buttons.indexOf(button);
      if (index >= 0) setPickerActive(side, index);
    });

    results.addEventListener("click", (event) => {
      if (!event.target.closest("[data-route-entity]")) return;
      requestAnimationFrame(() => {
        input.scrollLeft = 0;
        try { input.setSelectionRange(0, 0); } catch {}
        syncExpanded(side);
      });
    });
  }
}

function installRouteBindingObserver() {
  bindRouteComboboxes();
  const observer = new MutationObserver(() => bindRouteComboboxes());
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", (event) => {
    for (const side of ["from", "to"]) {
      const { input, results } = pickerElements(side);
      if (!input || !results) continue;
      if (event.target === input || results.contains(event.target)) continue;
      closePicker(side);
    }
  });
}

function installOverviewDensityHints() {
  const hostGrid = document.getElementById("overviewHosts");
  if (!hostGrid) return;
  const observer = new MutationObserver(() => {
    const count = hostGrid.querySelectorAll(":scope > .summary-card").length;
    hostGrid.classList.toggle("single-host-overview", count === 1);
  });
  observer.observe(hostGrid, { childList: true });
  const count = hostGrid.querySelectorAll(":scope > .summary-card").length;
  hostGrid.classList.toggle("single-host-overview", count === 1);
}

ensureAcceptanceStyles();
installRouteBindingObserver();
installOverviewDensityHints();
