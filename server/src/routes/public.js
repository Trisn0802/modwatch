import express from "express";
import path from "node:path";

import { query } from "../db.js";
import { shareOverview, writeShareImage, shareVersion } from "../share.js";
import { getOrCreateExport } from "../export.js";
import { listModsForZip, streamModZip } from "../mod-zip.js";
import { KIND_ORDER, kindPlural } from "../kinds.js";
import { SOURCE } from "../labels.js";

export const publicRouter = express.Router();

publicRouter.get("/s/:token([a-f0-9]{16})", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM instances WHERE share_token = $1", [req.params.token]);
    const instance = rows[0];
    if (!instance) return next();
    const overview = await shareOverview(instance);
    const view = req.query.view === "updates" ? "updates" : "all";
    const shareUrl = `${res.locals.baseUrl}/s/${instance.share_token}`;
    res.render("pages/share.njk", {
      page: "share",
      title: instance.pack_name || instance.name,
      instance,
      overview,
      view,
      shareUrl,
      ogType: "website",
      ogTitle: `${instance.pack_name || instance.name} · ModWatch`,
      ogDescription: overview.stats.updates
        ? `${overview.stats.updates} update${overview.stats.updates === 1 ? "" : "s"} waiting for ${overview.stats.mods} tracked projects on ${instance.mc_version} ${instance.loader}.`
        : `${overview.stats.mods} tracked projects, all up to date on ${instance.mc_version} ${instance.loader}.`,
      kindOptions: KIND_ORDER.map((kind) => ({
        value: kind, label: kindPlural(kind), count: overview.kindCounts[kind] || 0,
      })),
      sourceOptions: ["modrinth", "curseforge", "github", "manual"].map((source) => ({
        value: source, label: SOURCE[source].label, count: overview.sourceCounts[source] || 0,
      })),
      ogImage: `${res.locals.baseUrl}/s/${instance.share_token}/og.png?v=${shareVersion(instance, overview)}`,
      ogUrl: shareUrl,
    });
  } catch (err) {
    next(err);
  }
});

publicRouter.post("/s/:token([a-f0-9]{16})/download-zip", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM instances WHERE share_token = $1", [req.params.token]);
    const instance = rows[0];
    if (!instance) return next();
    const ids = [].concat(req.body.mod_ids || [])
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    const all = String(req.body.all || "") === "1";
    const mods = await listModsForZip(instance, { modIds: ids, all });
    if (!mods.length) return res.redirect(`/s/${instance.share_token}`);
    await streamModZip(instance, mods, res);
  } catch (err) {
    if (res.headersSent) {
      console.error("share zip:", err.message);
      res.destroy();
      return;
    }
    next(err);
  }
});

publicRouter.get("/s/:token([a-f0-9]{16})/og.png", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM instances WHERE share_token = $1", [req.params.token]);
    const instance = rows[0];
    if (!instance) return next();
    const overview = await shareOverview(instance);
    const file = await writeShareImage(instance, overview);
    res.type("png").set("Cache-Control", "public, max-age=300");
    res.sendFile(file);
  } catch (err) {
    next(err);
  }
});

publicRouter.get("/s/:token([a-f0-9]{16})/export", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM instances WHERE share_token = $1", [req.params.token]);
    const instance = rows[0];
    if (!instance) return next();
    const record = await getOrCreateExport(instance, { maxAgeMinutes: 1 });
    res.download(path.join(process.cwd(), "uploads", record.file_path), `${instance.pack_name || instance.name}.mrpack`);
  } catch (err) {
    next(err);
  }
});
