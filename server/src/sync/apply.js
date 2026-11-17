import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { query, tryAdvisoryLock } from "../db.js";
import { ensureStoredJar } from "../export.js";
import { jarAbsolute } from "../uploads.js";
import { logActivity } from "../activity.js";
import { createNotifications, telegramSend } from "../notify.js";
import { scanTarget, syncConnectionById, syncTargetById } from "./index.js";
import { createRemote } from "./remote.js";

const APPLY_ACTIONS = new Set(["add", "replace", "disable", "enable"]);
const MAX_CHANGES = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localSha1(file) {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

async function waitForStatus(remote, predicate, timeoutMs, { onProgress, message, key = "wait" } = {}) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    const state = await remote.power.status();
    if (predicate(state)) return state;
    attempt += 1;
    onProgress?.({ stage: "wait", key, message, percent: 55, attempt });
    await sleep(3000);
  }
  throw new Error(`${message || "The server"} did not reach the expected state in time.`);
}

function crashReason(text) {
  const boot = text.lastIndexOf("Starting minecraft server version");
  const tail = boot === -1 ? text : text.slice(boot);
  if (!/Failed to start the minecraft server|crash report has been saved to/i.test(tail)) return "";
  const dep = tail.lastIndexOf("Missing or unsupported mandatory dependencies:");
  if (dep !== -1) {
    const block = tail.slice(dep + "Missing or unsupported mandatory dependencies:".length).split("\n\n")[0];
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^Mod ID:/.test(line))
      .slice(0, 3);
    if (lines.length) return lines.join(" · ");
  }
  const description = tail.match(/Description:\s*(.+)/)?.[1]?.trim();
  if (description) return description;
  const fatal = tail.lastIndexOf("[FATAL]");
  if (fatal !== -1) return tail.slice(fatal, fatal + 300).split("\n")[0].replace(/^\[[^\]]+\]\s*/, "");
  return "the server log reports a startup failure";
}

async function crashNames(remote) {
  const entries = await remote.files.listDir("crash-reports").catch(() => []);
  return new Set(entries.filter((entry) => entry.type !== "d").map((entry) => entry.name));
}

async function crashSince(remote, before) {
  const entries = await remote.files.listDir("crash-reports").catch(() => []);
  const fresh = entries
    .filter((entry) => entry.type !== "d" && !before.has(entry.name))
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));
  if (!fresh.length) return "";
  const buffer = await remote.files.read(`crash-reports/${fresh[0].name}`).catch(() => null);
  const text = buffer ? buffer.toString("utf8") : "";
  const description = text.match(/Description:\s*(.+)/)?.[1]?.trim();
  return description ? `${description} (${fresh[0].name})` : fresh[0].name;
}

