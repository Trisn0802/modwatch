// Page-level motion: a delayed loading skeleton on slow internal navigations,
// one-time reveal of the content sheet, and a shared visibility helper.
(() => {
  const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)");
  const SLOW_MS = 220;
  let timer = null;
  let skeleton = null;
  let leaving = false;

  function build() {
    const node = document.createElement("div");
    node.className = "page-skeleton";
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = `
      <div class="sk-head"><span class="sk-line sk-title"></span><span class="sk-line sk-sub"></span></div>
      <div class="sk-cards">${"<span class=\"sk-card\"></span>".repeat(4)}</div>
      <div class="sk-panels"><span class="sk-block tall"></span><span class="sk-block"></span></div>`;
    return node;
  }

  function show() {
    if (skeleton || REDUCE.matches) return;
    const target = document.querySelector(".canvas") || document.querySelector("main");
    if (!target) return;
    const rect = target.getBoundingClientRect();
    skeleton = build();
    skeleton.classList.add("is-leave");
    skeleton.style.top = `${Math.max(0, rect.top)}px`;
    skeleton.style.left = `${Math.max(0, rect.left)}px`;
    skeleton.style.width = `${rect.width}px`;
    skeleton.style.height = `${Math.max(240, Math.min(rect.height, window.innerHeight - rect.top))}px`;
    document.body.appendChild(skeleton);
    requestAnimationFrame(() => skeleton?.classList.add("is-visible"));
  }

  function hide() {
    if (timer) { clearTimeout(timer); timer = null; }
    leaving = false;
    if (!skeleton) return;
    const node = skeleton;
    skeleton = null;
    node.classList.add("is-done");
    window.setTimeout(() => node.remove(), 260);
  }

  document.addEventListener("click", (event) => {
    if (leaving || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.("a[href]");
    if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    leaving = true;
    timer = window.setTimeout(show, SLOW_MS);
  });

  window.addEventListener("pageshow", hide);
  window.addEventListener("beforeunload", () => {
    if (timer) clearTimeout(timer);
  });

  requestAnimationFrame(() => document.body.classList.add("is-ready"));

  window.MWMotion = {
    whenVisible(el, fn) {
      if (!el) return;
      if (!("IntersectionObserver" in window) || REDUCE.matches) { fn(); return; }
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          io.disconnect();
          fn();
        }
      }, { rootMargin: "0px 0px -8% 0px" });
      io.observe(el);
    },
    reduced: REDUCE,
  };
})();
