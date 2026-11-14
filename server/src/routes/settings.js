import express from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { config } from "../config.js";
import { getSettings, setSetting } from "../settings.js";
import { scheduleNext, schedulerState } from "../scheduler.js";
import { clearSourceCache } from "../sources/http.js";
import { telegramSend } from "../notify.js";
import { requireAdmin, flash, csrfValid } from "../middleware.js";
import { logActivity } from "../activity.js";
import { CHANNEL } from "../labels.js";
import { avatarUpload, receiveUpload, uploadPath, removeUpload, uploadMessage } from "../uploads.js";

export const settingsRouter = express.Router();

async function settingsLocals() {
  const settings = await getSettings();
  return {
    settings,
    scheduler: schedulerState(),
    env: {
      curseforgeReady: config.curseforgeReady,
      curseforgeFallback: config.curseforgeFallback,
      githubReady: Boolean(config.githubToken),
      telegramReady: config.telegramReady,
      appUrl: config.appUrl,
      contact: config.contact,
    },
  };
}

settingsRouter.get("/settings", requireAdmin, async (req, res, next) => {
  try {
    res.render("pages/settings-general.njk", {
      page: "settings",
      title: "Settings",
      section: "general",
      channelLabels: CHANNEL,
      ...(await settingsLocals()),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post("/settings/general", requireAdmin, async (req, res, next) => {
  try {
    const hours = Math.max(1, Math.min(168, Number.parseInt(req.body.check_interval_hours, 10) || 6));
    const channel = ["release", "beta", "alpha"].includes(req.body.default_channel_policy)
      ? req.body.default_channel_policy
      : "release";
    await setSetting("check_interval_hours", hours);
    await setSetting("default_channel_policy", channel);
    await scheduleNext();
    await logActivity({
      userId: req.session.user.id, action: "settings_updated", subjectType: "settings",
      meta: { check_interval_hours: hours, default_channel_policy: channel },
    });
    flash(req, "ok", `Check interval set to ${hours} hours.`);
    res.redirect("/settings");
  } catch (err) {
    next(err);
  }
});

settingsRouter.get("/settings/notifications", requireAdmin, async (req, res, next) => {
  try {
    res.render("pages/settings-notifications.njk", {
      page: "settings",
      title: "Notifications",
      section: "notifications",
      ...(await settingsLocals()),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post("/settings/notifications", requireAdmin, async (req, res, next) => {
  try {
    await setSetting("telegram_enabled", req.body.telegram_enabled === "on");
    await setSetting("telegram_chat_id", String(req.body.telegram_chat_id || "").trim());
    flash(req, "ok", "Notification settings saved.");
    res.redirect("/settings/notifications");
  } catch (err) {
    next(err);
  }
});

settingsRouter.post("/settings/notifications/test", requireAdmin, async (req, res, next) => {
  try {
    const sent = await telegramSend("ModWatch · test notification\nTelegram is connected to your instance.");
    flash(req, sent ? "ok" : "error", sent
      ? "Test message sent to Telegram."
      : "Telegram is not ready. Set TELEGRAM_BOT_TOKEN in .env and enable it here.");
    res.redirect("/settings/notifications");
  } catch (err) {
    next(err);
  }
});

settingsRouter.get("/settings/sources", requireAdmin, async (req, res, next) => {
  try {
    res.render("pages/settings-sources.njk", {
      page: "settings",
      title: "Sources",
      section: "sources",
      ...(await settingsLocals()),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post("/settings/sources", requireAdmin, async (req, res, next) => {
  try {
    await setSetting("curseforge_enabled", req.body.curseforge_enabled === "on");
    clearSourceCache();
    await logActivity({
      userId: req.session.user.id, action: "settings_updated", subjectType: "settings",
      meta: { curseforge_enabled: req.body.curseforge_enabled === "on" },
    });
    flash(req, "ok", "Source settings saved. The cache was cleared.");
    res.redirect("/settings/sources");
  } catch (err) {
    next(err);
  }
});

settingsRouter.post("/settings/sources/clear-cache", requireAdmin, async (req, res) => {
  clearSourceCache();
  flash(req, "ok", "Source cache cleared. The next check fetches fresh data.");
  res.redirect("/settings/sources");
});

settingsRouter.get("/settings/account", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [req.session.user.id]);
    res.render("pages/settings-account.njk", {
      page: "settings",
      title: "Account",
      section: "account",
      account: rows[0],
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post("/settings/account", async (req, res, next) => {
  try {
    await receiveUpload(avatarUpload, req, res);
    if (!csrfValid(req)) {
      await removeUpload(uploadPath(req.file, "avatars"));
      return res.status(403).render("pages/403.njk", {
        page: "", title: "Request expired",
        message: "Your form session expired. Reload the page and try again.",
      });
    }
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [req.session.user.id]);
    const current = rows[0];
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!name || !email.includes("@")) {
      await removeUpload(uploadPath(req.file, "avatars"));
      flash(req, "error", "A name and a valid email are required.");
      return res.redirect("/settings/account");
    }
    const duplicate = await query("SELECT 1 FROM users WHERE email = $1 AND id <> $2", [email, req.session.user.id]);
    if (duplicate.rows.length) {
      await removeUpload(uploadPath(req.file, "avatars"));
      flash(req, "error", "That email is already used by another account.");
      return res.redirect("/settings/account");
    }
    let avatarPath = current.avatar_path;
    if (req.file) {
      avatarPath = uploadPath(req.file, "avatars");
      await removeUpload(current.avatar_path);
    } else if (req.body.remove_avatar === "1") {
      await removeUpload(current.avatar_path);
      avatarPath = null;
    }
    await query("UPDATE users SET name = $1, email = $2, avatar_path = $3 WHERE id = $4", [
      name, email, avatarPath, req.session.user.id,
    ]);
    req.session.user.name = name;
    req.session.user.email = email;
    req.session.user.avatar_path = avatarPath;
    await logActivity({ userId: req.session.user.id, action: "user_updated", subjectType: "user", subjectId: req.session.user.id, meta: { self: true } });
    flash(req, "ok", "Account details saved.");
    res.redirect("/settings/account");
  } catch (err) {
    if (err?.code === "LIMIT_FILE_SIZE" || err?.code === "IMAGE_TYPE") {
      flash(req, "error", uploadMessage(err));
      return res.redirect("/settings/account");
    }
    next(err);
  }
});

settingsRouter.post("/settings/account/password", async (req, res, next) => {
  try {
    const current = String(req.body.current_password || "");
    const nextPassword = String(req.body.new_password || "");
    const confirm = String(req.body.confirm_password || "");
    if (nextPassword.length < 8) {
      flash(req, "error", "The new password must be at least 8 characters.");
      return res.redirect("/settings/account");
    }
    if (nextPassword !== confirm) {
      flash(req, "error", "The new passwords do not match.");
      return res.redirect("/settings/account");
    }
    const { rows } = await query("SELECT password_hash FROM users WHERE id = $1", [req.session.user.id]);
    if (!(await bcrypt.compare(current, rows[0].password_hash))) {
      flash(req, "error", "Your current password is not correct.");
      return res.redirect("/settings/account");
    }
    await query("UPDATE users SET password_hash = $1 WHERE id = $2", [
      await bcrypt.hash(nextPassword, 12),
      req.session.user.id,
    ]);
    flash(req, "ok", "Password updated.");
    res.redirect("/settings/account");
  } catch (err) {
    next(err);
  }
});

settingsRouter.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE" || err?.code === "IMAGE_TYPE") {
    flash(req, "error", uploadMessage(err));
    return res.redirect("/settings/account");
  }
  next(err);
});
