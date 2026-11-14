import express from "express";
import { instanceSummaries, unknownCounts, overviewStats, updatesByDay, monthlyActivity, recentCheckRuns } from "../queries.js";
import { recentActivity } from "../activity.js";
import { getSettings, nextCheckAt } from "../settings.js";
import { checkAll } from "../checker.js";
import { schedulerState } from "../scheduler.js";
import { flash } from "../middleware.js";

export const dashboardRouter = express.Router();

dashboardRouter.get("/api/scheduler", (req, res) => {
  res.json(schedulerState());
});

dashboardRouter.get("/", async (req, res, next) => {
  try {
    const [instances, unknownMap, stats, days, monthly, activity, runs, settings] = await Promise.all([
      instanceSummaries(),
      unknownCounts(),
      overviewStats(),
      updatesByDay(7),
      monthlyActivity(12),
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
      monthlyLabels: monthly.map((row) => new Date(row.month).toLocaleDateString("en-GB", { month: "short" })),
      monthlyUpdates: monthly.map((row) => row.updates),
      monthlyDownloads: monthly.map((row) => row.downloads),
      monthlyTotals: {
        updates: monthly.reduce((sum, row) => sum + row.updates, 0),
        downloads: monthly.reduce((sum, row) => sum + row.downloads, 0),
      },
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
