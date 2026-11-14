import { query, tryAdvisoryLock } from "./db.js";
import { latestForMod } from "./sources/index.js";
import { createNotifications, telegramSend } from "./notify.js";
import { logActivity } from "./activity.js";
import { isNewer } from "./helpers.js";
import { broadcastRefresh } from "./realtime.js";

const MOD_CONCURRENCY = 5;
const LOCK_KEY = 20261114;

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const results = [];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      results.push(await worker(item));
    }
  });
  await Promise.all(runners);
  return results;
}

async function installedPublishedAt(mod, fallback = null) {
  const { rows } = await query(
    `SELECT published_at FROM mod_versions_cache
      WHERE mod_id = $1 AND (version_id = $2 OR version_string = $3)
      ORDER BY published_at DESC NULLS LAST LIMIT 1`,
    [mod.id, mod.installed_version_id, mod.installed_version]
  );
  return rows[0]?.published_at || fallback;
}

async function cacheVersion(modId, version) {
  if (!version?.version_id) return;
  await query(
    `INSERT INTO mod_versions_cache (mod_id, version_id, version_string, channel, mc_versions, loaders, published_at, changelog_url, download_page_url, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (mod_id, version_id) DO UPDATE SET
       version_string = EXCLUDED.version_string,
       channel = EXCLUDED.channel,
       mc_versions = EXCLUDED.mc_versions,
       loaders = EXCLUDED.loaders,
       published_at = EXCLUDED.published_at,
       changelog_url = EXCLUDED.changelog_url,
       download_page_url = EXCLUDED.download_page_url,
       fetched_at = now()`,
    [
      modId,
      version.version_id,
      version.version,
      version.channel || "release",
      version.mc_versions || [],
      version.loaders || [],
      version.published_at || null,
      version.changelog_url || "",
      version.download_page_url || "",
    ]
  ).catch((err) => console.error("version cache:", err.message));
}

async function checkMod(mod, instance) {
  if (mod.source === "manual") {
    await query(
      "UPDATE mods SET status = 'manual', last_checked_at = now(), last_error = NULL WHERE id = $1",
      [mod.id]
    );
    return { mod, result: "manual" };
  }
  if (mod.status === "ignored") return { mod, result: "ignored" };

  try {
    const versions = await latestForMod(mod, instance);
    const latest = versions?.[0] || null;
    if (!latest) {
      await query(
        `UPDATE mods SET status = $2, latest_version = installed_version,
           latest_version_id = installed_version_id, last_checked_at = now(), last_error = NULL
         WHERE id = $1`,
        [mod.id, mod.frozen_at ? "frozen" : "up_to_date"]
      );
      return { mod, result: "none" };
    }

    const installedDate = await installedPublishedAt(mod);
    const newer = latest.version_id !== mod.installed_version_id &&
      isNewer(latest.version, mod.installed_version, latest.published_at, installedDate);
    const frozen = Boolean(mod.frozen_at);
    const snoozed = Boolean(mod.snoozed_version_id && mod.snoozed_version_id === latest.version_id);
    const clearSnooze = Boolean(mod.snoozed_version_id && mod.snoozed_version_id !== latest.version_id && newer);
    const status = frozen ? "frozen" : newer && !snoozed ? "update_available" : "up_to_date";

    await query(
      `UPDATE mods SET status = $1, latest_version = $2, latest_version_id = $3,
         latest_published_at = $4, last_checked_at = now(), last_error = NULL,
         snoozed_version_id = CASE WHEN $6 THEN NULL ELSE snoozed_version_id END
       WHERE id = $5`,
      [status, latest.version, latest.version_id, latest.published_at || null, mod.id, clearSnooze]
    );
    await cacheVersion(mod.id, latest);

    if (newer && !snoozed && !frozen) {
      await createNotifications({
        kind: "update",
        instanceId: instance.id,
        modId: mod.id,
        versionId: latest.version_id,
        title: `${mod.name} ${mod.installed_version} → ${latest.version}`,
        body: `${instance.name} · ${instance.loader === "forge" ? "Forge" : instance.loader} ${instance.mc_version}. Open the version board to see the release.`,
      });
    }
    return { mod, result: status, latest };
  } catch (err) {
    const message = err.code === "not_configured" ? "CurseForge is not configured" : err.message;
    await query(
      "UPDATE mods SET status = 'source_error', last_checked_at = now(), last_error = $2 WHERE id = $1",
      [mod.id, message]
    );
    return { mod, result: "error", error: message };
  }
}

