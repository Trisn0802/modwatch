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

async function waitForStatus(remote, predicate, timeoutMs, { onProgress, message } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await remote.power.status();
    if (predicate(state)) return state;
    onProgress?.({ stage: "wait", message, percent: 55 });
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
  while (Date.now() - started < timeoutMs) {
    const state = await remote.power.status();
    if (remote.power.isStarted(state)) return state;
    const buffer = await remote.files.read("logs/latest.log").catch(() => null);
    if (buffer) {
      const reason = crashReason(buffer.toString("utf8"));
      if (reason) throw new Error(`The server failed to start: ${reason}`);
    }
    onProgress?.({ stage: "wait", message: "Waiting for the server to start", percent: 62 });
    await sleep(3000);
  }
  throw new Error(`The server did not start within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function waitReady(remote, timeoutMs, { onProgress } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const buffer = await remote.files.read("logs/latest.log").catch(() => null);
    if (buffer) {
      const text = buffer.toString("utf8");
      const boot = text.lastIndexOf("Starting minecraft server version");
      if (boot !== -1 && text.indexOf("Done (", boot) !== -1) return true;
      const reason = crashReason(text);
      if (reason) throw new Error(`The server failed to start: ${reason}`);
    }
    onProgress?.({ stage: "ready", message: "Waiting for the world to finish loading", percent: 70 });
    await sleep(4000);
  }
  throw new Error(`The server did not report ready within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function appendJobLog(jobId, lines, line) {
  if (line) lines.push(`[${new Date().toISOString()}] ${line}`);
  await query("UPDATE sync_jobs SET log = $2 WHERE id = $1", [jobId, lines.join("\n")]).catch(() => {});
}

export async function applyTarget(targetId, { userId = null, onProgress } = {}) {
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
    const scan = await scanTarget(target.id, { onProgress: (event) => report({ ...event, percent: Math.min(25, event.percent || 20) }) });
    const items = scan.plan.items.filter((item) => APPLY_ACTIONS.has(item.action));
    if (!items.length) throw new Error("There are no add, replace, enable or disable items to apply.");
    if (items.length > MAX_CHANGES) throw new Error(`The plan has ${items.length} changes; the safety limit is ${MAX_CHANGES}.`);

    let state = await remote.power.status();
    serverName = remote.kind === "pterodactyl" ? target.name : (state.name || target.name);
    if (target.require_empty_server && !remote.power.isStopped(state)) {
      const online = await remote.players();
      if (online > 0) {
        throw new Error(`${serverName} has ${online} player(s) online. Wait for an empty server or turn off “Require empty server”.`);
      }
    }

    const { rows } = await query(
      `INSERT INTO sync_jobs (target_id, user_id, mode, status, plan, started_at)
       VALUES ($1,$2,'apply','running',$3::jsonb,now()) RETURNING *`,
      [target.id, userId, JSON.stringify({ counts: scan.plan.counts, items })]
    );
    job = rows[0];
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

      await query(
        "UPDATE sync_jobs SET status = 'succeeded', result = $2::jsonb, finished_at = now() WHERE id = $1",
        [job.id, JSON.stringify({ changes: applied.length })]
      );
      report({ stage: "done", message: `Applied ${applied.length} change(s); server ready`, percent: 100 });

      const { rows: admins } = await query("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
      await createNotifications({
        kind: "sync",
        instanceId: target.instance_id,
        title: `Server sync: ${serverName}`,
        body: `${applied.length} change(s) applied and the server reached ready.`,
        userIds: admins.map((row) => row.id),
      });
      await telegramSend(`ModWatch · ${serverName}\n${applied.length} file(s) synced; server is ready.`);
      await logActivity({
        userId, action: "sync_applied", subjectType: "instance", subjectId: target.instance_id,
        meta: { target: target.name, changes: applied.length },
      });
      return { job, ok: true, changes: applied.length };
    } catch (err) {
      await appendJobLog(job.id, logLines, `ERROR ${err.message}`);
      if (stopped) {
        report({ stage: "rollback", message: "Rolling back the server files", percent: 80 });
        try {
          const current = await remote.power.status();
          if (!remote.power.isStopped(current)) {
            await remote.power.stop();
            await waitForStatus(remote, (next) => remote.power.isStopped(next), stopTimeoutMs, { message: "Waiting to roll back" });
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
          await waitForGame(remote, startTimeoutMs);
          const restartedReady = await waitReady(remote, Math.min(startTimeoutMs, 180_000), {}).then(() => true).catch(() => false);
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
            title: `Sync rolled back: ${serverName}`,
            body: `${err.message}. The previous jars were restored and the server was restarted.`,
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
            kind: "sync", instanceId: target.instance_id,
            title: `Rollback failed: ${serverName}`,
            body: `${err.message}. Rollback also failed: ${rollbackErr.message}`,
          });
          return { job, ok: false, rolledBack: false, error: `${err.message}; rollback failed: ${rollbackErr.message}` };
        }
      }
      await query(
        "UPDATE sync_jobs SET status = 'failed', result = $2::jsonb, finished_at = now() WHERE id = $1",
        [job.id, JSON.stringify({ error: err.message })]
      );
      await createNotifications({
        kind: "sync", instanceId: target.instance_id,
        title: `Sync failed: ${serverName}`,
        body: err.message,
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
