import { cached, requestJson } from "./http.js";
import { KINDS, kindFromModrinth, normalizeKind } from "../kinds.js";

const API = "https://api.modrinth.com/v2";
const TTL = 10 * 60_000;

const KIND_PATH = {
  mod: "mod",
  resourcepack: "resourcepack",
  datapack: "datapack",
  shader: "shader",
};

const loaderSlug = {
  forge: "forge",
  fabric: "fabric",
  neoforge: "neoforge",
  quilt: "quilt",
  plugin: "bukkit",
  datapack: "datapack",
};

const PLUGIN_LOADERS = new Set([
  "bukkit", "spigot", "paper", "purpur", "folia", "velocity", "bungeecord", "waterfall",
]);

function matchesLoader(version, loader) {
  const slug = loaderSlug[loader];
  if (!slug) return true;
  const loaders = version.loaders || [];
  if (loader === "plugin") return loaders.some((item) => PLUGIN_LOADERS.has(item));
  return loaders.includes(slug);
}

function normalizeSearch(hit, kind = "mod") {
  const type = normalizeKind(kind);
  return {
    source: "modrinth",
    project_id: hit.project_id,
    slug: hit.slug,
    kind: type,
    name: hit.title,
    description: hit.description,
    icon_url: hit.icon_url || (hit.project_id ? `https://cdn.modrinth.com/data/${hit.project_id}/icon.png` : null),
    downloads: hit.downloads,
    project_url: `https://modrinth.com/${KIND_PATH[type]}/${hit.slug || hit.project_id}`,
    author: hit.author,
    creator_name: hit.author || "",
    creator_url: "",
    creator_avatar_url: null,
  };
}

export async function searchProject(query, { mcVersion, loader, limit = 10, kind = "mod" } = {}) {
  const type = normalizeKind(kind);
  const facets = [[`project_type:${KINDS[type].modrinthType}`]];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (type === "mod") {
    const slug = loaderSlug[loader];
    if (loader === "plugin") {
      facets.push(["categories:bukkit", "categories:paper", "categories:spigot"]);
    } else if (slug) {
      facets.push([`categories:${slug}`]);
    }
  }
  const url = `${API}/search?query=${encodeURIComponent(query)}&limit=${limit}&index=relevance&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const data = await cached(`mr:search:${url}`, TTL, () => requestJson(url));
  return (data.hits || []).map((hit) => normalizeSearch(hit, type));
}

export async function lookupByHash(sha1s) {
  if (!sha1s?.length) return new Map();
  const data = await requestJson(`${API}/version_files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hashes: sha1s, algorithm: "sha1" }),
  });
  const map = new Map();
  for (const [hash, version] of Object.entries(data || {})) map.set(hash, normalizeVersion(version));
  return map;
}

export async function getProjects(ids) {
  if (!ids?.length) return new Map();
  const url = `${API}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`;
  const data = await cached(`mr:projects:${ids.slice().sort().join(",")}`, TTL, () => requestJson(url));
  return new Map((data || []).map((p) => [p.id, p]));
}

export async function getProject(idOrSlug) {
  return cached(`mr:project:${idOrSlug}`, TTL, () => requestJson(`${API}/project/${encodeURIComponent(idOrSlug)}`));
}

export async function getProjectCreator(project) {
  const teamId = project?.team;
  if (!teamId) return null;
  const members = await cached(`mr:team:${teamId}`, TTL, () =>
    requestJson(`${API}/team/${encodeURIComponent(teamId)}/members`)
  ).catch(() => null);
  const list = Array.isArray(members) ? members : [];
  const creator = list.find((member) => String(member.role || "").toLowerCase() === "creator") || list[0];
  const user = creator?.user;
  if (!user?.username) return null;
  return {
    creator_name: user.username,
    creator_url: `https://modrinth.com/user/${user.username}`,
    creator_avatar_url: user.avatar_url || null,
  };
}

export async function projectMeta(projectId, kind = "mod") {
  const project = await getProject(projectId).catch(() => null);
  if (!project) return null;
  const creator = await getProjectCreator(project).catch(() => null);
  return {
    kind: normalizeKind(kind),
    name: project.title || "",
    icon_url: project.icon_url || null,
    ...(creator || {}),
  };
}

function normalizeVersion(v) {
  const file = (v.files || []).find((f) => f.primary) || (v.files || [])[0] || {};
  return {
    source: "modrinth",
    project_id: v.project_id,
    version_id: v.id,
    version: v.version_number,
    name: v.name,
    channel: v.version_type || v.release_type || "release",
    mc_versions: v.game_versions || [],
    loaders: v.loaders || [],
    published_at: v.date_published,
    changelog_url: v.id ? `https://modrinth.com/version/${v.id}` : "",
    download_page_url: v.project_id ? `https://modrinth.com/project/${v.project_id}/versions` : "",
    downloads: v.downloads,
    file_name: file.filename || "",
    download_url: file.url || "",
    file_size: file.size || null,
    file_sha1: file.hashes?.sha1 || null,
    file_sha512: file.hashes?.sha512 || null,
    raw: v,
  };
}

export async function getVersion(versionId) {
  return normalizeVersion(await requestJson(`${API}/version/${encodeURIComponent(versionId)}`));
}

export async function listVersions(projectId, { mcVersion, loader, channels = ["release"], kind = "mod" } = {}) {
  const type = normalizeKind(kind);
  const url = `${API}/project/${encodeURIComponent(projectId)}/version`;
  const data = await cached(`mr:versions:${projectId}`, 5 * 60_000, () => requestJson(url));
  const wantedLoader = type === "datapack" ? "datapack" : KINDS[type].loaderBound ? loader : null;
  return (data || [])
    .filter((v) => !mcVersion || (v.game_versions || []).includes(mcVersion))
    .filter((v) => !wantedLoader || matchesLoader(v, wantedLoader))
    .filter((v) => channels.includes(v.version_type || v.release_type))
    .map(normalizeVersion)
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
}

export async function resolveUrl(url) {
  const match = String(url).match(/modrinth\.com\/(mod|project|resourcepack|datapack|shader|plugin|modpack)\/([^/?#]+)/i);
  if (!match) return null;
  const project = await getProject(match[2]).catch(() => null);
  if (!project) return null;
  const pathType = match[1].toLowerCase();
  const kind = kindFromModrinth(project, pathType);
  const creator = await getProjectCreator(project).catch(() => null);
  return {
    source: "modrinth",
    project_id: project.id,
    slug: project.slug,
    kind,
    name: project.title,
    description: project.description,
    icon_url: project.icon_url,
    project_url: `https://modrinth.com/${KIND_PATH[kind]}/${project.slug || project.id}`,
    ...(creator || {}),
  };
}

export { normalizeVersion };
