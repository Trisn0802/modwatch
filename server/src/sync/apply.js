import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { query, tryAdvisoryLock } from "../db.js";
import { ensureStoredJar } from "../export.js";
import { jarAbsolute } from "../uploads.js";
import { logActivity } from "../activity.js";
import { createNotifications, telegramSend } from "../notify.js";
import { scanTarget, syncConnectionById, syncTargetById } from "./index.js";
import * as amp from "./drivers/amp.js";
import * as sftp from "./drivers/sftp.js";

const APPLY_ACTIONS = new Set(["add", "replace", "disable", "enable"]);
const MAX_CHANGES = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localSha1(file) {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

async function waitForStatus(connection, predicate, timeoutMs, { onProgress, message } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await amp.appStatus(connection);
    if (predicate(state)) return state;
    onProgress?.({ stage: "wait", message: `${message} (${state.players || 0} players)`, percent: 55 });
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

async function crashNames(client, connection) {
  const entries = await sftp.listDir(client, connection, "crash-reports").catch(() => []);
  return new Set(entries.filter((entry) => entry.type !== "d").map((entry) => entry.name));
}

async function crashSince(client, connection, before) {
  const entries = await sftp.listDir(client, connection, "crash-reports").catch(() => []);
  const fresh = entries
    .filter((entry) => entry.type !== "d" && !before.has(entry.name))
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));
  if (!fresh.length) return "";
  const buffer = await sftp.readRemote(client, connection, `crash-reports/${fresh[0].name}`).catch(() => null);
  const text = buffer ? buffer.toString("utf8") : "";
  const description = text.match(/Description:\s*(.+)/)?.[1]?.trim();
  return description ? `${description} (${fresh[0].name})` : fresh[0].name;
}

