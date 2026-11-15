import express from "express";

import { isProgressOp, subscribeProgress } from "../progress.js";

export const progressRouter = express.Router();

progressRouter.get("/api/progress/:op", (req, res) => {
  if (!isProgressOp(req.params.op)) return res.status(404).end();
  subscribeProgress(req.params.op, req, res);
});
