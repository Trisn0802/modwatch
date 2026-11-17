import express from "express";
import { query, withTransaction } from "../db.js";
import { requireAdmin, flash } from "../middleware.js";
import { createNotifications } from "../notify.js";
import { logActivity } from "../activity.js";
import { insertMod } from "../mod-service.js";
import { checkOne } from "../checker.js";
import { LOADER, SOURCE } from "../labels.js";
import { loadPreview, discardPreview, createInstanceFromPreview, applyTreeSelection } from "../import.js";
import { applyPackUpdate, saveUpdateResult } from "../pack-update.js";
import { instanceById } from "../queries.js";
import { checkInstance } from "../checker.js";
import {
  decidedImportRequests, expireImportRequests, importRequestById, pendingImportRequests,
} from "../import-requests.js";
import { decidedRoleRequests, pendingRoleRequests } from "../role-requests.js";

export const approvalsRouter = express.Router();

approvalsRouter.use("/approvals", requireAdmin);

approvalsRouter.get("/approvals", async (req, res, next) => {
  try {
    await expireImportRequests().catch(() => {});
    const importPending = await pendingImportRequests();
    const importDecided = await decidedImportRequests();
    const rolePending = await pendingRoleRequests();
    const roleDecided = await decidedRoleRequests();
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
      importPending,
      importDecided,
      rolePending,
      roleDecided,
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
      const modId = await insertMod(request.instance_id, request.payload, request.requested_by, client);
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
    flash(req, "ok", `${request.payload.name} approved and added. A check is running.${String(req.body.note || "").trim() ? ` Note: ${String(req.body.note).trim()}` : ""}`);
    res.redirect("/approvals");
  } catch (err) {
    if (err.code === "23505") {
      flash(req, "error", "That project is already tracked in the instance. The request was left pending.");
      return res.redirect("/approvals");
    }
    next(err);
  }
});

