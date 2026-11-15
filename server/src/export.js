import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yazl from "yazl";

import { query, withTransaction } from "./db.js";
import { getVersion, listVersions as modrinthVersions } from "./sources/modrinth.js";
import { listVersions as curseforgeVersions } from "./sources/curseforge.js";
import { listVersions as githubVersions } from "./sources/github.js";
import { jarAbsolute, saveJar, writeExport } from "./uploads.js";
import { kindExtension, kindFolder } from "./kinds.js";

const MAX_JAR = 120 * 1024 * 1024;

function loaderKey(loader) {
  return {
    forge: "forge",
    neoforge: "neoforge",
    fabric: "fabric-loader",
    quilt: "quilt-loader",
  }[loader];
}

function envFor(side) {
  if (side === "client") return { client: "required", server: "unsupported" };
  if (side === "server") return { client: "unsupported", server: "required" };
  return { client: "required", server: "required" };
}

export function jarFileName(mod) {
  const extension = kindExtension(mod.kind);
  const base = String(mod.file_name || `${mod.name}-${mod.installed_version}${extension}`)
    .replace(/\.(?:jar|zip)(?:\.disabled)?$/i, "")
    .replace(/[^a-zA-Z0-9._+-]/g, "_");
  return `${base || "project"}${extension}`;
}

