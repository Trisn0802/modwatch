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
  const popovers = $$("details.pop, details.user-pop, details.menu");
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
      const panel = item.querySelector(".pop-panel, .user-pop-panel, .menu-panel");
      if (panel && !reduceMotion.matches) {
        panel.classList.remove("pop-in");
        void panel.offsetWidth;
        panel.classList.add("pop-in");
        window.setTimeout(() => panel.classList.remove("pop-in"), 1100);
      }
    });
    const panel = item.querySelector(".menu-panel");
    panel?.addEventListener("click", (event) => {
      if (event.target.closest("a, button")) closePopover(item);
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
    if (kind === "mod" && item.kindLabel) {
      const badge = document.createElement("span");
      badge.className = `kind-badge kind-${item.kind || "mod"}`;
      badge.textContent = item.kindLabel;
      meta.append(badge, document.createTextNode(` ${item.instance || "Instance"} · ${item.version || "No version"}`));
    } else {
      meta.textContent = kind === "mod"
        ? `${item.instance || "Instance"} · ${item.version || "No version"}`
        : item.scope || "Instance";
    }
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
      head.innerHTML = `<span>Projects</span><span class="search-result-count">${data.mods.length}${data.totalMods > data.mods.length ? " of " + data.totalMods : ""}</span>`;
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

  // --- realtime project search on the add-mod page ---------------------------
  for (const form of $$("form[data-realtime-search]")) {
    const target = $(form.dataset.realtimeSearch || "");
    if (!target) continue;
    const field = $('input[type="search"]', form);
    const status = $("[data-search-live]", form.parentElement);
    const statusText = $("[data-search-live-text]", form.parentElement);
    const empty = document.createElement("div");
    empty.className = "panel-body";
    empty.innerHTML = '<p class="faint" style="font-size:12px;text-align:center">Search is unavailable right now. Use the Search button to retry.</p>';
    let timer = null;
    let controller = null;
    let sequence = 0;

    const skeleton = () => {
      target.innerHTML = '<div class="result-skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span></div>';
    };
    const setStatus = (text) => {
      if (!status) return;
      status.hidden = !text;
      if (text && statusText) statusText.textContent = text;
    };
    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      const mine = ++sequence;
      const url = new URL(form.action, location.href);
      for (const [key, value] of new FormData(form)) if (value !== "") url.searchParams.set(key, value);
      setStatus("Searching Modrinth and GitHub…");
      skeleton();
      try {
        const response = await fetch(url.pathname + url.search, {
          signal: controller.signal,
          cache: "no-store",
          headers: { "X-Requested-With": "fetch" },
        });
        if (!response.ok) throw new Error("search failed");
        const html = await response.text();
        if (mine !== sequence) return;
        target.innerHTML = html;
        target.querySelector(".table-wrap")?.classList.add("table-live");
        history.replaceState(null, "", url.pathname + url.search);
      } catch (err) {
        if (err.name === "AbortError" || mine !== sequence) return;
        target.replaceChildren(empty);
      } finally {
        if (mine === sequence) setStatus("");
      }
    };
    field?.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 300);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      window.clearTimeout(timer);
      run();
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
        document.dispatchEvent(new CustomEvent("mw:results-replaced"));
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
    // Repeated params (kind, source) must stay repeated: appending keeps every
    // checked box, while set() would leave only the last one.
    const formUrl = () => {
      const url = new URL(form.action, location.href);
      url.search = "";
      for (const [key, value] of new FormData(form)) {
        if (value !== "") url.searchParams.append(key, value);
      }
      return url;
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const url = formUrl();
        fetchResults(url.pathname + url.search);
      }, 360);
    };
    field?.addEventListener("input", schedule);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const url = formUrl();
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

  // --- faceted filters: text + kind + source (public share table) -----------
  for (const scope of $$("[data-facet-filter]")) {
    const target = $(scope.dataset.facetTarget || "");
    if (!target) continue;
    const rows = $$("[data-row]", target);
    const search = $("[data-facet-search]", scope);
    const kinds = $$("[data-facet-kind]", scope);
    const sources = $$("[data-facet-source]", scope);
    const count = $("[data-facet-count]", scope);
    const badge = $("[data-facet-count-badge]", scope);
    const chips = $("[data-facet-chips]", scope);
    const empty = $(scope.dataset.facetEmpty || "");
    const noun = scope.dataset.facetNoun || "project";
    const total = rows.length;

    const labelFor = (input) => input.closest("label")?.querySelector("span")?.textContent?.trim() || input.value;
    const checked = (list) => list.filter((input) => input.checked).map((input) => input.value);

    const makeChip = (label, onRemove) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.append(document.createTextNode(`${label} `));
      const mark = document.createElement("span");
      mark.className = "chip-x";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = "×";
      chip.append(mark);
      chip.addEventListener("click", onRemove);
      return chip;
    };

    const apply = () => {
      const needle = (search?.value || "").trim().toLowerCase();
      const pickedKinds = checked(kinds);
      const pickedSources = checked(sources);
      let shown = 0;
      for (const row of rows) {
        const hit = (!needle || row.textContent.toLowerCase().includes(needle))
          && (!pickedKinds.length || pickedKinds.includes(row.dataset.kind))
          && (!pickedSources.length || pickedSources.includes(row.dataset.source));
        row.hidden = !hit;
        if (hit) shown += 1;
        else {
          const box = row.querySelector(".mod-select");
          if (box) box.checked = false;
        }
      }
      if (count) {
        count.textContent = shown === total
          ? `${shown} ${noun}${shown === 1 ? "" : "s"}`
          : `${shown} of ${total} ${noun}${total === 1 ? "" : "s"}`;
      }
      const activeCount = pickedKinds.length + pickedSources.length;
      if (badge) {
        badge.textContent = String(activeCount);
        badge.hidden = activeCount === 0;
      }
      if (empty) empty.hidden = shown > 0;
      if (chips) {
        chips.replaceChildren();
        const active = [
          ...kinds.filter((input) => input.checked).map((input) => ({ input, label: labelFor(input) })),
          ...sources.filter((input) => input.checked).map((input) => ({ input, label: labelFor(input) })),
        ];
        chips.hidden = active.length === 0;
        if (active.length) {
          const caption = document.createElement("span");
          caption.className = "filter-chips-label";
          caption.textContent = "Active";
          chips.append(caption);
          for (const item of active) {
            chips.append(makeChip(item.label, () => {
              item.input.checked = false;
              apply();
            }));
          }
          const clear = document.createElement("button");
          clear.type = "button";
          clear.className = "chip chip-clear";
          clear.textContent = "Clear all";
          clear.addEventListener("click", () => {
            for (const input of [...kinds, ...sources]) input.checked = false;
            if (search) search.value = "";
            apply();
          });
          chips.append(clear);
        }
      }
      scope.dispatchEvent(new CustomEvent("mw:filterchange", { bubbles: true }));
    };

    search?.addEventListener("input", apply);
    for (const input of [...kinds, ...sources]) input.addEventListener("change", apply);
    $("[data-facet-clear]", scope)?.addEventListener("click", () => {
      for (const input of [...kinds, ...sources]) input.checked = false;
      if (search) search.value = "";
      apply();
    });
    apply();
  }

  // --- public share: select visible projects for a zipped download ----------
  const shareZipForm = $("#share-zip-form");
  if (shareZipForm) {
    const boxes = $$('.mod-select[form="share-zip-form"]');
    const selectAll = $("[data-share-select-all]");
    const submit = $("[data-share-zip-submit]");
    const label = $("[data-share-zip-label]");
    const visibleBoxes = () => boxes.filter((box) => !box.closest("tr")?.hidden);
    const sync = () => {
      const selected = boxes.filter((box) => box.checked).length;
      if (submit) submit.disabled = selected === 0;
      if (label) label.textContent = selected ? `Download selected (${selected})` : "Download selected";
      if (selectAll) {
        const visible = visibleBoxes();
        const picked = visible.filter((box) => box.checked).length;
        selectAll.checked = visible.length > 0 && picked === visible.length;
        selectAll.indeterminate = picked > 0 && picked < visible.length;
      }
    };
    selectAll?.addEventListener("change", () => {
      for (const box of visibleBoxes()) box.checked = selectAll.checked;
      sync();
    });
    for (const box of boxes) box.addEventListener("change", sync);
    document.addEventListener("mw:filterchange", sync);
    sync();
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

  // --- confirmation dialog (RuangAset-style native dialog) -------------------
  function confirmAction(options = {}) {
    const modal = $("#confirm-modal");
    const title = $("#confirm-title");
    const kicker = $("#confirm-kicker");
    const message = $("#confirm-message");
    const note = $("#confirm-note");
    const list = $("#confirm-list");
    const error = $("#confirm-error");
    const ok = $("#confirm-ok");
    const cancel = $("#confirm-cancel");
    const close = $("#confirm-close");
    if (!modal || !title || !message || !ok) {
      return Promise.resolve(window.confirm(options.message || "Continue?"));
    }
    return new Promise((resolve) => {
      let settled = false;
      const restoreFocus = document.activeElement;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const reset = () => {
        modal.classList.remove("is-closing");
        if (error) { error.hidden = true; error.textContent = ""; }
        if (list) { list.hidden = true; list.innerHTML = ""; }
        if (note) { note.hidden = true; note.textContent = ""; }
        ok.disabled = false;
        ok.textContent = options.confirmLabel || (options.danger ? "Delete" : "Continue");
        ok.className = `btn ${options.danger ? "danger" : "primary"}`;
        if (cancel) cancel.textContent = options.cancelLabel || "Cancel";
        if (kicker) kicker.textContent = options.kicker || "Confirm";
      };
      const done = (value) => {
        if (settled) return;
        settled = true;
        modal.classList.add("is-closing");
        const finish = () => {
          modal.classList.remove("is-closing");
          if (typeof modal.close === "function") modal.close();
          else modal.removeAttribute("open");
          document.body.classList.remove("dialog-open");
          restoreFocus?.focus?.({ preventScroll: true });
          resolve(value);
        };
        if (reduce) finish();
        else window.setTimeout(finish, 150);
      };
      for (const details of $$("details.menu[open], details.pop[open], details.user-pop[open]")) details.open = false;
      reset();
      title.textContent = options.title || "Confirm action";
      message.textContent = options.message || "Continue with this action?";
      if (note && options.note) { note.hidden = false; note.textContent = options.note; }
      if (list && Array.isArray(options.details) && options.details.length) {
        list.hidden = false;
        for (const item of options.details) {
          const li = document.createElement("li");
          li.textContent = item;
          list.appendChild(li);
        }
      }
      if (typeof modal.showModal === "function") {
        if (modal.open) modal.close();
        modal.showModal();
      } else modal.setAttribute("open", "");
      document.body.classList.add("dialog-open");
      window.setTimeout(() => (cancel || ok).focus({ preventScroll: true }), 30);

      ok.onclick = () => done(true);
      if (cancel) cancel.onclick = () => done(false);
      if (close) close.onclick = () => done(false);
      modal.oncancel = (event) => { event.preventDefault(); done(false); };
      modal.onclick = (event) => { if (event.target === modal) done(false); };
    });
  }
  window.MWConfirm = confirmAction;
  window.RA = window.RA || {};
  window.RA.confirm = confirmAction;

  // --- destructive forms ask once -------------------------------------------
  for (const form of $$("form[data-confirm]")) {
    form.addEventListener("submit", async (event) => {
      if (form.dataset.confirmed === "1") return;
      event.preventDefault();
      const danger = Boolean(form.querySelector(".danger"));
      const needsUpdate = form.action.includes("/update");
      const ok = await confirmAction({
        title: form.dataset.confirmTitle || (danger ? "Confirm removal" : needsUpdate ? "Download and update?" : "Confirm action"),
        message: form.dataset.confirm,
        confirmLabel: form.dataset.confirmLabel || (danger ? "Delete" : needsUpdate ? "Update" : "Continue"),
        kicker: form.dataset.confirmKicker || "Confirm",
        danger,
      });
      if (!ok) return;
      form.dataset.confirmed = "1";
      window.setTimeout(() => { delete form.dataset.confirmed; }, 8000);
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
    });
  }

  // --- long-running forms show a pending state -------------------------------
  for (const form of $$("form[data-busy-label]")) {
    form.addEventListener("submit", (event) => {
      if (event.defaultPrevented) return;
      const button = form.querySelector('button[type="submit"]');
      if (!button) return;
      button.disabled = true;
      button.textContent = form.dataset.busyLabel || "Working…";
    });
  }

  // --- progress dialog for long writes --------------------------------------
  for (const form of $$("form[data-progress-title]")) {
    form.addEventListener("submit", async (event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const modal = $("#progress-modal");
      if (!modal) {
        form.submit();
        return;
      }
      const body = $(".progress-body", modal);
      const spinner = $(".progress-spinner", modal);
      const check = $("#progress-check", modal);
      const title = $("#progress-title", modal);
      const message = $("#progress-message", modal);
      const list = $("#progress-steps", modal);
      const kicker = $("#progress-kicker", modal);
      const errorBox = $("#progress-error", modal);
      const foot = $("#progress-foot", modal);
      const cont = $("#progress-continue", modal);
      let interval = null;
      let busy = true;
      modal.oncancel = (cancelEvent) => { if (busy) cancelEvent.preventDefault(); };

      body?.classList.remove("is-done", "is-error");
      if (check) check.hidden = true;
      if (spinner) spinner.style.display = "";
      if (foot) foot.hidden = true;
      if (cont) cont.hidden = true;
      if (errorBox) { errorBox.hidden = true; errorBox.textContent = ""; }
      if (title) title.textContent = form.dataset.progressTitle || "Working…";
      if (message) message.textContent = form.dataset.progressMessage || "Keep this tab open while ModWatch finishes.";
      if (kicker) kicker.textContent = form.dataset.progressKicker || "Working";
      modal.setAttribute("aria-busy", "true");

      if (list) {
        list.replaceChildren();
        const steps = String(form.dataset.progressSteps || "").split("|").filter(Boolean);
        steps.forEach((step, index) => {
          const item = document.createElement("li");
          item.textContent = step;
          if (index === 0) item.classList.add("is-active");
          list.appendChild(item);
        });
        if (steps.length > 1) {
          let active = 0;
          interval = window.setInterval(() => {
            const items = [...list.children];
            if (!items.length) return;
            items[active]?.classList.remove("is-active");
            items[active]?.classList.add("is-done");
            active = Math.min(active + 1, items.length - 1);
            items[active]?.classList.add("is-active");
          }, 900);
        }
      }

      if (typeof modal.showModal === "function") {
        if (!modal.open) modal.showModal();
      } else modal.setAttribute("open", "");
      document.body.classList.add("dialog-open");

      const finish = (mode, text, nextUrl, label) => {
        busy = false;
        window.clearInterval(interval);
        modal.setAttribute("aria-busy", "false");
        if (list) {
          for (const item of list.children) {
            item.classList.remove("is-active");
            item.classList.add("is-done");
          }
        }
        if (mode === "ok") {
          body?.classList.add("is-done");
          if (spinner) spinner.style.display = "none";
          if (check) check.hidden = false;
          if (title) title.textContent = form.dataset.progressDoneTitle || "Request processed";
          if (message) message.textContent = text || "The request was processed.";
          if (kicker) kicker.textContent = "Complete";
        } else {
          body?.classList.add("is-error");
          if (spinner) spinner.style.display = "none";
          if (title) title.textContent = "Could not finish";
          if (message) message.textContent = "The request did not complete.";
          if (kicker) kicker.textContent = "Failed";
          if (errorBox) { errorBox.hidden = false; errorBox.textContent = text; }
        }
        if (foot) foot.hidden = false;
        if (cont) {
          cont.hidden = false;
          cont.href = nextUrl || location.href;
          cont.textContent = label || (mode === "ok" ? "Continue" : "Back to approvals");
        }
      };

      try {
        const response = await fetch(form.action, {
          method: "POST",
          body: new FormData(form),
          redirect: "follow",
          headers: { "X-Requested-With": "fetch" },
        });
        const finalUrl = response.url || location.href;
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const successText = doc.querySelector(".flash-ok")?.textContent.trim() || "";
        const errorText = doc.querySelector(".flash-error")?.textContent.trim() || "";
        if (new URL(finalUrl, location.href).pathname === "/login") {
          return finish("error", "Your session expired. Sign in again.", "/login", "Sign in");
        }
        if (!response.ok) {
          return finish("error", `The server returned ${response.status}. Try again from approvals.`, "/approvals", "Back to approvals");
        }
        if (errorText) return finish("error", errorText, finalUrl, "Back to approvals");
        finish("ok", successText, finalUrl, form.dataset.progressDoneLabel || "Continue to approvals");
      } catch (err) {
        finish("error", err.message || "The request could not reach the server.", location.href, "Reload page");
      }
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

  // --- twelve-month updates and downloads chart ------------------------------
  const chart = $("#monthly-chart");
  if (chart && window.Charts) {
    const labels = (chart.dataset.labels || "").split(",").filter(Boolean);
    const updates = (chart.dataset.updates || "").split(",").map((n) => Number(n) || 0);
    const downloads = (chart.dataset.downloads || "").split(",").map((n) => Number(n) || 0);
    let frame = 0;
    const draw = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!labels.length || chart.clientWidth < 80) return;
        if (!updates.some(Boolean) && !downloads.some(Boolean)) {
          chart.innerHTML = '<p class="chart-empty">No update or download history yet. Checks and downloaded updates fill this chart.</p>';
          return;
        }
        window.Charts.line(chart, {
          labels,
          series: [
            { name: "Updates", values: updates },
            { name: "Downloads", values: downloads },
          ],
          height: window.innerWidth <= 560 ? 186 : 230,
          format: window.Charts.fmt.int,
          xAt: window.innerWidth <= 560 ? [0, 4, 8, labels.length - 1] : [0, 2, 4, 6, 8, labels.length - 1],
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

  // --- scheduler status (realtime event + polling fallback) -----------------
  const schedulerCard = $("[data-scheduler-card]");
  const schedulerTitle = schedulerCard ? $("[data-scheduler-title]", schedulerCard) : null;
  const schedulerCopy = schedulerCard ? $("[data-scheduler-copy]", schedulerCard) : null;
  const schedulerDot = schedulerCard ? $("[data-scheduler-dot]", schedulerCard) : null;
  function schedulerCountdown(iso) {
    if (!iso) return "";
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return "";
    if (ms <= 0) return "in a moment";
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `in ${Math.max(1, minutes)} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return `in ${hours} h${rest ? ` ${rest} min` : ""}`;
    return `in ${Math.floor(hours / 24)} d ${hours % 24} h`;
  }
  function applyScheduler(state = {}) {
    if (!schedulerCard) return;
    if (schedulerDot) {
      schedulerDot.classList.remove("live", "busy", "warn", "bad");
      schedulerDot.classList.add(state.running ? "busy" : "live");
    }
    if (schedulerTitle) schedulerTitle.textContent = state.running ? "Checking now" : "Watcher armed";
    if (schedulerCopy) {
      schedulerCopy.textContent = state.running
        ? "Results land as they finish"
        : state.nextRun ? `Next check ${schedulerCountdown(state.nextRun)}` : "Waiting for the next interval";
    }
  }
  const refreshScheduler = async () => {
    if (!schedulerCard || document.hidden) return;
    try {
      const response = await fetch("/api/scheduler", { headers: { accept: "application/json" } });
      if (!response.ok) return;
      applyScheduler(await response.json());
    } catch {}
  };
  window.MWScheduler = { apply: applyScheduler, refresh: refreshScheduler };
  if (schedulerCard) {
    refreshScheduler();
    window.setInterval(refreshScheduler, 60_000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshScheduler(); });
  }

  // --- select tracked projects for a zipped file download ------------------
  const zipForm = $("#zip-form");
  if (zipForm) {
    const selectAll = $("[data-select-all]");
    const zipSubmit = $("[data-zip-submit]");
    const zipLabel = $("[data-zip-label]");
    let zipBoxes = [];
    const syncZip = () => {
      const selected = zipBoxes.filter((box) => box.checked).length;
      if (zipSubmit) zipSubmit.disabled = selected === 0;
      if (zipLabel) zipLabel.textContent = selected ? `Download selected (${selected})` : "Download selected";
      if (selectAll) {
        selectAll.checked = zipBoxes.length > 0 && selected === zipBoxes.length;
        selectAll.indeterminate = selected > 0 && selected < zipBoxes.length;
      }
    };
    const bindZip = () => {
      zipBoxes = $$('input.mod-select[form="zip-form"]');
      for (const box of zipBoxes) box.addEventListener("change", syncZip);
      syncZip();
    };
    // The live table search swaps the tbody, so the listeners must be rebuilt.
    document.addEventListener("mw:results-replaced", bindZip);
    if (selectAll) {
      selectAll.onchange = () => {
        for (const box of zipBoxes) box.checked = selectAll.checked;
        syncZip();
      };
    }
    bindZip();
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
      return;
    }
    const resultIcon = image.closest(".result-icon");
    if (resultIcon) resultIcon.textContent = image.dataset.fallback || "?";
  }, true);

  // --- mark page ready (enables hover transitions only after load) ----------
  requestAnimationFrame(() => document.body.classList.add("is-ready"));
})();
