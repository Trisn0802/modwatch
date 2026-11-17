import express from "express";
import { query } from "../db.js";
import { instanceById } from "../queries.js";
import { searchProjects, resolveProjectUrl, listSourceVersions, projectMeta } from "../sources/index.js";
import { checkOne } from "../checker.js";
import { logActivity } from "../activity.js";
import { flash } from "../middleware.js";
import { createNotifications, telegramSend } from "../notify.js";
import { insertMod, cacheInstalledVersion, markUpdated, VALID_SOURCES } from "../mod-service.js";
import { ensureStoredJar, refreshStoredJar, setStoredDisabled } from "../export.js";
import { updateModToLatest, setModVersion } from "../updater.js";
import { CHANNEL, LOADER, SIDE, SOURCE, STATUS } from "../labels.js";
import { KIND_ORDER, kindLabel, normalizeKind } from "../kinds.js";
import { finishProgress, failProgress, isProgressOp, publishProgress } from "../progress.js";

export const modsRouter = express.Router();

function intParam(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

async function trackedProject(instanceId, resolved) {
  const { rows } = await query(
    "SELECT id, name, source FROM mods WHERE instance_id = $1 AND source = $2 AND project_id = $3 LIMIT 1",
    [instanceId, resolved.source, resolved.project_id]
  );
  return rows[0] || null;
}

modsRouter.get("/instances/:id/mods/new", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const q = String(req.query.q || "").trim();
    const sourceFilter = ["modrinth", "curseforge", "github"].includes(req.query.source)
      ? req.query.source
      : "all";
    const kind = normalizeKind(req.query.kind);
    let results = [];
    let searchError = null;
    if (q) {
      try {
        results = await searchProjects(q, instance, { kind });
        if (sourceFilter !== "all") results = results.filter((item) => item.source === sourceFilter);
      } catch (err) {
        searchError = err.message;
      }
    }
    const payload = {
      instance,
      q,
      kind,
      kindOptions: KIND_ORDER,
      kindLabel: kindLabel(kind),
      sourceFilter,
      results,
      searchError,
      manual: req.query.manual === "1",
      channelOptions: CHANNEL,
    };
    if (req.get("x-requested-with") === "fetch") {
      return res.render("partials/mod-add-results.njk", payload);
    }
    res.render("pages/mod-add.njk", {
      page: "instances",
      title: `Add a mod to ${instance.name}`,
      ...payload,
    });
  } catch (err) {
    next(err);
  }
});

