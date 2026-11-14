import express from "express";
import bcrypt from "bcryptjs";
import { query } from "../db.js";
import { logActivity } from "../activity.js";
import { loginAllowed, noteLoginFailure, clearLoginFailures } from "../middleware.js";

export const authRouter = express.Router();

authRouter.get("/login", (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("pages/login.njk", {
    layout: "auth-layout.njk",
    page: "login",
    title: "Sign in",
    error: null,
    email: "",
    next: typeof req.query.next === "string" ? req.query.next : "",
  });
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const nextUrl = typeof req.body.next === "string" && req.body.next.startsWith("/") ? req.body.next : "/";
    const key = `${req.ip}:${email}`;

    const fail = async (message) =>
      res.status(401).render("pages/login.njk", {
        layout: "auth-layout.njk",
        page: "login",
        title: "Sign in",
        error: message,
        email,
        next: req.body.next || "",
      });

    if (!loginAllowed(key)) {
      return fail("Too many attempts. Wait 15 minutes before trying again.");
    }

    const { rows } = await query("SELECT * FROM users WHERE email = $1", [email]);
    const user = rows[0];
    if (!user || user.status !== "active" || !(await bcrypt.compare(password, user.password_hash))) {
      noteLoginFailure(key);
      return fail("That email and password do not match an active account.");
    }

    clearLoginFailures(key);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar_path: user.avatar_path || null,
      };
      req.session.save(async (saveErr) => {
        if (saveErr) return next(saveErr);
        await query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
        await logActivity({ userId: user.id, action: "login", subjectType: "user", subjectId: user.id });
        res.redirect(nextUrl);
      });
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("modwatch.sid");
    res.redirect("/login");
  });
});
