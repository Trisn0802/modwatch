import express from "express";
import { activityFor } from "../queries.js";
import { ACTIVITY_LABEL } from "../labels.js";

export const activityRouter = express.Router();

activityRouter.get("/activity", async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = 50;
    const { rows, total } = await activityFor({ limit: pageSize, offset: (page - 1) * pageSize });
    res.render("pages/activity.njk", {
      page: "activity",
      title: "Activity",
      rows,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      labels: ACTIVITY_LABEL,
    });
  } catch (err) {
    next(err);
  }
});
