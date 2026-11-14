import express from "express";
import { query } from "../db.js";
import { initials, modIcon } from "../helpers.js";
import { STATUS, LOADER } from "../labels.js";

export const searchRouter = express.Router();

searchRouter.get("/api/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ q, mods: [], instances: [], totalMods: 0, totalInstances: 0 });
    const like = `%${q}%`;
    const [modResult, instanceResult] = await Promise.all([
      query(
        `SELECT m.id, m.name, m.status, m.installed_version, m.latest_version,
                m.source, m.project_id, m.icon_url, i.name AS instance_name,
                count(*) OVER()::int AS total
           FROM mods m JOIN instances i ON i.id = m.instance_id
          WHERE m.name ILIKE $1 OR m.file_name ILIKE $1 OR i.name ILIKE $1
          ORDER BY (m.status = 'update_available') DESC, m.name
          LIMIT 6`,
        [like]
      ),
      query(
        `SELECT i.id, i.name, i.mc_version, i.loader, i.loader_version,
                count(m.id) FILTER (WHERE m.status = 'update_available')::int AS updates,
                count(*) OVER()::int AS total
           FROM instances i LEFT JOIN mods m ON m.instance_id = i.id
          WHERE i.name ILIKE $1 OR i.mc_version ILIKE $1 OR i.loader ILIKE $1
          GROUP BY i.id
          ORDER BY i.name LIMIT 5`,
        [like]
      ),
    ]);
    res.json({
      q,
      mods: modResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        instance: row.instance_name,
        version: row.status === "update_available"
          ? `${row.installed_version || "?"} → ${row.latest_version || "?"}`
          : row.installed_version || "",
        state: STATUS[row.status]?.label || row.status,
        icon: modIcon(row),
        initials: initials(row.name),
      })),
      instances: instanceResult.rows.map((row) => ({
        id: row.id,
        name: row.name,
        scope: `${row.mc_version} · ${LOADER[row.loader] || row.loader}${row.loader_version ? ` ${row.loader_version}` : ""}`,
        state: row.updates ? `${row.updates} update${row.updates === 1 ? "" : "s"}` : "Up to date",
        initials: initials(row.name),
      })),
      totalMods: modResult.rows[0]?.total || 0,
      totalInstances: instanceResult.rows[0]?.total || 0,
    });
  } catch (err) {
    next(err);
  }
});

searchRouter.get("/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    let mods = [];
    let instances = [];
    if (q) {
      const like = `%${q}%`;
      ({ rows: mods } = await query(
        `SELECT m.*, i.name AS instance_name FROM mods m
           JOIN instances i ON i.id = m.instance_id
          WHERE m.name ILIKE $1 OR m.file_name ILIKE $1 OR i.name ILIKE $1
          ORDER BY m.name LIMIT 40`,
        [like]
      ));
      ({ rows: instances } = await query(
        "SELECT * FROM instances WHERE name ILIKE $1 OR mc_version ILIKE $1 ORDER BY name LIMIT 10",
        [like]
      ));
    }
    res.render("pages/search.njk", {
      page: "search",
      title: q ? `Search: ${q}` : "Search",
      q,
      mods,
      instances,
    });
  } catch (err) {
    next(err);
  }
});
