import express from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";

import { config } from "../config.js";
import { query } from "../db.js";
import { flash, csrfValid } from "../middleware.js";
import { parseMrpack, savePreview, loadPreview, discardPreview, createInstanceFromPreview } from "../import.js";
import { checkInstance } from "../checker.js";
import { logActivity } from "../activity.js";
import { finishProgress, failProgress, isProgressOp, publishProgress } from "../progress.js";
import { createImportRequest, importRequestByToken } from "../import-requests.js";
import { createNotifications } from "../notify.js";

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

importsRouter.get("/imports/new", (req, res) => {
  res.render("pages/import-upload.njk", {
    page: "instances",
    title: "Import a .mrpack",
    maxUploadMb: config.maxUploadMb,
    approvalRequired: req.session.user.role !== "admin",
    error: null,
  });
});

importsRouter.post("/imports/upload", async (req, res, next) => {
  try {
    await receive(req, res);
    if (!csrfValid(req)) {
      console.warn("[upload-csrf]", {
        sessionId: req.sessionID,
        user: req.session.user?.email || null,
        sessionToken: req.session.csrf ? String(req.session.csrf).slice(0, 8) : null,
        bodyToken: req.body?._csrf ? String(req.body._csrf).slice(0, 8) : null,
        bodyKeys: Object.keys(req.body || {}),
        hasCookie: Boolean(req.headers.cookie),
        contentType: req.get("content-type") || "",
        ip: req.ip,
      });
      if (req.file) await fs.promises.rm(req.file.path, { force: true });
      return res.status(403).render("pages/403.njk", {
        page: "",
        title: "Request expired",
        message: "Your form session expired. Reload the page and try again.",
      });
    }
    if (!req.file) {
      failProgress(isProgressOp(req.body.progress_op) ? req.body.progress_op : "", "Choose a .mrpack file to upload.");
      return res.status(400).render("pages/import-upload.njk", {
        page: "instances", title: "Import a .mrpack", maxUploadMb: config.maxUploadMb,
        error: "Choose a .mrpack file to upload.",
      });
    }
    const op = isProgressOp(req.body.progress_op) ? req.body.progress_op : "";
    publishProgress(op, { stage: "received", message: "Upload received; reading the archive", percent: 12 });
    const handle = await fs.promises.open(req.file.path, "r");
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, 4, 0);
    await handle.close();
    if (magic.toString("binary") !== "PK\u0003\u0004") {
      failProgress(op, "That file is not a zip archive.");
      await fs.promises.rm(req.file.path, { force: true });
      return res.status(400).render("pages/import-upload.njk", {
        page: "instances", title: "Import a .mrpack", maxUploadMb: config.maxUploadMb,
        error: "That file is not a zip archive. A .mrpack is a zip containing modrinth.index.json.",
      });
    }
    let preview;
    try {
      preview = await parseMrpack(req.file.path, req.file.originalname, {
        onProgress: (event) => publishProgress(op, event),
      });
    } catch (err) {
      failProgress(op, err.message);
      await fs.promises.rm(req.file.path, { force: true });
      return res.status(400).render("pages/import-upload.njk", {
        page: "instances", title: "Import a .mrpack", maxUploadMb: config.maxUploadMb,
        error: err.message,
      });
    }
    const token = await savePreview(preview, { uploadedBy: req.session.user.id });
    finishProgress(op, "Preview ready");
    res.redirect(`/imports/${token}`);
  } catch (err) {
    if (err instanceof multer.MulterError) {
      const message = err.code === "LIMIT_FILE_SIZE"
        ? `The pack is larger than the ${config.maxUploadMb} MB limit.`
        : err.message;
      failProgress(isProgressOp(req.body?.progress_op) ? req.body.progress_op : "", message);
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

function selectedCount(tree) {
  const count = (nodes) => nodes.reduce((sum, node) => sum + (node.type === "folder" ? count(node.children) : node.selectable && node.defaultChecked ? 1 : 0), 0);
  return count(tree || []);
}

importsRouter.get("/imports/:token", async (req, res, next) => {
  try {
    const preview = await loadPreview(req.params.token);
    if (!preview) {
      flash(req, "error", "That import preview expired. Upload the pack again.");
      return res.redirect("/imports/new");
    }
    const isAdmin = req.session.user.role === "admin";
    if (preview.uploaded_by && !isAdmin && preview.uploaded_by !== req.session.user.id) return next();
    if (!preview.uploaded_by && !isAdmin) return next();
    const request = await importRequestByToken(req.params.token);
    let existing = [];
    if (isAdmin) {
      ({ rows: existing } = await query(
        "SELECT id, name, mc_version, loader FROM instances WHERE lower(name) = lower($1) AND loader = $2",
        [preview.pack.name, preview.pack.loader]
      ));
    }
    res.render("pages/import-preview.njk", {
      page: "instances",
      title: `Import ${preview.pack.name}`,
      preview,
      token: req.params.token,
      existing,
      reviewRequest: null,
      request,
      isAdmin,
      treeJson: JSON.stringify(preview.tree || []).replace(/</g, "\\u003c"),
      selectedFileCount: selectedCount(preview.tree),
    });
  } catch (err) {
    next(err);
  }
});

importsRouter.post("/imports/:token/confirm", async (req, res, next) => {
  try {
    if (!csrfValid(req)) {
      return res.status(403).render("pages/403.njk", {
        page: "", title: "Request expired",
        message: "Your form session expired. Reload the page and try again.",
      });
    }
    const preview = await loadPreview(req.params.token);
    if (!preview) {
      flash(req, "error", "That import preview expired. Upload the pack again.");
      return res.redirect("/imports/new");
    }
    const isAdmin = req.session.user.role === "admin";
    if (preview.uploaded_by && !isAdmin && preview.uploaded_by !== req.session.user.id) return next();
    const op = isProgressOp(req.body.progress_op) ? req.body.progress_op : "";
    const selectedFiles = [].concat(req.body.files || []).map((value) => String(value || "").trim()).filter(Boolean);
    if (!isAdmin) {
      publishProgress(op, { stage: "request", message: "Packaging the preview for an admin", percent: 30 });
      const request = await createImportRequest(preview, { userId: req.session.user.id, selectedFiles });
      const { rows: admins } = await query("SELECT id FROM users WHERE role = 'admin' AND status = 'active'");
      await createNotifications({
        kind: "request",
        title: `Pack import: ${preview.pack.name}`,
        body: `${req.session.user.name} submitted ${preview.file_name} (${preview.counts?.projects || 0} projects, ${preview.counts?.files || 0} pack files).`,
        userIds: admins.map((row) => row.id),
      });
      await logActivity({
        userId: req.session.user.id, action: "import_requested", subjectType: "request", subjectId: request.id,
        meta: { pack: preview.pack.name, file: preview.file_name },
      });
      finishProgress(op, "Sent for approval");
      flash(req, "ok", `${preview.pack.name} is waiting for an admin to review the pack.`);
      return res.redirect("/instances");
    }
    publishProgress(op, { stage: "start", message: "Starting the import", percent: 5 });
    const mode = req.body.mode === "update" ? "update" : "new";
    const existingId = Number.parseInt(req.body.existing_id, 10) || null;
    const result = await createInstanceFromPreview(preview, {
      userId: req.session.user.id,
      mode,
      existingId,
      selectedFiles,
      onProgress: (event) => publishProgress(op, event),
    });
    await discardPreview(req.params.token);
    checkInstance(result.instance.id, { trigger: "import", userId: req.session.user.id }).catch((err) =>
      console.error("post-import check:", err.message)
    );
    finishProgress(op, `${result.instance.name} is ready`);
    flash(req, "ok", `${result.instance.name}: ${result.added} projects added, ${result.filesAdded} pack files stored, ${result.unknownAdded} need a decision.`);
    res.redirect(`/instances/${result.instance.id}`);
  } catch (err) {
    failProgress(isProgressOp(req.body.progress_op) ? req.body.progress_op : "", err.message);
    next(err);
  }
});

importsRouter.post("/imports/:token/cancel", async (req, res, next) => {
  try {
    const preview = await loadPreview(req.params.token);
    if (!preview) {
      flash(req, "error", "That import preview has already been processed.");
      return res.redirect("/instances");
    }
    const isAdmin = req.session.user.role === "admin";
    if (preview.uploaded_by && !isAdmin && preview.uploaded_by !== req.session.user.id) return next();
    await query(
      "UPDATE import_requests SET status = 'cancelled', decided_by = $2, decided_at = now() WHERE token = $1 AND status = 'pending'",
      [req.params.token, req.session.user.id]
    );
    await discardPreview(req.params.token);
    flash(req, "ok", "Import cancelled. Nothing was written.");
    res.redirect("/instances");
  } catch (err) {
    next(err);
  }
});