export async function checkOne(modId, { userId = null } = {}) {
  const { rows } = await query(
    `SELECT m.*, i.name AS instance_name, i.mc_version AS instance_mc_version, i.loader AS instance_loader
       FROM mods m JOIN instances i ON i.id = m.instance_id WHERE m.id = $1`,
    [modId]
  );
  const mod = rows[0];
  if (!mod) return { skipped: true, reason: "Mod not found" };
  const instance = {
    id: mod.instance_id,
    name: mod.instance_name,
    mc_version: mod.instance_mc_version,
    loader: mod.instance_loader,
  };
  const result = await checkMod(mod, instance);
  await query("UPDATE instances SET last_checked_at = now() WHERE id = $1", [mod.instance_id]);
  await logActivity({
    userId,
    action: "check_run",
    subjectType: "mod",
    subjectId: modId,
    meta: { trigger: "manual", result: result.result },
  });
  return result;
}

export async function checkInstance(instanceId, { trigger = "manual", userId = null } = {}) {
  const release = await tryAdvisoryLock(LOCK_KEY);
  if (!release) return { skipped: true, reason: "A check is already running" };

  let runId = null;
  try {
    const { rows: instanceRows } = await query("SELECT * FROM instances WHERE id = $1", [instanceId]);
    const instance = instanceRows[0];
    if (!instance) return { skipped: true, reason: "Instance not found" };

    const { rows: runRows } = await query(
      "INSERT INTO check_runs (instance_id, trigger) VALUES ($1, $2) RETURNING id",
      [instanceId, trigger]
    );
    runId = runRows[0].id;

    const { rows: mods } = await query(
      "SELECT * FROM mods WHERE instance_id = $1 AND status <> 'ignored' ORDER BY name",
      [instanceId]
    );
    const results = await mapLimit(mods, MOD_CONCURRENCY, (mod) => checkMod(mod, instance));
    const updates = results.filter((r) => r.result === "update_available");
    const errors = results.filter((r) => r.result === "error");

    await query("UPDATE instances SET last_checked_at = now() WHERE id = $1", [instanceId]);
    await query(
      `UPDATE check_runs SET finished_at = now(), checked = $2, updates = $3, errors = $4 WHERE id = $1`,
      [runId, results.length, updates.length, errors.length]
    );

    await logActivity({
      userId,
      action: "check_run",
      subjectType: "instance",
      subjectId: instanceId,
      meta: { trigger, checked: results.length, updates: updates.length, errors: errors.length },
    });

    broadcastRefresh("instances", { reason: "check", instanceId }).catch(() => {});
    if (updates.length) {
      const lines = updates.slice(0, 15).map(({ mod, latest }) =>
        `• ${mod.name} ${mod.installed_version} → ${latest?.version || ""}`
      );
      if (updates.length > 15) lines.push(`…and ${updates.length - 15} more`);
      await telegramSend(
        `ModWatch · ${instance.name}\n${updates.length} update${updates.length === 1 ? "" : "s"} for ${instance.loader} ${instance.mc_version}\n${lines.join("\n")}`
      );
    }

    return { checked: results.length, updates: updates.length, errors: errors.length };
  } finally {
    await release();
  }
}

export async function checkAll({ trigger = "manual", userId = null } = {}) {
  const { rows: instances } = await query("SELECT id, name FROM instances ORDER BY name");
  const out = [];
  for (const instance of instances) {
    const result = await checkInstance(instance.id, { trigger, userId });
    out.push({ instance, result });
  }
  return out;
}
