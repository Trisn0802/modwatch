import yazl from "yazl";

import { query } from "./db.js";
import { ensureStoredJar, jarFileName } from "./export.js";
import { jarAbsolute } from "./uploads.js";
import { KIND_ORDER, kindFolder, kindLabel, kindPlural } from "./kinds.js";

const SOURCES = new Set(["modrinth", "curseforge", "github", "hangar", "spigot", "manual"]);
const CONCURRENCY = 3;

function slug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function uniqueName(used, folder, name, id) {
  const ext = /\.jar(?:\.disabled)?$/i.exec(name)?.[0] || ".jar";
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  let n = 1;
  while (used.has(`${folder}/${candidate.toLowerCase()}`)) {
    candidate = `${base}-${n === 1 ? id : `${id}-${n}`}${ext}`;
    n += 1;
  }
  used.add(`${folder}/${candidate.toLowerCase()}`);
  return candidate;
}

export async function listModsForZip(instance, { modIds = [], all = false, source = "", kinds = [] } = {}) {
  const params = [instance.id];
  let where = "instance_id = $1 AND status <> 'ignored'";
  if (modIds.length) {
    params.push(modIds);
    where += " AND id = ANY($2::int[])";
  } else if (all) {
    if (source && SOURCES.has(source)) {
      params.push(source);
      where += ` AND source = $${params.length}`;
    }
  } else {
    return [];
  }
  const selected = kinds.filter((kind) => KIND_ORDER.includes(kind));
  if (selected.length) {
    params.push(selected);
    where += ` AND kind = ANY($${params.length}::text[])`;
  }
  const { rows } = await query(
    `SELECT id, name, kind, source, status, disabled, installed_version, installed_version_id,
            stored_path, stored_version_id, file_name, download_url, file_sha1, file_sha512,
            file_size, project_id, channel_policy, github_asset_pattern
       FROM mods WHERE ${where} ORDER BY kind, source, name`,
    params
  );
  return rows;
}

export async function streamModZip(instance, mods, res, { extraFiles = [] } = {}) {
  const zip = new yazl.ZipFile();
  const warnings = [];
  const included = [];
  const folderCounts = {};
  const used = new Set();
  const queue = [...mods];
  const safe = slug(instance.pack_name || instance.name) || "modwatch";
  const filename = `${safe}-files.zip`;

  res.status(200).set({
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${safe}-files.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  zip.outputStream.on("error", () => res.destroy());
  zip.outputStream.pipe(res);

  const worker = async () => {
    while (queue.length) {
      const mod = queue.shift();
      if (!mod || res.destroyed) return;
      try {
        const stored = await ensureStoredJar(mod);
        const absolute = jarAbsolute(stored);
        if (!absolute) throw new Error("No file is stored or downloadable.");
        const folder = kindFolder(mod.kind);
        let name = jarFileName(mod);
        if (mod.disabled && !/\.disabled$/i.test(name)) name += ".disabled";
        name = uniqueName(used, folder, name, mod.id);
        zip.addFile(absolute, `${folder}/${name}`, { compress: false });
        folderCounts[folder] = (folderCounts[folder] || 0) + 1;
        included.push({
          folder,
          kind: mod.kind,
          file: name,
          name: mod.name,
          version: mod.installed_version || "",
          source: mod.source,
          disabled: Boolean(mod.disabled),
        });
      } catch (err) {
        warnings.push({ name: mod.name, source: mod.source, error: err.message || "Download failed." });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (res.destroyed) return;

  let packFiles = 0;
  for (const file of extraFiles) {
    const relative = String(file.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!relative || relative.includes("..")) continue;
    const absolute = jarAbsolute(file.stored_path);
    if (!absolute) continue;
    zip.addFile(absolute, relative, { compress: false });
    included.push({
      folder: relative.split("/")[0],
      kind: "file",
      file: relative,
      name: relative,
      version: "",
      source: "pack",
      disabled: false,
    });
    packFiles += 1;
  }

  const summary = {
    instance: {
      name: instance.name,
      pack: instance.pack_name || null,
      pack_version: instance.pack_version || null,
      minecraft: instance.mc_version,
      loader: instance.loader,
      loader_version: instance.loader_version || null,
    },
    generated_at: new Date().toISOString(),
    folders: folderCounts,
    pack_files: packFiles,
    included: included.sort((a, b) => `${a.folder}/${a.file}`.localeCompare(`${b.folder}/${b.file}`)),
    warnings,
  };
  const readme = [
    "ModWatch mod download",
    "",
    `Instance: ${instance.name}`,
    `Pack: ${instance.pack_name || instance.name}${instance.pack_version ? ` ${instance.pack_version}` : ""}`,
    `Minecraft ${instance.mc_version} · ${instance.loader}${instance.loader_version ? ` ${instance.loader_version}` : ""}`,
    "",
    "Files are grouped by the kind of project they belong to:",
    ...Object.entries(folderCounts).sort().map(([folder, count]) => `  ${folder}/ — ${count} file${count === 1 ? "" : "s"}`),
    "",
    "Disabled projects are saved with a .disabled suffix.",
    packFiles ? `${packFiles} stored config or pack file(s) are included at their original paths.` : "",
    "Unresolved/unknown files are not included.",
    warnings.length ? `${warnings.length} project(s) could not be downloaded; see modwatch-download.json.` : "",
    "",
  ].filter(Boolean).join("\n");
  zip.addBuffer(Buffer.from(JSON.stringify(summary, null, 2)), "modwatch-download.json");
  zip.addBuffer(Buffer.from(readme), "README.txt");
  zip.end();
}
