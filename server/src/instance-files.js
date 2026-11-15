import { query } from "./db.js";

const VIEWABLE_IMAGES = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const VIEWABLE_TEXT = new Set([
  "txt", "md", "json", "json5", "toml", "yml", "yaml", "cfg", "conf", "properties",
  "ini", "log", "csv", "tsv", "js", "mjs", "ts", "css", "html", "xml", "mcmeta",
]);

export function extensionOf(name) {
  const parts = String(name || "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

export function isViewableFile(file) {
  const ext = extensionOf(file.file_name || file.path);
  if (VIEWABLE_IMAGES.has(ext)) return true;
  return VIEWABLE_TEXT.has(ext) && Number(file.file_size) <= 1024 * 1024;
}

export function contentTypeFor(file) {
  const ext = extensionOf(file.file_name || file.path);
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "text/plain; charset=utf-8";
}

export async function listInstanceFiles(instanceId) {
  const { rows } = await query(
    "SELECT * FROM instance_files WHERE instance_id = $1 ORDER BY path",
    [instanceId]
  );
  return rows;
}

export async function instanceFileByPath(instanceId, relativePath) {
  const { rows } = await query(
    "SELECT * FROM instance_files WHERE instance_id = $1 AND path = $2",
    [instanceId, relativePath]
  );
  return rows[0] || null;
}

export function buildFileTree(instanceId, rows) {
  const root = { type: "folder", name: "", path: "", children: [] };
  for (const file of rows) {
    const parts = String(file.path || "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let node = root;
    for (let index = 0; index < parts.length; index += 1) {
      const last = index === parts.length - 1;
      const name = parts[index];
      let child = node.children.find((item) => item.name === name && (last ? item.type === "file" : item.type === "folder"));
      if (!child) {
        child = last
          ? { type: "file", name, path: file.path, children: [] }
          : { type: "folder", name, path: parts.slice(0, index + 1).join("/"), children: [] };
        node.children.push(child);
      }
      if (last) {
        child.size = Number(file.file_size) || 0;
        child.modified_at = file.modified_at;
        child.download_url = `/instances/${instanceId}/files/download?path=${encodeURIComponent(file.path)}`;
        if (isViewableFile(file)) {
          child.view_url = `/instances/${instanceId}/files/view?path=${encodeURIComponent(file.path)}`;
        }
      }
      node = child;
    }
  }
  const decorate = (nodes) => {
    for (const node of nodes) {
      if (node.type === "folder") {
        decorate(node.children);
        node.size = node.children.reduce((sum, child) => sum + (child.size || 0), 0);
        node.count = node.children.reduce((sum, child) => sum + (child.count || (child.type === "file" ? 1 : 0)), 0);
      }
    }
    nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
  };
  decorate(root.children);
  return root.children;
}
