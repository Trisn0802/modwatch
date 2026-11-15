import { config } from "../config.js";
import { cached, requestJson } from "./http.js";
import { kindFromCurseforgePath, normalizeKind } from "../kinds.js";

const API = "https://api.curseforge.com/v1";
const CFW = "https://api.cfwidget.com/minecraft";
const TTL = 10 * 60_000;
const GAME = 432;

const CF_PATH = {
  mod: "mc-mods",
  resourcepack: "texture-packs",
  datapack: "data-packs",
  shader: "shaders",
};
// CurseForge only exposes class ids for mods and resource packs in the
// official search endpoint; the other kinds are reachable by project URL.
const CLASS_ID = { mod: 6, resourcepack: 12 };

const loaderId = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const LOADER_NAME = {
  forge: "forge",
  fabric: "fabric",
  quilt: "quilt",
  neoforge: "neoforge",
};
const LOADER_LABEL = {
  forge: "Forge",
  fabric: "Fabric",
  quilt: "Quilt",
  neoforge: "NeoForge",
};

function headers() {
  return { "x-api-key": config.curseforgeApiKey, accept: "application/json" };
}

function normalizeSearch(hit, kind = "mod") {
  const type = normalizeKind(kind);
  const author = (hit.authors || [])[0] || {};
  return {
    source: "curseforge",
    project_id: String(hit.id),
    kind: type,
    name: hit.name,
    description: hit.summary,
    icon_url: hit.logo?.thumbnailUrl || hit.logo?.url || null,
    downloads: hit.downloadCount,
    project_url: hit.links?.websiteUrl || `https://www.curseforge.com/minecraft/${CF_PATH[type]}/${hit.slug}`,
    author: author.name || "",
    creator_name: author.name || "",
    creator_url: author.url || "",
    creator_avatar_url: null,
  };
}

function normalizeWidget(project, kind = "mod") {
  const type = normalizeKind(kind);
  const member = (project.members || [])[0] || {};
  return {
    source: "curseforge",
    project_id: String(project.id),
    kind: type,
    name: project.title,
    description: project.summary,
    icon_url: project.thumbnail || null,
    downloads: project.downloads?.total || null,
    project_url: project.urls?.curseforge || project.urls?.project || `https://www.curseforge.com/minecraft/${CF_PATH[type]}/${project.id}`,
    author: member.title || "",
    creator_name: member.title || "",
    creator_url: member.url || "",
    creator_avatar_url: null,
  };
}

async function widgetProject(projectIdOrSlug, kind = "mod") {
  const type = normalizeKind(kind);
  return cached(`cfw:project:${type}:${projectIdOrSlug}`, TTL, () =>
    requestJson(`${CFW}/${CF_PATH[type]}/${encodeURIComponent(projectIdOrSlug)}`, {
      headers: { accept: "application/json", "user-agent": "ModWatch/1.0" },
    })
  );
}

export async function searchProject(query, { mcVersion, loader, limit = 10, kind = "mod" } = {}) {
  if (!config.curseforgeReady) return [];
  const type = normalizeKind(kind);
  const classId = CLASS_ID[type];
  if (!classId) return [];
  const params = new URLSearchParams({
    gameId: String(GAME),
    classId: String(classId),
    searchFilter: query,
    sortField: "2",
    sortOrder: "desc",
    pageSize: String(limit),
  });
  if (mcVersion) params.set("gameVersion", mcVersion);
  if (type === "mod" && loaderId[loader]) params.set("modLoaderType", String(loaderId[loader]));
  const url = `${API}/mods/search?${params}`;
  const data = await cached(`cf:search:${url}`, TTL, () => requestJson(url, { headers: headers() }));
  return (data.data || []).map((hit) => normalizeSearch(hit, type));
}

export async function lookupByHash() {
  return new Map();
}

function normalizeFile(file, projectId) {
  return {
    source: "curseforge",
    project_id: String(projectId),
    version_id: String(file.id),
    version: file.displayName,
    name: file.displayName,
    channel: file.releaseType === 1 ? "release" : file.releaseType === 2 ? "beta" : "alpha",
    mc_versions: file.gameVersions || [],
    loaders: [],
    published_at: file.fileDate,
    changelog_url: "",
    download_page_url: `https://www.curseforge.com/minecraft/mc-mods/project/${projectId}/files`,
    download_url: "",
    file_name: file.fileName || "",
    file_size: file.fileLength || null,
    file_sha1: null,
    file_sha512: null,
    raw: file,
  };
}