async function download(url, limit = MAX_JAR) {
  if (!/^https:\/\//i.test(url)) throw new Error("Only HTTPS downloads are allowed");
  const response = await fetch(url, {
    headers: { "user-agent": "ModWatch/1.0 (+self-hosted)" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Download failed with ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > limit) throw new Error("File is larger than the export limit");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw new Error("File is larger than the export limit");
  return buffer;
}

async function resolveModrinthFile(mod) {
  if (mod.download_url && (mod.file_sha1 || mod.file_sha512)) {
    return {
      download_url: mod.download_url,
      file_name: jarFileName(mod),
      file_size: mod.file_size,
      sha1: mod.file_sha1,
      sha512: mod.file_sha512,
    };
  }
  if (!mod.installed_version_id) return null;
  const version = await getVersion(mod.installed_version_id);
  const file = {
    download_url: version.download_url,
    file_name: version.file_name || jarFileName(mod),
    file_size: version.file_size,
    sha1: version.file_sha1,
    sha512: version.file_sha512,
  };
  await query(
    `UPDATE mods SET download_url = $2, file_name = COALESCE(NULLIF(file_name,''), $3),
        file_size = COALESCE(file_size, $4), file_sha1 = COALESCE(file_sha1, $5),
        file_sha512 = COALESCE(file_sha512, $6)
      WHERE id = $1`,
    [mod.id, file.download_url, file.file_name, file.file_size, file.sha1, file.sha512]
  ).catch(() => {});
  return file;
}

async function matchStoredFile(mod) {
  const { rows } = await query("SELECT * FROM instances WHERE id = $1", [mod.instance_id]);
  const instance = rows[0];
  if (!instance) return null;
  const fileName = String(mod.file_name || "").toLowerCase();
  if (mod.source === "curseforge" && mod.project_id) {
    const versions = await curseforgeVersions(mod.project_id, {
      mcVersion: instance.mc_version,
      loader: instance.loader,
      channels: ["release", "beta", "alpha"],
      kind: mod.kind,
    });
    const match = versions.find((v) => mod.installed_version_id && v.version_id === mod.installed_version_id)
      || versions.find((v) => fileName && String(v.file_name).toLowerCase() === fileName);
    if (match?.download_url) {
      await query(
        `UPDATE mods SET installed_version_id = COALESCE(installed_version_id, $2),
            download_url = $3, file_name = CASE WHEN file_name = '' THEN $4 ELSE file_name END
          WHERE id = $1`,
        [mod.id, match.version_id, match.download_url, match.file_name]
      );
      return { ...match, version_id: match.version_id, file_name: match.file_name || jarFileName(mod) };
    }
  }
  if (mod.source === "modrinth" && mod.project_id) {
    const versions = await modrinthVersions(mod.project_id, {
      mcVersion: instance.mc_version,
      loader: instance.loader,
      channels: ["release", "beta", "alpha"],
      kind: mod.kind,
    });
    const match = versions.find((v) => mod.installed_version_id && v.version_id === mod.installed_version_id)
      || versions.find((v) => fileName && String(v.file_name).toLowerCase() === fileName);
    if (match?.download_url) {
      await query(
        `UPDATE mods SET installed_version_id = COALESCE(installed_version_id, $2),
            download_url = $3, file_name = CASE WHEN file_name = '' THEN $4 ELSE file_name END,
            file_sha1 = COALESCE(file_sha1, $5), file_sha512 = COALESCE(file_sha512, $6)
          WHERE id = $1`,
        [mod.id, match.version_id, match.download_url, match.file_name, match.file_sha1, match.file_sha512]
      );
      return { ...match, version_id: match.version_id, file_name: match.file_name || jarFileName(mod) };
    }
  }
  if (mod.source === "github" && mod.project_id) {
    const versions = await githubVersions(mod.project_id, {
      channels: ["release", "beta", "alpha"],
      assetPattern: mod.github_asset_pattern || "",
    });
    const match = versions.find((v) => mod.installed_version_id && v.version_id === mod.installed_version_id)
      || versions.find((v) => fileName && String(v.file_name).toLowerCase() === fileName);
    if (match?.asset_url) {
      await query(
        `UPDATE mods SET installed_version_id = COALESCE(installed_version_id, $2),
            download_url = $3, file_name = CASE WHEN file_name = '' THEN $4 ELSE file_name END
          WHERE id = $1`,
        [mod.id, match.version_id, match.asset_url, match.file_name]
      );
      return { ...match, download_url: match.asset_url, version_id: match.version_id, file_name: match.file_name || jarFileName(mod) };
    }
  }
  return null;
}

export async function ensureStoredJar(mod, { force = false } = {}) {
  const existing = jarAbsolute(mod.stored_path);
  const sameVersion = !mod.stored_version_id || mod.stored_version_id === mod.installed_version_id;
  if (existing && sameVersion && !force) return mod.stored_path;

  let file = mod.source === "modrinth" && mod.installed_version_id
    ? await resolveModrinthFile(mod)
    : await matchStoredFile(mod);
  if (!file?.download_url && mod.download_url) {
    file = {
      download_url: mod.download_url,
      file_name: mod.file_name || jarFileName(mod),
      version_id: mod.installed_version_id || mod.stored_version_id || null,
      file_size: mod.file_size,
      sha1: mod.file_sha1,
      sha512: mod.file_sha512,
    };
  }
  if (!file?.download_url) return existing ? mod.stored_path : null;
  const buffer = await download(file.download_url);
  const storedName = mod.disabled ? disabledName(file.file_name || jarFileName(mod)) : (file.file_name || jarFileName(mod));
  const stored = await saveJar(mod.instance_id, storedName, buffer);
  await query(
    "UPDATE mods SET stored_path = $2, stored_version_id = $3, download_url = COALESCE(download_url, $4) WHERE id = $1",
    [mod.id, stored, file.version_id || mod.installed_version_id, file.download_url]
  );
  if (existing && mod.stored_path !== stored) await fs.promises.rm(jarAbsolute(mod.stored_path), { force: true }).catch(() => {});
  mod.stored_path = stored;
  mod.stored_version_id = file.version_id || mod.installed_version_id;
  return stored;
}

export async function refreshStoredJar(modId) {
  const { rows } = await query("SELECT * FROM mods WHERE id = $1", [modId]);
  const mod = rows[0];
  if (!mod) return;
  await ensureStoredJar(mod, { force: true }).catch((err) => console.error("refresh jar:", err.message));
}

function disabledName(name) {
  return /\.disabled$/i.test(name) ? name : `${name}.disabled`;
}

export async function setStoredDisabled(mod, disabled) {
  if (!mod?.stored_path) return;
  const current = jarAbsolute(mod.stored_path);
  if (!current) return;
  const wanted = disabled ? disabledName(current) : current.replace(/\.disabled$/i, "");
  if (wanted === current) return;
  await fs.promises.rename(current, wanted);
  const relative = path.relative(path.join(process.cwd(), "uploads"), wanted).split(path.sep).join("/");
  await query("UPDATE mods SET stored_path = $2 WHERE id = $1", [mod.id, relative]);
  mod.stored_path = relative;
}

export async function buildExport(instance, { userId = null, includeFiles = false } = {}) {
  if (!loaderKey(instance.loader)) {
    const err = new Error("This loader cannot be exported as a .mrpack");
    err.code = "unsupported_loader";
    throw err;
  }
  const [{ rows: mods }, { rows: unknown }, fileResult] = await Promise.all([
    query("SELECT * FROM mods WHERE instance_id = $1 AND status <> 'ignored' ORDER BY name", [instance.id]),
    query(
      "SELECT * FROM unknown_mods WHERE instance_id = $1 AND resolution = 'pending' ORDER BY file_name",
      [instance.id]
    ),
    includeFiles
      ? query("SELECT * FROM instance_files WHERE instance_id = $1 ORDER BY path", [instance.id])
      : Promise.resolve({ rows: [] }),
  ]);
  const instanceFiles = fileResult.rows;

  const files = [];
  const overrides = [];
  const warnings = [];

  for (const mod of mods) {
    if (mod.disabled) {
      const stored = await ensureStoredJar(mod).catch((err) => {
        warnings.push(`${mod.name}: ${err.message}`);
        return null;
      });
      const absolute = jarAbsolute(stored);
      if (absolute) {
        overrides.push({ path: `${kindFolder(mod.kind)}/${disabledName(jarFileName(mod))}`, absolute });
      } else {
        warnings.push(`${mod.name} is disabled but no file is stored on the server.`);
      }
      continue;
    }

    if (mod.kind === "mod" && mod.source === "modrinth") {
      const file = await resolveModrinthFile(mod).catch((err) => {
        warnings.push(`${mod.name}: ${err.message}`);
        return null;
      });
      if (file?.download_url && file.sha1) {
        const size = Number(file.file_size);
        files.push({
          path: `mods/${file.file_name || jarFileName(mod)}`,
          hashes: { sha1: file.sha1, ...(file.sha512 ? { sha512: file.sha512 } : {}) },
          env: envFor(mod.side),
          downloads: [file.download_url],
          ...(Number.isFinite(size) && size > 0 ? { fileSize: Math.trunc(size) } : {}),
        });
        continue;
      }
    }

    const stored = await ensureStoredJar(mod).catch((err) => {
      warnings.push(`${mod.name}: ${err.message}`);
      return null;
    });
    const absolute = jarAbsolute(stored);
    if (absolute) overrides.push({ path: `${kindFolder(mod.kind)}/${jarFileName(mod)}`, absolute });
    else warnings.push(`${mod.name}: no download URL and no stored file.`);
  }

  for (const item of unknown) {
    const absolute = jarAbsolute(item.stored_path);
    if (absolute) overrides.push({ path: `${kindFolder(item.kind)}/${jarFileName({ file_name: item.file_name, name: item.file_name, installed_version: "", kind: item.kind })}`, absolute });
    else warnings.push(`${item.file_name}: unknown file has no stored file.`);
  }

  for (const file of instanceFiles) {
    const absolute = jarAbsolute(file.stored_path);
    if (absolute) overrides.push({ path: file.path, absolute });
    else warnings.push(`${file.path}: stored pack file is missing from the server.`);
  }

  for (const file of files) {
    if (file.fileSize != null) file.fileSize = Math.trunc(Number(file.fileSize));
  }
  const deps = { minecraft: instance.mc_version };
  deps[loaderKey(instance.loader)] = instance.loader_version || "*";
  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: instance.pack_version || new Date().toISOString().slice(0, 10),
    name: instance.pack_name || instance.name,
    summary: instance.notes || `Exported from ModWatch for ${instance.mc_version} ${instance.loader}.`,
    files,
    dependencies: deps,
  };

  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(index, null, 2)), "modrinth.index.json");
  const added = new Set();
  for (const item of overrides) {
    const relative = String(item.path || "").replace(/^\/+/, "");
    if (!relative || relative.includes("..")) continue;
    if (added.has(relative.toLowerCase())) {
      warnings.push(`${relative}: duplicate override file skipped.`);
      continue;
    }
    added.add(relative.toLowerCase());
    zip.addFile(item.absolute, `overrides/${relative}`);
  }
  if (warnings.length) {
    zip.addBuffer(
      Buffer.from(JSON.stringify({ generated_at: new Date().toISOString(), warnings }, null, 2)),
      "modwatch-export.json"
    );
  }

  const chunks = [];
  await new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", resolve);
    zip.outputStream.on("error", reject);
    zip.end();
  });
  const buffer = Buffer.concat(chunks);
  const stored = await writeExport(instance.id, buffer);
  const token = crypto.randomBytes(16).toString("hex");

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO exports (instance_id, token, file_path, file_size, counts, created_by, include_files)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [instance.id, token, stored.path, stored.size, JSON.stringify({
        index: files.length,
        overrides: added.size,
        warnings: warnings.length,
      }), userId, includeFiles]
    );
    const { rows } = await client.query(
      "SELECT id, file_path FROM exports WHERE instance_id = $1 ORDER BY created_at DESC OFFSET 3",
      [instance.id]
    );
    for (const old of rows) {
      await client.query("DELETE FROM exports WHERE id = $1", [old.id]);
      await fs.promises.rm(path.join(process.cwd(), "uploads", old.file_path), { force: true }).catch(() => {});
    }
  });

  return { token, file_path: stored.path, path: stored.path, size: stored.size, counts: { files: files.length, overrides: added.size, warnings } };
}

