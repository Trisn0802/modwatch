(() => {
  const select = document.getElementById("sync-driver");
  if (!select) return;
  const form = select.closest("form");
  const isNew = form?.dataset.newConnection === "1";
  const subtitle = document.getElementById("sync-form-sub");
  const panels = Array.from(document.querySelectorAll("[data-driver-panel]"));
  const field = (name) => form?.querySelector(`[name="${name}"]`) || null;
  const require = (name, on) => {
    const el = field(name);
    if (el) el.required = on;
  };

  const apply = () => {
    const driver = select.value;
    for (const panel of panels) {
      panel.hidden = panel.dataset.driverPanel !== driver;
    }
    require("host", driver !== "pterodactyl");
    require("username", driver !== "pterodactyl");
    require("panel_url", driver === "pterodactyl");
    require("api_key", driver === "pterodactyl" && isNew);
    if (subtitle) {
      subtitle.textContent = driver === "pterodactyl"
        ? "Panel URL and client API key"
        : "SFTP host and credentials";
    }
  };

  select.addEventListener("change", apply);
  apply();
})();
