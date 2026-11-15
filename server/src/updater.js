import fs from "node:fs";

import { query, tryAdvisoryLock } from "./db.js";
import { getVersion } from "./sources/modrinth.js";
import { listSourceVersions } from "./sources/index.js";
import { saveJar, jarAbsolute } from "./uploads.js";
import { logActivity } from "./activity.js";
import { kindExtension } from "./kinds.js";

const MAX_JAR = 120 * 1024 * 1024;

export async function fetchJar(url) {
  if (!/^https:\/\//i.test(url)) throw new Error("Only HTTPS downloads are allowed");
  const response = await fetch(url, {
    headers: { "user-agent": "ModWatch/1.0 (+self-hosted)" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Download failed with ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_JAR) throw new Error("The file is larger than 120 MB");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_JAR) throw new Error("The file is larger than 120 MB");
  return buffer;
}

async function latestFile(mod, instance) {
  if (mod.source === "modrinth" && mod.latest_version_id) {
    const version = await getVersion(mod.latest_version_id);
    if (version?.download_url) return { ...version, download_url: version.download_url };
  }
  const versions = await listSourceVersions(
    mod.source,
    mod.project_id,
    instance,
    mod.channel_policy,
    mod.github_asset_pattern || "",
    mod.kind
  );
  const version = mod.latest_version_id
    ? versions.find((item) => item.version_id === mod.latest_version_id)
    : versions[0];
  if (!version) return null;
  return { ...version, download_url: version.download_url || version.asset_url || "" };
}

export async function updateModToLatest(modId, { userId = null, verify = false } = {}) {
  const { rows } = await query(
    `SELECT m.*, i.mc_version AS instance_mc_version, i.loader AS instance_loader,
            i.name AS instance_name, i.pack_name AS instance_pack_name
       FROM mods m JOIN instances i ON i.id = m.instance_id WHERE m.id = $1`,
    [modId]
  );
  const mod = rows[0];
  if (!mod) throw new Error("Mod not found");
  if (mod.status !== "update_available" || !mod.latest_version_id) {
    throw new Error("There is no newer version recorded for this mod.");
  }
  const instance = {
    id: mod.instance_id,
    name: mod.instance_name,
    mc_version: mod.instance_mc_version,
    loader: mod.instance_loader,
  };
  const file = await latestFile(mod, instance);
  if (!file?.download_url) {
    throw new Error("No download URL is available for this version.");
  }
  if (file.file_size && Number(file.file_size) > MAX_JAR) {
    throw new Error("The file is larger than 120 MB");
  }
  const buffer = await fetchJar(file.download_url);
  const extension = kindExtension(mod.kind);
  const rawName = file.file_name || `${mod.name}-${file.version}${extension}`;
  const baseName = rawName.replace(/\.(?:jar|zip)(?:\.disabled)?$/i, "");
  const fileName = `${baseName}${extension}`;
  const storedName = mod.disabled ? (fileName.endsWith(".disabled") ? fileName : `${fileName}.disabled`) : fileName;
  const stored = await saveJar(mod.instance_id, storedName, buffer);

  const oldPath = mod.stored_path;
  await query(
    `UPDATE mods SET installed_version = $2, installed_version_id = $3, file_name = $4,
        file_sha1 = $5, file_sha512 = $6, file_size = $7, download_url = $8,
        stored_path = $9, stored_version_id = $3, latest_version = $2,
        latest_version_id = $3, latest_published_at = $10, status = 'up_to_date',
        snoozed_version_id = NULL, last_error = NULL, last_checked_at = now()
      WHERE id = $1`,
    [
      mod.id,
      file.version || mod.latest_version,
      file.version_id || mod.latest_version_id,
      fileName,
      file.file_sha1 || null,
      file.file_sha512 || null,
      file.file_size || buffer.length,
      file.download_url,
      stored,
      file.published_at || null,
    ]
  );
  if (oldPath) {
    const old = jarAbsolute(oldPath);
    const next = jarAbsolute(stored);
    if (old && next && old !== next) await fs.promises.rm(old, { force: true }).catch(() => {});
  }
  await query(
    "UPDATE notifications SET read_at = now() WHERE mod_id = $1 AND kind = 'update' AND read_at IS NULL",
    [mod.id]
  ).catch(() => {});
  await logActivity({
    userId,
    action: "mod_updated",
    subjectType: "mod",
    subjectId: mod.id,
    meta: { name: mod.name, from: mod.installed_version, to: file.version, downloaded: true },
  });

  let verified = null;
  if (verify) {
    const { checkOne } = await import("./checker.js");
    const result = await checkOne(mod.id, { userId });
    verified = result?.result || null;
  }
  return { mod, from: mod.installed_version, to: file.version, verified };
}

export async function updateAllInInstance(instanceId, { userId = null } = {}) {
  const release = await tryAdvisoryLock(20261116);
  if (!release) throw new Error("An update download is already running.");
  try {
    const { rows } = await query(
      "SELECT id, name FROM mods WHERE instance_id = $1 AND status = 'update_available' ORDER BY name",
      [instanceId]
    );
    const updated = [];
    const failed = [];
    for (const row of rows) {
      try {
        const result = await updateModToLatest(row.id, { userId, verify: false });
        updated.push({ name: row.name, from: result.from, to: result.to });
      } catch (err) {
        failed.push({ name: row.name, error: err.message });
      }
    }
    return { total: rows.length, updated, failed };
  } finally {
    await release();
  }
}

export async function setModVersion(modId, versionId, { userId = null } = {}) {
  const { rows } = await query(
    `SELECT m.*, i.mc_version AS instance_mc_version, i.loader AS instance_loader,
            i.name AS instance_name
       FROM mods m JOIN instances i ON i.id = m.instance_id WHERE m.id = $1`,
    [modId]
  );
  const mod = rows[0];
  if (!mod) throw new Error("Project not found");
  if (mod.source === "manual" || !mod.project_id) {
    throw new Error("Manual projects do not have source versions.");
  }
  const instance = {
    id: mod.instance_id,
    name: mod.instance_name,
    mc_version: mod.instance_mc_version,
    loader: mod.instance_loader,
  };
  const versions = await listSourceVersions(
    mod.source,
    mod.project_id,
    instance,
    "alpha",
    mod.github_asset_pattern || "",
    mod.kind
  );
  const file = versions.find((item) => item.version_id === versionId);
  if (!file?.download_url) {
    throw new Error("That version is not available for this instance's scope.");
  }
  if (file.version_id === mod.installed_version_id) {
    throw new Error("That version is already installed.");
  }
  if (file.file_size && Number(file.file_size) > MAX_JAR) {
    throw new Error("The file is larger than 120 MB");
  }
  const buffer = await fetchJar(file.download_url);
  const extension = kindExtension(mod.kind);
  const rawName = file.file_name || `${mod.name}-${file.version}${extension}`;
  const baseName = rawName.replace(/\.(?:jar|zip)(?:\.disabled)?$/i, "");
  const fileName = `${baseName}${extension}`;
  const storedName = mod.disabled ? (fileName.endsWith(".disabled") ? fileName : `${fileName}.disabled`) : fileName;
  const stored = await saveJar(mod.instance_id, storedName, buffer);

  const oldPath = mod.stored_path;
  await query(
    `UPDATE mods SET installed_version = $2, installed_version_id = $3, file_name = $4,
        file_sha1 = $5, file_sha512 = $6, file_size = $7, download_url = $8,
        stored_path = $9, stored_version_id = $3, snoozed_version_id = NULL,
        last_error = NULL, last_checked_at = now(), status = 'up_to_date'
      WHERE id = $1`,
    [
      mod.id,
      file.version || versionId,
      file.version_id || versionId,
      fileName,
      file.file_sha1 || null,
      file.file_sha512 || null,
      file.file_size || buffer.length,
      file.download_url,
      stored,
    ]
  );
  if (oldPath) {
    const old = jarAbsolute(oldPath);
    const next = jarAbsolute(stored);
    if (old && next && old !== next) await fs.promises.rm(old, { force: true }).catch(() => {});
  }
  await query(
    "UPDATE notifications SET read_at = now() WHERE mod_id = $1 AND kind = 'update' AND read_at IS NULL",
    [mod.id]
  ).catch(() => {});
  await logActivity({
    userId,
    action: "mod_version_changed",
    subjectType: "mod",
    subjectId: mod.id,
    meta: { name: mod.name, from: mod.installed_version, to: file.version, downloaded: true },
  });

  let checked = null;
  try {
    const { checkOne } = await import("./checker.js");
    checked = await checkOne(mod.id, { userId });
  } catch (err) {
    console.error("version change check:", err.message);
  }
  return { mod, from: mod.installed_version, to: file.version, status: checked?.result || null };
}
