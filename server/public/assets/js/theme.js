// Theme control. Runs before the first paint so the page never flashes the wrong ground.
(() => {
  const KEY = "modwatch.theme";
  const MODES = ["oled", "dark", "light", "system"];
  const LIGHT = window.matchMedia("(prefers-color-scheme: light)");
  const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)");
  const root = document.documentElement;
  const paint = { oled: "#000000", dark: "#0e0f12", light: "#f7f8f9" };
  const ICONS = {
    oled: '<circle cx="8" cy="8" r="5.4" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.6v10.8" stroke="currentColor" stroke-width="1.5"/>',
    dark: '<path d="M13.2 9.6A5.7 5.7 0 016.4 2.8 5.7 5.7 0 1013.2 9.6z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
    light: '<circle cx="8" cy="8" r="3.1" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.3 3.3l1.3 1.3M11.4 11.4l1.3 1.3M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
    system: '<rect x="2" y="2.8" width="12" height="8.4" rx="1.4" stroke="currentColor" stroke-width="1.5"/><path d="M8 11.2v2M5.6 13.2h4.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  };
  const LABEL = { oled: "OLED black", dark: "Dark", light: "Light", system: "Sync with system" };
  const SHORT = { oled: "OLED", dark: "Dark", light: "Light", system: "System" };

  const read = () => {
    const stored = localStorage.getItem(KEY);
    return MODES.includes(stored) ? stored : "oled";
  };
  let current = read();
  let controller = null;

  function resolved(mode) {
    if (mode !== "system") return mode;
    return LIGHT.matches ? "light" : "oled";
  }

  function apply(mode, announce = true) {
    current = MODES.includes(mode) ? mode : "oled";
    const theme = resolved(current);
    root.dataset.theme = theme;
    root.dataset.themeMode = current;
    root.style.colorScheme = theme === "light" ? "light" : "dark";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", paint[theme] || paint.oled);
    for (const button of document.querySelectorAll("[data-theme-set]")) {
      const active = button.dataset.themeSet === current;
      button.setAttribute("aria-checked", active ? "true" : "false");
      button.classList.toggle("is-active", active);
    }
    if (controller) {
      controller.btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">${ICONS[current]}</svg>`;
      controller.btn.setAttribute("aria-label", `Theme: ${LABEL[current]}`);
      controller.btn.title = `Theme: ${LABEL[current]}`;
    }
    if (announce) {
      window.dispatchEvent(new CustomEvent("modwatch:themechange", { detail: { mode: current, theme } }));
    }
  }

  function build() {
    const wrap = document.createElement("div");
    wrap.className = "theme-wrap";
    wrap.innerHTML = `
      <button class="icon-btn theme-btn" type="button" aria-haspopup="menu" aria-expanded="false"></button>
      <div class="theme-pop" role="menu" aria-label="Theme" hidden>
        <p class="theme-pop-head">Appearance</p>
        ${MODES.map((mode) => `
          <button class="theme-opt" type="button" role="menuitemradio" aria-checked="false" data-theme-set="${mode}">
            <span class="theme-opt-icon"><svg viewBox="0 0 16 16" fill="none" aria-hidden="true">${ICONS[mode]}</svg></span>
            <span class="theme-opt-copy"><strong>${LABEL[mode]}</strong><span>${mode === "system" ? "Follow this device" : mode === "oled" ? "True black" : SHORT[mode] + " surfaces"}</span></span>
            <svg class="theme-check" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.2 8.4l3.1 3.1 6.4-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>`).join("")}
      </div>`;
    const btn = wrap.querySelector(".theme-btn");
    const pop = wrap.querySelector(".theme-pop");
    let closeTimer = null;

    const open = () => {
      clearTimeout(closeTimer);
      pop.hidden = false;
      pop.classList.remove("is-closing");
      pop.classList.add("is-open");
      btn.setAttribute("aria-expanded", "true");
      pop.querySelector(".theme-opt.is-active")?.focus({ preventScroll: true });
    };
    const close = (focus = false) => {
      if (pop.hidden || pop.classList.contains("is-closing")) return;
      const done = () => {
        pop.hidden = true;
        pop.classList.remove("is-open", "is-closing");
        btn.setAttribute("aria-expanded", "false");
        if (focus) btn.focus({ preventScroll: true });
      };
      if (REDUCE.matches) return done();
      pop.classList.add("is-closing");
      closeTimer = setTimeout(done, 140);
    };
    const toggle = () => (pop.hidden ? open() : close(true));

    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle();
    });
    pop.addEventListener("click", (event) => event.stopPropagation());
    for (const option of pop.querySelectorAll("[data-theme-set]")) {
      option.addEventListener("click", () => {
        localStorage.setItem(KEY, option.dataset.themeSet);
        apply(option.dataset.themeSet);
        close(true);
      });
    }
    pop.addEventListener("keydown", (event) => {
      const options = [...pop.querySelectorAll(".theme-opt")];
      const index = options.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); close(true); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const next = (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }
    });
    document.addEventListener("click", () => close());
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });

    controller = { wrap, btn, pop, open, close };
    return wrap;
  }

  function mount() {
    for (const host of document.querySelectorAll("[data-theme-mount]")) {
      if (!host.firstElementChild) host.appendChild(build());
    }
    const auth = document.getElementById("auth-theme");
    if (auth && !auth.firstElementChild) auth.appendChild(build());
    apply(current, false);
  }

  apply(current, false);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
  LIGHT.addEventListener("change", () => { if (current === "system") apply("system"); });
  window.addEventListener("storage", (event) => { if (event.key === KEY) apply(read()); });
})();
