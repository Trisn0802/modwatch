// Turns every native <select> into a panel-style listbox while keeping the
// original select in the form so submission, required checks and change
// listeners behave exactly as before.
(() => {
  const CHECK = "sel-opt-check";
  let seq = 0;
  let closeOpen = null;

  const raf = (fn) => requestAnimationFrame(fn);
  const labelText = (label) => label.textContent.replace(/\s+/g, " ").trim();
  const optionLabel = (option) => {
    const text = (option.label || option.textContent || "").replace(/\s+/g, " ").trim();
    return text || option.value || "Select";
  };

  const iconTemplate = (name) =>
    document.querySelector(`[data-icon-template="${name}"] .panel-icon`);

  function buildIcon(option) {
    const name = option.dataset.icon;
    if (!name) return null;
    const source = iconTemplate(name);
    if (!source) return null;
    const svg = source.cloneNode(true);
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    const span = document.createElement("span");
    span.className = "sel-ico";
    span.appendChild(svg);
    return span;
  }

  function enhance(select) {
    if (select.dataset.selReady || select.multiple || Number(select.size) > 1) return;
    if (select.closest("[data-sel-ignore]")) return;

    const parent = select.parentElement;
    const parentStyle = getComputedStyle(parent);
    const available =
      parent.clientWidth -
      parseFloat(parentStyle.paddingLeft || 0) -
      parseFloat(parentStyle.paddingRight || 0);
    const rect = select.getBoundingClientRect();
    const fills = rect.width > 40 && rect.width >= available - 2;

    select.dataset.selReady = "1";
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    const wrap = document.createElement("span");
    wrap.className = fills ? "sel sel--fill" : "sel";
    parent.insertBefore(wrap, select);
    wrap.appendChild(select);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "sel-trigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML =
      '<span class="sel-ico-slot"></span><span class="sel-value"></span><span class="sel-caret" aria-hidden="true"></span>';

    const valueEl = trigger.querySelector(".sel-value");
    const slot = trigger.querySelector(".sel-ico-slot");

    const pop = document.createElement("div");
    pop.className = "sel-pop";
    pop.hidden = true;
    pop.id = `sel-pop-${++seq}`;
    const list = document.createElement("div");
    list.className = "sel-list";
    list.id = `${pop.id}-list`;
    list.setAttribute("role", "listbox");
    pop.appendChild(list);
    trigger.setAttribute("aria-controls", list.id);

    const label = select.id
      ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`)
      : null;
    if (label) trigger.setAttribute("aria-labelledby", label.id || `lbl-${pop.id}`);
    if (label && !label.id) label.id = `lbl-${pop.id}`;
    if (!label) {
      trigger.setAttribute("aria-label", select.getAttribute("aria-label") || select.name || "Select");
    }

    wrap.appendChild(trigger);
    const host = select.closest("dialog") || document.body;
    host.appendChild(pop);

    let items = [];
    let active = -1;
    let typing = "";
    let typingAt = 0;
    let syncing = false;

    const selectedOption = () => select.options[select.selectedIndex] || null;

    function syncTrigger() {
      const option = selectedOption();
      valueEl.textContent = option ? optionLabel(option) : "Select";
      slot.replaceChildren();
      const icon = option ? buildIcon(option) : null;
      if (icon) slot.appendChild(icon);
      trigger.classList.toggle("has-icon", Boolean(icon));
      trigger.disabled = select.disabled;
      trigger.classList.toggle("is-muted", !option || option.value === "");
    }

    function buildList() {
      list.replaceChildren();
      items = Array.from(select.options).map((option, index) => {
        const row = document.createElement("div");
        row.className = "sel-opt";
        row.id = `${pop.id}-o${index}`;
        row.setAttribute("role", "option");
        row.dataset.index = String(index);
        if (option.disabled) {
          row.setAttribute("aria-disabled", "true");
          row.classList.add("is-disabled");
        }
        const icon = buildIcon(option);
        if (icon) row.appendChild(icon);
        const text = document.createElement("span");
        text.className = "sel-opt-text";
        text.textContent = optionLabel(option);
        row.appendChild(text);
        const check = document.createElement("span");
        check.className = CHECK;
        row.appendChild(check);
        row.addEventListener("click", () => choose(index));
        list.appendChild(row);
        return row;
      });
      syncSelection();
    }

    function syncSelection() {
      items.forEach((row, index) => {
        const selected = index === select.selectedIndex;
        row.classList.toggle("is-selected", selected);
        row.setAttribute("aria-selected", selected ? "true" : "false");
      });
    }

    function setActive(index, scroll = true) {
      if (!items.length) return;
      active = Math.max(0, Math.min(items.length - 1, index));
      items.forEach((row, i) => row.classList.toggle("is-active", i === active));
      trigger.setAttribute("aria-activedescendant", items[active].id);
      if (scroll) items[active].scrollIntoView({ block: "nearest" });
    }

    function step(delta) {
      if (!items.length) return;
      let next = active;
      for (let guard = 0; guard < items.length; guard += 1) {
        next = (next + delta + items.length) % items.length;
        if (!select.options[next].disabled) break;
      }
      setActive(next);
    }

    function position() {
      if (pop.hidden) return;
      const box = trigger.getBoundingClientRect();
      const margin = 8;
      const gap = 8;
      const width = Math.min(Math.max(box.width, 180), window.innerWidth - margin * 2);
      pop.style.width = `${width}px`;
      list.style.maxHeight = "0px";
      const full = list.scrollHeight;
      const below = window.innerHeight - box.bottom - gap - margin;
      const above = box.top - gap - margin;
      const up = below < Math.min(full, 260) && above > below;
      const room = Math.max(96, Math.min(320, up ? above : below));
      list.style.maxHeight = `${room}px`;
      const height = pop.offsetHeight;
      const top = up ? box.top - gap - height : box.bottom + gap;
      let left = box.left;
      if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
      left = Math.max(margin, left);
      pop.style.top = `${Math.round(top)}px`;
      pop.style.left = `${Math.round(left)}px`;
      pop.classList.toggle("sel-pop--up", up);
      const center = box.left + box.width / 2 - left;
      const arrow = Math.min(Math.max(center, 16), width - 16);
      pop.style.setProperty("--arrow-x", `${Math.round(arrow)}px`);
    }

    function open() {
      if (!pop.hidden || select.disabled) return;
      if (closeOpen) closeOpen();
      buildList();
      pop.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      wrap.classList.add("is-open");
      const chosen = select.selectedIndex >= 0 ? select.selectedIndex : 0;
      setActive(chosen, false);
      position();
      closeOpen = () => close(false);
      document.addEventListener("pointerdown", onDocumentDown, true);
      window.addEventListener("scroll", position, true);
      window.addEventListener("resize", position);
    }

    function close(focus = true) {
      if (pop.hidden) return;
      pop.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-activedescendant");
      wrap.classList.remove("is-open");
      closeOpen = null;
      document.removeEventListener("pointerdown", onDocumentDown, true);
      window.removeEventListener("scroll", position, true);
      window.removeEventListener("resize", position);
      if (focus) trigger.focus();
    }

    function onDocumentDown(event) {
      if (pop.contains(event.target) || trigger.contains(event.target)) return;
      close(false);
    }

    function choose(index) {
      const option = select.options[index];
      if (!option || option.disabled) return;
      if (select.selectedIndex !== index) {
        select.selectedIndex = index;
        syncing = true;
        select.dispatchEvent(new Event("input", { bubbles: true }));
        select.dispatchEvent(new Event("change", { bubbles: true }));
        syncing = false;
      }
      syncSelection();
      syncTrigger();
      close();
    }

    function typeahead(key) {
      const now = Date.now();
      typing = now - typingAt > 700 ? key.toLowerCase() : typing + key.toLowerCase();
      typingAt = now;
      const found = Array.from(select.options).findIndex(
        (option) => !option.disabled && optionLabel(option).toLowerCase().startsWith(typing)
      );
      if (found >= 0) {
        if (pop.hidden) choose(found);
        else setActive(found);
      }
    }

    trigger.addEventListener("click", () => (pop.hidden ? open() : close()));
    trigger.addEventListener("keydown", (event) => {
      const { key } = event;
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        if (pop.hidden) open();
        else step(key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        if (pop.hidden) open();
        else choose(active);
        return;
      }
      if (key === "Escape" && !pop.hidden) {
        event.preventDefault();
        close();
        return;
      }
      if (key === "Home" && !pop.hidden) {
        event.preventDefault();
        setActive(0);
        return;
      }
      if (key === "End" && !pop.hidden) {
        event.preventDefault();
        setActive(items.length - 1);
        return;
      }
      if (key === "Tab" && !pop.hidden) {
        close(false);
        return;
      }
      if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        typeahead(key);
      }
    });

    select.addEventListener("change", () => {
      if (syncing) return;
      syncTrigger();
      if (!pop.hidden) syncSelection();
    });

    const form = select.form;
    if (form) {
      form.addEventListener("reset", () => {
        raf(() => {
          syncTrigger();
          if (!pop.hidden) {
            syncSelection();
            setActive(select.selectedIndex, false);
          }
        });
      });
    }

    if (label && !label.dataset.selBound) {
      label.dataset.selBound = "1";
      label.addEventListener("click", (event) => {
        if (event.target.closest("a, button")) return;
        event.preventDefault();
        trigger.focus();
      });
    }

    syncTrigger();
  }

  function enhanceAll(root = document) {
    root.querySelectorAll("select").forEach(enhance);
  }

  enhanceAll();
  document.addEventListener("DOMContentLoaded", () => enhanceAll());

  // Import preview rows and dialogs can add selects after first paint.
  const observer = new MutationObserver((records) => {
    let dirty = false;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "SELECT" || node.querySelector?.("select")) dirty = true;
      }
    }
    if (dirty) raf(() => enhanceAll());
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
