import express from "express";
import path from "node:path";

import { query } from "../db.js";
import { shareOverview, writeShareImage } from "../share.js";
import { getOrCreateExport } from "../export.js";

export const publicRouter = express.Router();

publicRouter.get("/s/:token([a-f0-9]{16})", async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM instances WHERE share_token = $1", [req.params.token]);
    const instance = rows[0];
    if (!instance) return next();
    const overview = await shareOverview(instance);
    const shareUrl = `${res.locals.baseUrl}/s/${instance.share_token}`;
    res.render("pages/share.njk", {
      page: "share",
      title: instance.pack_name || instance.name,
      instance,
      overview,
      shareUrl,
      ogType: "website",
      ogTitle: `${instance.pack_name || instance.name} · ModWatch`,
      ogDescription: overview.stats.updates
        ? `${overview.stats.updates} update${overview.stats.updates === 1 ? "" : "s"} waiting for ${overview.stats.mods} tracked mods on ${instance.mc_version} ${instance.loader}.`
        : `${overview.stats.mods} tracked mods, all up to date on ${instance.mc_version} ${instance.loader}.`,
      ogImage: `${res.locals.baseUrl}/s/${instance.share_token}/og.png`,
      ogUrl: shareUrl,
    });
  } catch (err) {
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
