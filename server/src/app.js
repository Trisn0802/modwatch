import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import nunjucks from "nunjucks";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import helmet from "helmet";
import bcrypt from "bcryptjs";

import { config } from "./config.js";
import { pool, query, waitForDb } from "./db.js";
import { ensureSettings } from "./settings.js";
import { ensureCsrf, csrfProtection, requireAuth, exposeFlash } from "./middleware.js";
import { navStats, notificationHref } from "./queries.js";
import { notificationFeed } from "./notify.js";
import { cleanupPreviews } from "./import.js";
import { getProjects } from "./sources/modrinth.js";
import { startScheduler, schedulerState } from "./scheduler.js";
import {
  number, fileSize, relative, countdown, date, dateTime, isoDate, initials, truncate, json, modIcon, percent,
} from "./helpers.js";
import {
  STATUS, SOURCE, LOADER, CHANNEL, SIDE, REASON, ROLE, USER_STATUS, ACTIVITY_LABEL,
} from "./labels.js";
import { KINDS, KIND_ORDER, kindLabel, kindPlural, kindFolder } from "./kinds.js";

import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { instancesRouter } from "./routes/instances.js";
import { modsRouter } from "./routes/mods.js";
import { importsRouter } from "./routes/imports.js";
import { approvalsRouter } from "./routes/approvals.js";
import { notificationsRouter } from "./routes/notifications.js";
import { activityRouter } from "./routes/activity.js";
import { settingsRouter } from "./routes/settings.js";
import { usersRouter } from "./routes/users.js";
import { searchRouter } from "./routes/search.js";
import { eventsRouter } from "./routes/events.js";
import { progressRouter } from "./routes/progress.js";
import { publicRouter } from "./routes/public.js";
import { authorizeChannel, broadcastRefresh, realtimeConfig, realtimeEnabled } from "./realtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const schema = fs.readFileSync(path.join(root, "db", "schema.sql"), "utf8");

const assetVersion = (() => {
  const stamp = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(css|js)$/i.test(entry.name)) {
        stamp.push(`${path.relative(root, full)}:${crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex")}`);
      }
    }
  };
  try {
    walk(path.join(root, "public", "assets"));
  } catch {
    return "0";
  }
  return crypto.createHash("sha1").update(stamp.sort().join("|")).digest("hex").slice(0, 10);
})();

await waitForDb();
const schemaClient = await pool.connect();
try {
  await schemaClient.query("SELECT pg_advisory_lock(20261030)");
  await schemaClient.query(schema);
} finally {
  await schemaClient.query("SELECT pg_advisory_unlock(20261030)").catch(() => {});
  schemaClient.release();
}
await ensureSettings();

// Small, one-time-ish backfill for icons on databases imported before icon_url
// was persisted. It runs in the background and skips when nothing is missing.
async function backfillIcons() {
  const { rows } = await query(
    `SELECT DISTINCT project_id FROM mods
      WHERE source = 'modrinth' AND project_id IS NOT NULL
        AND (icon_url IS NULL OR icon_url = '')`
  );
  const ids = rows.map((row) => row.project_id).filter(Boolean).slice(0, 500);
  if (!ids.length) return;
  const projects = await getProjects(ids);
  for (const [id, project] of projects) {
    if (project?.icon_url) await query("UPDATE mods SET icon_url = $2 WHERE project_id = $1 AND source = 'modrinth'", [id, project.icon_url]);
  }
}
backfillIcons().catch((err) => console.error("icon backfill:", err.message));

// First admin, only when the database has no users at all.
const { rows: userCount } = await query("SELECT count(*)::int AS n FROM users");
if (userCount[0].n === 0) {
  if (config.adminEmail && config.adminPassword) {
    await query(
      `INSERT INTO users (name, email, role, password_hash) VALUES ($1,$2,'admin',$3)`,
      [config.adminName, config.adminEmail, await bcrypt.hash(config.adminPassword, 12)]
    );
    console.log(`Created the first admin: ${config.adminEmail}`);
  } else {
    console.warn("No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env to create the first admin.");
  }
}

await cleanupPreviews(24 * 7).catch(() => {});

