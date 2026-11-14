// Realtime refresh + private notification channel. The server stays the source
// of truth: Pusher only says which page scope changed, then the page reloads.
(() => {
  const body = document.body;
  const key = body.dataset.pusherKey;
  const cluster = body.dataset.pusherCluster;
  const userId = body.dataset.pusherUser;
  const csrf = body.dataset.csrf;
  if (!key || !cluster || !userId || !window.Pusher) return;

  const path = location.pathname;
  const page = path === "/" ? "dashboard"
    : path.startsWith("/instances") ? "instances"
      : path.startsWith("/mods") ? "mods"
        : path.startsWith("/approvals") ? "approvals"
          : path.startsWith("/notifications") ? "notifications"
            : path.startsWith("/activity") ? "activity"
              : path.startsWith("/users") ? "users"
                : path.startsWith("/settings") ? "settings"
                  : "dashboard";

  const SCOPES = {
    dashboard: ["instances", "mods", "approvals", "notifications", "activity", "users", "settings"],
    instances: ["instances", "mods"],
    mods: ["mods", "instances"],
    approvals: ["approvals", "instances", "mods"],
    notifications: ["notifications"],
    activity: ["activity", "instances", "mods"],
    users: ["users"],
    settings: ["settings", "notifications"],
  };

  let pusher;
  try {
    pusher = new window.Pusher(key, {
      cluster,
      forceTLS: true,
      authEndpoint: "/pusher/auth",
      auth: { headers: { "X-CSRF-Token": csrf } },
    });
  } catch (err) {
    console.warn("Realtime unavailable:", err.message);
    return;
  }
  window.__mwPusher = pusher;

  const workspace = pusher.subscribe("private-workspace");
  const personal = pusher.subscribe(`private-user-${userId}`);
  personal.bind("pusher:subscription_error", (err) => {
    console.warn("Notification channel unavailable:", err?.status || err);
  });

  let reloadTimer = null;
  let loadGuardUntil = performance.now() + 1200;
  let submitting = false;
  let pendingReload = false;

  document.addEventListener("submit", () => {
    submitting = true;
    window.setTimeout(() => { submitting = false; }, 6000);
  }, true);

  const canReload = () => performance.now() > loadGuardUntil
    && !submitting
    && !document.querySelector("dialog[open]");

  const reloadPage = () => {
    if (!canReload()) {
      pendingReload = true;
      return;
    }
    try {
      sessionStorage.setItem("modwatch:realtime:scroll", JSON.stringify({ path: location.pathname + location.search, y: scrollY }));
    } catch {}
    location.reload();
  };

  const scheduleReload = () => {
    window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(reloadPage, 320);
  };

  const setBadge = (count) => {
    const badge = document.querySelector("[data-notif-badge]");
    if (!badge) return;
    badge.textContent = count > 99 ? "99+" : String(count || 0);
    badge.hidden = !count;
    const pop = badge.closest("[data-notif-poll]");
    if (pop) pop.classList.toggle("has-unread", count > 0);
  };

  const refreshBadge = async () => {
    try {
      const response = await fetch("/api/notifications", { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const data = await response.json();
      setBadge(Number(data.unread) || 0);
    } catch {}
  };

  workspace.bind("refresh", (data = {}) => {
    const scope = data.scope || "workspace";
    if (scope === "notifications") {
      refreshBadge();
      if (page === "notifications") scheduleReload();
      return;
    }
    if (scope === "workspace" || (SCOPES[page] || []).includes(scope)) scheduleReload();
  });

  personal.bind("notification", (data = {}) => {
    if (typeof data.unread === "number") setBadge(data.unread);
    else refreshBadge();
    if (page === "notifications") scheduleReload();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !pendingReload) return;
    pendingReload = false;
    if (canReload()) reloadPage();
  });

  // Restore the position after a realtime-triggered reload.
  try {
    const raw = sessionStorage.getItem("modwatch:realtime:scroll");
    if (raw) {
      sessionStorage.removeItem("modwatch:realtime:scroll");
      const saved = JSON.parse(raw);
      if (saved.path === location.pathname + location.search) {
        requestAnimationFrame(() => window.scrollTo(0, Number(saved.y) || 0));
      }
    }
  } catch {}

  pusher.connection.bind("error", (err) => {
    console.warn("Realtime connection error:", err?.error || err);
  });
})();
