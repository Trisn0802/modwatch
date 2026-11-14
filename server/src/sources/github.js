import { config } from "../config.js";
import { cached, requestJson } from "./http.js";

const API = "https://api.github.com";
const TTL = 10 * 60_000;

function headers() {
  const h = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (config.githubToken) h.authorization = `Bearer ${config.githubToken}`;
  return h;
}

export function parseRepo(value) {
  const text = String(value || "").trim();
  const match = text.match(/github\.com\/([^/?#]+)\/([^/?#]+)/i);
  if (match) return `${match[1]}/${match[2].replace(/\.git$/, "")}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return text;
  return null;
}

function pickAsset(release, pattern) {
  const assets = release.assets || [];
  const jars = assets.filter((a) => /\.jar$/i.test(a.name));
  if (!jars.length) return null;
  if (pattern) {
    try {
      const re = new RegExp(pattern, "i");
      return jars.find((a) => re.test(a.name)) || null;
    } catch {
      const needle = pattern.toLowerCase();
      return jars.find((a) => a.name.toLowerCase().includes(needle)) || null;
    }
  }
  return jars[0];
}

export async function listVersions(projectId, { channels = ["release"], assetPattern = "" } = {}) {
  const repo = parseRepo(projectId);
  if (!repo) return [];
  const data = await cached(`gh:releases:${repo}`, 5 * 60_000, () =>
    requestJson(`${API}/repos/${repo}/releases?per_page=40`, { headers: headers() })
  );
  return (data || [])
    .filter((r) => !r.draft)
    .map((r) => {
      const asset = pickAsset(r, assetPattern);
      const channel = r.prerelease ? "beta" : "release";
      return {
        source: "github",
        project_id: repo,
        version_id: String(r.id),
        version: r.tag_name || r.name,
        name: r.name || r.tag_name,
        channel,
        mc_versions: [],
        loaders: [],
        published_at: r.published_at || r.created_at,
        changelog_url: r.html_url,
        download_page_url: r.html_url,
        file_name: asset?.name || "",
        file_size: asset?.size || null,
        file_sha1: null,
        asset_url: asset?.browser_download_url || "",
        raw: r,
      };
    })
    .filter((v) => channels.includes(v.channel))
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
}

export async function searchProject(query, { limit = 8 } = {}) {
  const data = await requestJson(`${API}/search/repositories?q=${encodeURIComponent(query + " minecraft mod")}&per_page=${limit}`, {
    headers: headers(),
  }).catch(() => null);
  return (data?.items || []).map((repo) => ({
    source: "github",
    project_id: repo.full_name,
    name: repo.name,
    description: repo.description || "",
    icon_url: repo.owner?.avatar_url || null,
    downloads: repo.stargazers_count,
    project_url: repo.html_url,
    author: repo.owner?.login || "",
  }));
}

export async function resolveUrl(url) {
  const repo = parseRepo(url);
  if (!repo) return null;
  const data = await requestJson(`${API}/repos/${repo}`, { headers: headers() }).catch(() => null);
  if (!data) return null;
  return {
    source: "github",
    project_id: data.full_name,
    name: data.name,
    description: data.description || "",
    icon_url: data.owner?.avatar_url || null,
    project_url: data.html_url,
  };
}
