import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import yauzl from "yauzl";
import { parse as parseToml } from "smol-toml";

import { config } from "./config.js";
import { query, withTransaction } from "./db.js";
import { lookupByHash, getProjects } from "./sources/modrinth.js";
import { logActivity } from "./activity.js";
import { saveJar } from "./uploads.js";

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

function isJar(name) {
  return /\.jar$/i.test(name);
}

function safeEntryName(name) {
  const normalized = String(name).replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  return true;
}

async function readZipEntries(filePath, wanted) {
  const zip = await openZip(filePath);
  const found = new Map();
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
  return found;
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

function hashBuffers(buffer) {
  return {
    sha1: crypto.createHash("sha1").update(buffer).digest("hex"),
    sha512: crypto.createHash("sha512").update(buffer).digest("hex"),
  };
}

export async function parseMrpack(filePath, originalName) {
  const wanted = (name) => /^overrides\/mods\/[^/]+\.jar(?:\.disabled)?$/i.test(name);
  const entries = await readZipEntries(filePath, wanted);
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
  const modEntries = fileEntries.filter((f) => /^mods\/[^/]+\.jar$/i.test(f.path || ""));
  const skipped = fileEntries.length - modEntries.length;

  const overrideJars = [...entries.entries()]
    .filter(([name]) => /^overrides\/mods\/[^/]+\.jar(?:\.disabled)?$/i.test(name))
    .map(([name, value]) => {
      const entry = path.basename(name);
      const disabled = /\.disabled$/i.test(entry);
      return {
        entry,
        name: disabled ? entry.replace(/\.disabled$/i, "") : entry,
        disabled,
        buffer: value.buffer,
        ...hashBuffers(value.buffer),
      };
    });

  const hashes = new Map();
  for (const file of modEntries) {
    const sha1 = file.hashes?.sha1;
    if (sha1) hashes.set(sha1, { file });
  }
  for (const jar of overrideJars) hashes.set(jar.sha1, { jar });

  let hashLookup = new Map();
  try {
    hashLookup = await lookupByHash([...hashes.keys()]);
  } catch (err) {
    console.error("mrpack hash lookup:", err.message);
  }

  const projectIds = [...new Set([...hashLookup.values()].map((v) => v.project_id).filter(Boolean))];
  const projects = projectIds.length ? await getProjects(projectIds).catch(() => new Map()) : new Map();

  const identified = [];
  const unknown = [];
  const seenProjects = new Set();

  for (const file of modEntries) {
    const sha1 = file.hashes?.sha1 || "";
    const version = hashLookup.get(sha1);
    if (version) {
      const project = projects.get(version.project_id);
      const key = `${version.project_id}`;
      if (seenProjects.has(key)) continue;
      seenProjects.add(key);
      identified.push({
        source: "modrinth",
        project_id: version.project_id,
        name: project?.title || version.name || file.path,
        project_url: `https://modrinth.com/mod/${project?.slug || version.project_id}`,
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
        identified.push({
          source: "modrinth",
          project_id: version.project_id,
          name: project?.title || version.name || jar.name,
          project_url: `https://modrinth.com/mod/${project?.slug || version.project_id}`,
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
        });
        continue;
      }
    }
    const meta = await readJarMetadata(jar.buffer).catch(() => null);
    unknown.push({
      file_name: jar.name,
      jar_entry: jar.entry,
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
      mods: identified.length + unknown.length,
      identified: identified.length,
      unknown: unknown.length,
      skipped,
    },
    identified,
    unknown,
    index_file_count: fileEntries.length,
  };
}

export async function savePreview(preview) {
  const token = crypto.randomUUID();
  const dir = path.join(process.cwd(), "uploads", "tmp");
  await fs.promises.mkdir(dir, { recursive: true });
  const meta = { ...preview, token, created_at: new Date().toISOString() };
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

export async function createInstanceFromPreview(preview, { userId, mode = "new", existingId = null }) {
  return withTransaction(async (client) => {
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

    // Override jars are the only bytes present in the uploaded .mrpack. Keep
    // them so a disabled/manual file can be exported later without reupload.
    const overrideMap = new Map();
    try {
      const jarEntries = await readZipEntries(
        preview.file_path,
        (name) => /^overrides\/mods\/[^/]+\.jar(?:\.disabled)?$/i.test(name)
      );
      for (const [name, value] of jarEntries) overrideMap.set(path.basename(name), value.buffer);
    } catch (err) {
      console.error("import override jars:", err.message);
    }

    const channel = (await client.query("SELECT value FROM settings WHERE key = 'default_channel_policy'")).rows[0]?.value || "release";
    const seen = new Set();
    let added = 0;
    for (const mod of preview.identified) {
      if (!mod.project_id || seen.has(mod.project_id)) continue;
      seen.add(mod.project_id);
      const { rows } = await client.query(
        `INSERT INTO mods (instance_id, name, side, source, project_id, project_url, installed_version,
            installed_version_id, file_name, file_sha1, file_sha512, file_size, icon_url, download_url,
            channel_policy, status, latest_version, latest_version_id, latest_published_at, added_by, disabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'up_to_date',$7,$8,$16,$17,$18)
         ON CONFLICT (instance_id, source, project_id) WHERE project_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          instance.id, mod.name, mod.side || "both", mod.source, mod.project_id, mod.project_url,
          mod.installed_version, mod.installed_version_id, mod.file_name, mod.file_sha1,
          mod.file_sha512, mod.file_size, mod.icon_url || null, mod.download_url || null,
          channel, mod.published_at, userId, Boolean(mod.disabled),
        ]
      );
      if (rows.length) {
        added += 1;
        const jar = mod.jar_entry ? overrideMap.get(mod.jar_entry) : null;
        if (jar) {
          const stored = await saveJar(instance.id, mod.file_name, jar);
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
    }

    let unknownAdded = 0;
    for (const item of preview.unknown) {
      const { rows } = await client.query(
        `INSERT INTO unknown_mods (instance_id, import_id, file_name, file_sha1, file_sha512, file_size,
            jar_mod_id, jar_name, jar_version, jar_loaders, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (instance_id, file_sha1) DO NOTHING RETURNING id`,
        [
          instance.id, importId, item.file_name, item.file_sha1, item.file_sha512, item.file_size,
          item.jar_mod_id || null, item.jar_name || null, item.jar_version || null,
          item.jar_loaders || [], item.reason || "no_match",
        ]
      );
      if (rows.length) {
        unknownAdded += 1;
        const jar = item.jar_entry ? overrideMap.get(item.jar_entry) : null;
        if (jar) {
          const stored = await saveJar(instance.id, item.file_name, jar);
          await client.query("UPDATE unknown_mods SET stored_path = $2 WHERE id = $1", [rows[0].id, stored]);
        }
      }
    }

    await logActivity({
      userId,
      action: "import",
      subjectType: "instance",
      subjectId: instance.id,
      meta: { file: preview.file_name, counts: preview.counts, added, unknownAdded },
    });

    return { instance, importId, added, unknownAdded };
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
