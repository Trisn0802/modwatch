import express from "express";
import { query } from "../db.js";
import { instanceById } from "../queries.js";
import { searchProjects, resolveProjectUrl, listSourceVersions } from "../sources/index.js";
import { checkOne } from "../checker.js";
import { logActivity } from "../activity.js";
import { flash } from "../middleware.js";
import { createNotifications, telegramSend } from "../notify.js";
import { insertMod, cacheInstalledVersion, markUpdated, VALID_SOURCES } from "../mod-service.js";
import { ensureStoredJar, refreshStoredJar, setStoredDisabled } from "../export.js";
import { updateModToLatest } from "../updater.js";
import { CHANNEL, LOADER, SIDE, SOURCE, STATUS } from "../labels.js";

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
    let results = [];
    let searchError = null;
    if (q) {
      try {
        results = await searchProjects(q, instance);
        if (sourceFilter !== "all") results = results.filter((item) => item.source === sourceFilter);
      } catch (err) {
        searchError = err.message;
      }
    }
    res.render("pages/mod-add.njk", {
      page: "instances",
      title: `Add a mod to ${instance.name}`,
      instance,
      q,
      sourceFilter,
      results,
      searchError,
      manual: req.query.manual === "1",
      channelOptions: CHANNEL,
    });
  } catch (err) {
    next(err);
  }
});

modsRouter.get("/instances/:id/mods/resolve", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const url = String(req.query.url || "").trim();
    const resolved = await resolveProjectUrl(url);
    if (!resolved) {
      flash(req, "error", "That project URL was not recognised. Use a Modrinth, CurseForge or GitHub project page.");
      return res.redirect(`/instances/${instance.id}/mods/new?manual=1`);
    }
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
      name: resolved.name || "",
      project_url: resolved.project_url || url,
      icon_url: resolved.icon_url || "",
    });
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
    if (!projectId) return res.redirect(`/instances/${instance.id}/mods/new`);

    let versions = [];
    let error = null;
    try {
      versions = await listSourceVersions(source, projectId, instance, "alpha", req.query.asset_pattern || "");
    } catch (err) {
      error = err.message;
    }
    const manual = req.query.manual === "1" || source === "manual";
    res.render("pages/mod-choose.njk", {
      page: "instances",
      title: `Add ${name || "a mod"}`,
      instance,
      source,
      projectId,
      name,
      projectUrl,
      iconUrl: req.query.icon_url || null,
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
          name: resolved.name || "",
          project_url: resolved.project_url || suppliedUrl,
          icon_url: resolved.icon_url || "",
        });
        return res.redirect(`/instances/${instance.id}/mods/choose?${params}`);
      }
      if (/modrinth\.com|curseforge\.com|github\.com/i.test(suppliedUrl)) {
        flash(req, "error", "That project URL could not be resolved. Check the URL or keep it as a plain manual entry without a source link.");
        return res.redirect(`/instances/${instance.id}/mods/new?manual=1`);
      }
    }
    const payload = {
      name: String(req.body.name || "").trim(),
      source,
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
      channel: req.body.channel || "release",
      mc_versions: String(req.body.mc_versions || "").split(",").filter(Boolean),
      loaders: String(req.body.loaders || "").split(",").filter(Boolean),
      changelog_url: req.body.changelog_url || "",
      download_page_url: req.body.download_page_url || "",
    };
    if (!payload.name) {
      flash(req, "error", "A mod name is required.");
      return res.redirect(`/instances/${instance.id}/mods/new`);
    }
    if (payload.source !== "manual" && payload.project_id) {
      const existing = await trackedProject(instance.id, payload);
      if (existing) {
        flash(req, "ok", `${existing.name} is already tracked in this instance from ${SOURCE[existing.source]?.label || existing.source}.`);
        return res.redirect(`/mods/${existing.id}`);
      }
    }

    if (req.session.user.role !== "admin") {
      const payloadJson = { ...payload, requested_from: "add-mod" };
      const { rows } = await query(
        `INSERT INTO mod_requests (instance_id, requested_by, payload) VALUES ($1,$2,$3::jsonb) RETURNING id`,
        [instance.id, req.session.user.id, JSON.stringify(payloadJson)]
      );
      await createNotifications({
        kind: "request",
        instanceId: instance.id,
        title: `${req.session.user.name} requested ${payload.name}`,
        body: `${instance.name} · waiting for an admin decision.`,
      });
      await telegramSend(
        `ModWatch · new request\n${req.session.user.name} asked to add ${payload.name} to ${instance.name}.`
      );
      await logActivity({
        userId: req.session.user.id, action: "request_created", subjectType: "request",
        subjectId: rows[0].id, meta: { mod: payload.name, instance: instance.name },
      });
      flash(req, "ok", "Request sent. An admin will review it on the Approvals page.");
      return res.redirect(`/instances/${instance.id}`);
    }

    const id = await insertMod(instance.id, payload, req.session.user.id);
    if (payload.source !== "manual") await cacheInstalledVersion(id, payload, instance);
    await logActivity({
      userId: req.session.user.id, action: "mod_added", subjectType: "mod", subjectId: id,
      meta: { name: payload.name, instance: instance.name, source },
    });
    if (payload.source !== "manual") checkOne(id, { userId: req.session.user.id }).catch(() => {});
    flash(req, "ok", `${payload.name} is tracked in ${instance.name}.`);
    res.redirect(`/instances/${instance.id}`);
  } catch (err) {
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
          mod.source, mod.project_id, instance, mod.channel_policy, mod.github_asset_pattern
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
