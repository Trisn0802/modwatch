import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import sharp from "sharp";

import { query } from "./db.js";
import { initials } from "./helpers.js";
import { uploadsRoot } from "./uploads.js";
import { USER_AGENT } from "./sources/http.js";

const cacheDir = path.join(process.cwd(), "uploads", "og");
const iconCacheDir = path.join(cacheDir, "icons");
const ICON_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const ICON_MAX_BYTES = 2 * 1024 * 1024;
const OG_LAYOUT_VERSION = "3";
const ICON_HOSTS = new Set([
  "cdn.modrinth.com",
  "avatars.githubusercontent.com",
  "media.forgecdn.net",
  "mediafilez.forgecdn.net",
  "edge.forgecdn.net",
]);
const LOADER_LABEL = { forge: "Forge", fabric: "Fabric", neoforge: "NeoForge", quilt: "Quilt", plugin: "Plugin" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[c]);
}

function clip(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, Math.max(0, length - 1))}…` : text;
}

function allowedIconUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ICON_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function readIconCache(key) {
  const file = path.join(iconCacheDir, `icon-${key}.png`);
  try {
    const stat = await fs.promises.stat(file);
    if (Date.now() - stat.mtimeMs > ICON_CACHE_TTL) return null;
    return `data:image/png;base64,${(await fs.promises.readFile(file)).toString("base64")}`;
  } catch {
    return null;
  }
}

async function iconDataUri(value) {
  const source = String(value || "").trim();
  if (!source) return null;
  const key = crypto.createHash("sha1").update(source).digest("hex");
  const cached = await readIconCache(key);
  if (cached) return cached;

  try {
    let input;
    if (source.startsWith("/uploads/") || source.startsWith("uploads/")) {
      const relative = source.replace(/^\/?uploads\//, "");
      const file = path.join(uploadsRoot, relative);
      if (!file.startsWith(uploadsRoot)) return null;
      input = await fs.promises.readFile(file);
    } else {
      if (!allowedIconUrl(source)) return null;
      const response = await fetch(source, {
        headers: { "user-agent": USER_AGENT, accept: "image/*" },
        redirect: "follow",
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok || !allowedIconUrl(response.url)) return null;
      const type = response.headers.get("content-type") || "";
      if (!/^image\/(png|jpe?g|webp|gif|avif)/i.test(type)) return null;
      const length = Number(response.headers.get("content-length") || 0);
      if (length > ICON_MAX_BYTES) return null;
      input = Buffer.from(await response.arrayBuffer());
      if (input.length > ICON_MAX_BYTES) return null;
    }

    const normalized = await sharp(input)
      .resize(88, 88, { fit: "cover", position: "centre" })
      .png({ compressionLevel: 9 })
      .toBuffer();
    fs.mkdirSync(iconCacheDir, { recursive: true });
    await fs.promises.writeFile(path.join(iconCacheDir, `icon-${key}.png`), normalized);
    return `data:image/png;base64,${normalized.toString("base64")}`;
  } catch {
    return null;
  }
}

async function loadModIcons(rows) {
  const entries = await Promise.all(rows.map(async (row) => [row.id, await iconDataUri(row.icon_url)]));
  return new Map(entries);
}

export async function shareOverview(instance) {
  const [{ rows: stats }, { rows: updates }, { rows: items }, { rows: mods }] = await Promise.all([
    query(
      `SELECT count(*)::int AS mods,
              count(*) FILTER (WHERE status = 'update_available')::int AS updates,
              count(*) FILTER (WHERE disabled)::int AS disabled
         FROM mods WHERE instance_id = $1 AND status <> 'ignored'`,
      [instance.id]
    ),
    query(
      `SELECT id, name, kind, installed_version, latest_version, icon_url, source, project_id, side,
              status, disabled, frozen_at, snoozed_version_id, creator_name, creator_url, creator_avatar_url
         FROM mods WHERE instance_id = $1 AND status = 'update_available'
        ORDER BY name LIMIT 5`,
      [instance.id]
    ),
    query(
      `SELECT id, name, kind, installed_version, latest_version, icon_url, source, project_id, side,
              status, disabled, frozen_at, snoozed_version_id, creator_name, creator_url, creator_avatar_url
         FROM mods WHERE instance_id = $1 AND status <> 'ignored'
        ORDER BY (status = 'update_available') DESC, name LIMIT 4`,
      [instance.id]
    ),
    query(
      `SELECT id, name, kind, installed_version, latest_version, icon_url, source, project_id, side,
              status, disabled, frozen_at, snoozed_version_id, file_name,
              creator_name, creator_url, creator_avatar_url
         FROM mods WHERE instance_id = $1 AND status <> 'ignored'
        ORDER BY kind, name`,
      [instance.id]
    ),
  ]);
  const kindCounts = {};
  const sourceCounts = {};
  for (const row of mods) {
    kindCounts[row.kind] = (kindCounts[row.kind] || 0) + 1;
    sourceCounts[row.source] = (sourceCounts[row.source] || 0) + 1;
  }
  return { stats: stats[0], updates, items, mods, kindCounts, sourceCounts };
}

export function shareSvg(instance, overview, icons = new Map()) {
  const { stats, items } = overview;
  const rows = items.slice(0, 4);
  const rowHeight = 78;
  const panelTop = 104;
  const iconClips = rows.map((row, index) => {
    const y = panelTop + 106 + index * rowHeight;
    return `<clipPath id="modClip${index}"><rect x="744" y="${y - 24}" width="44" height="44" rx="10"/></clipPath>`;
  }).join("");
  const rowsSvg = rows.length
    ? rows.map((row, index) => {
        const y = panelTop + 106 + index * rowHeight;
        const isUpdate = row.status === "update_available";
        const icon = icons.get(row.id);
        const versionLine = isUpdate
          ? `${clip(row.installed_version, 18)}  →  ${clip(row.latest_version, 18)}`
          : `${clip(row.installed_version, 26)} · latest`;
        const art = icon
          ? `<g clip-path="url(#modClip${index})">
              <rect x="744" y="${y - 24}" width="44" height="44" fill="#17171c"/>
              <image href="${icon}" x="744" y="${y - 24}" width="44" height="44" preserveAspectRatio="xMidYMid slice"/>
            </g>
            <rect x="744" y="${y - 24}" width="44" height="44" rx="10" fill="none" stroke="#25262b"/>`
          : `<g>
              <rect x="744" y="${y - 24}" width="44" height="44" rx="10" fill="${isUpdate ? "#10251a" : "#17171c"}"/>
              <text x="766" y="${y + 4}" text-anchor="middle" font-size="15" font-weight="700" fill="${isUpdate ? "#1bd96a" : "#96a2b0"}">${esc(initials(row.name))}</text>
            </g>`;
        return `
          ${art}
          <text x="808" y="${y - 6}" font-size="21" font-weight="600" fill="#ffffff">${esc(clip(row.name, 16))}</text>
          <text x="808" y="${y + 20}" font-size="15" fill="#96a2b0">${esc(versionLine)}</text>
          <rect x="1016" y="${y - 21}" width="96" height="30" rx="15" fill="${isUpdate ? "#1bd96a" : "#1c1d22"}"/>
          <text x="1064" y="${y - 1}" text-anchor="middle" font-size="13" font-weight="700" fill="${isUpdate ? "#05140b" : "#96a2b0"}">${isUpdate ? "Update" : "Latest"}</text>`;
      }).join("")
    : `<text x="744" y="${panelTop + 152}" font-size="20" fill="#96a2b0">No tracked projects yet.</text>`;

  const updateLabel = stats.updates === 1 ? "1 update" : `${stats.updates} updates`;
  const loaderName = LOADER_LABEL[instance.loader] || instance.loader;
  let artHref = "";
  if (instance.image_path) {
    const file = path.join(uploadsRoot, instance.image_path);
    try {
      const ext = path.extname(file).toLowerCase();
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      artHref = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
    } catch {}
  }
  const art = artHref
    ? `<image href="${artHref}" x="704" y="94" width="54" height="54" clip-path="url(#instanceArt)"/>`
    : `<rect x="704" y="94" width="54" height="54" rx="12" fill="#10251a"/><text x="731" y="129" text-anchor="middle" font-size="16" font-weight="700" fill="#1bd96a">${esc(initials(instance.name))}</text>`;
  const headline = stats.updates ? "Updates waiting." : "All up to date.";
  const subline = stats.updates
    ? `${instance.pack_name || instance.name} · ${instance.pack_version || "pack"}`
    : `${instance.pack_name || instance.name} is fully up to date.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <defs>
      ${iconClips}
      <clipPath id="panelClip"><rect x="672" y="72" width="456" height="486" rx="20"/></clipPath>
      <clipPath id="instanceArt"><rect x="704" y="94" width="54" height="54" rx="12"/></clipPath>
    </defs>
    <rect width="1200" height="630" fill="#000000"/>
    <g transform="translate(72,64)">
      <rect width="72" height="72" rx="18" fill="#101013" stroke="#25262b" stroke-width="1.5"/>
      <polygon points="36,14 58,26 58,50 36,62 14,50 14,26" fill="#1bd96a"/>
      <polyline points="14,26 36,39 58,26" fill="none" stroke="#05140b" stroke-width="2.5" stroke-linejoin="round"/>
      <line x1="36" y1="39" x2="36" y2="61" stroke="#05140b" stroke-width="2.5"/>
    </g>
    <text x="162" y="112" font-family="DejaVu Sans, Inter, sans-serif" font-size="30" font-weight="700" fill="#ffffff">ModWatch</text>
    <text x="72" y="238" font-family="DejaVu Sans, Inter, sans-serif" font-size="56" font-weight="700" fill="#ffffff">${esc(clip(headline, 20))}</text>
    <text x="72" y="308" font-family="DejaVu Sans, Inter, sans-serif" font-size="56" font-weight="700" fill="#1bd96a">${esc(clip(instance.name, 18))}</text>
    <text x="72" y="360" font-family="DejaVu Sans, Inter, sans-serif" font-size="22" fill="#b0bac5">${esc(clip(subline, 52))}</text>
    <g font-family="DejaVu Sans, Inter, sans-serif">
      <rect x="72" y="414" width="148" height="42" rx="21" fill="#17171c" stroke="#25262b"/>
      <text x="146" y="441" text-anchor="middle" font-size="15" fill="#d7dee6">Minecraft ${esc(instance.mc_version)}</text>
      <rect x="232" y="414" width="148" height="42" rx="21" fill="#17171c" stroke="#25262b"/>
      <text x="306" y="441" text-anchor="middle" font-size="15" fill="#d7dee6">${esc(loaderName)} ${esc(clip(instance.loader_version, 8))}</text>
      <rect x="392" y="414" width="148" height="42" rx="21" fill="#17171c" stroke="#25262b"/>
      <text x="466" y="441" text-anchor="middle" font-size="15" fill="#d7dee6">${stats.mods} projects</text>
    </g>
    <g clip-path="url(#panelClip)">
      <rect x="672" y="72" width="456" height="486" rx="20" fill="#101013" stroke="#25262b"/>
      ${art}
      <text x="774" y="123" font-family="DejaVu Sans, Inter, sans-serif" font-size="24" font-weight="700" fill="#ffffff">${esc(clip(instance.pack_name || instance.name, 18))}</text>
      <text x="774" y="149" font-family="DejaVu Sans, Inter, sans-serif" font-size="14" fill="#96a2b0">${esc(loaderName)} ${esc(instance.mc_version)} · ${esc(instance.pack_version || "pack")}</text>
      <rect x="1006" y="94" width="86" height="32" rx="16" fill="#10251a"/>
      <text x="1049" y="116" text-anchor="middle" font-family="DejaVu Sans, Inter, sans-serif" font-size="13" font-weight="700" fill="#1bd96a">${esc(updateLabel)}</text>
      <line x1="672" y1="176" x2="1128" y2="176" stroke="#25262b"/>
      ${rowsSvg}
      <line x1="672" y1="500" x2="1128" y2="500" stroke="#25262b"/>
      <text x="704" y="532" font-family="DejaVu Sans, Inter, sans-serif" font-size="15" fill="#96a2b0">${stats.mods} tracked projects · ${stats.disabled} disabled · self-hosted</text>
    </g>
  </svg>`;
}

export function shareVersion(instance, overview) {
  const stamp = [
    OG_LAYOUT_VERSION,
    instance.id,
    instance.pack_name,
    instance.pack_version,
    instance.image_path,
    overview.stats.mods,
    overview.stats.updates,
    ...overview.items.map((row) => `${row.id}:${row.status}:${row.latest_version}:${row.icon_url}`),
  ].join("|");
  return crypto.createHash("sha1").update(stamp).digest("hex").slice(0, 10);
}

export async function shareImage(instance, overview) {
  const icons = await loadModIcons(overview.items.slice(0, 4));
  const svg = shareSvg(instance, overview, icons);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function writeShareImage(instance, overview) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `share-${instance.share_token}.png`);
  const buffer = await shareImage(instance, overview);
  await fs.promises.writeFile(file, buffer);
  return file;
}
