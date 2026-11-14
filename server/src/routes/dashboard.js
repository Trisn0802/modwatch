import express from "express";
import { instanceSummaries, unknownCounts, overviewStats, updatesByDay, recentCheckRuns } from "../queries.js";
import { recentActivity } from "../activity.js";
import { getSettings, nextCheckAt } from "../settings.js";
import { checkAll } from "../checker.js";
import { flash } from "../middleware.js";

export const dashboardRouter = express.Router();

dashboardRouter.get("/", async (req, res, next) => {
  try {
    const [instances, unknownMap, stats, days, activity, runs, settings] = await Promise.all([
      instanceSummaries(),
      unknownCounts(),
      overviewStats(),
      updatesByDay(7),
      recentActivity(6),
      recentCheckRuns(4),
      getSettings(),
    ]);
    for (const instance of instances) instance.unknown = unknownMap.get(instance.id) || 0;
    const withUpdates = instances.filter((i) => i.updates > 0);
    const lastChecked = instances.reduce((latest, i) => {
      if (!i.last_checked_at) return latest;
      return !latest || new Date(i.last_checked_at) > new Date(latest) ? i.last_checked_at : latest;
    }, null);

    res.render("pages/dashboard.njk", {
      page: "dashboard",
      title: "Overview",
      instances,
      stats,
      days,
      activity,
      runs,
      settings,
      lastChecked,
      nextCheck: nextCheckAt(settings.check_interval_hours, lastChecked),
      withUpdates,
      chartLabels: days.map((d) => new Date(d.day).toLocaleDateString("en-GB", { day: "numeric", month: "short" })),
      chartValues: days.map((d) => d.updates),
    });
  } catch (err) {
    next(err);
  }
});

dashboardRouter.post("/check-all", async (req, res, next) => {
  try {
    checkAll({ trigger: "manual", userId: req.session.user.id }).catch((err) =>
      console.error("manual check all:", err.message)
    );
    flash(req, "ok", "Checking every instance. The board updates as results come in.");
    res.redirect(req.get("referer") || "/");
  } catch (err) {
    next(err);
  }
});
