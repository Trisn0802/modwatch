import express from "express";
import { query } from "../db.js";
import { notificationsFor, notificationHref } from "../queries.js";
import { unreadCount } from "../notify.js";
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
      `SELECT id, title, body, kind, created_at FROM notifications
        WHERE user_id = $1 AND read_at IS NULL ORDER BY created_at DESC LIMIT 4`,
      [req.session.user.id]
    );
    res.json({ unread, items: rows });
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
