// Realtime refresh + notifications. Pusher is the hosted transport; the SSE
// stream is a native fallback so the UI stays live when Pusher cannot deliver.
(() => {
  const body = document.body;
  const key = body.dataset.pusherKey;
  const cluster = body.dataset.pusherCluster;
  const userId = body.dataset.userId || body.dataset.pusherUser;
  const csrf = body.dataset.csrf;

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
      // A dialog flushes this on close. Everything else (the load guard or a
      // form that is still submitting) retries shortly so a notification that
      // lands right after load still applies.
      if (!document.querySelector("dialog[open]")) {
        window.setTimeout(() => { if (pendingReload) reloadPage(); }, 500);
      }
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

  const notifList = document.querySelector("[data-notif-list]");
  const refreshNotifPopup = async () => {
    if (!notifList) return;
    try {
      const response = await fetch("/api/notifications/popup", { headers: { accept: "text/html" } });
      if (!response.ok) return;
      notifList.innerHTML = await response.text();
    } catch {}
  };
  window.MWRefreshNotifications = refreshNotifPopup;

  // --- decision dialog -------------------------------------------------------
  // A member may be approved while signed in, or while away. Either way the
  // decision is shown in a dialog and the notification is marked read when the
  // member closes it.
  const DECISION_KEY = "modwatch:decision";
  const decisionModal = document.getElementById("decision-modal");
  const decisionKicker = document.getElementById("decision-kicker");
  const decisionTitle = document.getElementById("decision-title");
  const decisionMessage = document.getElementById("decision-message");
  const decisionTable = document.getElementById("decision-table");
  const decisionRows = document.getElementById("decision-rows");
  const decisionReasonWrap = document.getElementById("decision-reason-wrap");
  const decisionReason = document.getElementById("decision-reason");
  const decisionPhoto = document.getElementById("decision-photo");
  const decisionPhotoImg = document.getElementById("decision-photo-img");
  let decisionCurrent = null;
  let lastDecisionId = null;

  const stashDecision = (item) => {
    try { sessionStorage.setItem(DECISION_KEY, JSON.stringify(item)); } catch {}
  };

  const readStashedDecision = () => {
    try {
      const raw = sessionStorage.getItem(DECISION_KEY);
      if (!raw) return null;
      sessionStorage.removeItem(DECISION_KEY);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const SEEN_KEY = "modwatch:decision:seen";
  const seenDecisions = () => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || "[]"));
    } catch {
      return new Set();
    }
  };
  const markDecisionSeen = (id) => {
    if (!id) return;
    try {
      const seen = seenDecisions();
      seen.add(String(id));
      sessionStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(seen).slice(-50)));
    } catch {}
  };

  const markDecisionRead = (id) => {
    if (!id) return;
    fetch(`/api/notifications/${id}/read`, {
      method: "POST",
      keepalive: true,
      headers: { "x-csrf-token": csrf, accept: "application/json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (data && typeof data.unread === "number") setBadge(data.unread); })
      .catch(() => {});
  };

  const openDecision = (item) => {
    if (!decisionModal || !item || decisionModal.open) return false;
    decisionCurrent = item;
    if (item.id) lastDecisionId = item.id;
    const meta = item.meta || {};
    const changes = Array.isArray(meta.changes) ? meta.changes : [];
    const reason = String(meta.reason || "").trim();
    const photoUrl = String(meta.photoUrl || "");
    if (decisionKicker) decisionKicker.textContent = item.roleChanged || changes.length ? "Account update" : "Decision";
    if (decisionTitle) decisionTitle.textContent = item.title || "Request decided";
    if (decisionMessage) decisionMessage.textContent = item.body || "An admin decided on your request.";
    if (decisionTable) decisionTable.hidden = !changes.length;
    if (decisionRows) {
      decisionRows.replaceChildren();
      for (const change of changes) {
        const row = document.createElement("tr");
        for (const value of [change.label, change.from, change.to]) {
          const cell = document.createElement("td");
          cell.textContent = value || "—";
          row.appendChild(cell);
        }
        decisionRows.appendChild(row);
      }
    }
    if (decisionReasonWrap) decisionReasonWrap.hidden = !reason;
    if (decisionReason) decisionReason.textContent = reason;
    if (decisionPhoto) decisionPhoto.hidden = !photoUrl;
    if (decisionPhotoImg) {
      decisionPhotoImg.hidden = !photoUrl;
      if (photoUrl) decisionPhotoImg.src = photoUrl;
      else decisionPhotoImg.removeAttribute("src");
    }
    decisionModal.showModal();
    document.body.classList.add("dialog-open");
    return true;
  };

  const revealDecision = (item) => {
    if (!decisionModal || !item) return false;
    if (document.querySelector("dialog[open]")) {
      stashDecision(item);
      return false;
    }
    return openDecision(item);
  };

  const flushStashedDecision = () => {
    const item = readStashedDecision();
    return item ? revealDecision(item) : false;
  };

  if (decisionModal) {
    const closeDecision = () => { if (decisionModal.open) decisionModal.close(); };
    document.getElementById("decision-ok")?.addEventListener("click", closeDecision);
    document.getElementById("decision-close")?.addEventListener("click", closeDecision);
    decisionModal.addEventListener("close", () => {
      if (!document.querySelector("dialog[open]")) document.body.classList.remove("dialog-open");
      const item = decisionCurrent;
      decisionCurrent = null;
      markDecisionSeen(item?.id);
      if (item?.id) markDecisionRead(item.id);
    });
  }

  const onRefresh = (data = {}) => {
    const scope = data.scope || "workspace";
    if (scope === "notifications") {
      refreshBadge();
      refreshNotifPopup();
      if (page === "notifications") scheduleReload();
      return;
    }
    if (scope === "workspace" || (SCOPES[page] || []).includes(scope)) scheduleReload();
  };

  const onScheduler = (data = {}) => {
    window.MWScheduler?.apply?.(data);
  };

  const onNotification = (data = {}) => {
    if (typeof data.unread === "number") setBadge(data.unread);
    else refreshBadge();
    refreshNotifPopup();
    if (page === "notifications") scheduleReload();

    if (!["decision", "account"].includes(data.kind)) return;
    if (data.id && String(data.id) === String(lastDecisionId)) return;
    lastDecisionId = data.id || lastDecisionId;
    const item = {
      id: data.id || null,
      title: data.title || (data.kind === "account" ? "Your account was updated" : "Request decided"),
      body: data.body || "",
      roleChanged: Boolean(data.roleChanged),
      meta: data.meta || {},
    };
    if (data.roleChanged) {
      // Menus and permissions come from the session, so reload to pick up the
      // new role. The dialog opens from storage once the page is back.
      stashDecision(item);
      scheduleReload();
      return;
    }
    revealDecision(item);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (pendingReload) {
      pendingReload = false;
      if (canReload()) reloadPage();
      return;
    }
    flushStashedDecision();
  });

  // A refresh that arrived while a dialog was open stays queued; flush it once
  // the dialog closes instead of waiting for the next visibility change. A
  // stashed decision waits until the page has the new role, then opens.
  document.addEventListener("close", (event) => {
    if (!(event.target instanceof HTMLDialogElement)) return;
    // The decision is already handled at this point; remember it before a
    // queued reload can land so the dialog does not appear twice.
    if (event.target === decisionModal) markDecisionSeen(decisionCurrent?.id);
    if (pendingReload) {
      reloadPage();
      return;
    }
    flushStashedDecision();
  }, true);

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

  // Show the decision that caused this reload, or one the member missed while
  // the page was closed. The dialog marks the notification read when closed.
  flushStashedDecision();
  if (!decisionModal?.open) {
    fetch("/api/notifications", { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const seen = seenDecisions();
        const item = (data?.items || []).find((entry) =>
          (entry.kind === "decision" || entry.kind === "account") && !seen.has(String(entry.id))
        );
        if (item) {
          revealDecision({
            id: item.id,
            title: item.title,
            body: item.body,
            roleChanged: false,
            meta: item.meta || {},
          });
        }
      })
      .catch(() => {});
  }

  // --- native Server-Sent Events fallback ------------------------------------
  if (userId && window.EventSource) {
    const source = new EventSource("/api/events");
    window.__mwStream = source;
    const read = (event) => {
      try {
        return JSON.parse(event.data || "{}");
      } catch {
        return {};
      }
    };
    source.addEventListener("refresh", (event) => onRefresh(read(event)));
    source.addEventListener("scheduler", (event) => onScheduler(read(event)));
    source.addEventListener("notification", (event) => onNotification(read(event)));
  }

  // --- hosted Pusher transport ------------------------------------------------
  if (!key || !cluster || !userId || !window.Pusher) return;

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

  workspace.bind("refresh", onRefresh);
  workspace.bind("scheduler", onScheduler);
  personal.bind("notification", onNotification);

  pusher.connection.bind("error", (err) => {
    console.warn("Realtime connection error:", err?.error || err);
  });
})();
