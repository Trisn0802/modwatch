import express from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { requireAdmin, flash, csrfValid } from "../middleware.js";
import { logActivity } from "../activity.js";
import { ROLE, USER_STATUS } from "../labels.js";
import { avatarUpload, receiveUpload, uploadPath, removeUpload, uploadMessage, finalizeImage } from "../uploads.js";

export const usersRouter = express.Router();

usersRouter.use("/users", requireAdmin);

async function listUsers() {
  const { rows } = await query(
    `SELECT u.*,
       (SELECT count(*)::int FROM mods m WHERE m.added_by = u.id) AS mods_added,
       (SELECT count(*)::int FROM mod_requests r WHERE r.requested_by = u.id) AS requests
     FROM users u ORDER BY u.role, u.name`
  );
  return rows;
}

usersRouter.get("/users", async (req, res, next) => {
  try {
    res.render("pages/users.njk", {
      page: "users", title: "Users", users: await listUsers(), roles: ROLE, statusLabels: USER_STATUS,
    });
  } catch (err) {
    next(err);
  }
});

usersRouter.get("/users/new", (req, res) => {
  res.render("pages/user-form.njk", {
    page: "users", title: "New user", account: null, roles: ROLE, error: null,
  });
});

usersRouter.post("/users", async (req, res, next) => {
  try {
    await receiveUpload(avatarUpload, req, res);
    if (!csrfValid(req)) {
      await removeUpload(uploadPath(req.file, "avatars"));
      return res.status(403).render("pages/403.njk", {
        page: "", title: "Request expired",
        message: "Your form session expired. Reload the page and try again.",
      });
    }
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = req.body.role === "admin" ? "admin" : "member";
    const password = String(req.body.password || "");
    if (!name || !email.includes("@") || password.length < 8) {
      await removeUpload(uploadPath(req.file, "avatars"));
      return res.status(400).render("pages/user-form.njk", {
        page: "users", title: "New user", account: req.body, roles: ROLE,
        error: "Name, a valid email and a password of at least 8 characters are required.",
      });
    }
    const exists = await query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (exists.rows.length) {
      await removeUpload(uploadPath(req.file, "avatars"));
      return res.status(409).render("pages/user-form.njk", {
        page: "users", title: "New user", account: req.body, roles: ROLE,
        error: "An account with that email already exists.",
      });
    }
    let avatarPath = null;
    try {
      avatarPath = await finalizeImage(req.file, "avatars");
    } catch (err) {
      return res.status(400).render("pages/user-form.njk", {
        page: "users", title: "New user", account: req.body, roles: ROLE, error: uploadMessage(err),
      });
    }
    const { rows } = await query(
      `INSERT INTO users (name, email, role, password_hash, avatar_path) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, email, role, await bcrypt.hash(password, 12), avatarPath]
    );
    await logActivity({
      userId: req.session.user.id, action: "user_created", subjectType: "user", subjectId: rows[0].id,
      meta: { name, email, role },
    });
    flash(req, "ok", `${name} can now sign in.`);
    res.redirect("/users");
  } catch (err) {
    next(err);
  }
});

usersRouter.get("/users/:id/edit", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM users WHERE id = $1", [Number.parseInt(req.params.id, 10)]);
    if (!rows.length) return next();
    res.render("pages/user-form.njk", {
      page: "users", title: `Edit ${rows[0].name}`, account: rows[0], roles: ROLE, error: null,
    });
  } catch (err) {
    next(err);
  }
});

usersRouter.post("/users/:id", async (req, res, next) => {
  try {
    await receiveUpload(avatarUpload, req, res);
    if (!csrfValid(req)) {
      await removeUpload(uploadPath(req.file, "avatars"));
      return res.status(403).render("pages/403.njk", {
        page: "", title: "Request expired",
        message: "Your form session expired. Reload the page and try again.",
      });
    }
    const id = Number.parseInt(req.params.id, 10);
    const { rows: found } = await query("SELECT * FROM users WHERE id = $1", [id]);
    const account = found[0];
    if (!account) {
      await removeUpload(uploadPath(req.file, "avatars"));
      return next();
    }
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = req.body.role === "admin" ? "admin" : "member";
    const status = req.body.status === "disabled" ? "disabled" : "active";
    const password = String(req.body.password || "");

    if (id === req.session.user.id && (role !== "admin" || status === "disabled")) {
      await removeUpload(uploadPath(req.file, "avatars"));
      flash(req, "error", "You cannot demote or disable your own account.");
      return res.redirect(`/users/${id}/edit`);
    }
    if (account.role === "admin" && role !== "admin") {
      const admins = await query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active'");
      if (admins.rows[0].n <= 1) {
        await removeUpload(uploadPath(req.file, "avatars"));
        flash(req, "error", "Keep at least one active admin.");
        return res.redirect(`/users/${id}/edit`);
      }
    }
    if (!name || !email.includes("@")) {
      await removeUpload(uploadPath(req.file, "avatars"));
      return res.status(400).render("pages/user-form.njk", {
        page: "users", title: `Edit ${account.name}`, account: { ...account, ...req.body }, roles: ROLE,
        error: "A name and a valid email are required.",
      });
    }
    const duplicate = await query("SELECT 1 FROM users WHERE email = $1 AND id <> $2", [email, id]);
    if (duplicate.rows.length) {
      await removeUpload(uploadPath(req.file, "avatars"));
      return res.status(409).render("pages/user-form.njk", {
        page: "users", title: `Edit ${account.name}`, account: { ...account, ...req.body }, roles: ROLE,
        error: "Another account already uses that email.",
      });
    }
    if (password) {
      if (password.length < 8) {
        await removeUpload(uploadPath(req.file, "avatars"));
        flash(req, "error", "A new password must be at least 8 characters.");
        return res.redirect(`/users/${id}/edit`);
      }
      await query("UPDATE users SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(password, 12), id]);
    }
    let avatarPath = account.avatar_path;
    if (req.file) {
      try {
        avatarPath = await finalizeImage(req.file, "avatars");
      } catch (err) {
        flash(req, "error", uploadMessage(err));
        return res.redirect(`/users/${id}/edit`);
      }
      await removeUpload(account.avatar_path);
    } else if (req.body.remove_avatar === "1") {
      await removeUpload(account.avatar_path);
      avatarPath = null;
    }
    await query(
      "UPDATE users SET name = $1, email = $2, role = $3, status = $4, avatar_path = $5 WHERE id = $6",
      [name, email, role, status, avatarPath, id]
    );
    if (id === req.session.user.id) {
      req.session.user.name = name;
      req.session.user.email = email;
      req.session.user.avatar_path = avatarPath;
    }
    await logActivity({
      userId: req.session.user.id, action: "user_updated", subjectType: "user", subjectId: id,
      meta: { name, email, role, status },
    });
    flash(req, "ok", `${name} updated.`);
    res.redirect("/users");
  } catch (err) {
    next(err);
  }
});

usersRouter.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE" || err?.code === "IMAGE_TYPE") {
    flash(req, "error", uploadMessage(err));
    const id = Number.parseInt(req.params.id, 10);
    return res.redirect(Number.isFinite(id) ? `/users/${id}/edit` : "/users/new");
  }
  next(err);
});
