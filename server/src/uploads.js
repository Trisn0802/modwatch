import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";
import sharp from "sharp";

export const uploadsRoot = path.join(process.cwd(), "uploads");
export const jarsRoot = path.join(uploadsRoot, "jars");
export const exportsRoot = path.join(uploadsRoot, "exports");

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extension(file) {
  if (file.mimetype === "image/png") return "png";
  if (file.mimetype === "image/webp") return "webp";
  if (file.mimetype === "image/gif") return "gif";
  if (file.mimetype === "image/svg+xml") return "svg";
  return "jpg";
}

const IMAGE_TYPES = [
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml",
];

function imageUpload(subdir, prefix, maxBytes) {
  const dir = ensure(path.join(uploadsRoot, subdir));
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename(req, file, cb) {
        cb(null, `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension(file)}`);
      },
    }),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter(req, file, cb) {
      const ok = IMAGE_TYPES.includes(file.mimetype) || /\.(png|jpe?g|webp|gif|svg)$/i.test(file.originalname || "");
      cb(ok ? null : Object.assign(new Error("Use a PNG, JPG, WebP, GIF or SVG image."), { code: "IMAGE_TYPE" }), ok);
    },
  });
}

export const avatarUpload = imageUpload("avatars", "avatar", 2 * 1024 * 1024).single("avatar");
export const instanceUpload = imageUpload("instances", "instance", 2 * 1024 * 1024).single("image");

export function receiveUpload(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

export function uploadPath(file, subdir) {
  return file ? `${subdir}/${path.basename(file.path)}` : null;
}

// SVG can carry script, so it is rasterised before it is ever served from our
// origin. GIFs stay animated: browsers render them as a normal raster image.
export async function finalizeImage(file, subdir) {
  if (!file) return null;
  const relative = uploadPath(file, subdir);
  const full = path.join(uploadsRoot, relative);
  if (path.extname(full).toLowerCase() !== ".svg") return relative;
  try {
    const png = await sharp(full).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
    const next = full.replace(/\.svg$/i, ".png");
    await fs.promises.writeFile(next, png);
    await fs.promises.rm(full, { force: true });
    return path.relative(uploadsRoot, next).split(path.sep).join("/");
  } catch {
    await fs.promises.rm(full, { force: true }).catch(() => {});
    throw Object.assign(new Error("That SVG could not be read as an image."), { code: "IMAGE_TYPE" });
  }
}

export async function removeUpload(relative) {
  if (!relative) return;
  const full = path.join(uploadsRoot, relative);
  if (!full.startsWith(uploadsRoot)) return;
  await fs.promises.rm(full, { force: true }).catch(() => {});
}

function safeName(name) {
  return path.basename(String(name || "mod.jar")).replace(/[^a-zA-Z0-9._+-]/g, "_") || "mod.jar";
}

export async function saveJar(instanceId, fileName, buffer) {
  const dir = ensure(path.join(jarsRoot, `instance-${instanceId}`));
  const clean = safeName(fileName);
  const full = path.join(dir, clean);
  await fs.promises.writeFile(full, buffer);
  return path.relative(uploadsRoot, full).split(path.sep).join("/");
}

export function jarAbsolute(relative) {
  if (!relative) return null;
  const full = path.join(uploadsRoot, relative);
  return full.startsWith(uploadsRoot) && fs.existsSync(full) ? full : null;
}

export async function writeExport(instanceId, buffer) {
  const dir = ensure(exportsRoot);
  const name = `instance-${instanceId}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mrpack`;
  const full = path.join(dir, name);
  await fs.promises.writeFile(full, buffer);
  return { path: path.relative(uploadsRoot, full).split(path.sep).join("/"), size: buffer.length };
}

export function uploadMessage(err) {
  if (!err) return "";
  if (err.code === "LIMIT_FILE_SIZE") return "That image is larger than the allowed size.";
  if (err.code === "IMAGE_TYPE") return "Use a PNG, JPG, WebP, GIF or SVG image.";
  return err.message || "The image could not be uploaded.";
}

function safeRelative(relative) {
  const clean = String(relative || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes("\0"))) return "";
  return parts.join("/");
}

export async function saveInstanceFile(instanceId, relative, buffer) {
  const clean = safeRelative(relative);
  if (!clean) throw new Error("The file path is not safe to store.");
  const dir = ensure(path.join(uploadsRoot, "files", `instance-${instanceId}`));
  const full = path.join(dir, ...clean.split("/"));
  if (!full.startsWith(dir + path.sep)) throw new Error("The file path is not safe to store.");
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  await fs.promises.writeFile(full, buffer);
  return path.relative(uploadsRoot, full).split(path.sep).join("/");
}

export function instanceFileAbsolute(relative) {
  if (!relative) return null;
  const full = path.join(uploadsRoot, relative);
  return full.startsWith(uploadsRoot + path.sep) && fs.existsSync(full) ? full : null;
}