async function waitForGame(remote, timeoutMs, { onProgress } = {}) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    const state = await remote.power.status();
    if (remote.power.isStarted(state)) return state;
    const buffer = await remote.files.read("logs/latest.log").catch(() => null);
    if (buffer) {
      const reason = crashReason(buffer.toString("utf8"));
      if (reason) throw new Error(`The server failed to start: ${reason}`);
    }
    attempt += 1;
    onProgress?.({ stage: "wait", key: "game-start", message: "Waiting for the server to start", percent: 62, attempt });
    await sleep(3000);
  }
  throw new Error(`The server did not start within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function waitReady(remote, timeoutMs, { onProgress } = {}) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    const buffer = await remote.files.read("logs/latest.log").catch(() => null);
    if (buffer) {
      const text = buffer.toString("utf8");
      const boot = text.lastIndexOf("Starting minecraft server version");
      if (boot !== -1 && text.indexOf("Done (", boot) !== -1) return true;
      const reason = crashReason(text);
      if (reason) throw new Error(`The server failed to start: ${reason}`);
    }
    attempt += 1;
    onProgress?.({ stage: "ready", key: "world-ready", message: "Waiting for the world to finish loading", percent: 70, attempt });
    await sleep(4000);
  }
  throw new Error(`The server did not report ready within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function appendJobLog(jobId, lines, line) {
  if (line) lines.push(`[${new Date().toISOString()}] ${line}`);
  await query("UPDATE sync_jobs SET log = $2 WHERE id = $1", [jobId, lines.join("\n")]).catch(() => {});
}

async function syncRecipients(userId) {
  if (userId) return [userId];
  const { rows } = await query("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
  return rows.map((row) => row.id);
}

export async function applyTarget(targetId, { userId = null, onProgress, jobId = null, restart = true } = {}) {
  const report = (event) => { try { onProgress?.(event); } catch {} };
  const release = await tryAdvisoryLock(907000 + targetId);
  if (!release) throw new Error("A sync job is already running for this target.");
  let job = null;
  let remote = null;
  let serverName = "The server";
  const logLines = [];
  try {
    const target = await syncTargetById(targetId);
    if (!target) throw new Error("Sync target not found.");
    const connection = await syncConnectionById(target.connection_id);
    if (!connection) throw new Error("Sync connection not found.");
    remote = await createRemote(connection, target);
    if (!remote.power.configured) {
      throw new Error("Server power is not configured on this connection.");
    }
    report({ stage: "scan", message: "Rescanning the server before apply", percent: 5 });
    const scan = await scanTarget(target.id, {
      onProgress: (event) => report({
        ...event,
        // The scan's own "done" is not the end of the apply; only the final
        // report below may close the background progress stream.
        stage: event.stage === "done" ? "scan-done" : event.stage,
        percent: Math.min(25, event.percent || 20),
      }),
    });
    const items = scan.plan.items.filter((item) => APPLY_ACTIONS.has(item.action));
    if (!items.length) throw new Error("There are no add, replace, enable or disable items to apply.");
    if (items.length > MAX_CHANGES) throw new Error(`The plan has ${items.length} changes; the safety limit is ${MAX_CHANGES}.`);

    let state = await remote.power.status();
    const wasStarted = remote.power.isStarted(state);
    serverName = remote.kind === "pterodactyl" ? target.name : (state.name || target.name);
    if (target.require_empty_server && !remote.power.isStopped(state)) {
      const online = await remote.players();
      if (online > 0) {
        throw new Error(`${serverName} has ${online} player(s) online. Wait for an empty server or turn off “Require empty server”.`);
      }
    }

    const jobRows = jobId
      ? (await query("SELECT * FROM sync_jobs WHERE id = $1", [jobId])).rows
      : (await query(
          `INSERT INTO sync_jobs (target_id, user_id, mode, status, plan, started_at)
           VALUES ($1,$2,'apply','queued','{}'::jsonb,now()) RETURNING *`,
          [target.id, userId]
        )).rows;
    job = jobRows[0];
    if (!job) throw new Error("The sync job no longer exists.");
    const plan = { counts: scan.plan.counts, items };
    await query(
      "UPDATE sync_jobs SET status = 'running', plan = $2::jsonb, started_at = COALESCE(started_at, now()) WHERE id = $1",
      [job.id, JSON.stringify(plan)]
    );
    job = { ...job, status: "running", plan };
    for (const item of items) {
      await query(
        `INSERT INTO sync_job_items (job_id, mod_id, action, file_name, old_file_name, sha1, size)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [job.id, item.modId || null, item.action, item.file || "", item.oldFile || "", item.remoteSha1 || null, item.remoteSize || null]
      );
    }
    await appendJobLog(job.id, logLines, `Job ${job.id} started with ${items.length} change(s).`);

    // Download every new jar before the server is stopped.
    report({ stage: "prepare", message: "Preparing local jars", percent: 28 });
    const prepared = new Map();
    for (const item of items) {
      if (!["add", "replace"].includes(item.action)) continue;
      if (!item.modId) throw new Error(`${item.name} has no tracked project to prepare.`);
      const { rows: modRows } = await query("SELECT * FROM mods WHERE id = $1", [item.modId]);
      const mod = modRows[0];
      if (!mod) throw new Error(`${item.name} no longer exists.`);
      const stored = await ensureStoredJar(mod);
      const absolute = jarAbsolute(stored);
      if (!absolute) throw new Error(`${item.name} has no stored jar and no download URL.`);
      prepared.set(item.file || item.oldFile, {
        local: absolute,
        sha1: localSha1(absolute),
      });
    }

    const startTimeoutMs = Math.max(60, Number(target.start_timeout_seconds) || 300) * 1000;
    const stopTimeoutMs = remote.stopTimeoutMs || 180_000;
    const modsPath = target.mods_path || "mods";
    const backupDir = path.posix.join(path.posix.dirname(modsPath), "mods_backup", String(job.id));
    let stopped = false;
    const applied = [];
    try {
      await remote.files.mkdir(backupDir);
      await remote.files.mkdir(modsPath);

      report({ stage: "backup", message: "Backing up the jars that will change", percent: 35 });
      for (const item of items) {
        if (!item.oldFile) continue;
        const oldPath = path.posix.join(modsPath, item.oldFile);
        if (await remote.files.exists(oldPath)) {
          const backupPath = path.posix.join(backupDir, item.oldFile);
          await remote.files.copy(oldPath, backupPath);
          await appendJobLog(job.id, logLines, `Backed up ${item.oldFile}`);
        }
      }

      report({ stage: "stop", message: `Stopping ${serverName}`, percent: 45 });
      await remote.power.stop();
      await waitForStatus(remote, (next) => remote.power.isStopped(next), stopTimeoutMs, {
        onProgress: (event) => report({ ...event, percent: 48 }),
        message: "Waiting for the server to stop",
        key: "stop-wait",
      });
      await sleep(2500);
      stopped = true;
      await appendJobLog(job.id, logLines, "Server stopped.");

      for (const item of items) {
        const filePath = path.posix.join(modsPath, item.file);
        const oldPath = item.oldFile ? path.posix.join(modsPath, item.oldFile) : "";
        if (item.action === "add" || item.action === "replace") {
          const file = prepared.get(item.file || item.oldFile);
          if (!file) throw new Error(`${item.name}: the prepared local file is missing.`);
          const tmpPath = path.posix.join(modsPath, `${item.file}.modwatch-tmp`);
          await remote.files.write(tmpPath, file.local);
          const uploaded = await remote.files.hash(tmpPath);
          if (uploaded.sha1 !== file.sha1) throw new Error(`${item.name}: uploaded file hash did not match.`);
          if (oldPath && await remote.files.exists(oldPath)) {
            await remote.files.remove(oldPath);
          }
          await remote.files.rename(tmpPath, filePath);
          await query("UPDATE sync_job_items SET status = 'done', sha1 = $2 WHERE job_id = $1 AND file_name = $3", [job.id, file.sha1, item.file]);
          applied.push(item);
          await appendJobLog(job.id, logLines, `${item.action} ${item.file}`);
        } else if (item.action === "disable" || item.action === "enable") {
          if (!oldPath || !(await remote.files.exists(oldPath))) {
            throw new Error(`${item.name}: the file to ${item.action} is missing on the server.`);
          }
          await remote.files.rename(oldPath, filePath);
          await query("UPDATE sync_job_items SET status = 'done' WHERE job_id = $1 AND file_name = $2", [job.id, item.file]);
          applied.push(item);
          await appendJobLog(job.id, logLines, `${item.action} ${item.oldFile} -> ${item.file}`);
        }
      }

      if (restart) {
        const crashBefore = await crashNames(remote);
        report({ stage: "start", message: `Starting ${serverName}`, percent: 60 });
        await remote.power.start();
        await waitForGame(remote, startTimeoutMs, { onProgress: report });
        await waitReady(remote, startTimeoutMs, { onProgress: report });

        report({ stage: "verify", message: "Checking that the server stays up", percent: 92 });
        await sleep(6000);
        const crash = await crashSince(remote, crashBefore);
        if (crash) throw new Error(`The server crashed after it reported ready: ${crash}`);
        const after = await remote.power.status();
        if (!remote.power.isStarted(after)) throw new Error("The server stopped after it reported ready.");
        await appendJobLog(job.id, logLines, "Server reached ready and stayed up.");
      } else {
        await appendJobLog(job.id, logLines, `Applied ${applied.length} file(s); restart required.`);
      }

      const result = restart
        ? { changes: applied.length }
        : { changes: applied.length, restart_required: true, was_running: wasStarted };
      await query(
        "UPDATE sync_jobs SET status = 'succeeded', result = $2::jsonb, finished_at = now() WHERE id = $1",
        [job.id, JSON.stringify(result)]
      );
      report({
        stage: "done",
        message: restart
          ? `Applied ${applied.length} change(s); server ready`
          : `Applied ${applied.length} change(s); restart required`,
        percent: 100,
        restartRequired: !restart,
      });

      const recipients = await syncRecipients(userId);
      await createNotifications({
        kind: "sync",
        instanceId: target.instance_id,
        syncJobId: job.id,
        title: `Server sync: ${serverName}`,
        body: restart
          ? `${applied.length} change(s) applied and the server reached ready.`
          : `${applied.length} change(s) applied. Restart the server to load them.`,
        userIds: recipients,
      });
      await telegramSend(`ModWatch · ${serverName}\n${applied.length} file(s) synced${restart ? "; server is ready." : "; restart required."}`);
      await logActivity({
        userId, action: "sync_applied", subjectType: "instance", subjectId: target.instance_id,
        meta: { target: target.name, changes: applied.length, restart_required: !restart },
      });
      return { job, ok: true, changes: applied.length, restartRequired: !restart };
    } catch (err) {
      await appendJobLog(job.id, logLines, `ERROR ${err.message}`);
      if (stopped) {
        report({ stage: "rollback", message: "Rolling back the server files", percent: 80 });
        try {
          const current = await remote.power.status();
          if (!remote.power.isStopped(current)) {
            await remote.power.stop();
            await waitForStatus(remote, (next) => remote.power.isStopped(next), stopTimeoutMs, { message: "Waiting to roll back", key: "rollback-wait", onProgress: report });
            await sleep(2500);
          }
          for (const item of [...applied].reverse()) {
            const filePath = path.posix.join(modsPath, item.file);
            const oldPath = item.oldFile ? path.posix.join(modsPath, item.oldFile) : "";
            const backupPath = item.oldFile ? path.posix.join(backupDir, item.oldFile) : "";
            if (item.action === "add") {
              await remote.files.remove(filePath);
            } else if (item.action === "replace") {
              await remote.files.remove(filePath);
              if (backupPath && await remote.files.exists(backupPath)) {
                await remote.files.copy(backupPath, oldPath);
              }
            } else if (item.action === "disable" || item.action === "enable") {
              await remote.files.rename(filePath, oldPath);
            }
          }
          await query(
            "UPDATE sync_job_items SET status = 'rolled_back' WHERE job_id = $1 AND status <> 'rolled_back'",
            [job.id]
          );
          await remote.power.start();
          await waitForGame(remote, startTimeoutMs, { onProgress: report });
          const restartedReady = await waitReady(remote, Math.min(startTimeoutMs, 180_000), { onProgress: report }).then(() => true).catch(() => false);
          await appendJobLog(
            job.id,
            logLines,
            restartedReady
              ? "Server restarted after rollback and reached ready."
              : "Server restarted after rollback but did not report ready."
          );
          await query(
            "UPDATE sync_jobs SET status = 'rolled_back', result = $2::jsonb, finished_at = now() WHERE id = $1",
            [job.id, JSON.stringify({ error: err.message, restored: applied.length, restarted_ready: restartedReady })]
          );
          await createNotifications({
            kind: "sync",
            instanceId: target.instance_id,
            syncJobId: job.id,
            title: `Sync rolled back: ${serverName}`,
            body: `${err.message}. The previous jars were restored and the server was restarted.`,
            userIds: await syncRecipients(userId),
          });
          await telegramSend(`ModWatch · ${serverName}\nRolled back: ${err.message}`);
          await logActivity({
            userId, action: "sync_rolled_back", subjectType: "instance", subjectId: target.instance_id,
            meta: { target: target.name, error: err.message },
          });
          return { job, ok: false, rolledBack: true, restartedReady, error: err.message };
        } catch (rollbackErr) {
          await appendJobLog(job.id, logLines, `ROLLBACK FAILED ${rollbackErr.message}`);
          await query(
            "UPDATE sync_jobs SET status = 'failed', result = $2::jsonb, finished_at = now() WHERE id = $1",
            [job.id, JSON.stringify({ error: err.message, rollbackError: rollbackErr.message })]
          );
          await createNotifications({
            kind: "sync", instanceId: target.instance_id, syncJobId: job.id,
            title: `Rollback failed: ${serverName}`,
            body: `${err.message}. Rollback also failed: ${rollbackErr.message}`,
            userIds: await syncRecipients(userId),
          });
          return { job, ok: false, rolledBack: false, error: `${err.message}; rollback failed: ${rollbackErr.message}` };
        }
      }
      await query(
        "UPDATE sync_jobs SET status = 'failed', result = $2::jsonb, finished_at = now() WHERE id = $1",
        [job.id, JSON.stringify({ error: err.message })]
      );
      await createNotifications({
        kind: "sync", instanceId: target.instance_id, syncJobId: job.id,
        title: `Sync failed: ${serverName}`,
        body: err.message,
        userIds: await syncRecipients(userId),
      });
      await logActivity({
        userId, action: "sync_failed", subjectType: "instance", subjectId: target.instance_id,
        meta: { target: target.name, error: err.message },
      });
      return { job, ok: false, rolledBack: false, error: err.message };
    }
  } finally {
    if (remote) await remote.close().catch(() => {});
    await release();
  }
}

// Start a server that an apply-only run left stopped.
export async function restartTarget(targetId, { userId = null, onProgress, jobId = null } = {}) {
  const report = (event) => { try { onProgress?.(event); } catch {} };
  const release = await tryAdvisoryLock(907000 + targetId);
  if (!release) throw new Error("A sync job is already running for this target.");
  let remote = null;
  let job = null;
  let instanceId = null;
  let serverName = "The server";
  const logLines = [];
  try {
    const target = await syncTargetById(targetId);
    if (!target) throw new Error("Sync target not found.");
    instanceId = target.instance_id;
    serverName = target.name;
    const connection = await syncConnectionById(target.connection_id);
    if (!connection) throw new Error("Sync connection not found.");
    const jobRows = jobId
      ? (await query("SELECT * FROM sync_jobs WHERE id = $1", [jobId])).rows
      : (await query(
          `INSERT INTO sync_jobs (target_id, user_id, mode, status, plan, started_at)
           VALUES ($1,$2,'restart','queued','{}'::jsonb,now()) RETURNING *`,
          [target.id, userId]
        )).rows;
    job = jobRows[0];
    if (!job || job.target_id !== target.id) throw new Error("The sync job no longer exists.");
    await query("UPDATE sync_jobs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1", [job.id]);
    await appendJobLog(job.id, logLines, `Restart job ${job.id} started.`);

    remote = await createRemote(connection, target);
    if (!remote.power.configured) throw new Error("Server power is not configured on this connection.");
    const state = await remote.power.status();
    if (remote.power.isStarted(state)) {
      await query(
        "UPDATE sync_jobs SET status = 'succeeded', result = $2::jsonb, finished_at = now() WHERE id = $1",
        [job.id, JSON.stringify({ restart: true, already_running: true })]
      );
      report({ stage: "done", message: "The server is already running", percent: 100 });
      await appendJobLog(job.id, logLines, "The server was already running.");
      return { job, ok: true, alreadyRunning: true };
    }

    const startTimeoutMs = Math.max(60, Number(target.start_timeout_seconds) || 300) * 1000;
    report({ stage: "start", message: `Starting ${serverName}`, percent: 20 });
    await remote.power.start();
    await waitForGame(remote, startTimeoutMs, { onProgress: report });
    await waitReady(remote, startTimeoutMs, { onProgress: report });
    await query(
      "UPDATE sync_jobs SET status = 'succeeded', result = $2::jsonb, finished_at = now() WHERE id = $1",
      [job.id, JSON.stringify({ restart: true })]
    );
    report({ stage: "done", message: "Server started and ready", percent: 100 });
    await appendJobLog(job.id, logLines, "Server started and reached ready.");
    await createNotifications({
      kind: "sync", instanceId, syncJobId: job.id,
      title: `Server restarted: ${serverName}`,
      body: "The server started and reached ready.",
      userIds: await syncRecipients(userId),
    });
    await logActivity({
      userId, action: "sync_restarted", subjectType: "instance", subjectId: instanceId,
      meta: { target: serverName, job: job.id },
    });
    return { job, ok: true };
  } catch (err) {
    if (job) {
      await appendJobLog(job.id, logLines, `ERROR ${err.message}`);
      await query(
        "UPDATE sync_jobs SET status = 'failed', result = $2::jsonb, finished_at = now() WHERE id = $1",
        [job.id, JSON.stringify({ error: err.message })]
      ).catch(() => {});
      await createNotifications({
        kind: "sync", instanceId, syncJobId: job.id,
        title: `Server restart failed: ${serverName}`,
        body: err.message,
        userIds: await syncRecipients(userId),
      }).catch(() => {});
    }
    return { job, ok: false, error: err.message };
  } finally {
    if (remote) await remote.close().catch(() => {});
    await release();
  }
}
