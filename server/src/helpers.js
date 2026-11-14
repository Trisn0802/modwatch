const DAY = 86_400_000;

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function number(value) {
  if (value == null || value === "") return "0";
  return new Intl.NumberFormat("en").format(Number(value));
}

export function fileSize(bytes) {
  if (bytes == null || bytes === "") return "—";
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function relative(value) {
  if (!value) return "Never";
  const then = new Date(value).getTime();
  const diff = Date.now() - then;
  if (diff < 0) return "Scheduled";
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < DAY * 7) return `${Math.floor(diff / DAY)} d ago`;
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function countdown(value) {
  if (!value) return "Not scheduled";
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return "Due now";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `in ${hours} h ${rest} min` : `in ${hours} h`;
  return `in ${Math.floor(hours / 24)} d`;
}

export function date(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function dateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function isoDate(value) {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

export function initials(name) {
  const parts = String(name || "?").replace(/[()[\]{}]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function truncate(value, length = 8) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function versionParts(version) {
  return String(version || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

// Raw Minecraft version strings are messy by design. Compare numeric chunks first,
// treat any suffix after the numbers as a prerelease, and never throw.
export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (typeof l === "number" && typeof r === "number") {
      if (l !== r) return l > r ? 1 : -1;
      continue;
    }
    if (typeof l === "number" && typeof r === "string") return 1;
    if (typeof l === "string" && typeof r === "number") return -1;
    if (l !== r) return String(l) > String(r) ? 1 : -1;
  }
  return 0;
}

export function isNewer(latest, installed, latestDate, installedDate) {
  if (!latest || !installed) return false;
  if (String(latest).toLowerCase() === String(installed).toLowerCase()) return false;
  if (latestDate && installedDate) {
    const l = new Date(latestDate).getTime();
    const i = new Date(installedDate).getTime();
    if (Number.isFinite(l) && Number.isFinite(i) && l !== i) return l > i;
  }
  return compareVersions(latest, installed) > 0;
}

export function modIcon(mod) {
  if (!mod) return null;
  if (mod.icon_url) return mod.icon_url;
  if (mod.source === "modrinth" && mod.project_id) {
    return `https://cdn.modrinth.com/data/${mod.project_id}/icon.png`;
  }
  return null;
}

export function range(start, end) {
  const out = [];
  for (let i = start; i <= end; i++) out.push(i);
  return out;
}

export function percent(part, total) {
  if (!total) return 0;
  return Math.round((Number(part) / Number(total)) * 100);
}

export function planText(value) {
  const map = { release: "Release only", beta: "Beta and release", alpha: "Alpha, beta and release" };
  return map[value] || value;
}

export function json(value) {
  return JSON.stringify(value ?? null);
}

export { DAY };