const app = express();
if (config.trustProxy) app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        scriptSrc: ["'self'"],
        // Only force HTTPS when this deployment says it is HTTPS. Plain HTTP
        // on a LAN address must keep loading its own assets and forms.
        upgradeInsecureRequests: config.nodeEnv === "production" && config.appUrl.startsWith("https://") ? [] : null,
        imgSrc: ["'self'", "data:", "https://cdn.modrinth.com", "https://avatars.githubusercontent.com", "https://*.githubusercontent.com", "https://media.forgecdn.net", "https://mediafilez.forgecdn.net", "https://edge.forgecdn.net"],
        connectSrc: ["'self'", "https://*.pusher.com", "wss://*.pusher.com"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

const env = nunjucks.configure(path.join(root, "views"), {
  express: app,
  autoescape: true,
  noCache: config.nodeEnv !== "production",
  watch: false,
});
app.set("view engine", "njk");

const filters = {
  number, fileSize, relative, countdown, date, dateTime, isoDate, initials, truncate, json, modIcon, percent,
};
for (const [name, fn] of Object.entries(filters)) env.addFilter(name, fn);
env.addFilter("statusMeta", (value) => STATUS[value] || { label: value, tone: "neutral" });
env.addFilter("sourceMeta", (value) => SOURCE[value] || { label: value, tone: "neutral" });
env.addFilter("loaderLabel", (value) => LOADER[value] || value);
env.addFilter("channelLabel", (value) => CHANNEL[value] || value);
env.addFilter("sideLabel", (value) => SIDE[value] || value);
env.addFilter("reasonLabel", (value) => REASON[value] || value);
env.addFilter("roleLabel", (value) => ROLE[value] || value);
env.addFilter("userStatus", (value) => USER_STATUS[value] || { label: value, tone: "neutral" });
env.addFilter("activityLabel", (value) => ACTIVITY_LABEL[value] || value);
env.addFilter("includes", (list, value) => Array.isArray(list) && list.includes(value));
env.addFilter("endsWith", (value, suffix) => String(value || "").toLowerCase().endsWith(String(suffix || "").toLowerCase()));
env.addFilter("urlencode", (value) => encodeURIComponent(value ?? ""));
env.addFilter("kindLabel", kindLabel);
env.addFilter("kindPlural", kindPlural);
env.addFilter("kindFolder", kindFolder);
env.addGlobal("KIND_ORDER", KIND_ORDER);
env.addGlobal("KIND_META", KINDS);

app.use("/assets", express.static(path.join(root, "public", "assets"), {
  maxAge: config.nodeEnv === "production" ? "7d" : 0,
  setHeaders: (res) => {
    if (config.nodeEnv !== "production") res.setHeader("Cache-Control", "no-store");
  },
}));
app.use("/uploads", express.static(path.join(root, "uploads"), { maxAge: 0, index: false }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "1mb" }));

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({ pool, tableName: "session", createTableIfMissing: false }),
    name: "modwatch.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: true,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.nodeEnv === "production" && config.appUrl.startsWith("https://"),
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  })
);

app.use(ensureCsrf);
app.use(csrfProtection);
app.use(exposeFlash);

app.use((req, res, next) => {
  res.on("finish", () => {
    const upload = req.method === "POST" && req.path.endsWith("/imports/upload");
    if (res.statusCode === 404 || upload) {
      console.log("[request]", req.method, req.originalUrl, res.statusCode, req.get("host") || "", req.get("content-type") || "");
    }
  });
  next();
});