approvalsRouter.post("/approvals/roles/:id/approve", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const note = String(req.body.note || "").trim();
    const request = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT r.*, u.name AS requester_name, u.email AS requester_email, u.role AS current_role, u.status AS account_status
           FROM role_requests r
           JOIN users u ON u.id = r.user_id
          WHERE r.id = $1 AND r.status = 'pending' FOR UPDATE`,
        [id]
      );
      const found = rows[0];
      if (!found) return null;
      await client.query("UPDATE users SET role = 'admin' WHERE id = $1", [found.user_id]);
      await client.query(
        `UPDATE role_requests SET status = 'approved', decided_by = $2, decision_note = $3, decided_at = now()
          WHERE id = $1`,
        [id, req.session.user.id, note]
      );
      await client.query(
        `UPDATE role_requests SET status = 'cancelled', decided_by = $2, decision_note = $3, decided_at = now()
          WHERE user_id = $1 AND status = 'pending' AND id <> $4`,
        [found.user_id, req.session.user.id, "Another role request was approved.", id]
      );
      return found;
    });
    if (!request) {
      flash(req, "error", "That role request is no longer pending.");
      return res.redirect("/approvals");
    }
    await createNotifications({
      kind: "decision",
      title: "Admin role approved",
      body: note ? `An admin approved your request: ${note}` : "An admin approved your request. You can now manage instances, users and approvals.",
      userIds: [request.user_id],
      extra: { roleChanged: true },
    });
    await logActivity({
      userId: req.session.user.id, action: "role_approved", subjectType: "role_request", subjectId: id,
      meta: { user: request.requester_name, email: request.requester_email, note },
    });
    flash(req, "ok", `${request.requester_name} is now an admin.${note ? ` Note: ${note}` : ""}`);
    res.redirect("/approvals");
  } catch (err) {
    next(err);
  }
});

approvalsRouter.post("/approvals/roles/:id/reject", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const note = String(req.body.note || "").trim();
    const { rows } = await query(
      `SELECT r.*, u.name AS requester_name, u.email AS requester_email
         FROM role_requests r
         JOIN users u ON u.id = r.user_id
        WHERE r.id = $1 AND r.status = 'pending'`,
      [id]
    );
    const request = rows[0];
    if (!request) {
      flash(req, "error", "That role request is no longer pending.");
      return res.redirect("/approvals");
    }
    await query(
      `UPDATE role_requests SET status = 'rejected', decided_by = $2, decision_note = $3, decided_at = now()
        WHERE id = $1`,
      [id, req.session.user.id, note]
    );
    await createNotifications({
      kind: "decision",
      title: "Admin role declined",
      body: note ? `Note from the admin: ${note}` : "An admin declined your request for the admin role.",
      userIds: [request.user_id],
    });
    await logActivity({
      userId: req.session.user.id, action: "role_rejected", subjectType: "role_request", subjectId: id,
      meta: { user: request.requester_name, email: request.requester_email, note },
    });
    flash(req, "ok", `Admin request from ${request.requester_name} declined.${note ? ` Note: ${note}` : ""}`);
    res.redirect("/approvals");
  } catch (err) {
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
    flash(req, "ok", `Request for ${request.payload.name} rejected.${note ? ` Note: ${note}` : ""}`);
    res.redirect("/approvals");
  } catch (err) {
    next(err);
  }
});

function selectedCount(tree) {
  const count = (nodes) => nodes.reduce((sum, node) => sum + (node.type === "folder" ? count(node.children) : node.selectable && node.defaultChecked ? 1 : 0), 0);
  return count(tree || []);
}

approvalsRouter.get("/approvals/imports/:id", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return next();
    const request = await importRequestById(id);
    if (!request || request.status !== "pending") {
      flash(req, "error", "That import request is no longer pending.");
      return res.redirect("/approvals");
    }
    const preview = await loadPreview(request.token);
    if (!preview) {
      await query("UPDATE import_requests SET status = 'expired', decided_at = now() WHERE id = $1", [id]);
      flash(req, "error", "The uploaded pack expired. Ask the member to upload it again.");
      return res.redirect("/approvals");
    }
    if (request.mode === "update") {
      const instance = await instanceById(request.instance_id);
      if (!instance) {
        flash(req, "error", "The instance for that update no longer exists.");
        return res.redirect("/approvals");
      }
      return res.render("pages/import-update-preview.njk", {
        page: "approvals",
        title: `Review update for ${instance.name}`,
        instance,
        preview,
        diff: preview.diff,
        token: request.token,
        reviewRequest: request,
        isAdmin: true,
        selectedProjects: request.selected_projects || {},
        selectedFiles: request.selected_files || [],
      });
    }
    applyTreeSelection(preview.tree, request.selected_files);
    const { rows: existing } = await query(
      "SELECT id, name, mc_version, loader FROM instances WHERE lower(name) = lower($1) AND loader = $2",
      [preview.pack.name, preview.pack.loader]
    );
    res.render("pages/import-preview.njk", {
      page: "approvals",
      title: `Review ${preview.pack.name}`,
      preview,
      token: request.token,
      reviewRequest: request,
      request,
      isAdmin: true,
      existing,
      treeJson: JSON.stringify(preview.tree || []).replace(/</g, "\\u003c"),
      selectedFileCount: selectedCount(preview.tree),
    });
  } catch (err) {
    next(err);
  }
});

approvalsRouter.post("/approvals/imports/:id/approve", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const request = await importRequestById(id);
    if (!request || request.status !== "pending") {
      flash(req, "error", "That import request is no longer pending.");
      return res.redirect("/approvals");
    }
    const preview = await loadPreview(request.token);
    if (!preview) {
      await query("UPDATE import_requests SET status = 'expired', decided_at = now() WHERE id = $1", [id]);
      flash(req, "error", "The uploaded pack expired. Ask the member to upload it again.");
      return res.redirect("/approvals");
    }
    if (request.mode === "update") {
      const instance = await instanceById(request.instance_id);
      if (!instance) {
        flash(req, "error", "The instance for that update no longer exists.");
        return res.redirect("/approvals");
      }
      const selectedProjects = {};
      for (const [key, value] of Object.entries(req.body)) {
        if (key.startsWith("action__")) selectedProjects[key.slice(8)] = String(value);
      }
      const selectedFiles = [].concat(req.body.files || []).map((value) => String(value || "")).filter(Boolean);
      const summary = await applyPackUpdate(
        preview,
        instance,
        preview.diff,
        { projects: selectedProjects, files: selectedFiles },
        { userId: req.session.user.id }
      );
      await discardPreview(request.token);
      await query(
        `UPDATE import_requests SET status = 'approved', decided_by = $2, decision_note = $3,
           instance_id = $4, decided_at = now() WHERE id = $1`,
        [id, req.session.user.id, String(req.body.note || "").trim(), instance.id]
      );
      const resultToken = await saveUpdateResult(summary);
      await createNotifications({
        kind: "decision",
        instanceId: instance.id,
        title: `Approved update: ${instance.name}`,
        body: `Your pack update was applied to ${instance.name}.`,
        userIds: [request.requested_by],
      });
      await logActivity({
        userId: req.session.user.id, action: "import_update_approved", subjectType: "request", subjectId: id,
        meta: { pack: preview.pack.name, instance: instance.name, updated: summary.updated.length, added: summary.added.length },
      });
      flash(req, "ok", `${instance.name}: ${summary.updated.length} updated, ${summary.added.length} added.`);
      return res.redirect(`/instances/${instance.id}/import/result/${resultToken}`);
    }
    const mode = req.body.mode === "update" ? "update" : "new";
    const existingId = Number.parseInt(req.body.existing_id, 10) || null;
    const selectedFiles = [].concat(req.body.files || []).map((value) => String(value || "").trim()).filter(Boolean);
    const result = await createInstanceFromPreview(preview, {
      userId: req.session.user.id,
      mode,
      existingId,
      selectedFiles,
    });
    await discardPreview(request.token);
    await query(
      `UPDATE import_requests SET status = 'approved', decided_by = $2, decision_note = $3,
         instance_id = $4, decided_at = now() WHERE id = $1`,
      [id, req.session.user.id, String(req.body.note || "").trim(), result.instance.id]
    );
    checkInstance(result.instance.id, { trigger: "import", userId: req.session.user.id }).catch((err) =>
      console.error("post-import check:", err.message)
    );
    await createNotifications({
      kind: "decision",
      instanceId: result.instance.id,
      title: `Approved: ${preview.pack.name}`,
      body: `Your pack import was approved in ${result.instance.name}.`,
      userIds: [request.requested_by],
    });
    await logActivity({
      userId: req.session.user.id, action: "import_request_approved", subjectType: "request", subjectId: id,
      meta: { pack: preview.pack.name, instance: result.instance.name },
    });
    flash(req, "ok", `${result.instance.name}: ${result.added} projects added, ${result.filesAdded} pack files stored.`);
    res.redirect(`/instances/${result.instance.id}`);
  } catch (err) {
    next(err);
  }
});

approvalsRouter.post("/approvals/imports/:id/reject", async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const request = await importRequestById(id);
    if (!request || request.status !== "pending") {
      flash(req, "error", "That import request is no longer pending.");
      return res.redirect("/approvals");
    }
    const note = String(req.body.note || "").trim();
    await query(
      `UPDATE import_requests SET status = 'rejected', decided_by = $2, decision_note = $3,
         decided_at = now() WHERE id = $1`,
      [id, req.session.user.id, note]
    );
    await discardPreview(request.token);
    await createNotifications({
      kind: "decision",
      title: `Rejected: ${request.pack_name}`,
      body: note ? `Note from the admin: ${note}` : "Your pack import was rejected.",
      userIds: [request.requested_by],
    });
    await logActivity({
      userId: req.session.user.id, action: "import_request_rejected", subjectType: "request", subjectId: id,
      meta: { pack: request.pack_name, note },
    });
    flash(req, "ok", `Import request for ${request.pack_name} rejected.`);
    res.redirect("/approvals");
  } catch (err) {
    next(err);
  }
});