async function waitForGame(connection, client, timeoutMs, { onProgress } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await amp.appStatus(connection);
    if (state.gameListening || state.state === 20) return state;
    const buffer = await sftp.readRemote(client, connection, "logs/latest.log").catch(() => null);
    if (buffer) {
      const reason = crashReason(buffer.toString("utf8"));
      if (reason) throw new Error(`The server failed to start: ${reason}`);
    }
    onProgress?.({ stage: "wait", message: "Waiting for the server to start", percent: 62 });
    await sleep(3000);
  }
  throw new Error(`The server did not start listening within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function waitReady(client, connection, timeoutMs, { onProgress } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const buffer = await sftp.readRemote(client, connection, "logs/latest.log").catch(() => null);
    if (buffer) {
      const text = buffer.toString("utf8");
      const boot = text.lastIndexOf("Starting minecraft server version");
      if (boot !== -1 && text.indexOf("Done (", boot) !== -1) return true;
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
  const logLines = [];
  try {
    const target = await syncTargetById(targetId);
    if (!target) throw new Error("Sync target not found.");
    const connection = await syncConnectionById(target.connection_id);
    if (!connection) throw new Error("Sync connection not found.");
    if (!amp.ampConfigured(connection)) {
      throw new Error("AMP power is not configured on this connection. Add the AMP URL, user, password and instance name.");
    }
    report({ stage: "scan", message: "Rescanning the server before apply", percent: 5 });
    const scan = await scanTarget(target.id, { onProgress: (event) => report({ ...event, percent: Math.min(25, event.percent || 20) }) });
    const items = scan.plan.items.filter((item) => APPLY_ACTIONS.has(item.action));
    if (!items.length) throw new Error("There are no add, replace, enable or disable items to apply.");
    if (items.length > MAX_CHANGES) throw new Error(`The plan has ${items.length} changes; the safety limit is ${MAX_CHANGES}.`);

    let state = await amp.appStatus(connection);
    if (target.require_empty_server && Number(state.players) > 0) {
      throw new Error(`${state.name} has ${state.players} player(s) online. Wait for an empty server or turn off “Require empty server”.`);
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
    const { client } = await sftp.connect(connection);
    let stopped = false;
    const applied = [];
    try {
      const backupDir = path.posix.join(path.posix.dirname(target.mods_path || "mods"), "mods_backup", String(job.id));
      await sftp.mkdirRemote(client, connection, backupDir);
      report({ stage: "backup", message: "Backing up the jars that will change", percent: 35 });
      for (const item of items) {
        if (!item.oldFile) continue;
        const oldPath = path.posix.join(target.mods_path || "mods", item.oldFile);
        if (await sftp.existsRemote(client, connection, oldPath)) {
          const backupPath = path.posix.join(backupDir, item.oldFile);
          await sftp.copyRemote(client, connection, oldPath, backupPath);
          await appendJobLog(job.id, logLines, `Backed up ${item.oldFile}`);
        }
      }

      report({ stage: "stop", message: `Stopping ${state.name}`, percent: 45 });
      await amp.appStop(connection);
      await waitForStatus(connection, (next) => Number(next.state) === 0 && !next.gameListening, 180_000, {
        onProgress: (event) => report({ ...event, percent: 48 }),
        message: "Waiting for the server to stop",
      });
      await sleep(2500);
      stopped = true;
      await appendJobLog(job.id, logLines, "Server stopped.");

      for (const item of items) {
        const filePath = path.posix.join(target.mods_path || "mods", item.file);
        const oldPath = item.oldFile ? path.posix.join(target.mods_path || "mods", item.oldFile) : "";
        if (item.action === "add" || item.action === "replace") {
          const file = prepared.get(item.file || item.oldFile);
          if (!file) throw new Error(`${item.name}: the prepared local file is missing.`);
          const tmpName = `${item.file}.modwatch-tmp`;
          const tmpPath = path.posix.join(target.mods_path || "mods", tmpName);
          await sftp.writeRemote(client, connection, tmpPath, file.local);
          const remote = await sftp.hashRemote(client, connection, tmpPath);
          if (remote.sha1 !== file.sha1) throw new Error(`${item.name}: uploaded file hash did not match.`);
          if (oldPath && await sftp.existsRemote(client, connection, oldPath)) {
            await sftp.removeRemote(client, connection, oldPath);
          }
          await sftp.renameRemote(client, connection, tmpPath, filePath);
          await query("UPDATE sync_job_items SET status = 'done', sha1 = $2 WHERE job_id = $1 AND file_name = $3", [job.id, file.sha1, item.file]);
          applied.push(item);
          await appendJobLog(job.id, logLines, `${item.action} ${item.file}`);
        } else if (item.action === "disable" || item.action === "enable") {
          if (!oldPath || !(await sftp.existsRemote(client, connection, oldPath))) {
            throw new Error(`${item.name}: the file to ${item.action} is missing on the server.`);
          }
          await sftp.renameRemote(client, connection, oldPath, filePath);
          await query("UPDATE sync_job_items SET status = 'done' WHERE job_id = $1 AND file_name = $2", [job.id, item.file]);
          applied.push(item);
          await appendJobLog(job.id, logLines, `${item.action} ${item.oldFile} -> ${item.file}`);
        }
      }

      const crashBefore = await crashNames(client, connection);
      report({ stage: "start", message: `Starting ${state.name}`, percent: 60 });
      await amp.appStart(connection);
      await waitForGame(connection, client, startTimeoutMs, { onProgress: report });
      await waitReady(client, connection, startTimeoutMs, { onProgress: report });

      report({ stage: "verify", message: "Checking that the server stays up", percent: 92 });
      await sleep(6000);
      const crash = await crashSince(client, connection, crashBefore);
      if (crash) throw new Error(`The server crashed after it reported ready: ${crash}`);
      const after = await amp.appStatus(connection);
      if (!after.gameListening) throw new Error("The server stopped listening after it reported ready.");
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
        title: `Server sync: ${state.name}`,
        body: `${applied.length} change(s) applied and the server reached ready.`,
        userIds: admins.map((row) => row.id),
      });
      await telegramSend(`ModWatch · ${state.name}\n${applied.length} file(s) synced; server is ready.`);
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
          const current = await amp.appStatus(connection);
          if (current.running) {
            await amp.appStop(connection);
            await waitForStatus(connection, (next) => Number(next.state) === 0 && !next.gameListening, 180_000, { message: "Waiting to roll back" });
            await sleep(2500);
          }
          const backupDir = path.posix.join(path.posix.dirname(target.mods_path || "mods"), "mods_backup", String(job.id));
          for (const item of [...applied].reverse()) {
            const filePath = path.posix.join(target.mods_path || "mods", item.file);
            const oldPath = item.oldFile ? path.posix.join(target.mods_path || "mods", item.oldFile) : "";
            const backupPath = item.oldFile ? path.posix.join(backupDir, item.oldFile) : "";
            if (item.action === "add") {
              await sftp.removeRemote(client, connection, filePath);
            } else if (item.action === "replace") {
              await sftp.removeRemote(client, connection, filePath);
              if (backupPath && await sftp.existsRemote(client, connection, backupPath)) {
                await sftp.copyRemote(client, connection, backupPath, oldPath);
              }
            } else if (item.action === "disable" || item.action === "enable") {
              await sftp.renameRemote(client, connection, filePath, oldPath);
            }
          }
          await query(
            "UPDATE sync_job_items SET status = 'rolled_back' WHERE job_id = $1 AND status <> 'rolled_back'",
            [job.id]
          );
          await amp.appStart(connection);
          await waitForGame(connection, client, startTimeoutMs);
          const restartedReady = await waitReady(client, connection, Math.min(startTimeoutMs, 180_000), {}).then(() => true).catch(() => false);
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
            title: `Sync rolled back: ${state.name}`,
            body: `${err.message}. The previous jars were restored and the server was restarted.`,
          });
          await telegramSend(`ModWatch · ${state.name}\nRolled back: ${err.message}`);
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
            title: `Rollback failed: ${state.name}`,
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
        title: `Sync failed: ${state.name}`,
        body: err.message,
      });
      await logActivity({
        userId, action: "sync_failed", subjectType: "instance", subjectId: target.instance_id,
        meta: { target: target.name, error: err.message },
      });
      return { job, ok: false, rolledBack: false, error: err.message };
    } finally {
      await sftp.close(client);
    }
  } finally {
    await release();
  }
}
