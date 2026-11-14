import express from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";

import { config } from "../config.js";
import { query } from "../db.js";
import { requireAdmin, flash, csrfValid } from "../middleware.js";
import { parseMrpack, savePreview, loadPreview, discardPreview, createInstanceFromPreview } from "../import.js";
import { checkInstance } from "../checker.js";
import { logActivity } from "../activity.js";

export const importsRouter = express.Router();

const tmpDir = path.join(process.cwd(), "uploads", "tmp");
fs.mkdirSync(tmpDir, { recursive: true });

const upload = multer({
  dest: tmpDir,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    if (!/\.mrpack$/i.test(file.originalname)) {
      cb(new Error("Only a .mrpack file can be imported."));
      return;
    }
    cb(null, true);
  },
}).single("pack");

function receive(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

importsRouter.use("/imports", requireAdmin);

importsRouter.get("/imports/new", (req, res) => {
  res.render("pages/import-upload.njk", {
    page: "instances",
    title: "Import a .mrpack",
    maxUploadMb: config.maxUploadMb,
    error: null,
  });
});

importsRouter.post("/imports/upload", async (req, res, next) => {
  try {
    await receive(req, res);
    if (!csrfValid(req)) {
      if (req.file) await fs.promises.rm(req.file.path, { force: true });
      return res.status(403).render("pages/403.njk", {
        page: "",
        title: "Request expired",
        message: "Your form session expired. Reload the page and try again.",
      });
    }
    if (!req.file) {
      return res.status(400).render("pages/import-upload.njk", {
        page: "instances", title: "Import a .mrpack", maxUploadMb: config.maxUploadMb,
        error: "Choose a .mrpack file to upload.",
      });
    }
    const handle = await fs.promises.open(req.file.path, "r");
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    await handle.close();
    if (magic.toString("binary") !== "PK\u0003\u0004") {
      await fs.promises.rm(req.file.path, { force: true });
      return res.status(400).render("pages/import-upload.njk", {
        page: "instances", title: "Import a .mrpack", maxUploadMb: config.maxUploadMb,
        error: "That file is not a zip archive. A .mrpack is a zip containing modrinth.index.json.",
      });
    }
    let preview;
    try {
      preview = await parseMrpack(req.file.path, req.file.originalname);
    } catch (err) {
      await fs.promises.rm(req.file.path, { force: true });
      return res.status(400).render("pages/import-upload.njk", {
        page: "instances", title: "Import a .mrpack", maxUploadMb: config.maxUploadMb,
        error: err.message,
      });
    }
    const token = await savePreview(preview);
    res.redirect(`/imports/${token}`);
  } catch (err) {
    if (err instanceof multer.MulterError) {
      const message = err.code === "LIMIT_FILE_SIZE"
        ? `The pack is larger than the ${config.maxUploadMb} MB limit.`
        : err.message;
      return res.status(400).render("pages/import-upload.njk", {
        page: "instances", title: "Import a .mrpack", maxUploadMb: config.maxUploadMb, error: message,
      });
    }
    if (err.message === "Only a .mrpack file can be imported.") {
      return res.status(400).render("pages/import-upload.njk", {
        page: "instances", title: "Import a .mrpack", maxUploadMb: config.maxUploadMb, error: err.message,
      });
    }
    next(err);
  }
});

importsRouter.get("/imports/:token", async (req, res, next) => {
  try {
    const preview = await loadPreview(req.params.token);
    if (!preview) {
      flash(req, "error", "That import preview expired. Upload the pack again.");
      return res.redirect("/imports/new");
    }
    const { rows: existing } = await query(
      "SELECT id, name, mc_version, loader FROM instances WHERE lower(name) = lower($1) AND loader = $2",
      [preview.pack.name, preview.pack.loader]
    );
    res.render("pages/import-preview.njk", {
      page: "instances",
      title: `Import ${preview.pack.name}`,
      preview,
      token: req.params.token,
      existing,
    });
  } catch (err) {
    next(err);
  }
});

importsRouter.post("/imports/:token/confirm", async (req, res, next) => {
  try {
    const preview = await loadPreview(req.params.token);
    if (!preview) {
      flash(req, "error", "That import preview expired. Upload the pack again.");
      return res.redirect("/imports/new");
    }
    const mode = req.body.mode === "update" ? "update" : "new";
    const existingId = Number.parseInt(req.body.existing_id, 10) || null;
    const result = await createInstanceFromPreview(preview, {
      userId: req.session.user.id,
      mode,
      existingId,
    });
    await discardPreview(req.params.token);
    checkInstance(result.instance.id, { trigger: "import", userId: req.session.user.id }).catch((err) =>
      console.error("post-import check:", err.message)
    );
    flash(req, "ok", `${result.instance.name}: ${result.added} mods added, ${result.unknownAdded} files need a decision.`);
    res.redirect(`/instances/${result.instance.id}`);
  } catch (err) {
    next(err);
  }
});

importsRouter.post("/imports/:token/cancel", async (req, res) => {
  await discardPreview(req.params.token);
  flash(req, "ok", "Import cancelled. Nothing was written.");
  res.redirect("/instances");
});
