import express from "express";

import { query } from "../db.js";
import { flash, requireAdmin } from "../middleware.js";
import { instanceById } from "../queries.js";
import { decryptSecret, encryptSecret, syncKeyReady } from "../sync/crypto.js";
import { scanTarget, syncConnectionById, syncConnectionList, syncTargetById, syncTargetsForInstance, testSyncConnection } from "../sync/index.js";
import { applyTarget } from "../sync/apply.js";
import { ampConfigured } from "../sync/drivers/amp.js";
import { normalizeFingerprint } from "../sync/drivers/sftp.js";
import { finishProgress, failProgress, isProgressOp, publishProgress } from "../progress.js";

export const syncRouter = express.Router();

function intParam(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function connectionFields(body) {
  return {
    host: String(body.host || "").trim(),
    port: Number.parseInt(body.port, 10) || 22,
    username: String(body.username || "").trim(),
    basePath: String(body.base_path || "").trim(),
    hostFingerprint: normalizeFingerprint(body.host_fingerprint),
    ampUrl: String(body.amp_url || "").trim(),
    ampUsername: String(body.amp_username || "").trim(),
    ampInstance: String(body.amp_instance || "").trim(),
  };
}

syncRouter.get("/settings/sync", requireAdmin, async (req, res, next) => {
  try {
    const connections = await syncConnectionList();
    let editConnection = null;
    if (req.query.edit) {
      const { rows } = await query("SELECT * FROM sync_connections WHERE id = $1", [intParam(req.query.edit)]);
      editConnection = rows[0] || null;
    }
    res.render("pages/settings-sync.njk", {
      page: "settings",
      section: "sync",
      title: "Sync",
      connections,
      editConnection,
      keyReady: syncKeyReady(),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

syncRouter.post("/settings/sync", requireAdmin, async (req, res, next) => {
  try {
    if (!syncKeyReady()) {
      return res.status(400).render("pages/settings-sync.njk", {
        page: "settings", section: "sync", title: "Sync", connections: await syncConnectionList(),
        editConnection: null, keyReady: false,
        error: "Set SYNC_SECRET_KEY in .env before saving credentials.",
      });
    }
    const name = String(req.body.name || "").trim();
    const driver = "sftp";
    const config = connectionFields(req.body);
    const password = String(req.body.password || "");
    const privateKey = String(req.body.private_key || "");
    const passphrase = String(req.body.passphrase || "");
    const ampPassword = String(req.body.amp_password || "");
    if (!name || !config.host || !config.username || (!password && !privateKey)) {
      return res.status(400).render("pages/settings-sync.njk", {
        page: "settings", section: "sync", title: "Sync", connections: await syncConnectionList(),
        editConnection: null, keyReady: true,
        error: "Name, host, username and a password or private key are required.",
      });
    }
    const { rows } = await query(
      `INSERT INTO sync_connections (name, driver, config, secret_enc, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING id`,
      [name, driver, JSON.stringify(config), encryptSecret({ password, privateKey, passphrase, ampPassword }), req.session.user.id]
    );
    flash(req, "ok", `${name} saved. Test it to pin the host key.`);
    res.redirect(`/settings/sync?edit=${rows[0].id}`);
  } catch (err) {
    if (err.code === "23505") {
      flash(req, "error", "A connection with that name already exists.");
      return res.redirect("/settings/sync");
    }
    next(err);
  }
});

syncRouter.post("/settings/sync/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query("SELECT * FROM sync_connections WHERE id = $1", [id]);
    const existing = rows[0];
    if (!existing) return next();
    const config = connectionFields(req.body);
    if (existing.config?.host !== config.host && !config.hostFingerprint) config.hostFingerprint = "";
    const password = String(req.body.password || "");
    const privateKey = String(req.body.private_key || "");
    const passphrase = String(req.body.passphrase || "");
    const ampPassword = String(req.body.amp_password || "");
    let secretEnc = existing.secret_enc;
    if (password || privateKey || passphrase || ampPassword) {
      let prior = {};
      try { prior = existing.secret_enc ? decryptSecret(existing.secret_enc) : {}; } catch {}
      secretEnc = encryptSecret({
        password: password || prior.password || "",
        privateKey: privateKey || prior.privateKey || "",
        passphrase: passphrase || prior.passphrase || "",
        ampPassword: ampPassword || prior.ampPassword || "",
      });
    }
    await query(
      "UPDATE sync_connections SET name = $2, config = $3::jsonb, secret_enc = $4 WHERE id = $1",
      [id, String(req.body.name || existing.name).trim(), JSON.stringify(config), secretEnc]
    );
    flash(req, "ok", "Connection updated.");
    res.redirect("/settings/sync");
  } catch (err) {
    next(err);
  }
});

syncRouter.post("/settings/sync/:id/test", requireAdmin, async (req, res, next) => {
  const id = intParam(req.params.id);
  try {
    const result = await testSyncConnection(id, String(req.body.mods_path || "mods").trim() || "mods");
    const suffix = result.fingerprint ? ` Host key SHA256 ${result.fingerprint} pinned.` : "";
    flash(req, "ok", `Connection works; ${result.files} jar${result.files === 1 ? "" : "s"} visible.${suffix}`);
  } catch (err) {
    await query(
      "UPDATE sync_connections SET last_test_at = now(), last_test_ok = false, last_test_error = $2 WHERE id = $1",
      [id, err.message]
    ).catch(() => {});
    flash(req, "error", err.message || "The connection test failed.");
  }
  res.redirect("/settings/sync");
});

syncRouter.post("/settings/sync/:id/delete", requireAdmin, async (req, res, next) => {
  try {
    const id = intParam(req.params.id);
    const { rows } = await query("SELECT count(*)::int AS n FROM sync_targets WHERE connection_id = $1", [id]);
    if (rows[0]?.n) {
      flash(req, "error", "Remove the sync targets that use this connection first.");
      return res.redirect("/settings/sync");
    }
    await query("DELETE FROM sync_connections WHERE id = $1", [id]);
    flash(req, "ok", "Connection deleted.");
    res.redirect("/settings/sync");
  } catch (err) {
    next(err);
  }
});

syncRouter.get("/instances/:id/servers", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const targets = await syncTargetsForInstance(instance.id);
    const connections = req.session.user.role === "admin" ? await syncConnectionList() : [];
    res.render("pages/instance-servers.njk", {
      page: "instances",
      title: `${instance.name} servers`,
      instance,
      targets,
      connections,
      isAdmin: req.session.user.role === "admin",
      keyReady: syncKeyReady(),
    });
  } catch (err) {
    next(err);
  }
});

syncRouter.post("/instances/:id/servers", requireAdmin, async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const name = String(req.body.name || "").trim();
    const connectionId = intParam(req.body.connection_id);
    const modsPath = String(req.body.mods_path || "mods").trim() || "mods";
    const removePolicy = req.body.remove_policy === "backup_then_remove" ? "backup_then_remove" : "never";
    const sides = [];
    if (req.body.side_both === "1") sides.push("both");
    if (req.body.side_server === "1") sides.push("server");
    if (!sides.length) sides.push("both", "server");
    if (!name || !connectionId) {
      flash(req, "error", "A target name and connection are required.");
      return res.redirect(`/instances/${instance.id}/servers`);
    }
    await query(
      `INSERT INTO sync_targets
         (instance_id, connection_id, name, mods_path, sides, remove_policy, require_empty_server, start_timeout_seconds, keep_backups)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        instance.id, connectionId, name, modsPath, sides, removePolicy,
        req.body.require_empty_server !== "0", intParam(req.body.start_timeout_seconds) || 300,
        intParam(req.body.keep_backups) || 5,
      ]
    );
    flash(req, "ok", `${name} added. Run a scan to see the diff.`);
    res.redirect(`/instances/${instance.id}/servers`);
  } catch (err) {
    if (err.code === "23505") {
      flash(req, "error", "A target with that name already exists on this instance.");
      return res.redirect(`/instances/${instance.id}/servers`);
    }
    next(err);
  }
});

syncRouter.post("/instances/:id/servers/:targetId", requireAdmin, async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const target = await syncTargetById(intParam(req.params.targetId));
    if (!target || target.instance_id !== instance.id) return next();
    const sides = [];
    if (req.body.side_both === "1") sides.push("both");
    if (req.body.side_server === "1") sides.push("server");
    if (!sides.length) sides.push("both", "server");
    await query(
      `UPDATE sync_targets SET name = $2, mods_path = $3, sides = $4, remove_policy = $5,
          require_empty_server = $6, start_timeout_seconds = $7, keep_backups = $8 WHERE id = $1`,
      [
        target.id, String(req.body.name || target.name).trim(), String(req.body.mods_path || target.mods_path).trim(),
        sides, req.body.remove_policy === "backup_then_remove" ? "backup_then_remove" : "never",
        req.body.require_empty_server !== "0", intParam(req.body.start_timeout_seconds) || target.start_timeout_seconds,
        intParam(req.body.keep_backups) || target.keep_backups,
      ]
    );
    flash(req, "ok", "Target updated.");
    res.redirect(`/instances/${instance.id}/servers`);
  } catch (err) {
    next(err);
  }
});

syncRouter.post("/instances/:id/servers/:targetId/scan", requireAdmin, async (req, res, next) => {
  const instance = await instanceById(intParam(req.params.id)).catch(() => null);
  if (!instance) return next();
  const target = await syncTargetById(intParam(req.params.targetId)).catch(() => null);
  if (!target || target.instance_id !== instance.id) return next();
  const op = isProgressOp(req.body.progress_op) ? req.body.progress_op : "";
  try {
    publishProgress(op, { stage: "start", message: "Starting the SFTP scan", percent: 5 });
    const result = await scanTarget(target.id, {
      onProgress: (event) => publishProgress(op, event),
    });
    finishProgress(op, `Scan complete: ${result.plan.counts.add + result.plan.counts.replace} changes`);
    flash(req, "ok", `Scanned ${result.observed.length} jars on ${target.name}.`);
    res.redirect(`/instances/${instance.id}/servers/${target.id}`);
  } catch (err) {
    failProgress(op, err.message);
    flash(req, "error", err.message || "The scan failed.");
    res.redirect(`/instances/${instance.id}/servers`);
  }
});

syncRouter.get("/instances/:id/servers/:targetId", async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const target = await syncTargetById(intParam(req.params.targetId));
    if (!target || target.instance_id !== instance.id) return next();
    const summary = target.last_scan_summary || null;
    const connection = await syncConnectionById(target.connection_id);
    res.render("pages/instance-sync-diff.njk", {
      page: "instances",
      title: `${instance.name} · ${target.name}`,
      instance,
      target,
      summary,
      powerReady: ampConfigured(connection),
      isAdmin: req.session.user.role === "admin",
    });
  } catch (err) {
    next(err);
  }
});

syncRouter.post("/instances/:id/servers/:targetId/delete", requireAdmin, async (req, res, next) => {
  try {
    const instance = await instanceById(intParam(req.params.id));
    if (!instance) return next();
    const target = await syncTargetById(intParam(req.params.targetId));
    if (!target || target.instance_id !== instance.id) return next();
    await query("DELETE FROM sync_targets WHERE id = $1", [target.id]);
    flash(req, "ok", `${target.name} removed.`);
    res.redirect(`/instances/${instance.id}/servers`);
  } catch (err) {
    next(err);
  }
});

syncRouter.post("/instances/:id/servers/:targetId/apply", requireAdmin, async (req, res, next) => {
  const instance = await instanceById(intParam(req.params.id)).catch(() => null);
  if (!instance) return next();
  const target = await syncTargetById(intParam(req.params.targetId)).catch(() => null);
  if (!target || target.instance_id !== instance.id) return next();
  const op = isProgressOp(req.body.progress_op) ? req.body.progress_op : "";
  try {
    publishProgress(op, { stage: "start", message: "Starting the sync job", percent: 3 });
    const result = await applyTarget(target.id, {
      userId: req.session.user.id,
      onProgress: (event) => publishProgress(op, event),
    });
    const jobId = result.job?.id;
    if (!jobId) throw new Error("The sync job could not be created.");
    if (result.ok) {
      finishProgress(op, `${result.changes} change(s) applied; server is ready`);
      flash(req, "ok", `${target.name}: ${result.changes} change(s) applied. Server reached ready.`);
    } else {
      if (result.rolledBack) {
        const readyNote = result.restartedReady === false
          ? "The server restarted but did not report ready again."
          : "The previous files are running again.";
        failProgress(op, result.error || "The apply was undone.", {
          rolledBack: true,
          restartedReady: result.restartedReady !== false,
        });
        flash(req, "error", `${target.name}: apply failed and was rolled back. ${readyNote} ${result.error}`);
      } else {
        failProgress(op, result.error || "The sync did not complete.");
        flash(req, "error", `${target.name} failed. ${result.error}`);
      }
    }
    res.redirect(`/sync-jobs/${jobId}`);
  } catch (err) {
    failProgress(op, err.message);
    flash(req, "error", err.message || "The sync could not start.");
    res.redirect(`/instances/${instance.id}/servers/${target.id}`);
  }
});

syncRouter.get("/sync-jobs/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT j.*, t.name AS target_name, t.instance_id, i.name AS instance_name
         FROM sync_jobs j
         JOIN sync_targets t ON t.id = j.target_id
         JOIN instances i ON i.id = t.instance_id
        WHERE j.id = $1`,
      [intParam(req.params.id)]
    );
    const job = rows[0];
    if (!job) return next();
    const { rows: items } = await query("SELECT * FROM sync_job_items WHERE job_id = $1 ORDER BY id", [job.id]);
    res.render("pages/sync-job.njk", {
      page: "instances",
      title: `Sync job ${job.id}`,
      job,
      items,
    });
  } catch (err) {
    next(err);
  }
});