export async function latestExport(instanceId, { includeFiles = null } = {}) {
  const { rows } = await query(
    `SELECT * FROM exports WHERE instance_id = $1
       ${includeFiles == null ? "" : "AND include_files = $2"}
     ORDER BY created_at DESC LIMIT 1`,
    includeFiles == null ? [instanceId] : [instanceId, includeFiles]
  );
  return rows[0] || null;
}

export async function getOrCreateExport(instance, { userId = null, maxAgeMinutes = 60, includeFiles = false } = {}) {
  const latest = await latestExport(instance.id, { includeFiles });
  if (latest && Date.now() - new Date(latest.created_at).getTime() < maxAgeMinutes * 60_000) return latest;
  const built = await buildExport(instance, { userId, includeFiles });
  return { ...built, created_at: new Date() };
}

export async function getExportByToken(token) {
  const { rows } = await query("SELECT * FROM exports WHERE token = $1", [token]);
  return rows[0] || null;
}

export async function removeInstanceFiles(instanceId) {
  await Promise.all([
    fs.promises.rm(path.join(process.cwd(), "uploads", "jars", `instance-${instanceId}`), { recursive: true, force: true }),
    fs.promises.rm(path.join(process.cwd(), "uploads", "files", `instance-${instanceId}`), { recursive: true, force: true }),
  ]).catch(() => {});
}
