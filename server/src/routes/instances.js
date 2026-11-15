import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query, withTransaction } from "../db.js";
import { instanceById, instanceStats, unknownMods } from "../queries.js";
import { checkInstance } from "../checker.js";
import { logActivity } from "../activity.js";
import { flash, csrfValid } from "../middleware.js";
import { SOURCE, STATUS } from "../labels.js";
import { resolveProjectUrl } from "../sources/index.js";
import { KIND_ORDER, isKind, kindPlural } from "../kinds.js";
import { instanceUpload, receiveUpload, uploadPath, removeUpload, uploadMessage } from "../uploads.js";
import { buildExport, latestExport, getExportByToken, removeInstanceFiles, ensureStoredJar } from "../export.js";
import { updateAllInInstance } from "../updater.js";
import { listModsForZip, streamModZip } from "../mod-zip.js";

export const instancesRouter = express.Router();

const LOADERS = ["forge", "fabric", "neoforge", "quilt", "plugin"];

function intParam(value, fallback = 1) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Filters arrive as repeated query params, and old links may still carry a
// comma-joined value from the single-select days.
function multiParam(value) {
  const out = [];
  for (const item of [].concat(value ?? [])) {
    for (const part of String(item).split(",")) {
      const next = part.trim();
      if (next && !out.includes(next)) out.push(next);
    }
  }
  return out;
}

function instanceHref(id, { status = "all", kinds = [], sources = [], q = "", page = 0, omitKind = "", omitSource = "" } = {}) {
  const params = new URLSearchParams();
  if (status && status !== "all") params.set("status", status);
  for (const kind of kinds) if (kind !== omitKind) params.append("kind", kind);
  for (const source of sources) if (source !== omitSource) params.append("source", source);
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const search = params.toString();
  return `/instances/${id}${search ? `?${search}` : ""}`;
}