app.get("/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(async (req, res, next) => {
  try {
    const user = req.session.user || null;
    res.locals.currentUser = user;
    res.locals.isAdmin = user?.role === "admin";
    res.locals.path = req.path;
    res.locals.baseUrl = config.appUrl || `${req.protocol}://${req.get("host")}`;
    const first = req.path.split("/")[1] || "";
    res.locals.area = ["instances", "mods", "imports"].includes(first) ? "instances" : (first || "dashboard");
    res.locals.assetVersion = assetVersion;
    res.locals.appVersion = config.appVersion;
    res.locals.scheduler = schedulerState();
    res.locals.notifHref = notificationHref;
    res.locals.env = {
      curseforgeReady: config.curseforgeReady,
      githubReady: Boolean(config.githubToken),
      telegramReady: config.telegramReady,
    };
    res.locals.pusher = { ...realtimeConfig(), userId: user?.id || null };
    res.locals.notif = user ? await notificationFeed(user.id, 6) : { items: [], unread: 0 };
    res.locals.pendingRequests = user?.role === "admin"
      ? (await query(
          `SELECT ((SELECT count(*)::int FROM mod_requests WHERE status = 'pending')
                 + (SELECT count(*)::int FROM import_requests WHERE status = 'pending')) AS n`
        )).rows[0].n
      : 0;
    res.locals.nav = user ? await navStats(user) : { updates: 0, unknown: 0, requests: 0, unread: 0 };
    next();
  } catch (err) {
    next(err);
  }
});

app.use(authRouter);
app.use(publicRouter);

app.post("/pusher/auth", (req, res) => {
  if (!realtimeEnabled()) return res.status(404).json({ error: "Realtime is not configured" });
  const user = req.session.user;
  if (!user) return res.status(403).json({ error: "Sign in first" });
  const socketId = String(req.body?.socket_id || "");
  const channel = String(req.body?.channel_name || "");
  if (!/^\d+\.\d+$/.test(socketId)) return res.status(400).json({ error: "Invalid socket id" });
  const allowed = channel === "private-workspace" || channel === `private-user-${user.id}`;
  if (!allowed) return res.status(403).json({ error: "Channel not allowed" });
  try {
    res.json(authorizeChannel(socketId, channel));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Every successful write gets a scope event after the response is sent. Reads
// (GET) stay silent so a page reload cannot trigger another reload.
app.use((req, res, next) => {
  if (!realtimeEnabled() || req.method !== "POST" || !req.session.user) return next();
  if (["/login", "/logout", "/pusher/auth"].includes(req.path)) return next();
  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    let scope = "workspace";
    if (req.path.startsWith("/approvals")) scope = "approvals";
    else if (req.path.startsWith("/instances") || req.path === "/check-all") scope = "instances";
    else if (req.path.startsWith("/mods")) scope = "mods";
    else if (req.path.startsWith("/imports")) scope = "instances";
    else if (req.path.startsWith("/notifications")) scope = "notifications";
    else if (req.path.startsWith("/settings")) scope = "settings";
    else if (req.path.startsWith("/users")) scope = "users";
    broadcastRefresh(scope, { at: new Date().toISOString() }).catch(() => {});
  });
  next();
});

app.use(requireAuth);
app.get("/api/csrf", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ token: req.session.csrf || "" });
});
app.use(eventsRouter);
app.use(progressRouter);

app.use(dashboardRouter);
app.use(instancesRouter);
app.use(importsRouter);
app.use(modsRouter);
app.use(approvalsRouter);
app.use(notificationsRouter);
app.use(activityRouter);
app.use(settingsRouter);
app.use(usersRouter);
app.use(searchRouter);

app.use((req, res) => {
  res.status(404).render("pages/404.njk", { page: "", title: "Not found" });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.locals.currentUser = res.locals.currentUser || null;
  res.locals.notif = res.locals.notif || { items: [], unread: 0 };
  res.locals.nav = res.locals.nav || { updates: 0, unknown: 0, requests: 0, unread: 0 };
  res.locals.pendingRequests = res.locals.pendingRequests || 0;
  res.locals.flash = res.locals.flash || null;
  res.locals.assetVersion = res.locals.assetVersion || assetVersion;
  res.locals.path = res.locals.path || req.path;
  res.locals.baseUrl = res.locals.baseUrl || config.appUrl || `${req.protocol}://${req.get("host")}`;
  res.locals.notifHref = res.locals.notifHref || notificationHref;
  res.locals.scheduler = res.locals.scheduler || schedulerState();
  res.status(500).render("pages/500.njk", {
    page: "",
    title: "Something went wrong",
    message: config.nodeEnv === "production" ? "The request could not be completed." : err.message,
  });
});

app.listen(config.port, () => {
  console.log(`ModWatch running on http://localhost:${config.port}`);
  startScheduler().catch((err) => console.error("scheduler start:", err.message));
});
