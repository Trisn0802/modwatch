import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yauzl from "yauzl";
import { parse as parseToml } from "smol-toml";

import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { lookupByHash, getProjects } from "./sources/modrinth.js";
import { logActivity } from "./activity.js";
import { saveJar, saveInstanceFile } from "./uploads.js";
import { kindFolder, kindFromPackPath, kindFromProjectType } from "./kinds.js";

const MAX_ENTRIES = 20_000;
const MAX_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
const MAX_INDEX = 8 * 1024 * 1024;
const MAX_JAR = 120 * 1024 * 1024;

const LOADER_KEYS = {
  forge: "forge",
  neoforge: "neoforge",
  "fabric-loader": "fabric",
  "quilt-loader": "quilt",
};

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) reject(err);
      else resolve(zip);
    });
  });
}

function readEntry(zip, entry, limit) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > limit) {
      reject(new Error(`Entry ${entry.fileName} is larger than the limit`));
      return;
    }
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) {
          stream.destroy(new Error(`Entry ${entry.fileName} is larger than the limit`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

function safeEntryName(name) {
  const normalized = String(name).replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  return true;
}

function entryModified(entry) {
  try {
    const date = entry.getLastModDate?.();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

export async function readZipEntries(filePath, wanted) {
  const zip = await openZip(filePath);
  const found = new Map();
  const listing = [];
  let entries = 0;
  let total = 0;
  await new Promise((resolve, reject) => {
    zip.on("entry", async (entry) => {
      entries += 1;
      total += entry.uncompressedSize || 0;
      if (entries > MAX_ENTRIES || total > MAX_UNCOMPRESSED) {
        zip.close();
        reject(new Error("Archive is larger than the safety limits allow"));
        return;
      }
      try {
        const name = String(entry.fileName || "").replace(/\\/g, "/");
        if (!name.endsWith("/") && safeEntryName(name)) {
          listing.push({ name, size: entry.uncompressedSize || 0, modified_at: entryModified(entry) });
        }
        if (!safeEntryName(entry.fileName)) {
          zip.readEntry();
          return;
        }
        const size = entry.uncompressedSize || 0;
        if (entry.fileName === "modrinth.index.json" && size <= MAX_INDEX) {
          found.set(entry.fileName, { buffer: await readEntry(zip, entry, MAX_INDEX), entry });
        } else if (wanted(entry.fileName) && size <= MAX_JAR) {
          found.set(entry.fileName, { buffer: await readEntry(zip, entry, MAX_JAR), entry });
        }
        zip.readEntry();
      } catch (err) {
        try { zip.close(); } catch {}
        reject(err);
      }
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return { found, listing };
}

function jwtLoader(dependencies = {}) {
  for (const [key, loader] of Object.entries(LOADER_KEYS)) {
    if (dependencies[key]) return { loader, version: String(dependencies[key]) };
  }
  return { loader: "forge", version: "" };
}

function envSide(env = {}) {
  const client = env.client || "required";
  const server = env.server || "required";
  if (server === "unsupported") return "client";
  if (client === "unsupported") return "server";
  return "both";
}

export async function readJarMetadata(buffer) {
  const zip = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true }, (err, z) => {
      if (err) reject(err);
      else resolve(z);
    });
  });
  const names = [
    "META-INF/neoforge.mods.toml",
    "META-INF/mods.toml",
    "fabric.mod.json",
    "quilt.mod.json",
  ];
  const data = new Map();
  await new Promise((resolve) => {
    zip.on("entry", async (entry) => {
      if (names.includes(entry.fileName) && entry.uncompressedSize <= 2 * 1024 * 1024) {
        try {
          data.set(entry.fileName, await readEntry(zip, entry, 2 * 1024 * 1024));
        } catch {}
      }
      zip.readEntry();
    });
    zip.on("end", resolve);
    zip.on("error", resolve);
    zip.readEntry();
  });

  const meta = { id: "", name: "", version: "", loaders: [] };
  const neoforge = data.get("META-INF/neoforge.mods.toml");
  const forge = data.get("META-INF/mods.toml");
  const fabric = data.get("fabric.mod.json");
  const quilt = data.get("quilt.mod.json");

  if (neoforge) {
    try {
      const parsed = parseToml(neoforge.toString("utf8"));
      const mods = parsed.mods || [];
      const mod = mods.find((m) => m.modId) || mods[0] || {};
      meta.id = mod.modId || parsed.modId || "";
      meta.name = mod.displayName || mod.modId || "";
      meta.version = String(mod.version || parsed.version || "");
      meta.loaders.push("neoforge");
    } catch {}
  }
  if (forge) {
    try {
      const parsed = parseToml(forge.toString("utf8"));
      const mods = parsed.mods || [];
      const mod = mods.find((m) => m.modId) || mods[0] || {};
      if (!meta.id) meta.id = mod.modId || parsed.modId || "";
      if (!meta.name) meta.name = mod.displayName || mod.modId || "";
      if (!meta.version) meta.version = String(mod.version || parsed.version || "");
      meta.loaders.push("forge");
    } catch {}
  }
  if (fabric) {
    try {
      const parsed = JSON.parse(fabric.toString("utf8"));
      if (!meta.id) meta.id = parsed.id || "";
      if (!meta.name) meta.name = parsed.name || parsed.id || "";
      if (!meta.version) meta.version = String(parsed.version || "");
      meta.loaders.push("fabric");
    } catch {}
  }
  if (quilt) {
    try {
      const parsed = JSON.parse(quilt.toString("utf8"));
      const loader = parsed.quilt_loader || {};
      if (!meta.id) meta.id = loader.id || "";
      if (!meta.name) meta.name = (loader.metadata && loader.metadata.name) || loader.id || "";
      if (!meta.version) meta.version = String(loader.version || "");
      meta.loaders.push("quilt");
    } catch {}
  }
  meta.loaders = [...new Set(meta.loaders)];
  return meta;
}

function storedProjectName(kind, fileName, disabled = false) {
  const base = String(fileName || "project").replace(/\.disabled$/i, "");
  return `${kind || "mod"}-${base}${disabled ? ".disabled" : ""}`;
}

function hashBuffers(buffer) {
  return {
    sha1: crypto.createHash("sha1").update(buffer).digest("hex"),
    sha512: crypto.createHash("sha512").update(buffer).digest("hex"),
  };
}

const PROJECT_PATH_RE = /^(?:overrides\/)?(?:mods|resourcepacks|datapacks|shaderpacks)\/[^/]+\.(?:jar|zip)(?:\.disabled)?$/i;

function isProjectPath(name) {
  return PROJECT_PATH_RE.test(String(name || "").replace(/\\/g, "/"));
}

function packPath(name) {
  return String(name || "").replace(/\\/g, "/").replace(/^overrides\//, "");
}

const DEFAULT_CHECKED_FOLDERS = new Set([
  "mods", "resourcepacks", "datapacks", "shaderpacks", "config", "defaultconfigs", "kubejs", "scripts",
]);

function topFolder(path) {
  return String(path || "").split("/")[0].toLowerCase();
}

function insertTreeNode(root, path, meta) {
  const parts = String(path || "").split("/").filter(Boolean);
  let node = root;
  for (let index = 0; index < parts.length; index += 1) {
    const last = index === parts.length - 1;
    const name = parts[index];
    let child = node.children.find((item) => item.name === name && (last ? item.type === "file" : item.type === "folder"));
    if (!child) {
      child = last
        ? { type: "file", name, path, children: [] }
        : { type: "folder", name, path: parts.slice(0, index + 1).join("/"), children: [] };
      node.children.push(child);
    }
    if (last) Object.assign(child, meta);
    node = child;
  }
}

function decorateTree(nodes) {
  for (const node of nodes) {
    if (node.type === "folder") {
      decorateTree(node.children);
      node.size = node.children.reduce((sum, child) => sum + (child.size || 0), 0);
      node.count = node.children.reduce((sum, child) => sum + (child.count || (child.type === "file" ? 1 : 0)), 0);
      node.selectable = node.children.some((child) => child.selectable || (child.type === "folder" && child.selectable));
      node.defaultChecked = Boolean(node.selectable && node.children.some((child) => child.defaultChecked));
    }
  }
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
}

function buildPackTree(listing, indexFiles, projectPaths, { limit = 3000 } = {}) {
  const files = new Map();
  for (const file of indexFiles) {
    const path = String(file.path || "").replace(/\\/g, "/");
    if (!path) continue;
    files.set(path, {
      path,
      size: Number(file.fileSize) || 0,
      modified_at: null,
      indexed: true,
    });
  }
  for (const entry of listing) {
    if (entry.name === "modrinth.index.json" || !entry.name.startsWith("overrides/")) continue;
    const path = packPath(entry.name);
    if (!path) continue;
    if (files.has(path) && files.get(path).indexed) continue;
    files.set(path, {
      path,
      size: entry.size || 0,
      modified_at: entry.modified_at || null,
      indexed: false,
    });
  }

  let items = [...files.values()];
  const knownProjects = new Set(projectPaths);
  for (const item of items) {
    item.project = knownProjects.has(item.path) || knownProjects.has(`overrides/${item.path}`);
    item.kind = kindFromPackPath(item.path);
  }
  let truncated = false;
  if (items.length > limit) {
    const projects = items.filter((item) => item.project);
    const rest = items.filter((item) => !item.project).slice(0, Math.max(0, limit - projects.length));
    items = [...projects, ...rest];
    truncated = true;
  }

  const root = { children: [] };
  for (const item of items) {
    const selectable = !item.project;
    insertTreeNode(root, item.path, {
      project: Boolean(item.project),
      selectable,
      indexed: Boolean(item.indexed),
      kind: item.kind || "",
      size: item.size || 0,
      modified_at: item.modified_at || null,
      defaultChecked: selectable && DEFAULT_CHECKED_FOLDERS.has(topFolder(item.path)) && !["saves", "screenshots", "logs", "crash-reports", "backups"].includes(topFolder(item.path)),
    });
  }
  decorateTree(root.children);
  return { tree: root.children, truncated, files: items };
}

function allSelectablePaths(nodes, out = []) {
  for (const node of nodes) {
    if (node.type === "folder") allSelectablePaths(node.children, out);
    else if (node.selectable) out.push(node.path);
  }
  return out;
}

export async function parseMrpack(filePath, originalName, { onProgress } = {}) {
  const report = (event) => { try { onProgress?.(event); } catch {} };
  report({ stage: "read-index", message: "Reading the pack index and file list", percent: 8 });
  const wanted = (name) => isProjectPath(name);
  const { found: entries, listing } = await readZipEntries(filePath, wanted);
  const indexEntry = entries.get("modrinth.index.json");
  if (!indexEntry) throw new Error("This zip has no modrinth.index.json, so it is not a .mrpack");

  let index;
  try {
    index = JSON.parse(indexEntry.buffer.toString("utf8"));
  } catch {
    throw new Error("modrinth.index.json is not valid JSON");
  }

  const deps = index.dependencies || {};
  const mcVersion = String(deps.minecraft || "");
  const { loader, version: loaderVersion } = jwtLoader(deps);
  const packName = String(index.name || "").trim() || originalName.replace(/\.mrpack$/i, "");
  const packVersion = String(index.versionId || "");

  const fileEntries = Array.isArray(index.files) ? index.files : [];
  const projectEntries = fileEntries.filter((file) => isProjectPath(file.path || ""));
  const skipped = fileEntries.length - projectEntries.length;

  report({ stage: "hash", message: `Hashing ${projectEntries.length} index file${projectEntries.length === 1 ? "" : "s"} and overrides`, percent: 22 });
  const overrideJars = [...entries.entries()]
    .filter(([name]) => name !== "modrinth.index.json" && isProjectPath(name))
    .map(([name, value]) => {
      const entry = path.basename(name);
      const disabled = /\.disabled$/i.test(entry);
      const packName = packPath(name);
      return {
        entry,
        path: packName,
        name: disabled ? entry.replace(/\.disabled$/i, "") : entry,
        disabled,
        kind: kindFromPackPath(packName),
        buffer: value.buffer,
        ...hashBuffers(value.buffer),
      };
    });

  const hashes = new Map();
  for (const file of projectEntries) {
    const sha1 = file.hashes?.sha1;
    if (sha1) hashes.set(sha1, { file });
  }
  for (const jar of overrideJars) hashes.set(jar.sha1, { jar });

  report({ stage: "match", message: `Matching ${hashes.size} hash${hashes.size === 1 ? "" : "es"} on Modrinth`, percent: 42 });
  let hashLookup = new Map();
  try {
    hashLookup = await lookupByHash([...hashes.keys()]);
  } catch (err) {
    console.error("mrpack hash lookup:", err.message);
  }

  const projectIds = [...new Set([...hashLookup.values()].map((value) => value.project_id).filter(Boolean))];
  const projects = projectIds.length ? await getProjects(projectIds).catch(() => new Map()) : new Map();

  const identified = [];
  const unknown = [];
  const seenProjects = new Set();

  // The folder in the pack decides where the file will be installed; the
  // Modrinth project type is only a fallback (Modrinth calls datapacks "mod").
  const projectKind = (project, packFile) =>
    kindFromPackPath(packFile) || kindFromProjectType(project?.project_type) || "mod";

  for (const file of projectEntries) {
    const sha1 = file.hashes?.sha1 || "";
    const version = hashLookup.get(sha1);
    const pathKind = kindFromPackPath(file.path);
    if (version) {
      const project = projects.get(version.project_id);
      const key = `${version.project_id}`;
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      const kind = projectKind(project, file.path);
      identified.push({
        source: "modrinth",
        project_id: version.project_id,
        kind,
        name: project?.title || version.name || file.path,
        project_url: `https://modrinth.com/${kindFolder(kind)}/${project?.slug || version.project_id}`,
        installed_version: version.version,
        installed_version_id: version.version_id,
        published_at: version.published_at,
        file_name: file.path.split("/").pop() || "",
        file_sha1: sha1,
        file_sha512: file.hashes?.sha512 || null,
        file_size: file.fileSize || null,
        side: envSide(file.env),
        icon_url: project?.icon_url || null,
        download_url: file.downloads?.[0] || "",
        disabled: false,
      });
    } else {
      unknown.push({
        kind: pathKind || "mod",
        file_name: file.path.split("/").pop() || file.path,
        file_sha1: sha1,
        file_sha512: file.hashes?.sha512 || null,
        file_size: file.fileSize || null,
        jar_mod_id: "",
        jar_name: "",
        jar_version: "",
        jar_loaders: [],
        reason: "no_match",
      });
    }
  }

  for (const jar of overrideJars) {
    const version = hashLookup.get(jar.sha1);
    if (version) {
      const project = projects.get(version.project_id);
      if (!seenProjects.has(version.project_id)) {
        seenProjects.add(version.project_id);
        const kind = projectKind(project, jar.path);
        identified.push({
          source: "modrinth",
          project_id: version.project_id,
          kind,
          name: project?.title || version.name || jar.name,
          project_url: `https://modrinth.com/${kindFolder(kind)}/${project?.slug || version.project_id}`,
          installed_version: version.version,
          installed_version_id: version.version_id,
          published_at: version.published_at,
          file_name: jar.name,
          file_sha1: jar.sha1,
          file_sha512: jar.sha512,
          file_size: jar.buffer.length,
          side: "both",
          icon_url: project?.icon_url || null,
          download_url: "",
          disabled: jar.disabled,
          jar_entry: jar.entry,
          jar_path: jar.path,
        });
        continue;
      }
    }
    const meta = await readJarMetadata(jar.buffer).catch(() => null);
    unknown.push({
      kind: jar.kind || "mod",
      file_name: jar.name,
      jar_entry: jar.entry,
      jar_path: jar.path,
      file_sha1: jar.sha1,
      file_sha512: jar.sha512,
      file_size: jar.buffer.length,
      jar_mod_id: meta?.id || "",
      jar_name: meta?.name || "",
      jar_version: meta?.version || "",
      jar_loaders: meta?.loaders || [],
      reason: "no_match",
    });
  }

  const projectPaths = new Set();
  for (const file of projectEntries) projectPaths.add(String(file.path || "").replace(/\\/g, "/"));
  for (const item of [...identified, ...unknown]) {
    if (item.jar_path) projectPaths.add(`overrides/${item.jar_path}`);
    else if (item.jar_entry) projectPaths.add(`overrides/${item.jar_entry}`);
  }

  report({ stage: "tree", message: "Building the folder tree", percent: 82 });
  const { tree, truncated, files: treeFiles } = buildPackTree(listing, fileEntries, projectPaths);
  const selectableCount = allSelectablePaths(tree).length;
  const folders = new Set(treeFiles.map((item) => topFolder(item.path)).filter(Boolean));

  report({ stage: "done", message: `Preview ready: ${identified.length} tracked, ${unknown.length} to resolve`, percent: 100 });

  return {
    file_name: originalName,
    file_path: filePath,
    pack: {
      name: packName,
      version: packVersion,
      mc_version: mcVersion,
      loader,
      loader_version: loaderVersion,
      summary: index.summary || "",
    },
    counts: {
      projects: identified.length + unknown.length,
      mods: identified.length + unknown.length,
      identified: identified.length,
      unknown: unknown.length,
      files: selectableCount,
      skipped,
    },
    identified,
    unknown,
    tree,
    tree_truncated: truncated,
    index_file_count: fileEntries.length,
  };
}

export async function hashOverrideFiles(filePath, { maxFile = 50 * 1024 * 1024, maxTotal = 512 * 1024 * 1024 } = {}) {
  const zip = await openZip(filePath);
  const files = new Map();
  let total = 0;
  await new Promise((resolve, reject) => {
    zip.on("entry", (entry) => {
      const name = String(entry.fileName || "").replace(/\\/g, "/");
      if (entry.fileName === "modrinth.index.json" || !name.startsWith("overrides/") || isProjectPath(name)) {
        zip.readEntry();
        return;
      }
      const size = entry.uncompressedSize || 0;
      if (size > maxFile || total + size > maxTotal) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (err, stream) => {
        if (err) {
          try { zip.close(); } catch {}
          reject(err);
          return;
        }
        const hash = crypto.createHash("sha1");
        let length = 0;
        stream.on("data", (chunk) => {
          length += chunk.length;
          hash.update(chunk);
        });
        stream.on("error", reject);
        stream.on("end", () => {
          files.set(packPath(name), {
            sha1: hash.digest("hex"),
            size: length,
            modified_at: entryModified(entry),
          });
          total += length;
          zip.readEntry();
        });
      });
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return files;
}

export async function savePreview(preview, { uploadedBy = null } = {}) {
  const token = crypto.randomUUID();
  const dir = path.join(process.cwd(), "uploads", "tmp");
  await fs.promises.mkdir(dir, { recursive: true });
  const meta = { ...preview, token, uploaded_by: uploadedBy, created_at: new Date().toISOString() };
  await fs.promises.writeFile(path.join(dir, `${token}.json`), JSON.stringify(meta));
  return token;
}

export async function loadPreview(token) {
  if (!/^[a-f0-9-]{36}$/.test(String(token))) return null;
  const file = path.join(process.cwd(), "uploads", "tmp", `${token}.json`);
  try {
    const meta = JSON.parse(await fs.promises.readFile(file, "utf8"));
    if (!meta.file_path || !fs.existsSync(meta.file_path)) return null;
    return meta;
  } catch {
    return null;
  }
}

export function applyTreeSelection(tree, selectedFiles) {
  const selected = new Set((selectedFiles || []).map((value) => String(value)));
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === "folder") walk(node.children);
      else if (node.selectable) node.defaultChecked = selected.has(node.path);
    }
  };
  walk(tree);
  return tree;
}

export async function discardPreview(token) {
  const preview = await loadPreview(token);
  if (!preview) return;
  await fs.promises.rm(path.join(process.cwd(), "uploads", "tmp", `${token}.json`), { force: true });
  await fs.promises.rm(preview.file_path, { force: true });
}

async function uniqueInstanceName(client, base) {
  let name = base;
  let n = 2;
  while (true) {
    const { rows } = await client.query("SELECT 1 FROM instances WHERE name = $1", [name]);
    if (!rows.length) return name;
    name = `${base} (${n})`;
    n += 1;
  }
}

export async function createInstanceFromPreview(preview, {
  userId,
  mode = "new",
  existingId = null,
  selectedFiles = [],
  onProgress = null,
} = {}) {
  const report = (event) => { try { onProgress?.(event); } catch {} };
  return withTransaction(async (client) => {
    report({ stage: "instance", message: "Creating the instance", percent: 10 });
    let instance;
    if (mode === "update" && existingId) {
      const found = await client.query("SELECT * FROM instances WHERE id = $1", [existingId]);
      if (!found.rows.length) throw new Error("The instance to update no longer exists");
      instance = found.rows[0];
      await client.query(
        `UPDATE instances SET pack_name = $1, pack_version = $2, mc_version = $3, loader = $4,
           loader_version = $5 WHERE id = $6`,
        [preview.pack.name, preview.pack.version, preview.pack.mc_version, preview.pack.loader, preview.pack.loader_version, instance.id]
      );
    } else {
      const name = await uniqueInstanceName(client, preview.pack.name || "Imported instance");
      const { rows } = await client.query(
        `INSERT INTO instances (name, mc_version, loader, loader_version, pack_name, pack_version, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          name,
          preview.pack.mc_version || "unknown",
          preview.pack.loader || "forge",
          preview.pack.loader_version || "",
          preview.pack.name,
          preview.pack.version,
          userId,
        ]
      );
      instance = rows[0];
    }

    const { rows: importRows } = await client.query(
      `INSERT INTO imports (instance_id, user_id, file_name, pack_name, pack_version, mc_version, loader, loader_version, counts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
      [
        instance.id,
        userId,
        preview.file_name,
        preview.pack.name,
        preview.pack.version,
        preview.pack.mc_version,
        preview.pack.loader,
        preview.pack.loader_version,
        JSON.stringify(preview.counts),
      ]
    );
    const importId = importRows[0].id;

    report({ stage: "projects", message: "Writing tracked projects", percent: 25 });
    // Override project files are the only bytes present in the uploaded .mrpack.
    // Keep them so a disabled/manual file can be exported later without reupload.
    const overrideMap = new Map();
    try {
      const { found: jarEntries } = await readZipEntries(preview.file_path, (name) => isProjectPath(name));
      for (const [name, value] of jarEntries) {
        if (name === "modrinth.index.json") continue;
        const relative = packPath(name);
        overrideMap.set(relative, value.buffer);
        if (!overrideMap.has(path.basename(relative))) overrideMap.set(path.basename(relative), value.buffer);
      }
    } catch (err) {
      console.error("import override files:", err.message);
    }

    const channel = (await client.query("SELECT value FROM settings WHERE key = 'default_channel_policy'")).rows[0]?.value || "release";
    const seen = new Set();
    let added = 0;
    const totalProjects = preview.identified.length + preview.unknown.length;
    let writtenProjects = 0;
    for (const mod of preview.identified) {
      if (!mod.project_id || seen.has(mod.project_id)) continue;
      seen.add(mod.project_id);
      const kind = mod.kind || "mod";
      const { rows } = await client.query(
        `INSERT INTO mods (instance_id, name, side, source, kind, project_id, project_url, installed_version,
            installed_version_id, file_name, file_sha1, file_sha512, file_size, icon_url, download_url,
            channel_policy, status, latest_version, latest_version_id, latest_published_at, added_by, disabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'up_to_date',$8,$9,$17,$18,$19)
         ON CONFLICT (instance_id, source, project_id) WHERE project_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          instance.id, mod.name, mod.side || "both", mod.source, kind, mod.project_id, mod.project_url,
          mod.installed_version, mod.installed_version_id, mod.file_name, mod.file_sha1,
          mod.file_sha512, mod.file_size, mod.icon_url || null, mod.download_url || null,
          channel, mod.published_at, userId, Boolean(mod.disabled),
        ]
      );
      if (rows.length) {
        added += 1;
        writtenProjects += 1;
        const jar = mod.jar_path ? overrideMap.get(mod.jar_path) : mod.jar_entry ? overrideMap.get(mod.jar_entry) : null;
        if (jar) {
          const stored = await saveJar(instance.id, storedProjectName(mod.kind, mod.file_name, mod.disabled), jar);
          await client.query(
            "UPDATE mods SET stored_path = $2, stored_version_id = installed_version_id WHERE id = $1",
            [rows[0].id, stored]
          );
        }
        if (mod.installed_version_id) {
          await client.query(
            `INSERT INTO mod_versions_cache (mod_id, version_id, version_string, channel, mc_versions, loaders, published_at, changelog_url, download_page_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (mod_id, version_id) DO NOTHING`,
            [
              rows[0].id, mod.installed_version_id, mod.installed_version, "release",
              [preview.pack.mc_version], [preview.pack.loader], mod.published_at,
              `https://modrinth.com/version/${mod.installed_version_id}`,
              `https://modrinth.com/project/${mod.project_id}/versions`,
            ]
          );
        }
      }
      if (writtenProjects && writtenProjects % 10 === 0 && totalProjects) {
        report({
          stage: "projects",
          message: `Wrote ${writtenProjects} of ${totalProjects} projects`,
          percent: 25 + Math.round((writtenProjects / totalProjects) * 30),
        });
      }
    }

    let unknownAdded = 0;
    for (const item of preview.unknown) {
      const { rows } = await client.query(
        `INSERT INTO unknown_mods (instance_id, import_id, file_name, file_sha1, file_sha512, file_size,
            kind, jar_mod_id, jar_name, jar_version, jar_loaders, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (instance_id, file_sha1) DO NOTHING RETURNING id`,
        [
          instance.id, importId, item.file_name, item.file_sha1, item.file_sha512, item.file_size,
          item.kind || "mod", item.jar_mod_id || null, item.jar_name || null, item.jar_version || null,
          item.jar_loaders || [], item.reason || "no_match",
        ]
      );
      if (rows.length) {
        unknownAdded += 1;
        const jar = item.jar_path ? overrideMap.get(item.jar_path) : item.jar_entry ? overrideMap.get(item.jar_entry) : null;
        if (jar) {
          const stored = await saveJar(instance.id, storedProjectName(item.kind, item.file_name), jar);
          await client.query("UPDATE unknown_mods SET stored_path = $2 WHERE id = $1", [rows[0].id, stored]);
        }
      }
    }

    report({ stage: "files", message: "Storing the selected pack files", percent: 65 });
    const allowed = new Set(allSelectablePaths(preview.tree || []));
    const wanted = [...new Set(selectedFiles.map((value) => String(value || "").trim()).filter(Boolean))]
      .filter((value) => allowed.has(value));
    let filesAdded = 0;
    let storedBytes = 0;
    if (wanted.length) {
      const wantedEntries = new Set(wanted.map((value) => `overrides/${value}`));
      try {
        const { found: picked } = await readZipEntries(preview.file_path, (name) => wantedEntries.has(name));
        for (const relative of wanted) {
          const entryName = `overrides/${relative}`;
          const value = picked.get(entryName);
          if (!value || !value.buffer) continue;
          if (value.buffer.length > 50 * 1024 * 1024) continue;
          if (storedBytes + value.buffer.length > 512 * 1024 * 1024) {
            report({ stage: "files", message: "File budget reached; remaining files were skipped", percent: 92 });
            break;
          }
          const hashes = hashBuffers(value.buffer);
          const stored = await saveInstanceFile(instance.id, relative, value.buffer);
          const folder = topFolder(relative);
          await client.query(
            `INSERT INTO instance_files (instance_id, import_id, path, folder, file_name, file_size, file_sha1, stored_path, modified_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (instance_id, path) DO NOTHING`,
            [
              instance.id, importId, relative, folder, path.basename(relative),
              value.buffer.length, hashes.sha1, stored, entryModified(value.entry),
            ]
          );
          storedBytes += value.buffer.length;
          filesAdded += 1;
          if (filesAdded % 25 === 0) {
            report({
              stage: "files",
              message: `Stored ${filesAdded} of ${wanted.length} pack files`,
              percent: 65 + Math.round((filesAdded / Math.max(1, wanted.length)) * 25),
            });
          }
        }
      } catch (err) {
        console.error("import instance files:", err.message);
        report({ stage: "files", message: `Some pack files could not be stored: ${err.message}`, percent: 92 });
      }
    }

    await logActivity({
      userId,
      action: "import",
      subjectType: "instance",
      subjectId: instance.id,
      meta: { file: preview.file_name, counts: preview.counts, added, unknownAdded, filesAdded },
    });

    report({ stage: "done", message: `${added} projects, ${unknownAdded} to resolve, ${filesAdded} files stored`, percent: 100 });
    return { instance, importId, added, unknownAdded, filesAdded };
  });
}

export async function cleanupPreviews(maxAgeHours = 24) {
  const dir = path.join(process.cwd(), "uploads", "tmp");
  try {
    const files = await fs.promises.readdir(dir);
    for (const file of files) {
      const full = path.join(dir, file);
      const stat = await fs.promises.stat(full);
      if (Date.now() - stat.mtimeMs > maxAgeHours * 3_600_000) await fs.promises.rm(full, { force: true });
    }
  } catch {}
}
