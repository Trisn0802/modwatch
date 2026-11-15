import { query } from "./db.js";
import { discardPreview } from "./import.js";

export async function createImportRequest(preview, {
  userId,
  selectedFiles = [],
  instanceId = null,
  mode = "new",
  selectedProjects = {},
} = {}) {
  const { rows } = await query(
    `INSERT INTO import_requests
       (token, requested_by, instance_id, mode, file_name, pack_name, pack_version,
        mc_version, loader, loader_version, counts, selected_files, selected_projects)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb)
     ON CONFLICT (token) DO UPDATE
       SET selected_files = EXCLUDED.selected_files,
           selected_projects = EXCLUDED.selected_projects,
           counts = EXCLUDED.counts,
           expires_at = GREATEST(import_requests.expires_at, EXCLUDED.expires_at)
     RETURNING *`,
    [
      preview.token,
      userId,
      instanceId,
      mode === "update" ? "update" : "new",
      preview.file_name || "",
      preview.pack?.name || "",
      preview.pack?.version || "",
      preview.pack?.mc_version || "",
      preview.pack?.loader || "",
      preview.pack?.loader_version || "",
      JSON.stringify(preview.counts || {}),
      selectedFiles,
      JSON.stringify(selectedProjects || {}),
    ]
  );
  return rows[0];
}

export async function importRequestByToken(token) {
  const { rows } = await query(
    `SELECT r.*, u.name AS requester_name, u.email AS requester_email,
            i.name AS instance_name
       FROM import_requests r
       JOIN users u ON u.id = r.requested_by
       LEFT JOIN instances i ON i.id = r.instance_id
      WHERE r.token = $1`,
    [token]
  );
  return rows[0] || null;
}

export async function importRequestById(id) {
  const { rows } = await query(
    `SELECT r.*, u.name AS requester_name, u.email AS requester_email,
            i.name AS instance_name
       FROM import_requests r
       JOIN users u ON u.id = r.requested_by
       LEFT JOIN instances i ON i.id = r.instance_id
      WHERE r.id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function pendingImportRequests() {
  const { rows } = await query(
    `SELECT r.*, u.name AS requester_name, u.email AS requester_email,
            i.name AS instance_name
       FROM import_requests r
       JOIN users u ON u.id = r.requested_by
       LEFT JOIN instances i ON i.id = r.instance_id
      WHERE r.status = 'pending'
      ORDER BY r.created_at ASC`
  );
  return rows;
}

export async function decidedImportRequests(limit = 15) {
  const { rows } = await query(
    `SELECT r.*, u.name AS requester_name, d.name AS decider_name,
            i.name AS instance_name
       FROM import_requests r
       JOIN users u ON u.id = r.requested_by
       LEFT JOIN users d ON d.id = r.decided_by
       LEFT JOIN instances i ON i.id = r.instance_id
      WHERE r.status <> 'pending'
      ORDER BY r.decided_at DESC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function expireImportRequests() {
  const { rows } = await query(
    `UPDATE import_requests SET status = 'expired', decided_at = now()
      WHERE status = 'pending' AND expires_at < now()
      RETURNING token`
  );
  for (const row of rows) {
    await discardPreview(row.token).catch(() => {});
  }
  return rows.length;
}

export async function countPendingImportRequests() {
  const { rows } = await query("SELECT count(*)::int AS n FROM import_requests WHERE status = 'pending'");
  return rows[0]?.n || 0;
}
