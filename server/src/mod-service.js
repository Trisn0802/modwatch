import { query } from "./db.js";
import { kindExtension, normalizeKind } from "./kinds.js";

export const VALID_SOURCES = ["modrinth", "curseforge", "github", "hangar", "spigot", "manual"];

export async function insertMod(instanceId, payload, userId, client = null) {
  const source = VALID_SOURCES.includes(payload.source) ? payload.source : "manual";
  const kind = normalizeKind(payload.kind);
  const extension = kindExtension(kind);
  const rawFile = String(payload.file_name || "").trim();
  const fileName = rawFile
    ? `${rawFile.replace(/\.(?:jar|zip)(?:\.disabled)?$/i, "")}${extension}`
    : "";
  const status = source === "manual" || payload.status === "manual" ? "manual" : "up_to_date";
  const installed = String(payload.installed_version || "").trim() || "unknown version";
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `INSERT INTO mods (instance_id, name, side, source, kind, project_id, project_url, github_asset_pattern,
        installed_version, installed_version_id, file_name, file_sha1, file_sha512, file_size,
        icon_url, download_url, channel_policy, status, latest_version, latest_version_id,
        latest_published_at, added_by, creator_name, creator_url, creator_avatar_url)
     VALUES ($1,$2,$3,$4,$20,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$8,$9,$18,$19,$21,$22,$23)
     RETURNING id`,
    [
      instanceId,
      String(payload.name || "").trim() || "Unnamed mod",
      ["both", "client", "server"].includes(payload.side) ? payload.side : "both",
      source,
      payload.project_id || null,
      payload.project_url || "",
      payload.github_asset_pattern || "",
      installed,
      payload.installed_version_id || null,
      fileName,
      payload.file_sha1 || null,
      payload.file_sha512 || null,
      payload.file_size || null,
      payload.icon_url || null,
      payload.download_url || null,
      ["release", "beta", "alpha"].includes(payload.channel_policy) ? payload.channel_policy : "release",
      status,
      payload.published_at || null,
      userId,
      kind,
      payload.creator_name || "",
      payload.creator_url || "",
      payload.creator_avatar_url || null,
    ]
  );
  return rows[0].id;
}

export async function cacheInstalledVersion(modId, payload, instance) {
  if (!payload.installed_version_id) return;
  await query(
    `INSERT INTO mod_versions_cache (mod_id, version_id, version_string, channel, mc_versions, loaders, published_at, changelog_url, download_page_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (mod_id, version_id) DO NOTHING`,
    [
      modId,
      payload.installed_version_id,
      payload.installed_version || "",
      payload.channel || "release",
      payload.mc_versions || [instance.mc_version],
      payload.loaders || [instance.loader],
      payload.published_at || null,
      payload.changelog_url || "",
      payload.download_page_url || "",
    ]
  ).catch((err) => console.error("installed version cache:", err.message));
}

export async function markUpdated(mod) {
  await query(
    `UPDATE mods SET installed_version = latest_version, installed_version_id = latest_version_id,
        status = 'up_to_date', snoozed_version_id = NULL, last_checked_at = now()
      WHERE id = $1`,
    [mod.id]
  );
  if (mod.latest_version_id) {
    await query(
      `INSERT INTO mod_versions_cache (mod_id, version_id, version_string, channel, published_at, changelog_url, download_page_url)
       VALUES ($1,$2,$3,'release',$4,$5,$6)
       ON CONFLICT (mod_id, version_id) DO NOTHING`,
      [
        mod.id, mod.latest_version_id, mod.latest_version, mod.latest_published_at || null,
        `https://modrinth.com/version/${mod.latest_version_id}`,
        `https://modrinth.com/project/${mod.project_id}/versions`,
      ]
    ).catch(() => {});
  }
  await query(
    "UPDATE notifications SET read_at = now() WHERE mod_id = $1 AND kind = 'update' AND read_at IS NULL",
    [mod.id]
  ).catch(() => {});
}
