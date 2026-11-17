import express from "express";
import { query } from "../db.js";
import { notificationsFor, notificationHref } from "../queries.js";
import { unreadCount, notificationFeed } from "../notify.js";
import { relative } from "../helpers.js";
import { flash } from "../middleware.js";

export const notificationsRouter = express.Router();

notificationsRouter.get("/notifications", async (req, res, next) => {
  try {
    const filter = req.query.filter === "unread" ? "unread" : "all";
    const items = await notificationsFor(req.session.user.id, { filter });
    const unread = await unreadCount(req.session.user.id);
    res.render("pages/notifications.njk", {
      page: "notifications",
      title: "Notifications",
      items,
      unread,
      filter,
      hrefFor: notificationHref,
    });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post("/notifications/:id/open", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const { rows } = await query(
      "SELECT * FROM notifications WHERE id = $1 AND user_id = $2",
      [id, req.session.user.id]
    );
    const item = rows[0];
    if (!item) return res.redirect("/notifications");
    await query("UPDATE notifications SET read_at = now() WHERE id = $1", [id]);
    res.redirect(notificationHref(item));
  } catch (err) {
    next(err);
  }
});

notificationsRouter.post("/notifications/read-all", async (req, res, next) => {
  try {
    await query(
      "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL",
      [req.session.user.id]
    );
    flash(req, "ok", "All notifications marked as read.");
    res.redirect(req.get("referer") || "/notifications");
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get("/api/notifications", async (req, res, next) => {
  try {
    const unread = await unreadCount(req.session.user.id);
    const { rows } = await query(
      `SELECT n.id, n.title, n.body, n.kind, n.created_at, n.meta, n.sync_job_id,
              n.instance_id, n.mod_id,
              i.name AS instance_name, i.image_path AS instance_image,
              m.name AS mod_name, m.disabled AS mod_disabled,
              m.icon_url AS icon_url, m.source AS source, m.project_id AS project_id
         FROM notifications n
         LEFT JOIN instances i ON i.id = n.instance_id
         LEFT JOIN mods m ON m.id = n.mod_id
        WHERE n.user_id = $1 AND n.read_at IS NULL
        ORDER BY n.created_at DESC LIMIT 6`,
      [req.session.user.id]
    );
    const items = rows.map((row) => ({ ...row, href: notificationHref(row), relative: relative(row.created_at) }));
    res.json({ unread, items });
  } catch (err) {
    next(err);
  }
});

// Server-rendered popup list so the bell shows the same content the page does,
// including icons, after a Pusher or SSE notification.
notificationsRouter.get("/api/notifications/popup", async (req, res, next) => {
  try {
    const notif = await notificationFeed(req.session.user.id, 6);
    res.set("Cache-Control", "no-store");
    res.render("partials/notif-pop-list.njk", { notif });
  } catch (err) {
    next(err);
  }
});

// The decision dialog marks its notification as read when the member closes it,
// without leaving the page.
notificationsRouter.post("/api/notifications/:id/read", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (Number.isFinite(id)) {
      await query(
        "UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL",
        [id, req.session.user.id]
      );
    }
    const unread = await unreadCount(req.session.user.id);
    res.json({ ok: true, unread });
  } catch (err) {
    next(err);
  }
});
