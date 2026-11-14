import { config } from "../config.js";
import * as modrinth from "./modrinth.js";
import * as curseforge from "./curseforge.js";
import * as github from "./github.js";

export const SOURCE_MODULES = { modrinth, curseforge, github };

export function channelsFor(policy) {
  if (policy === "alpha") return ["release", "beta", "alpha"];
  if (policy === "beta") return ["release", "beta"];
  return ["release"];
}

export async function searchProjects(query, instance, { includeCurseforge = true, includeGithub = true } = {}) {
  const results = await modrinth
    .searchProject(query, { mcVersion: instance?.mc_version, loader: instance?.loader, limit: 8 })
    .catch((err) => {
      console.error("modrinth search:", err.message);
      return [];
    });
  if (includeCurseforge && config.curseforgeReady) {
    const cf = await curseforge
      .searchProject(query, { mcVersion: instance?.mc_version, loader: instance?.loader, limit: 6 })
      .catch((err) => {
        console.error("curseforge search:", err.message);
        return [];
      });
    results.push(...cf);
  }
  if (includeGithub) {
    const gh = await github
      .searchProject(query, { limit: 8 })
      .catch((err) => {
        console.error("github search:", err.message);
        return [];
      });
    results.push(...gh);
  }
  return results;
}

export async function resolveProjectUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  if (/modrinth\.com/i.test(raw)) return modrinth.resolveUrl(raw).catch(() => null);
  if (/github\.com/i.test(raw)) return github.resolveUrl(raw).catch(() => null);
  if (/curseforge\.com/i.test(raw)) {
    const cf = await curseforge.resolveUrl(raw).catch(() => null);
    if (cf) return cf;

    // cfwidget does not index every CurseForge project. When the public
    // metadata endpoint misses, try the same slug on Modrinth so a valid
    // project URL still lands on a real, trackable source.
    const slug = raw.match(/curseforge\.com\/minecraft\/mc-mods\/([^/?#]+)/i)?.[1];
    if (slug) {
      const direct = await modrinth.resolveUrl(`https://modrinth.com/mod/${slug}`).catch(() => null);
      if (direct) return { ...direct, resolved_fallback: "modrinth" };
      const hits = await modrinth.searchProject(slug.replace(/[-_]+/g, " "), { limit: 6 }).catch(() => []);
      const wanted = slug.replace(/[-_]+/g, "").toLowerCase();
      const match = hits.find((hit) => String(hit.name || "").replace(/[^a-z0-9]/gi, "").toLowerCase() === wanted) || hits[0];
      if (match) return { ...match, resolved_fallback: "modrinth" };
    }
  }
  return null;
}

export async function listSourceVersions(source, projectId, instance, channelPolicy = "release", assetPattern = "") {
  const mod = SOURCE_MODULES[source];
  if (!mod) return [];
  return mod.listVersions(projectId, {
    mcVersion: instance?.mc_version,
    loader: instance?.loader,
    channels: channelsFor(channelPolicy),
    assetPattern,
  });
}

export async function latestForMod(mod, instance) {
  if (mod.source === "manual") return [];
  return listSourceVersions(mod.source, mod.project_id, instance, mod.channel_policy, mod.github_asset_pattern);
}
