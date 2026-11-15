export const KINDS = {
  mod: {
    label: "Mod",
    plural: "Mods",
    folder: "mods",
    extension: ".jar",
    loaderBound: true,
    modrinthType: "mod",
  },
  resourcepack: {
    label: "Resource pack",
    plural: "Resource packs",
    folder: "resourcepacks",
    extension: ".zip",
    loaderBound: false,
    modrinthType: "resourcepack",
  },
  datapack: {
    label: "Data pack",
    plural: "Data packs",
    folder: "datapacks",
    extension: ".zip",
    loaderBound: false,
    modrinthType: "datapack",
  },
  shader: {
    label: "Shader",
    plural: "Shaders",
    folder: "shaderpacks",
    extension: ".zip",
    loaderBound: false,
    modrinthType: "shader",
  },
};

export const KIND_ORDER = ["mod", "resourcepack", "datapack", "shader"];

export function isKind(value) {
  return Object.prototype.hasOwnProperty.call(KINDS, String(value || ""));
}

export function normalizeKind(value, fallback = "mod") {
  const kind = String(value || "").toLowerCase();
  return isKind(kind) ? kind : fallback;
}

export function kindMeta(kind) {
  return KINDS[normalizeKind(kind)];
}

export function kindLabel(kind) {
  return kindMeta(kind).label;
}

export function kindPlural(kind) {
  return kindMeta(kind).plural;
}

export function kindFolder(kind) {
  return kindMeta(kind).folder;
}

export function kindExtension(kind) {
  return kindMeta(kind).extension;
}

export function kindFromModrinth(project, pathType = "") {
  const type = String(project?.project_type || "").toLowerCase();
  const path = String(pathType || "").toLowerCase();
  if (path === "datapack" || type === "datapack") return "datapack";
  if (path === "resourcepack" || type === "resourcepack") return "resourcepack";
  if (path === "shader" || type === "shader") return "shader";
  return "mod";
}

export function kindFromCurseforgePath(pathType = "") {
  const type = String(pathType || "").toLowerCase();
  if (["texture-packs", "texturepack", "resourcepack"].includes(type)) return "resourcepack";
  if (["worlds", "world", "datapacks", "data-packs"].includes(type)) return "datapack";
  if (["customization", "shaders", "shader"].includes(type)) return "shader";
  return "mod";
}

const FOLDER_KIND = {
  mods: "mod",
  resourcepacks: "resourcepack",
  datapacks: "datapack",
  shaderpacks: "shader",
  shaders: "shader",
};

const PROJECT_TYPE_KIND = {
  mod: "mod",
  resourcepack: "resourcepack",
  datapack: "datapack",
  shader: "shader",
};

// A path may be an index entry (`resourcepacks/foo.zip`) or an override
// (`overrides/resourcepacks/foo.zip`). Only the first folder decides the kind.
export function kindFromPackPath(value) {
  const clean = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts[0] === "overrides") parts.shift();
  return FOLDER_KIND[String(parts[0] || "").toLowerCase()] || "";
}

export function kindFromProjectType(value) {
  return PROJECT_TYPE_KIND[String(value || "").toLowerCase()] || "";
}

export function folderKind(value) {
  return FOLDER_KIND[String(value || "").toLowerCase()] || "";
}