function forgeCdnUrl(id, name) {
  const value = String(id || "");
  if (!value || !name) return "";
  return `https://mediafilez.forgecdn.net/files/${value.slice(0, 4)}/${value.slice(4)}/${encodeURIComponent(name)}`;
}

function normalizeWidgetFile(file, projectId) {
  const tokens = Array.isArray(file.versions) ? file.versions : [];
  const mc = tokens.filter((token) => /^\d+(?:\.\d+)+$/.test(String(token)));
  const loaders = tokens
    .map((token) => LOADER_NAME[String(token).toLowerCase()])
    .filter(Boolean);
  const channel = ["release", "beta", "alpha"].includes(file.type) ? file.type : "alpha";
  const display = file.display || file.name || String(file.id);
  const versionMatch = display.split(" - ")[0].match(/v?(\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?)/);
  return {
    source: "curseforge",
    project_id: String(projectId),
    version_id: String(file.id),
    version: versionMatch ? versionMatch[1] : display,
    name: display,
    channel,
    mc_versions: mc,
    loaders: [...new Set(loaders)],
    published_at: file.uploaded_at || null,
    changelog_url: "",
    download_page_url: file.url || "",
    download_url: forgeCdnUrl(file.id, file.name),
    file_name: file.name || "",
    file_size: file.filesize || null,
    file_sha1: null,
    file_sha512: null,
    raw: file,
  };
}

export async function listVersions(projectId, { mcVersion, loader, channels = ["release"], kind = "mod" } = {}) {
  const type = normalizeKind(kind);
  if (config.curseforgeReady) {
    const params = new URLSearchParams({ pageSize: "50" });
    if (mcVersion) params.set("gameVersion", mcVersion);
    if (type === "mod" && loaderId[loader]) params.set("modLoaderType", String(loaderId[loader]));
    const url = `${API}/mods/${encodeURIComponent(projectId)}/files?${params}`;
    const data = await cached(`cf:files:${url}`, 5 * 60_000, () => requestJson(url, { headers: headers() }));
    return (data.data || [])
      .map((f) => normalizeFile(f, projectId))
      .filter((v) => channels.includes(v.channel))
      .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
  }

  // Public fallback used when no CurseForge API key is configured. It exposes
  // project metadata and file lists, but not direct download URLs.
  const project = await widgetProject(projectId, type);
  const files = Array.isArray(project?.files) ? project.files : [];
  return files
    .map((file) => normalizeWidgetFile(file, project.id))
    .filter((v) => !mcVersion || v.mc_versions.includes(mcVersion))
    .filter((v) => type !== "mod" || !loader || loader === "plugin" || v.loaders.includes(loader))
    .filter((v) => channels.includes(v.channel))
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
}

export async function resolveUrl(url) {
  const match = String(url).match(/curseforge\.com\/minecraft\/(mc-mods|texture-packs|worlds|shaders|data-packs)\/([^/?#]+)/i);
  if (!match) return null;
  const kind = kindFromCurseforgePath(match[1]);
  const slug = match[2];

  if (config.curseforgeReady && CLASS_ID[kind]) {
    const params = new URLSearchParams({ gameId: String(GAME), slug, classId: String(CLASS_ID[kind]) });
    const data = await requestJson(`${API}/mods/search?${params}`, { headers: headers() }).catch(() => null);
    const hit = data?.data?.[0];
    if (hit) return { ...normalizeSearch(hit, kind), project_url: url };
  }

  const project = await widgetProject(slug, kind).catch(() => null);
  return project?.id ? { ...normalizeWidget(project, kind), project_url: url } : null;
}

export async function getProject(projectId, kind = "mod") {
  const type = normalizeKind(kind);
  if (config.curseforgeReady) {
    const data = await requestJson(`${API}/mods/${encodeURIComponent(projectId)}`, { headers: headers() }).catch(() => null);
    if (data?.data) return normalizeSearch(data.data, type);
  }
  const project = await widgetProject(projectId, type).catch(() => null);
  return project?.id ? normalizeWidget(project, type) : null;
}

export async function projectMeta(projectId, kind = "mod") {
  const project = await getProject(projectId, kind).catch(() => null);
  if (!project) return null;
  return {
    kind: normalizeKind(kind),
    name: project.name || "",
    icon_url: project.icon_url || null,
    creator_name: project.creator_name || "",
    creator_url: project.creator_url || "",
    creator_avatar_url: project.creator_avatar_url || null,
  };
}

export { normalizeFile };
