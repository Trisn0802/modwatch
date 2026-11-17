(() => {
  const require = (form, name, on) => {
    const el = form?.querySelector(`[name="${name}"]`);
    if (el) el.required = on;
  };

  // --- Settings → Sync: pick the panel driver and its fields -----------------
  const select = document.getElementById("sync-driver");
  if (select) {
    const form = select.closest("form");
    const isNew = form?.dataset.newConnection === "1";
    const subtitle = document.getElementById("sync-form-sub");
    const panels = Array.from(document.querySelectorAll("[data-driver-panel]"));

    const apply = () => {
      const driver = select.value;
      for (const panel of panels) {
        panel.hidden = panel.dataset.driverPanel !== driver;
      }
      require(form, "host", driver !== "pterodactyl");
      require(form, "username", driver !== "pterodactyl");
      require(form, "panel_url", driver === "pterodactyl");
      require(form, "api_key", driver === "pterodactyl" && isNew);
      if (subtitle) {
        subtitle.textContent = driver === "pterodactyl"
          ? "Panel URL and client API key"
          : "SFTP host and credentials";
      }
    };

    select.addEventListener("change", apply);
    apply();
  }

  // --- Instance → Servers: the UUID only belongs to a panel connection -------
  const targetConnection = document.getElementById("target-connection");
  if (targetConnection) {
    const form = targetConnection.closest("form");
    const refField = form?.querySelector("[data-target-ref]");
    const refInput = refField?.querySelector('input[name="remote_ref"]') || null;

    const applyTarget = () => {
      const option = targetConnection.selectedOptions[0];
      const needsRef = option?.dataset.driver === "pterodactyl";
      if (refField) refField.hidden = !needsRef;
      if (refInput) refInput.required = needsRef;
    };

    targetConnection.addEventListener("change", applyTarget);
    applyTarget();
  }
})();
