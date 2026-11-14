import { cached, requestJson } from "./http.js";

const API = "https://api.modrinth.com/v2";
const TTL = 10 * 60_000;

const loaderSlug = {
  forge: "forge",
  fabric: "fabric",
  neoforge: "neoforge",
  quilt: "quilt",
  plugin: "bukkit",
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

function normalizeSearch(hit) {
  return {
    source: "modrinth",
    project_id: hit.project_id,
    slug: hit.slug,
    name: hit.title,
    description: hit.description,
    icon_url: hit.icon_url || (hit.project_id ? `https://cdn.modrinth.com/data/${hit.project_id}/icon.png` : null),
    downloads: hit.downloads,
    project_url: `https://modrinth.com/mod/${hit.slug || hit.project_id}`,
    author: hit.author,
  };
}

export async function searchProject(query, { mcVersion, loader, limit = 10 } = {}) {
  const facets = [["project_type:mod"]];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  const slug = loaderSlug[loader];
  if (loader === "plugin") {
    facets.push(["categories:bukkit", "categories:paper", "categories:spigot"]);
  } else if (slug) {
    facets.push([`categories:${slug}`]);
  }
  const url = `${API}/search?query=${encodeURIComponent(query)}&limit=${limit}&index=relevance&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const data = await cached(`mr:search:${url}`, TTL, () => requestJson(url));
  return (data.hits || []).map(normalizeSearch);
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

export async function listVersions(projectId, { mcVersion, loader, channels = ["release"] } = {}) {
  const url = `${API}/project/${encodeURIComponent(projectId)}/version`;
  const data = await cached(`mr:versions:${projectId}`, 5 * 60_000, () => requestJson(url));
  return (data || [])
    .filter((v) => !mcVersion || (v.game_versions || []).includes(mcVersion))
    .filter((v) => matchesLoader(v, loader))
    .filter((v) => channels.includes(v.version_type || v.release_type))
    .map(normalizeVersion)
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
}

export async function resolveUrl(url) {
  const match = String(url).match(/modrinth\.com\/(?:mod|project)\/([^/?#]+)/i);
  if (!match) return null;
  const project = await getProject(match[1]).catch(() => null);
  if (!project) return null;
  return {
    source: "modrinth",
    project_id: project.id,
    slug: project.slug,
    name: project.title,
    description: project.description,
    icon_url: project.icon_url,
    project_url: `https://modrinth.com/mod/${project.slug || project.id}`,
  };
}

export { normalizeVersion };
