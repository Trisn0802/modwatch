import { query } from "./db.js";

export async function logActivity({ userId = null, action, subjectType = "", subjectId = null, meta = {} }) {
  await query(
    `INSERT INTO activity (user_id, action, subject_type, subject_id, meta)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, action, subjectType, subjectId, JSON.stringify(meta)]
  ).catch((err) => console.error("activity log failed:", err.message));
}

export async function recentActivity(limit = 8) {
  const { rows } = await query(
    `SELECT a.*, u.name AS user_name, u.avatar_path AS user_avatar
       FROM activity a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function activityFeed({ limit = 50, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT a.*, u.name AS user_name, u.avatar_path AS user_avatar
       FROM activity a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: countRows } = await query("SELECT count(*)::int AS n FROM activity");
  return { rows, total: countRows[0].n };
}