instancesRouter.get("/instances", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.*,
         count(m.id)::int AS mod_count,
         count(*) FILTER (WHERE m.status = 'update_available')::int AS updates,
         count(*) FILTER (WHERE m.status = 'manual')::int AS manual,
         count(*) FILTER (WHERE m.status = 'source_error')::int AS errors,
         (SELECT count(*)::int FROM unknown_mods u WHERE u.instance_id = i.id AND u.resolution = 'pending') AS unknown
       FROM instances i LEFT JOIN mods m ON m.instance_id = i.id
       GROUP BY i.id ORDER BY i.name`
    );
    res.render("pages/instances.njk", { page: "instances", title: "Instances", instances: rows });
  } catch (err) {
    next(err);
  }
});

instancesRouter.get("/instances/new", (req, res) => {
  res.render("pages/instance-form.njk", {
    page: "instances",
    title: "New instance",
    instance: null,
    loaders: LOADERS,
    error: null,
  });
});

instancesRouter.post("/instances", async (req, res, next) => {
  try {
    await receiveUpload(instanceUpload, req, res);
    if (!csrfValid(req)) {
      await removeUpload(uploadPath(req.file, "instances"));
      return res.status(403).render("pages/403.njk", {
        page: "", title: "Request expired",
        message: "Your form session expired. Reload the page and try again.",
      });
    }
    const name = String(req.body.name || "").trim();
    const mcVersion = String(req.body.mc_version || "").trim();
    const loader = String(req.body.loader || "forge");
    const loaderVersion = String(req.body.loader_version || "").trim();
    const packVersion = String(req.body.pack_version || "").trim();
    const notes = String(req.body.notes || "").trim();
    if (!name || !mcVersion || !LOADERS.includes(loader)) {
      await removeUpload(uploadPath(req.file, "instances"));
      return res.status(400).render("pages/instance-form.njk", {
        page: "instances", title: "New instance", instance: req.body, loaders: LOADERS,
        error: "Name, Minecraft version and a valid loader are required.",
      });
    }
    const exists = await query("SELECT 1 FROM instances WHERE name = $1", [name]);
    if (exists.rows.length) {
      await removeUpload(uploadPath(req.file, "instances"));
      return res.status(409).render("pages/instance-form.njk", {
        page: "instances", title: "New instance", instance: req.body, loaders: LOADERS,
        error: "An instance with that name already exists.",
      });
    }
    const { rows } = await query(
      `INSERT INTO instances (name, mc_version, loader, loader_version, pack_version, notes, image_path, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [name, mcVersion, loader, loaderVersion, packVersion, notes, uploadPath(req.file, "instances"), req.session.user.id]
    );
    await logActivity({
      userId: req.session.user.id, action: "instance_created",
      subjectType: "instance", subjectId: rows[0].id, meta: { name, mcVersion, loader },
    });
    flash(req, "ok", `${name} is ready. Add mods or import a .mrpack.`);
    res.redirect(`/instances/${rows[0].id}`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.get("/instances/:id", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const stats = await instanceStats(instance.id);
    const unknown = await unknownMods(instance.id);
    const status = ["all", "updates", "unknown", "manual", "errors", "ignored"].includes(req.query.status)
      ? req.query.status
      : "all";
    const kinds = multiParam(req.query.kind).filter(isKind);
    const sources = multiParam(req.query.source).filter((value) => SOURCE[value]);
    const q = String(req.query.q || "").trim();
    const page = intParam(req.query.page);
    const pageSize = 40;

    let mods = [];
    let total = 0;
    let pages = 1;

    if (status !== "unknown") {
      const where = ["m.instance_id = $1"];
      const params = [instance.id];
      if (status === "updates") where.push("m.status = 'update_available'");
      if (status === "manual") where.push("m.status = 'manual'");
      if (status === "errors") where.push("m.status = 'source_error'");
      if (status === "ignored") where.push("m.status = 'ignored'");
      if (status === "all") where.push("m.status <> 'ignored'");
      if (kinds.length) {
        params.push(kinds);
        where.push(`m.kind = ANY($${params.length}::text[])`);
      }
      if (sources.length) {
        params.push(sources);
        where.push(`m.source = ANY($${params.length}::text[])`);
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(`(m.name ILIKE $${params.length} OR m.file_name ILIKE $${params.length} OR m.installed_version ILIKE $${params.length} OR m.creator_name ILIKE $${params.length})`);
      }
      const clause = where.join(" AND ");
      const countRes = await query(`SELECT count(*)::int AS n FROM mods m WHERE ${clause}`, params);
      total = countRes.rows[0].n;
      pages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pages);
      const { rows } = await query(
        `SELECT m.* FROM mods m WHERE ${clause}
         ORDER BY CASE m.status WHEN 'update_available' THEN 0 WHEN 'source_error' THEN 1 WHEN 'unknown' THEN 2 ELSE 3 END,
                  m.name
         LIMIT ${pageSize} OFFSET ${(safePage - 1) * pageSize}`,
        params
      );
      mods = rows;
      req.query.page = safePage;
    }

    const [{ rows: sourceRows }, { rows: kindRows }] = await Promise.all([
      query(
        "SELECT source, count(*)::int AS n FROM mods WHERE instance_id = $1 AND status <> 'ignored' GROUP BY source",
        [instance.id]
      ),
      query(
        "SELECT kind, count(*)::int AS n FROM mods WHERE instance_id = $1 AND status <> 'ignored' GROUP BY kind",
        [instance.id]
      ),
    ]);
    const sourceCounts = Object.fromEntries(sourceRows.map((r) => [r.source, r.n]));
    const kindCounts = Object.fromEntries(kindRows.map((r) => [r.kind, r.n]));

    const selectedSources = sources.map((source) => SOURCE[source]?.label || source);
    const chips = [
      ...kinds.map((kind) => ({
        label: kindPlural(kind),
        count: kindCounts[kind] || 0,
        href: instanceHref(instance.id, { status, kinds, sources, q, omitKind: kind }),
      })),
      ...sources.map((source) => ({
        label: SOURCE[source]?.label || source,
        count: sourceCounts[source] || 0,
        href: instanceHref(instance.id, { status, kinds, sources, q, omitSource: source }),
      })),
    ];

    const statusTabs = [
      { key: "all", label: "All", count: Math.max(0, stats.mod_count - stats.ignored) },
      { key: "updates", label: "Updates", count: stats.updates, accent: true },
      { key: "unknown", label: "Unknown", count: stats.unknown },
      { key: "manual", label: "Manual", count: stats.manual },
      { key: "errors", label: "Errors", count: stats.errors },
      { key: "ignored", label: "Ignored", count: stats.ignored },
    ].map((tab) => ({
      ...tab,
      href: instanceHref(instance.id, { status: tab.key, kinds, sources, q }),
    }));

    res.render("pages/instance.njk", {
      page: "instances",
      title: instance.name,
      instance,
      stats,
      unknown,
      mods,
      total,
      pages,
      currentPage: intParam(req.query.page),
      status,
      statusTabs,
      selectedKinds: kinds,
      selectedSources: sources,
      selectedSourcesLabel: selectedSources.join(", "),
      chips,
      filterCount: kinds.length + sources.length,
      filterResetHref: instanceHref(instance.id, { status, q }),
      kindOptions: KIND_ORDER.map((kind) => ({ value: kind, label: kindPlural(kind), count: kindCounts[kind] || 0 })),
      sourceOptions: ["modrinth", "curseforge", "github", "manual"].map((source) => ({
        value: source,
        label: SOURCE[source].label,
        count: sourceCounts[source] || 0,
      })),
      pagerBase: instanceHref(instance.id, { status, kinds, sources, q }),
      q,
      sourceCounts,
      kindCounts,
    });
  } catch (err) {
    next(err);
  }
});

