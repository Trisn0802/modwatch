import { query } from "./db.js";

export async function instanceSummaries() {
  const { rows } = await query(
    `SELECT i.*,
       count(m.id)::int AS mod_count,
       count(*) FILTER (WHERE m.status = 'update_available')::int AS updates,
       count(*) FILTER (WHERE m.status = 'up_to_date')::int AS up_to_date,
       count(*) FILTER (WHERE m.status = 'manual')::int AS manual,
       count(*) FILTER (WHERE m.status = 'source_error')::int AS errors,
       count(*) FILTER (WHERE m.status = 'ignored')::int AS ignored
     FROM instances i
     LEFT JOIN mods m ON m.instance_id = i.id
     GROUP BY i.id
     ORDER BY updates DESC, i.name`
  );
  return rows;
}

export async function unknownCounts() {
  const { rows } = await query(
    `SELECT instance_id, count(*)::int AS n
       FROM unknown_mods
      WHERE resolution = 'pending'
      GROUP BY instance_id`
  );
  return new Map(rows.map((r) => [r.instance_id, r.n]));
}

export async function overviewStats() {
  const totals = await query(
    `SELECT
       (SELECT count(*)::int FROM instances) AS instances,
       (SELECT count(*)::int FROM mods) AS mods,
       (SELECT count(*)::int FROM mods WHERE status = 'update_available') AS updates,
       (SELECT count(*)::int FROM unknown_mods WHERE resolution = 'pending') AS unknown,
       (SELECT count(*)::int FROM mod_requests WHERE status = 'pending') AS requests`
  );
  return totals.rows[0];
}

export async function navStats(user) {
  const { rows } = await query(
    `SELECT
       (SELECT count(*)::int FROM mods WHERE status = 'update_available') AS updates,
       (SELECT count(*)::int FROM unknown_mods WHERE resolution = 'pending') AS unknown,
       ((SELECT count(*)::int FROM mod_requests WHERE status = 'pending')
        + (SELECT count(*)::int FROM import_requests WHERE status = 'pending')) AS requests,
       (SELECT count(*)::int FROM notifications WHERE user_id = $1 AND read_at IS NULL) AS unread`,
    [user?.id || 0]
  );
  return rows[0];
}

export async function updatesByDay(days = 7) {
  const { rows } = await query(
    `SELECT d::date AS day,
            (count(DISTINCT (n.mod_id, n.version_id)) FILTER (WHERE n.id IS NOT NULL))::int AS updates,
            (count(DISTINCT c.id) FILTER (WHERE c.id IS NOT NULL))::int AS runs
       FROM generate_series(current_date - ($1::int - 1), current_date, '1 day') d
       LEFT JOIN notifications n
         ON n.kind = 'update' AND n.created_at::date = d::date
       LEFT JOIN check_runs c
         ON c.started_at::date = d::date AND c.finished_at IS NOT NULL
      GROUP BY d
      ORDER BY d`,
    [days]
  );
  return rows;
}

export async function monthlyActivity(months = 12) {
  const { rows } = await query(
    `WITH span AS (
       SELECT generate_series(
         date_trunc('month', current_date) - (($1::int - 1) || ' months')::interval,
         date_trunc('month', current_date),
         '1 month'
       ) AS month
     )
     SELECT month::date AS month,
       (SELECT count(DISTINCT (n.mod_id, n.version_id)) FILTER (WHERE n.id IS NOT NULL)
          FROM notifications n
         WHERE n.kind = 'update' AND date_trunc('month', n.created_at) = span.month)::int AS updates,
       (SELECT count(*)
          FROM activity a
         WHERE a.action = 'mod_updated'
           AND a.meta->>'downloaded' = 'true'
           AND date_trunc('month', a.created_at) = span.month)::int AS downloads
     FROM span ORDER BY month`,
    [months]
  );
  return rows;
}

export async function recentCheckRuns(limit = 5) {
  const { rows } = await query(
    `SELECT c.*, i.name AS instance_name
       FROM check_runs c
       LEFT JOIN instances i ON i.id = c.instance_id
      ORDER BY c.started_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function pendingRequestsCount() {
  const { rows } = await query("SELECT count(*)::int AS n FROM mod_requests WHERE status = 'pending'");
  return rows[0].n;
}

export async function instanceById(id) {
  const { rows } = await query("SELECT * FROM instances WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function instanceStats(id) {
  const { rows } = await query(
    `SELECT
       count(*)::int AS mod_count,
       count(*) FILTER (WHERE status = 'update_available')::int AS updates,
       count(*) FILTER (WHERE status = 'up_to_date')::int AS up_to_date,
       count(*) FILTER (WHERE status = 'manual')::int AS manual,
       count(*) FILTER (WHERE status = 'source_error')::int AS errors,
       count(*) FILTER (WHERE status = 'ignored')::int AS ignored
     FROM mods WHERE instance_id = $1`,
    [id]
  );
  const row = rows[0];
  const { rows: unknown } = await query(
    "SELECT count(*)::int AS n FROM unknown_mods WHERE instance_id = $1 AND resolution = 'pending'",
    [id]
  );
  row.unknown = unknown[0].n;
  return row;
}

export async function unknownMods(instanceId) {
  const { rows } = await query(
    `SELECT * FROM unknown_mods
      WHERE instance_id = $1 AND resolution = 'pending'
      ORDER BY created_at DESC`,
    [instanceId]
  );
  return rows;
}

export async function notificationsFor(userId, { filter = "all", limit = 100 } = {}) {
  const params = [userId];
  let where = "n.user_id = $1";
  if (filter === "unread") where += " AND n.read_at IS NULL";
  const { rows } = await query(
    `SELECT n.*, i.name AS instance_name, m.name AS mod_name, m.disabled AS mod_disabled
       FROM notifications n
       LEFT JOIN instances i ON i.id = n.instance_id
       LEFT JOIN mods m ON m.id = n.mod_id
      WHERE ${where}
      ORDER BY n.created_at DESC
      LIMIT ${Number(limit)}`,
    params
  );
  return rows;
}

export function notificationHref(n) {
  if (n.kind === "sync" && n.sync_job_id) return `/sync-jobs/${n.sync_job_id}`;
  if (n.kind === "account") return "/settings/account";
  if (n.kind === "request") return "/approvals";
  if (n.mod_id) return `/mods/${n.mod_id}`;
  if (n.instance_id) return `/instances/${n.instance_id}`;
  if (n.kind === "decision") return "/instances";
  return "/notifications";
}

export async function activityFor({ limit = 40, offset = 0 }) {
  const { rows } = await query(
    `SELECT a.*, u.name AS user_name, u.avatar_path AS user_avatar,
            i.name AS instance_name, m.name AS mod_name
       FROM activity a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN instances i ON a.subject_type = 'instance' AND i.id = a.subject_id
       LEFT JOIN mods m ON a.subject_type = 'mod' AND m.id = a.subject_id
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: count } = await query("SELECT count(*)::int AS n FROM activity");
  return { rows, total: count[0].n };
}
