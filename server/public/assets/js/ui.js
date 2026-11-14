// ModWatch UI: the small pieces of behaviour the server-rendered pages need.
(() => {
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  // --- phone navigation sheet ------------------------------------------------
  const sidebar = $("#sidebar");
  const scrim = $("#sidebar-scrim");
  const closeButtons = $$("[data-sidebar-close]");

  function setSidebar(open) {
    if (!sidebar) return;
    sidebar.classList.toggle("open", open);
    document.body.classList.toggle("sheet-open", open);
    if (scrim) scrim.hidden = !open;
    $("#sidebar-toggle")?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      const first = sidebar.querySelector("a, button");
      if (first) first.focus({ preventScroll: true });
    } else {
      $("#sidebar-toggle")?.focus({ preventScroll: true });
    }
  }

  $("#sidebar-toggle")?.addEventListener("click", () => setSidebar(!sidebar?.classList.contains("open")));
  scrim?.addEventListener("click", () => setSidebar(false));
  for (const button of closeButtons) button.addEventListener("click", () => setSidebar(false));
  $$("#sidebar a").forEach((link) => link.addEventListener("click", () => setSidebar(false)));

  // --- popovers built on <details> ------------------------------------------
  const popovers = $$("details.pop, details.user-pop");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function closePopover(item, focus = false) {
    if (!item || !item.open || item.classList.contains("is-closing")) return;
    const summary = item.querySelector("summary");
    const done = () => {
      item.open = false;
      item.classList.remove("is-closing");
      summary?.setAttribute("aria-expanded", "false");
      if (focus) summary?.focus({ preventScroll: true });
    };
    if (reduceMotion.matches) return done();
    item.classList.add("is-closing");
    window.setTimeout(done, 140);
  }
  function closePopovers(except) {
    for (const item of popovers) if (item !== except) closePopover(item);
  }
  for (const item of popovers) {
    const summary = item.querySelector("summary");
    summary?.setAttribute("aria-expanded", "false");
    summary?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (item.open) return closePopover(item, true);
      closePopovers(item);
      item.open = true;
      summary.setAttribute("aria-expanded", "true");
      item.classList.remove("is-closing");
      const panel = item.querySelector(".pop-panel, .user-pop-panel");
      if (panel && !reduceMotion.matches) {
        panel.classList.remove("pop-in");
        void panel.offsetWidth;
        panel.classList.add("pop-in");
        window.setTimeout(() => panel.classList.remove("pop-in"), 1100);
      }
    });
  }
  document.addEventListener("click", (event) => {
    for (const item of popovers) {
      if (item.open && !item.contains(event.target)) closePopover(item);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    for (const item of popovers) if (item.open) closePopover(item, true);
  });

  // --- mobile search panel ---------------------------------------------------
  const mobileSearch = $("#mobile-search");
  const searchToggle = $("#search-toggle");
  function setMobileSearch(open) {
    if (!mobileSearch) return;
    mobileSearch.classList.remove("is-open");
    mobileSearch.hidden = !open;
    searchToggle?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      mobileSearch.classList.add("is-open");
      $("#mobile-search-input")?.focus({ preventScroll: true });
    }
  }
  searchToggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    setMobileSearch(mobileSearch?.hidden !== false);
  });
  mobileSearch?.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => {
    if (mobileSearch && !mobileSearch.hidden) setMobileSearch(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobileSearch && !mobileSearch.hidden) setMobileSearch(false);
  });

  // --- realtime global search -------------------------------------------------
  const searchControllers = new WeakMap();
  const searchTimers = new WeakMap();
  let searchSequence = 0;

  function resultRow(kind, item) {
    const link = document.createElement("a");
    link.className = "search-result";
    link.href = kind === "mod" ? `/mods/${item.id}` : `/instances/${item.id}`;
    const icon = document.createElement("span");
    icon.className = "search-result-icon";
    if (item.icon) {
      const image = document.createElement("img");
      image.src = item.icon;
      image.alt = "";
      image.loading = "lazy";
      image.addEventListener("error", () => { icon.textContent = (item.initials || "?").slice(0, 2); });
      icon.appendChild(image);
    } else {
      icon.textContent = (item.initials || "?").slice(0, 2);
    }
    const copy = document.createElement("span");
    copy.className = "search-result-copy";
    const title = document.createElement("span");
    title.className = "search-result-title";
    title.textContent = item.name;
    const meta = document.createElement("span");
    meta.className = "search-result-meta";
    meta.textContent = kind === "mod" ? `${item.instance || "Instance"} · ${item.version || "No version"}` : item.scope || "Instance";
    copy.append(title, meta);
    const state = document.createElement("span");
    state.className = "search-result-state";
    state.textContent = item.state || (kind === "mod" ? "Mod" : "Instance");
    link.append(icon, copy, state);
    return link;
  }

  function loadingResults(results) {
    results.innerHTML = '<div class="search-loading" aria-hidden="true"><span></span><span></span><span></span></div>';
  }

  function renderResults(results, data, query) {
    results.replaceChildren();
    const groups = [];
    if (data.mods?.length) {
      const group = document.createElement("div");
      group.className = "search-result-group";
      const head = document.createElement("p");
      head.className = "search-result-head";
      head.innerHTML = `<span>Mods</span><span class="search-result-count">${data.mods.length}${data.totalMods > data.mods.length ? " of " + data.totalMods : ""}</span>`;
      group.appendChild(head);
      for (const item of data.mods) group.appendChild(resultRow("mod", item));
      groups.push(group);
    }
    if (data.instances?.length) {
      const group = document.createElement("div");
      group.className = "search-result-group";
      const head = document.createElement("p");
      head.className = "search-result-head";
      head.innerHTML = `<span>Instances</span><span class="search-result-count">${data.instances.length}${data.totalInstances > data.instances.length ? " of " + data.totalInstances : ""}</span>`;
      group.appendChild(head);
      for (const item of data.instances) group.appendChild(resultRow("instance", item));
      groups.push(group);
    }
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "search-result-empty";
      empty.textContent = `No match for “${query}”`;
      groups.push(empty);
    }
    for (const group of groups) results.appendChild(group);
    results.hidden = false;
    results.classList.add("is-open");
  }

  for (const input of $$("[data-global-search]")) {
    const form = input.closest("form");
    const results = form?.querySelector("[data-search-results]");
    if (!results) continue;

    const close = () => {
      results.hidden = true;
      results.classList.remove("is-open");
    };
    const run = async () => {
      const q = input.value.trim();
      if (q.length < 2) return close();
      searchControllers.get(input)?.abort();
      const controller = new AbortController();
      searchControllers.set(input, controller);
      const sequence = ++searchSequence;
      loadingResults(results);
      results.hidden = false;
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error("search");
        const data = await response.json();
        if (sequence !== searchSequence) return;
        renderResults(results, data, q);
      } catch (err) {
        if (err.name === "AbortError") return;
        results.replaceChildren();
        const empty = document.createElement("p");
        empty.className = "search-result-empty";
        empty.textContent = "Search is unavailable right now.";
        results.appendChild(empty);
      }
    };

    input.addEventListener("input", () => {
      window.clearTimeout(searchTimers.get(input));
      searchTimers.set(input, window.setTimeout(run, 220));
    });
    input.addEventListener("focus", () => {
      if (input.value.trim().length >= 2 && results.hidden) run();
    });
    input.addEventListener("keydown", (event) => {
      const options = $$(".search-result", results);
      if (!options.length) return;
      let active = options.indexOf($(".search-result.is-active", results));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        for (const option of options) option.classList.remove("is-active");
        options[active].classList.add("is-active");
        options[active].scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter" && active >= 0) {
        event.preventDefault();
        options[active].click();
      } else if (event.key === "Escape") {
        close();
      }
    });
    form.addEventListener("submit", (event) => {
      const active = $(".search-result.is-active", results);
      if (active) {
        event.preventDefault();
        active.click();
      }
    });
    document.addEventListener("click", (event) => {
      if (!form.contains(event.target)) close();
    });
  }

  // --- realtime server-rendered table search --------------------------------
  for (const form of $$("form[data-live-search]")) {
    const targetSelector = form.dataset.liveSearch;
    const target = targetSelector ? $(targetSelector) : null;
    if (!target) continue;
    const field = $('input[type="search"]', form);
    let timer = null;
    let controller = null;
    const status = document.createElement("span");
    status.className = "filter-status";
    status.hidden = true;
    status.innerHTML = "Searching…";
    form.querySelector(".toolbar-right")?.prepend(status);

    const fetchResults = async (url) => {
      controller?.abort();
      controller = new AbortController();
      form.closest(".panel")?.classList.add("is-loading");
      status.hidden = false;
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          cache: "no-store",
          headers: { "X-Requested-With": "fetch" },
        });
        if (!response.ok) throw new Error("fetch");
        const text = await response.text();
        const doc = new DOMParser().parseFromString(text, "text/html");
        const next = doc.querySelector(targetSelector);
        if (!next) return;
        target.innerHTML = next.innerHTML;
        target.querySelector(".table-wrap")?.classList.add("table-live");
        const nextCount = doc.querySelector(".count-note");
        const currentCount = form.querySelector(".count-note");
        if (nextCount && currentCount) currentCount.textContent = nextCount.textContent;
        history.replaceState(null, "", url);
      } catch (err) {
        if (err.name !== "AbortError") form.submit();
      } finally {
        form.closest(".panel")?.classList.remove("is-loading");
        status.hidden = true;
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const url = new URL(form.action, location.href);
        for (const [key, value] of new FormData(form)) if (value !== "") url.searchParams.set(key, value);
        fetchResults(url.pathname + url.search);
      }, 360);
    };
    field?.addEventListener("input", schedule);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const url = new URL(form.action, location.href);
      for (const [key, value] of new FormData(form)) if (value !== "") url.searchParams.set(key, value);
      fetchResults(url.pathname + url.search);
    });
    target.addEventListener("click", (event) => {
      const link = event.target.closest(".pager a");
      if (!link) return;
      event.preventDefault();
      fetchResults(link.href);
    });
  }

  // --- dialogs ---------------------------------------------------------------
  function openDialog(dialog) {
    if (!dialog) return;
    dialog.classList.remove("is-closing");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    document.body.classList.add("dialog-open");
    const focusable = dialog.querySelector("input, select, textarea, button");
    if (focusable) focusable.focus({ preventScroll: true });
  }
  function closeDialog(dialog) {
    if (!dialog || !dialog.open || dialog.classList.contains("is-closing")) return;
    const done = () => {
      dialog.classList.remove("is-closing");
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      document.body.classList.remove("dialog-open");
    };
    if (reduceMotion.matches) return done();
    dialog.classList.add("is-closing");
    window.setTimeout(done, 140);
  }

  for (const trigger of $$("[data-dialog-open]")) {
    trigger.addEventListener("click", () => openDialog(document.getElementById(trigger.dataset.dialogOpen)));
  }
  for (const dialog of $$("dialog")) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
    for (const closer of $$("[data-dialog-close]", dialog)) {
      closer.addEventListener("click", () => closeDialog(dialog));
    }
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (sidebar?.classList.contains("open")) setSidebar(false);
    const open = $("dialog[open]");
    if (open) closeDialog(open);
  });

  // --- the "unknown mod detected" dialog ------------------------------------
  const unknownDialog = $("#unknown-dialog");
  for (const trigger of $$("[data-unknown-open]")) {
    trigger.addEventListener("click", () => {
      if (!unknownDialog) return;
      const file = trigger.dataset.unknownFile || "Unknown file";
      const form = $("#unknown-form", unknownDialog);
      if (form) form.setAttribute("action", trigger.dataset.unknownAction || "");
      const set = (selector, value) => {
        const node = $(selector, unknownDialog);
        if (node) node.textContent = value;
      };
      set("#unknown-file", file);
      set("#unknown-jar", trigger.dataset.unknownJar || "No mod metadata inside the jar");
      set("#unknown-version", trigger.dataset.unknownVersion || "Unknown version");
      set("#unknown-reason", trigger.dataset.unknownReason || "No match on Modrinth or CurseForge");
      set("#unknown-folder", trigger.dataset.unknownFolder || "mods/");
      const source = $("#unknown-source", unknownDialog);
      if (source) source.value = trigger.dataset.unknownUrl || "";
      const choice = $('input[name="action"][value="source"]', unknownDialog);
      if (choice) {
        choice.checked = true;
        choice.dispatchEvent(new Event("change", { bubbles: true }));
      }
      openDialog(unknownDialog);
    });
  }
  if (unknownDialog) {
    for (const radio of $$('input[name="action"]', unknownDialog)) {
      radio.addEventListener("change", () => {
        for (const section of $$("[data-unknown-section]", unknownDialog)) {
          section.hidden = section.dataset.unknownSection !== radio.value;
        }
      });
    }
  }

  // --- file drop zone --------------------------------------------------------
  const zone = $("[data-dropzone]");
  if (zone) {
    const input = $('input[type="file"]', zone);
    const name = $("[data-dropzone-name]", zone);
    const show = () => {
      if (!name) return;
      const file = input?.files?.[0];
      name.textContent = file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : "No file chosen yet";
      zone.classList.toggle("has-file", Boolean(file));
    };
    input?.addEventListener("change", show);
    for (const type of ["dragenter", "dragover"]) {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.add("is-over");
      });
    }
    for (const type of ["dragleave", "drop"]) {
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.remove("is-over");
      });
    }
    zone.addEventListener("drop", (event) => {
      if (!input || !event.dataTransfer?.files?.length) return;
      input.files = event.dataTransfer.files;
      show();
    });
    zone.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      input?.click();
    });
  }

  // --- filters that only touch the DOM --------------------------------------
  for (const input of $$("[data-filter]")) {
    const target = $(input.dataset.filterTarget || "");
    if (!target) continue;
    const rows = $$("[data-row]", target);
    const empty = $(input.dataset.filterEmpty || "");
    input.addEventListener("input", () => {
      const needle = input.value.trim().toLowerCase();
      let shown = 0;
      for (const row of rows) {
        const hit = !needle || row.textContent.toLowerCase().includes(needle);
        row.hidden = !hit;
        if (hit) shown += 1;
      }
      if (empty) empty.hidden = shown > 0;
    });
  }

  // --- selects that submit their GET form -----------------------------------
  for (const select of $$("[data-autosubmit]")) {
    select.addEventListener("change", () => select.form?.requestSubmit());
  }

  // --- destructive forms ask once -------------------------------------------
  for (const form of $$("form[data-confirm]")) {
    form.addEventListener("submit", (event) => {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  }

  // --- copy buttons ----------------------------------------------------------
  for (const button of $$("[data-copy]")) {
    button.addEventListener("click", async () => {
      const value = button.dataset.copy || "";
      try {
        await navigator.clipboard.writeText(value);
        button.classList.add("is-copied");
        const label = $("[data-copy-label]", button);
        const before = label?.textContent;
        if (label) label.textContent = "Copied";
        setTimeout(() => {
          button.classList.remove("is-copied");
          if (label && before) label.textContent = before;
        }, 1600);
      } catch {
        /* clipboard is a convenience, never a requirement */
      }
    });
  }

  // --- live scope preview on the instance form -------------------------------
  const scopePreview = $("[data-scope-preview]");
  if (scopePreview) {
    const loaderNames = { forge: "Forge", fabric: "Fabric", neoforge: "NeoForge", quilt: "Quilt", plugin: "Plugin" };
    const update = () => {
      const mc = $('[data-scope-field="mc"]');
      const loader = $('[data-scope-field="loader"]');
      const loaderVersion = $('[data-scope-field="loaderVersion"]');
      const outMc = $('[data-scope-output="mc"]', scopePreview);
      const outLoader = $('[data-scope-output="loader"]', scopePreview);
      if (outMc) outMc.textContent = mc?.value.trim() || "—";
      if (outLoader) {
        const name = loaderNames[loader?.value] || loader?.value || "Loader";
        outLoader.textContent = `${name}${loaderVersion?.value.trim() ? ` ${loaderVersion.value.trim()}` : ""}`;
      }
    };
    for (const field of $$("[data-scope-field]")) {
      field.addEventListener("input", update);
      field.addEventListener("change", update);
    }
    update();
  }

  // --- version picker fills the single POST form -----------------------------
  for (const form of $$("[data-version-form]")) {
    form.addEventListener("submit", (event) => {
      const picked = form.querySelector('input[name="picked"]:checked');
      if (!picked) {
        event.preventDefault();
        return;
      }
      const fields = {
        installed_version: "version",
        installed_version_id: "versionId",
        file_name: "file",
        file_sha1: "sha1",
        file_sha512: "sha512",
        file_size: "size",
        published_at: "published",
        channel: "channel",
        mc_versions: "mc",
        loaders: "loaders",
        changelog_url: "changelog",
        download_page_url: "download",
        download_url: "downloadUrl",
      };
      for (const [name, key] of Object.entries(fields)) {
        const input = form.querySelector(`input[name="${name}"]`);
        if (input) input.value = picked.dataset[key] || "";
      }
    });
  }

  // --- the seven-day update chart -------------------------------------------
  const chart = $("#updates-chart");
  if (chart && window.Charts) {
    const labels = (chart.dataset.labels || "").split(",").filter(Boolean);
    const values = (chart.dataset.values || "").split(",").map((n) => Number(n) || 0);
    let frame = 0;
    const draw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!labels.length || chart.clientWidth < 80) return;
        const top = values.reduce((a, b) => Math.max(a, b), 0);
        if (!top) {
          chart.innerHTML = '<p class="chart-empty">No updates found yet. Run a check and the last seven days fill in.</p>';
          return;
        }
        const highlight = values.length ? values.length - 1 : null;
        window.Charts.bars(chart, {
          labels,
          values,
          height: 168,
          format: window.Charts.fmt.int,
          highlight,
        });
      });
    };
    draw();
    new ResizeObserver(draw).observe(chart);
  }

  // --- notification badge refresh -------------------------------------------
  const poll = $("[data-notif-poll]");
  if (poll) {
    const badge = $("[data-notif-badge]", poll);
    const tick = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/notifications", { headers: { accept: "application/json" } });
        if (!response.ok) return;
        const data = await response.json();
        if (!badge) return;
        badge.textContent = data.unread > 99 ? "99+" : String(data.unread);
        badge.hidden = !data.unread;
        poll.classList.toggle("has-unread", data.unread > 0);
      } catch {
        /* a dropped poll is not an error the user needs */
      }
    };
    setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tick();
    });
  }

  // --- "/" focuses the topbar search ----------------------------------------
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = document.activeElement?.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
    const search = $("[data-global-search]");
    if (!search) return;
    event.preventDefault();
    search.focus();
  });

  // --- icon fallback ---------------------------------------------------------
  // Some Modrinth projects have no square icon. Swap the broken image for the
  // same initials tile the server renders when no icon URL exists at all.
  document.addEventListener("error", (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (image.classList.contains("mod-icon")) {
      const fallback = document.createElement("span");
      fallback.className = "mod-icon fallback";
      fallback.textContent = image.dataset.fallback || "?";
      image.replaceWith(fallback);
      return;
    }
    const avatar = image.closest(".avatar");
    if (avatar) {
      avatar.textContent = image.dataset.fallback || "?";
    }
  }, true);

  // --- mark page ready (enables hover transitions only after load) ----------
  requestAnimationFrame(() => document.body.classList.add("is-ready"));
})();
