import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { query } from "./db.js";
import { isNewer } from "./helpers.js";
import { kindExtension } from "./kinds.js";
import { hashOverrideFiles, readZipEntries } from "./import.js";
import { insertMod } from "./mod-service.js";
import { fetchJar } from "./updater.js";
import { jarAbsolute, saveInstanceFile, saveJar } from "./uploads.js";
import { logActivity } from "./activity.js";

const DEFAULT_FILE_FOLDERS = new Set(["config", "defaultconfigs", "kubejs", "scripts"]);
const SKIP_FILE_FOLDERS = new Set(["saves", "screenshots", "logs", "crash-reports", "backups"]);

function fileFolder(relative) {
  return String(relative || "").split("/")[0].toLowerCase();
}

function projectKey(index) {
  return `p${index}`;
}

function normalizeFileName(fileName, name, version, kind) {
  const extension = kindExtension(kind);
  const raw = fileName || `${name}-${version}${extension}`;
  const base = raw.replace(/\.(?:jar|zip)(?:\.disabled)?$/i, "");
  return `${base}${extension}`;
}

export async function buildPackUpdate(preview, instance) {
  const scopeMismatch = preview.pack.mc_version !== instance.mc_version || preview.pack.loader !== instance.loader
    ? {
        packMc: preview.pack.mc_version,
        instanceMc: instance.mc_version,
        packLoader: preview.pack.loader,
        instanceLoader: instance.loader,
      }
    : null;

  const [{ rows: existing }, { rows: currentFiles }] = await Promise.all([
    query(
      `SELECT m.*, c.published_at AS installed_published_at
         FROM mods m
         LEFT JOIN mod_versions_cache c ON c.mod_id = m.id AND c.version_id = m.installed_version_id
        WHERE m.instance_id = $1 AND m.status <> 'ignored'
        ORDER BY m.name`,
      [instance.id]
    ),
    query("SELECT path, file_sha1, file_size FROM instance_files WHERE instance_id = $1", [instance.id]),
  ]);
  const existingFiles = new Map(currentFiles.map((row) => [row.path, row]));

  const byProject = new Map();
  const byHash = new Map();
  const byName = new Map();
  for (const mod of existing) {
    if (mod.project_id) byProject.set(`${mod.source}:${mod.project_id}`, mod);
    if (mod.file_sha1) byHash.set(mod.file_sha1, mod);
    byName.set(String(mod.name || "").toLowerCase(), mod);
    if (mod.file_name) byName.set(String(mod.file_name).toLowerCase(), mod);
  }

  const used = new Set();
  const projects = [];

  const pushProject = (item) => {
    item.key = projectKey(projects.length);
    projects.push(item);
  };

  for (const incoming of preview.identified || []) {
    const existingMod = byProject.get(`${incoming.source}:${incoming.project_id}`)
      || byHash.get(incoming.file_sha1)
      || byName.get(String(incoming.name || "").toLowerCase());
    if (existingMod) used.add(existingMod.id);
    const same = existingMod && (
      (incoming.installed_version_id && incoming.installed_version_id === existingMod.installed_version_id)
      || (incoming.file_sha1 && incoming.file_sha1 === existingMod.file_sha1)
    );
    let state = "new";
    let defaultAction = "add";
    let note = "";
    if (existingMod) {
      if (incoming.kind && existingMod.kind && incoming.kind !== existingMod.kind) {
        state = "changed";
        defaultAction = "skip";
        note = `Kind changed from ${existingMod.kind} to ${incoming.kind}`;
      } else if (same) {
        state = "same";
        defaultAction = "skip";
      } else if (String(incoming.installed_version || "").toLowerCase() === String(existingMod.installed_version || "").toLowerCase()) {
        state = "changed";
        defaultAction = "skip";
        note = "Same version string but a different file hash";
      } else if (isNewer(incoming.installed_version, existingMod.installed_version, incoming.published_at, existingMod.installed_published_at)) {
        state = "newer";
        defaultAction = "replace";
      } else {
        state = "older";
        defaultAction = "skip";
      }
    }
    pushProject({
      state,
      defaultAction,
      note,
      existingId: existingMod?.id || null,
      existingName: existingMod?.name || "",
      existingVersion: existingMod?.installed_version || "",
      existingFile: existingMod?.file_name || "",
      existingDisabled: Boolean(existingMod?.disabled),
      name: incoming.name || existingMod?.name || incoming.file_name,
      kind: incoming.kind || existingMod?.kind || "mod",
      source: incoming.source,
      projectId: incoming.project_id,
      incoming: {
        name: incoming.name,
        kind: incoming.kind,
        source: incoming.source,
        projectId: incoming.project_id,
        version: incoming.installed_version,
        versionId: incoming.installed_version_id,
        publishedAt: incoming.published_at,
        fileName: incoming.file_name,
        fileSha1: incoming.file_sha1,
        fileSha512: incoming.file_sha512,
        fileSize: incoming.file_size,
        side: incoming.side,
        iconUrl: incoming.icon_url,
        projectUrl: incoming.project_url,
        downloadUrl: incoming.download_url,
        jarEntry: incoming.jar_entry || "",
        jarPath: incoming.jar_path || "",
      },
    });
  }

  for (const incoming of preview.unknown || []) {
    const existingMod = byHash.get(incoming.file_sha1)
      || byName.get(String(incoming.file_name || "").toLowerCase());
    if (existingMod) used.add(existingMod.id);
    const same = existingMod && incoming.file_sha1 && incoming.file_sha1 === existingMod.file_sha1;
    pushProject({
      state: same ? "same" : "unknown",
      defaultAction: "skip",
      note: same ? "" : "No Modrinth match for the incoming file",
      existingId: existingMod?.id || null,
      existingName: existingMod?.name || "",
      existingVersion: existingMod?.installed_version || "",
      existingFile: existingMod?.file_name || "",
      existingDisabled: Boolean(existingMod?.disabled),
      name: incoming.file_name || "Unknown file",
      kind: incoming.kind || "mod",
      source: "",
      projectId: "",
      incoming: {
        name: incoming.file_name,
        kind: incoming.kind,
        version: "",
        fileName: incoming.file_name,
        fileSha1: incoming.file_sha1,
        fileSha512: incoming.file_sha512,
        fileSize: incoming.file_size,
        jarEntry: incoming.jar_entry || "",
        jarPath: incoming.jar_path || "",
      },
    });
  }

  for (const mod of existing) {
    if (used.has(mod.id)) continue;
    pushProject({
      state: "not_in_pack",
      defaultAction: "keep",
      note: "Kept; it is not in the new pack",
      existingId: mod.id,
      existingName: mod.name,
      existingVersion: mod.installed_version,
      existingFile: mod.file_name,
      existingDisabled: Boolean(mod.disabled),
      name: mod.name,
      kind: mod.kind,
      source: mod.source,
      projectId: mod.project_id,
      incoming: null,
    });
  }

  const overrideHashes = await hashOverrideFiles(preview.file_path).catch(() => new Map());
  const files = [];
  for (const [relative, info] of overrideHashes) {
    const previous = existingFiles.get(relative);
    const same = previous && previous.file_sha1 && previous.file_sha1 === info.sha1;
    const state = !previous ? "new" : same ? "same" : "changed";
    const folder = fileFolder(relative);
    const defaultSelected = state !== "same" && !SKIP_FILE_FOLDERS.has(folder) && DEFAULT_FILE_FOLDERS.has(folder);
    files.push({
      path: relative,
      folder,
      size: info.size,
      sha1: info.sha1,
      state,
      defaultSelected,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const counts = {
    newer: projects.filter((item) => item.state === "newer").length,
    older: projects.filter((item) => item.state === "older").length,
    new: projects.filter((item) => item.state === "new").length,
    changed: projects.filter((item) => item.state === "changed").length,
    same: projects.filter((item) => item.state === "same").length,
    notInPack: projects.filter((item) => item.state === "not_in_pack").length,
    unknown: projects.filter((item) => item.state === "unknown").length,
    filesNew: files.filter((item) => item.state === "new").length,
    filesChanged: files.filter((item) => item.state === "changed").length,
    filesSame: files.filter((item) => item.state === "same").length,
  };

  return { scopeMismatch, projects, files, counts };
}

async function readOverrideBuffers(filePath, wanted) {
  if (!wanted.size) return new Map();
  const { found } = await readZipEntries(filePath, (name) => wanted.has(name));
  const map = new Map();
  for (const [name, value] of found) map.set(name, value.buffer);
  return map;
}

export async function applyPackUpdate(preview, instance, diff, selections, { userId = null } = {}) {
  const summary = {
    instanceId: instance.id,
    instanceName: instance.name,
    packName: preview.pack.name,
    packVersion: preview.pack.version,
    updated: [],
    added: [],
    skipped: [],
    notInPack: [],
    filesUpdated: [],
    warnings: [],
  };
  if (diff.scopeMismatch) throw new Error("This pack's Minecraft version or loader does not match the instance.");
  const actions = selections?.projects || {};
  const selectedFiles = new Set(selections?.files || []);

  const overrideWanted = new Set();
  for (const item of diff.projects) {
    const action = actions[item.key] || item.defaultAction;
    if (item.incoming?.jarPath && (action === "add" || action === "replace")) {
      overrideWanted.add(`overrides/${item.incoming.jarPath}`);
    }
  }
  for (const file of diff.files) {
    if (selectedFiles.has(file.path) && file.state !== "same") overrideWanted.add(`overrides/${file.path}`);
  }
  const overrideBuffers = await readOverrideBuffers(preview.file_path, overrideWanted);

  const checkLater = [];
  for (const item of diff.projects) {
    const action = actions[item.key] || item.defaultAction;
    if (action === "skip" || action === "keep") {
      if (!["same", "not_in_pack"].includes(item.state)) {
        summary.skipped.push({ name: item.name, version: item.incoming?.version || item.existingVersion, reason: action === "keep" ? "Kept" : "Skipped" });
      }
      if (item.state === "not_in_pack") summary.notInPack.push({ name: item.name, version: item.existingVersion });
      continue;
    }
    if (item.state === "not_in_pack" || item.state === "unknown") {
      summary.skipped.push({ name: item.name, version: item.incoming?.version || "", reason: "Not matched to a source" });
      continue;
    }
    if (action === "add") {
      if (!item.incoming?.source || !item.incoming?.projectId) {
        summary.skipped.push({ name: item.name, reason: "Not matched to a source" });
        continue;
      }
      try {
        const buffer = item.incoming.jarPath ? overrideBuffers.get(`overrides/${item.incoming.jarPath}`) : null;
        const id = await insertMod(instance.id, {
          name: item.incoming.name || item.name,
          source: item.incoming.source,
          kind: item.incoming.kind || item.kind,
          project_id: item.incoming.projectId,
          project_url: item.incoming.projectUrl || "",
          installed_version: item.incoming.version || "unknown version",
          installed_version_id: item.incoming.versionId || null,
          file_name: item.incoming.fileName || "",
          file_sha1: item.incoming.fileSha1 || null,
          file_sha512: item.incoming.fileSha512 || null,
          file_size: item.incoming.fileSize || null,
          icon_url: item.incoming.iconUrl || null,
          download_url: item.incoming.downloadUrl || null,
          side: item.incoming.side || "both",
          channel_policy: "release",
          published_at: item.incoming.publishedAt || null,
        }, userId);
        if (buffer) {
          const name = normalizeFileName(item.incoming.fileName, item.incoming.name, item.incoming.version, item.incoming.kind);
          const stored = await saveJar(instance.id, `${item.incoming.kind || "mod"}-${name}`, buffer);
          await query("UPDATE mods SET stored_path = $2, stored_version_id = installed_version_id WHERE id = $1", [id, stored]);
        }
        summary.added.push({ name: item.incoming.name || item.name, version: item.incoming.version || "" });
        checkLater.push(id);
      } catch (err) {
        summary.skipped.push({ name: item.name, reason: err.message });
      }
      continue;
    }
    if (action === "replace") {
      if (!item.existingId) {
        summary.skipped.push({ name: item.name, reason: "No existing project to replace" });
        continue;
      }
      try {
        const buffer = item.incoming.jarPath ? overrideBuffers.get(`overrides/${item.incoming.jarPath}`) : null;
        const downloaded = !buffer && item.incoming.downloadUrl ? await fetchJar(item.incoming.downloadUrl) : null;
        const bytes = buffer || downloaded;
        if (!bytes) throw new Error("No downloadable file for the incoming version");
        const kind = item.incoming.kind || item.kind;
        const fileName = normalizeFileName(item.incoming.fileName, item.incoming.name, item.incoming.version, kind);
        const storedName = item.existingDisabled
          ? (fileName.endsWith(".disabled") ? fileName : `${fileName}.disabled`)
          : fileName;
        const stored = await saveJar(instance.id, `${kind}-${storedName}`, bytes);
        const { rows: previous } = await query("SELECT stored_path FROM mods WHERE id = $1", [item.existingId]);
        const oldPath = previous[0]?.stored_path;
        await query(
          `UPDATE mods SET name = $2, source = $3, kind = $4, project_id = $5, project_url = $6,
              installed_version = $7, installed_version_id = $8, file_name = $9, file_sha1 = $10,
              file_sha512 = $11, file_size = $12, icon_url = COALESCE($13, icon_url), download_url = $14,
              stored_path = $15, stored_version_id = $8, status = 'up_to_date', snoozed_version_id = NULL,
              last_error = NULL, last_checked_at = now()
            WHERE id = $1`,
          [
            item.existingId, item.incoming.name || item.name, item.incoming.source, kind,
            item.incoming.projectId, item.incoming.projectUrl || "", item.incoming.version || "unknown version",
            item.incoming.versionId || null, fileName, item.incoming.fileSha1 || null,
            item.incoming.fileSha512 || null, item.incoming.fileSize || bytes.length,
            item.incoming.iconUrl || null, item.incoming.downloadUrl || null, stored,
          ]
        );
        if (oldPath && oldPath !== stored) {
          const old = jarAbsolute(oldPath);
          if (old) await fs.promises.rm(old, { force: true }).catch(() => {});
        }
        summary.updated.push({
          name: item.incoming.name || item.name,
          from: item.existingVersion || "unknown",
          to: item.incoming.version || "unknown",
        });
        checkLater.push(item.existingId);
      } catch (err) {
        summary.skipped.push({ name: item.name, reason: err.message });
      }
    }
  }

  for (const file of diff.files) {
    if (!selectedFiles.has(file.path) || file.state === "same") continue;
    const buffer = overrideBuffers.get(`overrides/${file.path}`);
    if (!buffer) {
      summary.warnings.push(`${file.path}: file was not found inside the uploaded pack.`);
      continue;
    }
    const hashes = crypto.createHash("sha1").update(buffer).digest("hex");
    const stored = await saveInstanceFile(instance.id, file.path, buffer);
    const folder = fileFolder(file.path);
    await query(
      `INSERT INTO instance_files (instance_id, path, folder, file_name, file_size, file_sha1, stored_path, modified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (instance_id, path) DO UPDATE
         SET file_size = EXCLUDED.file_size, file_sha1 = EXCLUDED.file_sha1,
             stored_path = EXCLUDED.stored_path, modified_at = now()`,
      [instance.id, file.path, folder, path.basename(file.path), buffer.length, hashes, stored]
    );
    summary.filesUpdated.push({ path: file.path, state: file.state });
  }

  const { checkOne } = await import("./checker.js");
  for (const id of checkLater) {
    await checkOne(id, { userId }).catch((err) => summary.warnings.push(`${id}: ${err.message}`));
  }

  await logActivity({
    userId,
    action: "import_update",
    subjectType: "instance",
    subjectId: instance.id,
    meta: {
      pack: preview.pack.name,
      updated: summary.updated.length,
      added: summary.added.length,
      files: summary.filesUpdated.length,
      skipped: summary.skipped.length,
    },
  });
  return summary;
}

export async function saveUpdateResult(summary) {
  const token = crypto.randomUUID();
  const dir = path.join(process.cwd(), "uploads", "tmp");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `update-${token}.json`), JSON.stringify({ ...summary, token, created_at: new Date().toISOString() }));
  return token;
}

export async function loadUpdateResult(token) {
  if (!/^[a-f0-9-]{36}$/.test(String(token || ""))) return null;
  try {
    const data = JSON.parse(await fs.promises.readFile(path.join(process.cwd(), "uploads", "tmp", `update-${token}.json`), "utf8"));
    return data;
  } catch {
    return null;
  }
}