modsRouter.get("/instances/:id/mods/resolve", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const op = isProgressOp(req.query.progress_op) ? req.query.progress_op : "";
    publishProgress(op, { stage: "resolve", message: "Reading the project URL", percent: 20 });
    const url = String(req.query.url || "").trim();
    const resolved = await resolveProjectUrl(url);
    if (!resolved) {
      flash(req, "error", "That project URL was not recognised. Use a Modrinth, CurseForge or GitHub project page.");
      return res.redirect(`/instances/${instance.id}/mods/new?manual=1`);
    }
    const existing = await trackedProject(instance.id, resolved);
    if (existing) {
      finishProgress(op, `${existing.name} is already tracked`);
      flash(req, "ok", `${existing.name} is already tracked in this instance from ${SOURCE[existing.source]?.label || existing.source}.`);
      return res.redirect(`/mods/${existing.id}`);
    }
    if (resolved.resolved_fallback) {
      flash(req, "ok", "CurseForge metadata was unavailable; ModWatch matched the same project on Modrinth.");
    }
    const params = new URLSearchParams({
      source: resolved.source,
      project_id: resolved.project_id,
      kind: normalizeKind(req.query.kind || resolved.kind),
      name: resolved.name || "",
      project_url: resolved.project_url || url,
      icon_url: resolved.icon_url || "",
      creator_name: resolved.creator_name || "",
      creator_url: resolved.creator_url || "",
      creator_avatar_url: resolved.creator_avatar_url || "",
    });
    if (op) params.set("progress_op", op);
    publishProgress(op, { stage: "resolved", message: `Found ${resolved.name || "the project"} on ${SOURCE[resolved.source]?.label || resolved.source}`, percent: 55 });
    res.redirect(`/instances/${instance.id}/mods/choose?${params}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.get("/instances/:id/mods/choose", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const source = VALID_SOURCES.includes(req.query.source) ? req.query.source : "modrinth";
    const projectId = String(req.query.project_id || "");
    const name = String(req.query.name || "");
    const projectUrl = String(req.query.project_url || "");
    const kind = normalizeKind(req.query.kind);
    const op = isProgressOp(req.query.progress_op) ? req.query.progress_op : "";
    if (!projectId) return res.redirect(`/instances/${instance.id}/mods/new`);

    publishProgress(op, { stage: "versions", message: "Loading versions for this instance", percent: 70 });
    let versions = [];
    let error = null;
    try {
      versions = await listSourceVersions(source, projectId, instance, "alpha", req.query.asset_pattern || "", kind);
    } catch (err) {
      error = err.message;
    }
    publishProgress(op, { stage: "versions", message: `${versions.length} version${versions.length === 1 ? "" : "s"} available`, percent: 95 });
    const manual = req.query.manual === "1" || source === "manual";
    res.render("pages/mod-choose.njk", {
      page: "instances",
      title: `Add ${name || "a project"}`,
      instance,
      source,
      projectId,
      kind,
      kindLabel: kindLabel(kind),
      name,
      projectUrl,
      iconUrl: req.query.icon_url || null,
      creatorName: req.query.creator_name || "",
      creatorUrl: req.query.creator_url || "",
      creatorAvatarUrl: req.query.creator_avatar_url || "",
      versions,
      error,
      manual,
      channelOptions: CHANNEL,
      assetPattern: req.query.asset_pattern || "",
    });
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/instances/:id/mods", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const source = VALID_SOURCES.includes(req.body.source) ? req.body.source : "manual";
    const suppliedUrl = String(req.body.project_url || "").trim();
    if (source === "manual" && suppliedUrl) {
      const resolved = await resolveProjectUrl(suppliedUrl);
      if (resolved) {
        const existing = await trackedProject(instance.id, resolved);
        if (existing) {
          flash(req, "ok", `${existing.name} is already tracked in this instance from ${SOURCE[existing.source]?.label || existing.source}.`);
          return res.redirect(`/mods/${existing.id}`);
        }
        if (resolved.resolved_fallback) {
          flash(req, "ok", "CurseForge metadata was unavailable; ModWatch matched the same project on Modrinth.");
        }
        const params = new URLSearchParams({
          source: resolved.source,
          project_id: resolved.project_id,
          kind: normalizeKind(req.body.kind || resolved.kind),
          name: resolved.name || "",
          project_url: resolved.project_url || suppliedUrl,
          icon_url: resolved.icon_url || "",
          creator_name: resolved.creator_name || "",
          creator_url: resolved.creator_url || "",
          creator_avatar_url: resolved.creator_avatar_url || "",
        });
        return res.redirect(`/instances/${instance.id}/mods/choose?${params}`);
      }
      if (/modrinth\.com|curseforge\.com|github\.com/i.test(suppliedUrl)) {
        flash(req, "error", "That project URL could not be resolved. Check the URL or keep it as a plain manual entry without a source link.");
        return res.redirect(`/instances/${instance.id}/mods/new?manual=1`);
      }
    }
    const kind = normalizeKind(req.body.kind);
    const payload = {
      name: String(req.body.name || "").trim(),
      source,
      kind,
      project_id: String(req.body.project_id || "").trim() || null,
      project_url: String(req.body.project_url || "").trim(),
      installed_version: String(req.body.installed_version || "").trim() || "unknown version",
      installed_version_id: String(req.body.installed_version_id || "").trim() || null,
      file_name: String(req.body.file_name || "").trim(),
      file_sha1: String(req.body.file_sha1 || "").trim() || null,
      file_sha512: String(req.body.file_sha512 || "").trim() || null,
      file_size: Number(req.body.file_size) || null,
      icon_url: String(req.body.icon_url || "").trim() || null,
      download_url: String(req.body.download_url || "").trim() || null,
      channel_policy: ["release", "beta", "alpha"].includes(req.body.channel_policy)
        ? req.body.channel_policy
        : "release",
      side: ["both", "client", "server"].includes(req.body.side) ? req.body.side : "both",
      github_asset_pattern: String(req.body.github_asset_pattern || "").trim(),
      published_at: req.body.published_at || null,
      creator_name: String(req.body.creator_name || "").trim(),
      creator_url: String(req.body.creator_url || "").trim(),
      creator_avatar_url: String(req.body.creator_avatar_url || "").trim() || null,
      channel: req.body.channel || "release",
      mc_versions: String(req.body.mc_versions || "").split(",").filter(Boolean),
      loaders: String(req.body.loaders || "").split(",").filter(Boolean),
      changelog_url: req.body.changelog_url || "",
      download_page_url: req.body.download_page_url || "",
    };
    if (!payload.name) {
      flash(req, "error", "A project name is required.");
      return res.redirect(`/instances/${instance.id}/mods/new?kind=${kind}`);
    }
    const op = isProgressOp(req.body.progress_op) ? req.body.progress_op : "";
    publishProgress(op, { stage: "save", message: "Saving the project baseline", percent: 30 });
    if (payload.source !== "manual" && payload.project_id) {
      const existing = await trackedProject(instance.id, payload);
      if (existing) {
        flash(req, "ok", `${existing.name} is already tracked in this instance from ${SOURCE[existing.source]?.label || existing.source}.`);
        return res.redirect(`/mods/${existing.id}`);
      }
      if (!payload.creator_name) {
        const meta = await projectMeta(payload.source, payload.project_id, kind);
        if (meta) {
          payload.creator_name = meta.creator_name || "";
          payload.creator_url = meta.creator_url || "";
          payload.creator_avatar_url = meta.creator_avatar_url || null;
          payload.icon_url = payload.icon_url || meta.icon_url || null;
        }
      }
    }

    if (req.session.user.role !== "admin") {
      const payloadJson = { ...payload, requested_from: "add-mod" };
      const { rows } = await query(
        `INSERT INTO mod_requests (instance_id, requested_by, payload) VALUES ($1,$2,$3::jsonb) RETURNING id`,
        [instance.id, req.session.user.id, JSON.stringify(payloadJson)]
      );
      const { rows: admins } = await query("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
      await createNotifications({
        kind: "request",
        instanceId: instance.id,
        title: `${req.session.user.name} requested ${payload.name}`,
        body: `${instance.name} · waiting for an admin decision.`,
        userIds: admins.map((row) => row.id),
      });
      await telegramSend(
        `ModWatch · new request\n${req.session.user.name} asked to add ${payload.name} to ${instance.name}.`
      );
      await logActivity({
        userId: req.session.user.id, action: "request_created", subjectType: "request",
        subjectId: rows[0].id, meta: { mod: payload.name, instance: instance.name },
      });
      finishProgress(op, "Request sent for approval");
      flash(req, "ok", "Request sent. An admin will review it on the Approvals page.");
      return res.redirect(`/instances/${instance.id}`);
    }

    publishProgress(op, { stage: "store", message: "Storing the installed version", percent: 65 });
    const id = await insertMod(instance.id, payload, req.session.user.id);
    if (payload.source !== "manual") await cacheInstalledVersion(id, payload, instance);
    await logActivity({
      userId: req.session.user.id, action: "mod_added", subjectType: "mod", subjectId: id,
      meta: { name: payload.name, instance: instance.name, source },
    });
    if (payload.source !== "manual") checkOne(id, { userId: req.session.user.id }).catch(() => {});
    finishProgress(op, `${payload.name} is tracked`);
    flash(req, "ok", `${payload.name} is tracked in ${instance.name}.`);
    res.redirect(`/instances/${instance.id}`);
  } catch (err) {
    failProgress(isProgressOp(req.body.progress_op) ? req.body.progress_op : "", err.message);
    if (err.code === "23505") {
      flash(req, "error", "That project is already tracked in this instance.");
      return res.redirect(`/instances/${req.params.id}`);
    }
    next(err);
  }
});

modsRouter.get("/mods/:id", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.*, i.name AS instance_name, i.mc_version, i.loader, i.loader_version, i.id AS instance_id,
              u.name AS added_by_name
         FROM mods m
         JOIN instances i ON i.id = m.instance_id
         LEFT JOIN users u ON u.id = m.added_by
        WHERE m.id = $1`,
      [intParam(req.params.id)]
    );
    const mod = rows[0];
    if (!mod) return next();
    const { rows: history } = await query(
      `SELECT * FROM mod_versions_cache WHERE mod_id = $1
        ORDER BY published_at DESC NULLS LAST, fetched_at DESC LIMIT 20`,
      [mod.id]
    );
    const { rows: activity } = await query(
      `SELECT a.*, u.name AS user_name FROM activity a
        LEFT JOIN users u ON u.id = a.user_id
        WHERE (a.subject_type = 'mod' AND a.subject_id = $1)
        ORDER BY a.created_at DESC LIMIT 12`,
      [mod.id]
    );
    res.render("pages/mod.njk", {
      page: "instances",
      title: mod.name,
      mod,
      history,
      activity,
      statusMeta: STATUS[mod.status],
      sourceMeta: SOURCE[mod.source],
      channelLabel: CHANNEL[mod.channel_policy],
      sideLabel: SIDE[mod.side],
      loaderLabel: LOADER[mod.loader],
    });
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/check", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query("SELECT * FROM mods WHERE id = $1", [id]);
    if (!rows.length) return next();
    checkOne(id, { userId: req.session.user.id }).catch((err) => console.error("mod check:", err.message));
    flash(req, "ok", `Checking ${rows[0].name} now. Refresh in a moment.`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/updated", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query("SELECT * FROM mods WHERE id = $1", [id]);
    const mod = rows[0];
    if (!mod) return next();
    if (!mod.latest_version_id || mod.status !== "update_available") {
      flash(req, "error", "There is no newer version recorded for this mod.");
      return res.redirect(req.get("referer") || `/mods/${id}`);
    }
    await markUpdated(mod);
    if (mod.source !== "manual" && mod.project_id && mod.latest_version_id) {
      try {
        const instance = await instanceById(mod.instance_id);
        const versions = await listSourceVersions(
          mod.source, mod.project_id, instance, mod.channel_policy, mod.github_asset_pattern, mod.kind
        );
        const picked = versions.find((version) => version.version_id === mod.latest_version_id);
        if (picked) {
          await query(
            `UPDATE mods SET download_url = $2, file_name = COALESCE(NULLIF($3,''), file_name),
                file_sha1 = $4, file_sha512 = $5, file_size = $6
              WHERE id = $1`,
            [mod.id, picked.download_url || null, picked.file_name || "",
             picked.file_sha1 || null, picked.file_sha512 || null, picked.file_size || null]
          );
        }
      } catch (err) {
        console.error("mark updated file:", err.message);
      }
    }
    if (mod.disabled || mod.stored_path) await refreshStoredJar(mod.id);
    await logActivity({
      userId: req.session.user.id, action: "mod_updated", subjectType: "mod", subjectId: mod.id,
      meta: { name: mod.name, from: mod.installed_version, to: mod.latest_version },
    });
    flash(req, "ok", `${mod.name} marked as updated to ${mod.latest_version}.`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/update", async (req, res, next) => {
  try {
    if (req.session.user.role !== "admin") {
      flash(req, "error", "Only an admin can download and update a mod.");
      return res.redirect(req.get("referer") || `/mods/${intParam(req.params.id)}`);
    }
    const id = intParam(req.params.id);
    const result = await updateModToLatest(id, { userId: req.session.user.id, verify: true });
    const verified = result.verified === "update_available"
      ? "A newer version appeared during the download, so it is still behind."
      : result.verified === "frozen"
        ? "The mod is frozen, so the new baseline is recorded without notices."
        : "Checked again: this is the newest allowed version.";
    flash(req, "ok", `${result.mod.name} updated from ${result.from} to ${result.to}. ${verified}`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    flash(req, "error", err.message || "The update could not be downloaded.");
    res.redirect(req.get("referer") || `/mods/${intParam(req.params.id)}`);
  }
});

modsRouter.get("/mods/:id/versions", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT m.*, i.mc_version AS instance_mc_version, i.loader AS instance_loader, i.name AS instance_name
         FROM mods m JOIN instances i ON i.id = m.instance_id WHERE m.id = $1`,
      [intParam(req.params.id)]
    );
    const mod = rows[0];
    if (!mod) return next();
    if (mod.source === "manual" || !mod.project_id) {
      return res.json({ versions: [], installed_version_id: mod.installed_version_id, error: "Manual projects do not have source versions." });
    }
    const all = req.query.channels === "all";
    const instance = { mc_version: mod.instance_mc_version, loader: mod.instance_loader };
    let versions = [];
    let error = "";
    try {
      versions = await listSourceVersions(
        mod.source, mod.project_id, instance, all ? "alpha" : mod.channel_policy,
        mod.github_asset_pattern || "", mod.kind
      );
    } catch (err) {
      error = "The source could not be reached. Cached versions are shown.";
    }
    if (!versions.length) {
      const { rows: cached } = await query(
        `SELECT * FROM mod_versions_cache WHERE mod_id = $1
          ORDER BY published_at DESC NULLS LAST, fetched_at DESC LIMIT 50`,
        [mod.id]
      );
      versions = cached.map((row) => ({
        version_id: row.version_id,
        version: row.version_string,
        channel: row.channel,
        mc_versions: row.mc_versions || [],
        loaders: row.loaders || [],
        published_at: row.published_at,
        file_name: "",
        download_url: "",
        cached: true,
      }));
      if (cached.length) {
        error = error || "Showing cached versions. The source is unavailable, so they cannot be installed right now.";
      }
    }
    res.json({
      installed_version_id: mod.installed_version_id,
      error,
      versions: versions.map((version) => ({
        version_id: version.version_id,
        version: version.version,
        channel: version.channel,
        mc_versions: version.mc_versions || [],
        loaders: version.loaders || [],
        published_at: version.published_at,
        file_name: version.file_name || "",
        download_url: version.download_url || "",
        cached: Boolean(version.cached),
      })),
    });
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/version", async (req, res, next) => {
  const id = intParam(req.params.id);
  const { rows } = await query("SELECT instance_id FROM mods WHERE id = $1", [id]);
  const fallback = rows[0] ? `/instances/${rows[0].instance_id}` : "/instances";
  try {
    if (req.session.user.role !== "admin") {
      flash(req, "error", "Only an admin can change a project version.");
      return res.redirect(req.get("referer") || fallback);
    }
    const versionId = String(req.body.version_id || "").trim();
    if (!versionId) {
      flash(req, "error", "Choose a version first.");
      return res.redirect(req.get("referer") || fallback);
    }
    const result = await setModVersion(id, versionId, { userId: req.session.user.id });
    const suffix = result.status === "update_available"
      ? " A newer allowed version is still available."
      : " Checked again against the instance scope.";
    flash(req, "ok", `${result.mod.name}: ${result.from} → ${result.to}.${suffix}`);
    res.redirect(req.get("referer") || fallback);
  } catch (err) {
    flash(req, "error", err.message || "The version could not be changed.");
    res.redirect(req.get("referer") || fallback);
  }
});

modsRouter.post("/mods/:id/snooze", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query("SELECT * FROM mods WHERE id = $1", [id]);
    const mod = rows[0];
    if (!mod) return next();
    if (!mod.latest_version_id) {
      flash(req, "error", "There is no version to snooze yet.");
      return res.redirect(req.get("referer") || `/mods/${id}`);
    }
    await query(
      "UPDATE mods SET snoozed_version_id = $2, status = 'up_to_date' WHERE id = $1",
      [mod.id, mod.latest_version_id]
    );
    await logActivity({
      userId: req.session.user.id, action: "mod_snoozed", subjectType: "mod", subjectId: mod.id,
      meta: { name: mod.name, version: mod.latest_version },
    });
    flash(req, "ok", `${mod.latest_version} will not be announced again.`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/unsnooze", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query(
      "UPDATE mods SET snoozed_version_id = NULL WHERE id = $1 RETURNING *",
      [id]
    );
    if (!rows.length) return next();
    await checkOne(id, { userId: req.session.user.id }).catch(() => {});
    await logActivity({
      userId: req.session.user.id, action: "mod_unsnoozed", subjectType: "mod", subjectId: id,
      meta: { name: rows[0].name, version: rows[0].latest_version },
    });
    flash(req, "ok", `${rows[0].latest_version} is allowed to appear again.`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/freeze", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query(
      "UPDATE mods SET frozen_at = now(), status = 'frozen' WHERE id = $1 RETURNING *",
      [id]
    );
    if (!rows.length) return next();
    await logActivity({
      userId: req.session.user.id, action: "mod_frozen", subjectType: "mod", subjectId: id,
      meta: { name: rows[0].name, version: rows[0].installed_version },
    });
    flash(req, "ok", `${rows[0].name} is frozen at ${rows[0].installed_version}. No update notices will fire.`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/unfreeze", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query(
      "UPDATE mods SET frozen_at = NULL, status = 'up_to_date' WHERE id = $1 RETURNING *",
      [id]
    );
    if (!rows.length) return next();
    await checkOne(id, { userId: req.session.user.id }).catch(() => {});
    await logActivity({
      userId: req.session.user.id, action: "mod_unfrozen", subjectType: "mod", subjectId: id,
      meta: { name: rows[0].name },
    });
    flash(req, "ok", `${rows[0].name} can report updates again.`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/disable", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query("UPDATE mods SET disabled = true WHERE id = $1 RETURNING *", [id]);
    const mod = rows[0];
    if (!mod) return next();
    let warning = "";
    try {
      await ensureStoredJar(mod);
      const { rows: fresh } = await query("SELECT * FROM mods WHERE id = $1", [id]);
      await setStoredDisabled(fresh[0], true);
    } catch (err) {
      warning = ` The jar could not be stored yet: ${err.message}`;
    }
    await logActivity({
      userId: req.session.user.id, action: "mod_disabled", subjectType: "mod", subjectId: id,
      meta: { name: mod.name, version: mod.installed_version },
    });
    flash(req, warning ? "error" : "ok", `${mod.name} is disabled.${warning}`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/enable", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query("UPDATE mods SET disabled = false WHERE id = $1 RETURNING *", [id]);
    if (!rows.length) return next();
    await setStoredDisabled(rows[0], false).catch(() => {});
    await logActivity({
      userId: req.session.user.id, action: "mod_enabled", subjectType: "mod", subjectId: id,
      meta: { name: rows[0].name },
    });
    flash(req, "ok", `${rows[0].name} will load again.`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/resolve", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query("SELECT * FROM mods WHERE id = $1", [id]);
    const mod = rows[0];
    if (!mod) return next();
    const url = String(req.body.project_url || mod.project_url || "").trim();
    const resolved = await resolveProjectUrl(url);
    if (!resolved) {
      flash(req, "error", "That project URL was not recognised. Use a Modrinth, CurseForge or GitHub project page.");
      return res.redirect(`/mods/${id}`);
    }
    const duplicate = await query(
      `SELECT id, name, source FROM mods
        WHERE instance_id = $1 AND id <> $2
          AND ((source = $3 AND project_id = $4) OR lower(name) = lower($5))
        LIMIT 1`,
      [mod.instance_id, id, resolved.source, resolved.project_id, mod.name]
    );
    if (duplicate.rows.length) {
      const other = duplicate.rows[0];
      flash(req, "error", `${mod.name} is already tracked from ${SOURCE[other.source]?.label || other.source}. Remove this manual duplicate first.`);
      return res.redirect(`/mods/${id}`);
    }
    await query(
      `UPDATE mods SET source = $2, project_id = $3, project_url = $4,
          icon_url = COALESCE($5, icon_url), status = 'up_to_date', last_error = NULL
        WHERE id = $1`,
      [id, resolved.source, resolved.project_id, resolved.project_url || url, resolved.icon_url || null]
    );
    await logActivity({
      userId: req.session.user.id, action: "mod_updated", subjectType: "mod", subjectId: id,
      meta: { name: mod.name, resolved_source: resolved.source },
    });
    checkOne(id, { userId: req.session.user.id }).catch(() => {});
    flash(req, "ok", `${mod.name} is now tracked from ${SOURCE[resolved.source]?.label || resolved.source}. A check is running.`);
    res.redirect(`/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/channel", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const policy = ["release", "beta", "alpha"].includes(req.body.channel_policy)
      ? req.body.channel_policy
      : "release";
    const { rows } = await query("UPDATE mods SET channel_policy = $2 WHERE id = $1 RETURNING *", [id, policy]);
    if (!rows.length) return next();
    checkOne(id, { userId: req.session.user.id }).catch(() => {});
    await logActivity({
      userId: req.session.user.id, action: "mod_updated", subjectType: "mod", subjectId: id,
      meta: { name: rows[0].name, channel_policy: policy },
    });
    flash(req, "ok", `Channel policy set to ${CHANNEL[policy]}.`);
    res.redirect(req.get("referer") || `/mods/${id}`);
  } catch (err) {
    next(err);
  }
});

modsRouter.post("/mods/:id/delete", async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query("SELECT * FROM mods WHERE id = $1", [id]);
    const mod = rows[0];
    if (!mod) return next();
    await query("DELETE FROM mods WHERE id = $1", [id]);
    await logActivity({
      userId: req.session.user.id, action: "mod_removed", subjectType: "mod", subjectId: id,
      meta: { name: mod.name, instance_id: mod.instance_id },
    });
    flash(req, "ok", `${mod.name} removed from the instance.`);
    res.redirect(`/instances/${mod.instance_id}`);
  } catch (err) {
    next(err);
  }
});
