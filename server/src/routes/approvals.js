import express from "express";
import { query, withTransaction } from "../db.js";
import { requireAdmin, flash } from "../middleware.js";
import { createNotifications } from "../notify.js";
import { logActivity } from "../activity.js";
import { insertMod } from "../mod-service.js";
import { checkOne } from "../checker.js";
import { LOADER, SOURCE } from "../labels.js";

export const approvalsRouter = express.Router();

approvalsRouter.use("/approvals", requireAdmin);

approvalsRouter.get("/approvals", async (req, res, next) => {
  try {
    const { rows: pending } = await query(
      `SELECT r.*, u.name AS requester_name, u.email AS requester_email, i.name AS instance_name
         FROM mod_requests r
         JOIN users u ON u.id = r.requested_by
         JOIN instances i ON i.id = r.instance_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at ASC`
    );
    const { rows: decided } = await query(
      `SELECT r.*, u.name AS requester_name, i.name AS instance_name, d.name AS decider_name
         FROM mod_requests r
         JOIN users u ON u.id = r.requested_by
         JOIN instances i ON i.id = r.instance_id
         LEFT JOIN users d ON d.id = r.decided_by
        WHERE r.status <> 'pending'
        ORDER BY r.decided_at DESC NULLS LAST
        LIMIT 15`
    );
    res.render("pages/approvals.njk", {
      page: "approvals",
      title: "Approvals",
      pending,
      decided,
      sourceLabels: SOURCE,
      loaderLabels: LOADER,
    });
  } catch (err) {
    next(err);
  }
});

approvalsRouter.post("/approvals/:id/approve", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT r.*, i.name AS instance_name FROM mod_requests r
           JOIN instances i ON i.id = r.instance_id
          WHERE r.id = $1 AND r.status = 'pending' FOR UPDATE`,
        [id]
      );
      const request = rows[0];
      if (!request) return null;
      const modId = await insertMod(request.instance_id, request.payload, request.requested_by);
      await client.query(
        `UPDATE mod_requests SET status = 'approved', decided_by = $2, decision_note = $3,
           mod_id = $4, decided_at = now() WHERE id = $1`,
        [id, req.session.user.id, String(req.body.note || "").trim(), modId]
      );
      return { request, modId };
    });
    if (!result) {
      flash(req, "error", "That request is no longer pending.");
      return res.redirect("/approvals");
    }
    const { request, modId } = result;
    checkOne(modId, { userId: req.session.user.id }).catch(() => {});
    await createNotifications({
      kind: "decision",
      instanceId: request.instance_id,
      modId,
      title: `Approved: ${request.payload.name}`,
      body: `An admin approved your request in ${request.instance_name}.`,
      userIds: [request.requested_by],
    });
    await logActivity({
      userId: req.session.user.id, action: "request_approved", subjectType: "request", subjectId: id,
      meta: { mod: request.payload.name, instance: request.instance_name },
    });
    flash(req, "ok", `${request.payload.name} approved and added. A check is running.`);
    res.redirect("/approvals");
  } catch (err) {
    if (err.code === "23505") {
      flash(req, "error", "That project is already tracked in the instance. The request was left pending.");
      return res.redirect("/approvals");
    }
    next(err);
  }
});

approvalsRouter.post("/approvals/:id/reject", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const note = String(req.body.note || "").trim();
    const { rows } = await query(
      `SELECT r.*, i.name AS instance_name FROM mod_requests r
         JOIN instances i ON i.id = r.instance_id
        WHERE r.id = $1 AND r.status = 'pending'`,
      [id]
    );
    const request = rows[0];
    if (!request) {
      flash(req, "error", "That request is no longer pending.");
      return res.redirect("/approvals");
    }
    await query(
      `UPDATE mod_requests SET status = 'rejected', decided_by = $2, decision_note = $3,
         decided_at = now() WHERE id = $1`,
      [id, req.session.user.id, note]
    );
    await createNotifications({
      kind: "decision",
      instanceId: request.instance_id,
      title: `Rejected: ${request.payload.name}`,
      body: note ? `Note from the admin: ${note}` : `Your request in ${request.instance_name} was rejected.`,
      userIds: [request.requested_by],
    });
    await logActivity({
      userId: req.session.user.id, action: "request_rejected", subjectType: "request", subjectId: id,
      meta: { mod: request.payload.name, instance: request.instance_name, note },
    });
    flash(req, "ok", `Request for ${request.payload.name} rejected.`);
    res.redirect("/approvals");
  } catch (err) {
    next(err);
  }
});