instancesRouter.get("/instances/:id/edit", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    res.render("pages/instance-form.njk", {
      page: "instances", title: `Edit ${instance.name}`, instance, loaders: LOADERS, error: null,
    });
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id", async (req, res, next) => {
  try {
    await receiveUpload(instanceUpload, req, res);
    if (!csrfValid(req)) {
      await removeUpload(uploadPath(req.file, "instances"));
      return res.status(403).render("pages/403.njk", {
        page: "", title: "Request expired",
        message: "Your form session expired. Reload the page and try again.",
      });
    }
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) {
      await removeUpload(uploadPath(req.file, "instances"));
      return next();
    }
    const name = String(req.body.name || "").trim();
    const mcVersion = String(req.body.mc_version || "").trim();
    const loader = String(req.body.loader || instance.loader);
    const loaderVersion = String(req.body.loader_version || "").trim();
    const packVersion = String(req.body.pack_version || "").trim();
    const notes = String(req.body.notes || "").trim();
    if (!name || !mcVersion || !LOADERS.includes(loader)) {
      await removeUpload(uploadPath(req.file, "instances"));
      return res.status(400).render("pages/instance-form.njk", {
        page: "instances", title: `Edit ${instance.name}`, instance: { ...instance, ...req.body },
        loaders: LOADERS, error: "Name, Minecraft version and a valid loader are required.",
      });
    }
    let imagePath = instance.image_path;
    if (req.file) {
      imagePath = uploadPath(req.file, "instances");
      await removeUpload(instance.image_path);
    } else if (req.body.remove_image === "1") {
      await removeUpload(instance.image_path);
      imagePath = null;
    }
    const telegramUpdates = req.session.user.role === "admin"
      ? req.body.telegram_updates === "1"
      : instance.telegram_updates;
    await query(
      `UPDATE instances SET name = $1, mc_version = $2, loader = $3, loader_version = $4,
         pack_version = $5, notes = $6, image_path = $7, telegram_updates = $8 WHERE id = $9`,
      [name, mcVersion, loader, loaderVersion, packVersion, notes, imagePath, telegramUpdates, instance.id]
    );
    await logActivity({
      userId: req.session.user.id, action: "instance_updated",
      subjectType: "instance", subjectId: instance.id, meta: { name, mcVersion, loader },
    });
    flash(req, "ok", "Instance settings saved.");
    res.redirect(`/instances/${instance.id}`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id/telegram", async (req, res, next) => {
  try {
    if (req.session.user.role !== "admin") {
      flash(req, "error", "Only an admin can change Telegram updates.");
      return res.redirect(`/instances/${intParam(req.params.id)}`);
    }
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const enabled = instance.telegram_updates === false;
    await query("UPDATE instances SET telegram_updates = $2 WHERE id = $1", [instance.id, enabled]);
    await logActivity({
      userId: req.session.user.id, action: "instance_updated", subjectType: "instance",
      subjectId: instance.id, meta: { name: instance.name, telegram: enabled },
    });
    flash(req, "ok", enabled
      ? `Telegram updates are on for ${instance.name}.`
      : `Telegram updates are off for ${instance.name}. In-app notifications still arrive.`);
    res.redirect(req.get("referer") || `/instances/${instance.id}`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id/update-all", async (req, res, next) => {
  try {
    if (req.session.user.role !== "admin") {
      flash(req, "error", "Only an admin can download and update mods.");
      return res.redirect(`/instances/${intParam(req.params.id)}`);
    }
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const result = await updateAllInInstance(instance.id, { userId: req.session.user.id });
    if (!result.total) {
      flash(req, "ok", "There are no updates waiting to download.");
      return res.redirect(`/instances/${instance.id}`);
    }
    await checkInstance(instance.id, { trigger: "manual", userId: req.session.user.id }).catch(() => {});
    const lines = [
      `${result.updated.length} of ${result.total} mods updated and verified.`,
      result.failed.length ? `${result.failed.length} failed: ${result.failed.map((item) => item.name).join(", ")}.` : "",
    ].filter(Boolean);
    flash(req, result.failed.length ? "error" : "ok", lines.join(" "));
    res.redirect(`/instances/${instance.id}`);
  } catch (err) {
    flash(req, "error", err.message || "The bulk update could not finish.");
    res.redirect(`/instances/${intParam(req.params.id)}`);
  }
});

instancesRouter.post("/instances/:id/share", async (req, res, next) => {
  try {
    if (req.session.user.role !== "admin") {
      flash(req, "error", "Only an admin can create a share link.");
      return res.redirect(`/instances/${intParam(req.params.id)}`);
    }
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const token = instance.share_token || crypto.randomBytes(8).toString("hex");
    await query("UPDATE instances SET share_token = $2, share_created_at = COALESCE(share_created_at, now()) WHERE id = $1", [instance.id, token]);
    await logActivity({
      userId: req.session.user.id, action: "instance_updated", subjectType: "instance",
      subjectId: instance.id, meta: { name: instance.name, share: true },
    });
    flash(req, "ok", `Share link ready: /s/${token}`);
    res.redirect(`/instances/${instance.id}`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id/share/revoke", async (req, res, next) => {
  try {
    if (req.session.user.role !== "admin") {
      flash(req, "error", "Only an admin can revoke a share link.");
      return res.redirect(`/instances/${intParam(req.params.id)}`);
    }
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    await query("UPDATE instances SET share_token = NULL WHERE id = $1", [instance.id]);
    flash(req, "ok", "Share link revoked.");
    res.redirect(`/instances/${instance.id}`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id/export", async (req, res, next) => {
  try {
    if (req.session.user.role !== "admin") {
      flash(req, "error", "Only an admin can generate an export.");
      return res.redirect(`/instances/${intParam(req.params.id)}`);
    }
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const result = await buildExport(instance, { userId: req.session.user.id });
    await logActivity({
      userId: req.session.user.id, action: "import", subjectType: "instance", subjectId: instance.id,
      meta: { export: true, name: instance.name, counts: result.counts },
    });
    flash(req, "ok", `Export ready with ${result.counts.files} index files and ${result.counts.overrides} overrides.`);
    res.redirect(`/exports/${result.token}/download`);
  } catch (err) {
    if (err.code === "unsupported_loader") {
      flash(req, "error", err.message);
      return res.redirect(`/instances/${intParam(req.params.id)}`);
    }
    next(err);
  }
});

instancesRouter.post("/instances/:id/download-zip", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const ids = [].concat(req.body.mod_ids || [])
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    const all = String(req.body.all || "") === "1";
    const source = String(req.body.source || "").trim();
    const kinds = multiParam(req.body.kind).filter(isKind);
    const mods = await listModsForZip(instance, { modIds: ids, all, source, kinds });
    if (!mods.length) {
      flash(req, "error", "Select at least one mod to download.");
      return res.redirect(`/instances/${instance.id}`);
    }
    await streamModZip(instance, mods, res);
  } catch (err) {
    if (res.headersSent) {
      console.error("mod zip:", err.message);
      res.destroy();
      return;
    }
    next(err);
  }
});

instancesRouter.get("/instances/:id/export/latest", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    let record = await latestExport(instance.id);
    if (!record && req.session.user.role === "admin") {
      const built = await buildExport(instance, { userId: req.session.user.id });
      record = { file_path: built.file_path };
    }
    if (!record) {
      flash(req, "error", "No export exists yet. Ask an admin to generate one.");
      return res.redirect(`/instances/${instance.id}`);
    }
    res.download(path.join(process.cwd(), "uploads", record.file_path), `${instance.pack_name || instance.name}.mrpack`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.get("/exports/:token/download", async (req, res, next) => {
  try {
    const record = await getExportByToken(req.params.token);
    if (!record) return next();
    const { rows } = await query("SELECT * FROM instances WHERE id = $1", [record.instance_id]);
    const instance = rows[0];
    res.download(
      path.join(process.cwd(), "uploads", record.file_path),
      `${instance?.pack_name || instance?.name || "modwatch-pack"}.mrpack`
    );
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id/duplicate", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const copy = await withTransaction(async (client) => {
      let name = `${instance.name} copy`;
      let n = 2;
      while ((await client.query("SELECT 1 FROM instances WHERE name = $1", [name])).rows.length) {
        name = `${instance.name} copy ${n}`;
        n += 1;
      }
      const { rows } = await client.query(
        `INSERT INTO instances (name, mc_version, loader, loader_version, pack_name, pack_version, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [name, instance.mc_version, instance.loader, instance.loader_version, instance.pack_name,
         instance.pack_version, instance.notes, req.session.user.id]
      );
      const target = rows[0];
      await client.query(
        `INSERT INTO mods (instance_id, name, side, source, project_id, project_url, github_asset_pattern,
            installed_version, installed_version_id, file_name, file_sha1, file_sha512, file_size,
            channel_policy, status, latest_version, latest_version_id, latest_published_at, added_by)
         SELECT $1, name, side, source, project_id, project_url, github_asset_pattern, installed_version,
            installed_version_id, file_name, file_sha1, file_sha512, file_size, channel_policy, status,
            latest_version, latest_version_id, latest_published_at, added_by
           FROM mods WHERE instance_id = $2`,
        [target.id, instance.id]
      );
      return target;
    });
    await logActivity({
      userId: req.session.user.id, action: "instance_created",
      subjectType: "instance", subjectId: copy.id, meta: { name: copy.name, duplicatedFrom: instance.name },
    });
    flash(req, "ok", `Duplicated ${instance.name}.`);
    res.redirect(`/instances/${copy.id}`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id/delete", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const { rows: files } = await query("SELECT file_path FROM exports WHERE instance_id = $1", [instance.id]);
    await query("DELETE FROM instances WHERE id = $1", [instance.id]);
    await removeInstanceFiles(instance.id);
    for (const file of files) {
      await fs.promises.rm(path.join(process.cwd(), "uploads", file.file_path), { force: true }).catch(() => {});
    }
    await removeUpload(instance.image_path);
    await logActivity({
      userId: req.session.user.id, action: "instance_deleted",
      subjectType: "instance", subjectId: instance.id, meta: { name: instance.name },
    });
    flash(req, "ok", `${instance.name} and its mod list were deleted.`);
    res.redirect("/instances");
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id/check", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    checkInstance(instance.id, { trigger: "manual", userId: req.session.user.id }).catch((err) =>
      console.error("manual instance check:", err.message)
    );
    if (req.accepts(["html", "json"]) === "json") {
      return res.json({ started: true, instance: instance.name });
    }
    flash(req, "ok", `Checking ${instance.name}. Results land on the board as they finish.`);
    res.redirect(`/instances/${instance.id}`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id/unknown/:unknownId", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const unknownId = intParam(req.params.unknownId);
    const { rows } = await query(
      "SELECT * FROM unknown_mods WHERE id = $1 AND instance_id = $2 AND resolution = 'pending'",
      [unknownId, instance.id]
    );
    const item = rows[0];
    if (!item) {
      flash(req, "error", "That unknown file was already resolved.");
      return res.redirect(`/instances/${instance.id}?status=unknown`);
    }
    const action = String(req.body.action || "");

    if (action === "ignore") {
      await query(
        "UPDATE unknown_mods SET resolution = 'ignored', resolved_at = now() WHERE id = $1",
        [item.id]
      );
      await logActivity({
        userId: req.session.user.id, action: "unknown_resolved", subjectType: "instance",
        subjectId: instance.id, meta: { file: item.file_name, resolution: "ignored" },
      });
      flash(req, "ok", `${item.file_name} will be ignored.`);
      return res.redirect(`/instances/${instance.id}?status=unknown`);
    }

    if (action === "manual") {
      const { rows: inserted } = await query(
        `INSERT INTO mods (instance_id, name, source, installed_version, file_name, file_sha1, file_sha512,
            file_size, stored_path, status, latest_version, added_by)
         VALUES ($1,$2,'manual',$3,$4,$5,$6,$7,$8,'manual',$3,$9) RETURNING id`,
        [
          instance.id,
          item.jar_name || item.file_name.replace(/\.jar$/i, ""),
          item.jar_version || "unknown version",
          item.file_name, item.file_sha1, item.file_sha512, item.file_size, item.stored_path || null,
          req.session.user.id,
        ]
      );
      await query(
        `UPDATE unknown_mods SET resolution = 'manual', mod_id = $2, resolved_at = now() WHERE id = $1`,
        [item.id, inserted[0].id]
      );
      await logActivity({
        userId: req.session.user.id, action: "unknown_resolved", subjectType: "instance",
        subjectId: instance.id, meta: { file: item.file_name, resolution: "manual" },
      });
      flash(req, "ok", `${item.file_name} is now tracked as a manual mod.`);
      return res.redirect(`/instances/${instance.id}?status=unknown`);
    }

    if (action === "source") {
      const url = String(req.body.project_url || "").trim();
      const resolved = await resolveProjectUrl(url);
      if (!resolved) {
        flash(req, "error", "That project URL was not recognised. Use a Modrinth, CurseForge or GitHub project page.");
        return res.redirect(`/instances/${instance.id}?status=unknown`);
      }
      const { rows: inserted } = await query(
        `INSERT INTO mods (instance_id, name, source, project_id, project_url, installed_version, file_name,
            file_sha1, file_sha512, file_size, icon_url, stored_path, status, latest_version, added_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'up_to_date',$6,$13) RETURNING id`,
        [
          instance.id, resolved.name, resolved.source, resolved.project_id, resolved.project_url,
          item.jar_version || "unknown version", item.file_name, item.file_sha1, item.file_sha512,
          item.file_size, resolved.icon_url || null, item.stored_path || null, req.session.user.id,
        ]
      );
      await query(
        `UPDATE unknown_mods SET resolution = 'source_set', mod_id = $2, resolved_at = now() WHERE id = $1`,
        [item.id, inserted[0].id]
      );
      const { rows: storedRows } = await query("SELECT * FROM mods WHERE id = $1", [inserted[0].id]);
      ensureStoredJar(storedRows[0]).catch((err) => console.error("store resolved jar:", err.message));
      checkInstance(instance.id, { trigger: "manual", userId: req.session.user.id }).catch(() => {});
      flash(req, "ok", `${item.file_name} is now tracked from ${SOURCE[resolved.source]?.label || resolved.source}.`);
      return res.redirect(`/instances/${instance.id}?status=unknown`);
    }

    flash(req, "error", "Choose an action for that file.");
    res.redirect(`/instances/${instance.id}?status=unknown`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.post("/instances/:id/unknown-bulk", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const action = String(req.body.action || "");
    const pending = await unknownMods(instance.id);
    if (!pending.length) {
      flash(req, "error", "There are no unidentified files left.");
      return res.redirect(`/instances/${instance.id}`);
    }
    if (action === "ignore") {
      await query(
        "UPDATE unknown_mods SET resolution = 'ignored', resolved_at = now() WHERE instance_id = $1 AND resolution = 'pending'",
        [instance.id]
      );
      flash(req, "ok", `${pending.length} files will be ignored.`);
    } else if (action === "manual") {
      await withTransaction(async (client) => {
        for (const item of pending) {
          const { rows } = await client.query(
            `INSERT INTO mods (instance_id, name, source, installed_version, file_name, file_sha1, file_sha512,
                file_size, stored_path, status, latest_version, added_by)
             VALUES ($1,$2,'manual',$3,$4,$5,$6,$7,$8,'manual',$3,$9) RETURNING id`,
            [
              instance.id, item.jar_name || item.file_name.replace(/\.jar$/i, ""),
              item.jar_version || "unknown version", item.file_name, item.file_sha1, item.file_sha512,
              item.file_size, item.stored_path || null, req.session.user.id,
            ]
          );
          await client.query(
            "UPDATE unknown_mods SET resolution = 'manual', mod_id = $2, resolved_at = now() WHERE id = $1",
            [item.id, rows[0].id]
          );
        }
      });
      flash(req, "ok", `${pending.length} files are now tracked as manual mods.`);
    } else {
      flash(req, "error", "Choose a bulk action.");
      return res.redirect(`/instances/${instance.id}?status=unknown`);
    }
    await logActivity({
      userId: req.session.user.id, action: "unknown_resolved", subjectType: "instance",
      subjectId: instance.id, meta: { bulk: action, count: pending.length },
    });
    res.redirect(`/instances/${instance.id}?status=unknown`);
  } catch (err) {
    next(err);
  }
});

instancesRouter.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE" || err?.code === "IMAGE_TYPE") {
    flash(req, "error", uploadMessage(err));
    const id = Number.parseInt(req.params.id, 10);
    return res.redirect(Number.isFinite(id) ? `/instances/${id}/edit` : "/instances/new");
  }
  next(err);
});
