import express from "express";

import { query } from "../db.js";
import { flash, requireAdmin } from "../middleware.js";
import { instanceById } from "../queries.js";
import { decryptSecret, encryptSecret, syncKeyReady } from "../sync/crypto.js";
import { createNotifications } from "../notify.js";
import { scanTarget, syncConnectionById, syncConnectionList, syncTargetById, syncTargetsForInstance, testSyncConnection } from "../sync/index.js";
import { applyTarget, restartTarget } from "../sync/apply.js";
import { ampConfigured } from "../sync/drivers/amp.js";
import { pterodactylConfigured } from "../sync/drivers/pterodactyl.js";
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
    panelUrl: String(body.panel_url || "").trim(),
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
    const driver = req.body.driver === "pterodactyl" ? "pterodactyl" : "sftp";
    const config = connectionFields(req.body);
    const password = String(req.body.password || "");
    const privateKey = String(req.body.private_key || "");
    const passphrase = String(req.body.passphrase || "");
    const ampPassword = String(req.body.amp_password || "");
    const apiKey = String(req.body.api_key || "").trim();
    const invalid = driver === "pterodactyl"
      ? !name || !config.panelUrl || !apiKey
      : !name || !config.host || !config.username || (!password && !privateKey);
    if (invalid) {
      return res.status(400).render("pages/settings-sync.njk", {
        page: "settings", section: "sync", title: "Sync", connections: await syncConnectionList(),
        editConnection: null, keyReady: true,
        error: driver === "pterodactyl"
          ? "Name, panel URL and a client API key are required."
          : "Name, host, username and a password or private key are required.",
      });
    }
    const { rows } = await query(
      `INSERT INTO sync_connections (name, driver, config, secret_enc, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING id`,
      [name, driver, JSON.stringify(config), encryptSecret({ password, privateKey, passphrase, ampPassword, apiKey }), req.session.user.id]
    );
    flash(req, "ok", driver === "pterodactyl"
      ? `${name} saved. Test it to list the panel servers.`
      : `${name} saved. Test it to pin the host key.`);
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
    const driver = req.body.driver === "pterodactyl" ? "pterodactyl" : "sftp";
    const password = String(req.body.password || "");
    const privateKey = String(req.body.private_key || "");
    const passphrase = String(req.body.passphrase || "");
    const ampPassword = String(req.body.amp_password || "");
    const apiKey = String(req.body.api_key || "").trim();
    let secretEnc = existing.secret_enc;
    if (password || privateKey || passphrase || ampPassword || apiKey) {
      let prior = {};
      try { prior = existing.secret_enc ? decryptSecret(existing.secret_enc) : {}; } catch {}
      secretEnc = encryptSecret({
        password: password || prior.password || "",
        privateKey: privateKey || prior.privateKey || "",
        passphrase: passphrase || prior.passphrase || "",
        ampPassword: ampPassword || prior.ampPassword || "",
        apiKey: apiKey || prior.apiKey || "",
      });
    }
    await query(
      "UPDATE sync_connections SET name = $2, driver = $3, config = $4::jsonb, secret_enc = $5 WHERE id = $1",
      [id, String(req.body.name || existing.name).trim(), driver, JSON.stringify(config), secretEnc]
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
    const result = await testSyncConnection(
      id,
      String(req.body.mods_path || "mods").trim() || "mods",
      String(req.body.server_uuid || "").trim()
    );
    if (result.kind === "pterodactyl") {
      flash(req, "ok", `Panel works; ${result.files} server${result.files === 1 ? "" : "s"} visible for this API key.`);
    } else {
      const suffix = result.fingerprint ? ` Host key SHA256 ${result.fingerprint} pinned.` : "";
      flash(req, "ok", `Connection works; ${result.files} jar${result.files === 1 ? "" : "s"} visible.${suffix}`);
    }
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
    const remoteRef = String(req.body.remote_ref || "").trim();
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
    const { rows: connections } = await query("SELECT id, driver FROM sync_connections WHERE id = $1", [connectionId]);
    if (!connections[0]) {
      flash(req, "error", "That connection no longer exists.");
      return res.redirect(`/instances/${instance.id}/servers`);
    }
    if (connections[0].driver === "pterodactyl" && !remoteRef) {
      flash(req, "error", "A Pterodactyl target needs the server UUID from the panel.");
      return res.redirect(`/instances/${instance.id}/servers`);
    }
    await query(
      `INSERT INTO sync_targets
         (instance_id, connection_id, name, remote_ref, mods_path, sides, remove_policy, require_empty_server, start_timeout_seconds, keep_backups)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        instance.id, connectionId, name, remoteRef, modsPath, sides, removePolicy,
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
    const remoteRef = String(req.body.remote_ref || "").trim();
    if (target.driver === "pterodactyl" && !remoteRef) {
      flash(req, "error", "A Pterodactyl target needs the server UUID from the panel.");
      return res.redirect(`/instances/${instance.id}/servers`);
    }
    const sides = [];
    if (req.body.side_both === "1") sides.push("both");
    if (req.body.side_server === "1") sides.push("server");
    if (!sides.length) sides.push("both", "server");
    await query(
      `UPDATE sync_targets SET name = $2, remote_ref = $3, mods_path = $4, sides = $5, remove_policy = $6,
          require_empty_server = $7, start_timeout_seconds = $8, keep_backups = $9 WHERE id = $1`,
      [
        target.id, String(req.body.name || target.name).trim(), remoteRef,
        String(req.body.mods_path || target.mods_path).trim(),
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
    publishProgress(op, { stage: "start", message: "Starting the server scan", percent: 5 });
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
    const powerReady = connection.driver === "pterodactyl"
      ? pterodactylConfigured(connection) && Boolean(target.remote_ref)
      : ampConfigured(connection);
    res.render("pages/instance-sync-diff.njk", {
      page: "instances",
      title: `${instance.name} · ${target.name}`,
      instance,
      target,
      summary,
      powerReady,
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
  const userId = req.session.user.id;
  const op = isProgressOp(req.body.progress_op) ? req.body.progress_op : "";
  const json = req.get("X-Requested-With") === "fetch";
  const restart = req.body.no_restart !== "1";
  try {
    const { rows: active } = await query(
      `SELECT id FROM sync_jobs
        WHERE target_id = $1 AND status IN ('queued', 'running')
        ORDER BY id DESC LIMIT 1`,
      [target.id]
    );
    if (active[0]) {
      const message = "A sync job is already running for this target.";
      if (json) return res.status(409).json({ ok: false, error: message });
      flash(req, "error", message);
      return res.redirect(`/instances/${instance.id}/servers/${target.id}`);
    }

    // Create the job before answering so the client gets an id immediately.
    const { rows } = await query(
      `INSERT INTO sync_jobs (target_id, user_id, mode, status, plan, started_at)
       VALUES ($1,$2,'apply','queued','{}'::jsonb,now()) RETURNING *`,
      [target.id, userId]
    );
    const job = rows[0];
    const jobUrl = `/sync-jobs/${job.id}`;
    publishProgress(op, { stage: "start", message: "Starting the sync job", percent: 3, jobId: job.id, jobUrl });
    if (json) res.status(202).json({ ok: true, jobId: job.id, op, jobUrl });
    else res.redirect(303, jobUrl);

    // The response is already sent. A proxy can time out without killing the
    // job, and the client can follow it on the progress stream or the job page.
    setImmediate(() => {
      applyTarget(target.id, {
        userId,
        jobId: job.id,
        restart,
        onProgress: (event) => publishProgress(op, {
          ...event,
          jobId: job.id,
          jobUrl,
          ...(event.stage === "done" && event.restartRequired
            ? { restartUrl: `/instances/${instance.id}/servers/${target.id}/restart` }
            : {}),
        }),
      })
        .then((result) => {
          if (result.ok) return;
          const meta = result.rolledBack
            ? { rolledBack: true, restartedReady: result.restartedReady !== false }
            : {};
          failProgress(op, result.error || "The sync did not complete.", { ...meta, jobId: job.id, jobUrl });
        })
        .catch(async (err) => {
          await query(
            "UPDATE sync_jobs SET status = 'failed', result = $2::jsonb, finished_at = now() WHERE id = $1",
            [job.id, JSON.stringify({ error: err.message })]
          ).catch(() => {});
          await createNotifications({
            kind: "sync", instanceId: instance.id, syncJobId: job.id,
            title: `Sync failed: ${target.name}`,
            body: err.message,
            userIds: [userId],
          }).catch(() => {});
          failProgress(op, err.message || "The sync could not start.", { jobId: job.id, jobUrl });
        });
    });
  } catch (err) {
    failProgress(op, err.message);
    if (json) return res.status(500).json({ ok: false, error: err.message });
    flash(req, "error", err.message || "The sync could not start.");
    res.redirect(`/instances/${instance.id}/servers/${target.id}`);
  }
});

syncRouter.post("/instances/:id/servers/:targetId/restart", requireAdmin, async (req, res, next) => {
  const instance = await instanceById(intParam(req.params.id)).catch(() => null);
  if (!instance) return next();
  const target = await syncTargetById(intParam(req.params.targetId)).catch(() => null);
  if (!target || target.instance_id !== instance.id) return next();
  const userId = req.session.user.id;
  const op = isProgressOp(req.body.progress_op) ? req.body.progress_op : "";
  const json = req.get("X-Requested-With") === "fetch";
  try {
    const { rows: active } = await query(
      `SELECT id FROM sync_jobs
        WHERE target_id = $1 AND status IN ('queued', 'running')
        ORDER BY id DESC LIMIT 1`,
      [target.id]
    );
    if (active[0]) {
      const message = "A sync job is already running for this target.";
      if (json) return res.status(409).json({ ok: false, error: message });
      flash(req, "error", message);
      return res.redirect(`/sync-jobs/${active[0].id}`);
    }
    const { rows } = await query(
      `INSERT INTO sync_jobs (target_id, user_id, mode, status, plan, started_at)
       VALUES ($1,$2,'restart','queued','{}'::jsonb,now()) RETURNING *`,
      [target.id, userId]
    );
    const job = rows[0];
    const jobUrl = `/sync-jobs/${job.id}`;
    publishProgress(op, { stage: "start", message: "Starting the server", percent: 10, jobId: job.id, jobUrl });
    if (json) res.status(202).json({ ok: true, jobId: job.id, op, jobUrl });
    else res.redirect(303, jobUrl);

    setImmediate(() => {
      restartTarget(target.id, {
        userId,
        jobId: job.id,
        onProgress: (event) => publishProgress(op, { ...event, jobId: job.id, jobUrl }),
      })
        .then((result) => {
          if (!result.ok) failProgress(op, result.error || "The server did not start.", { jobId: job.id, jobUrl });
        })
        .catch(async (err) => {
          await query(
            "UPDATE sync_jobs SET status = 'failed', result = $2::jsonb, finished_at = now() WHERE id = $1",
            [job.id, JSON.stringify({ error: err.message })]
          ).catch(() => {});
          await createNotifications({
            kind: "sync", instanceId: instance.id, syncJobId: job.id,
            title: `Server restart failed: ${target.name}`,
            body: err.message,
            userIds: [userId],
          }).catch(() => {});
          failProgress(op, err.message || "The server did not start.", { jobId: job.id, jobUrl });
        });
    });
  } catch (err) {
    failProgress(op, err.message);
    if (json) return res.status(500).json({ ok: false, error: err.message });
    flash(req, "error", err.message || "The server could not start.");
    res.redirect(`/instances/${instance.id}/servers/${target.id}`);
  }
});

syncRouter.get("/api/sync-jobs/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT j.id, j.status, j.result, t.instance_id, t.id AS target_id
         FROM sync_jobs j JOIN sync_targets t ON t.id = j.target_id
        WHERE j.id = $1`,
      [intParam(req.params.id)]
    );
    const job = rows[0];
    if (!job) return res.status(404).json({ ok: false, error: "That sync job no longer exists." });
    const restartRequired = Boolean(job.result?.restart_required);
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      id: job.id,
      status: job.status,
      result: job.result || {},
      restartRequired,
      restartUrl: restartRequired ? `/instances/${job.instance_id}/servers/${job.target_id}/restart` : "",
      jobUrl: `/sync-jobs/${job.id}`,
    });
  } catch (err) {
    next(err);
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
