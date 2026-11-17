import { query } from "./db.js";

export async function pendingRoleRequests() {
  const { rows } = await query(
    `SELECT r.*, u.name AS requester_name, u.email AS requester_email, u.role AS current_role, u.status AS account_status
       FROM role_requests r
       JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pending'
      ORDER BY r.created_at ASC`
  );
  return rows;
}

export async function decidedRoleRequests(limit = 15) {
  const { rows } = await query(
    `SELECT r.*, u.name AS requester_name, u.email AS requester_email, d.name AS decider_name
       FROM role_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users d ON d.id = r.decided_by
      WHERE r.status <> 'pending'
      ORDER BY r.decided_at DESC NULLS LAST
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function createRoleRequest(userId, note = "") {
  const { rows } = await query(
    `INSERT INTO role_requests (user_id, note)
     VALUES ($1, $2)
     ON CONFLICT (user_id) WHERE status = 'pending' DO NOTHING
     RETURNING *`,
    [userId, String(note || "").trim().slice(0, 500)]
  );
  return rows[0] || null;
}

export async function resolveRoleRequest(userId, status, deciderId, note = "", run = query) {
  await run(
    `UPDATE role_requests SET status = $2, decided_by = $3, decision_note = $4, decided_at = now()
      WHERE user_id = $1 AND status = 'pending'`,
    [userId, status, deciderId, String(note || "").trim().slice(0, 500)]
  );
}
