import { query } from "./db.js";
import { config } from "./config.js";
import { getSettings } from "./settings.js";
import { notifyUser } from "./realtime.js";

const KIND_LABEL = {
  update: "Update",
  unknown: "Unknown file",
  request: "Request",
  decision: "Decision",
  account: "Account",
  error: "Error",
  system: "System",
  sync: "Server sync",
};

export function notificationTitle(kind, title) {
  return `${KIND_LABEL[kind] || "Notice"}: ${title}`;
}

export async function createNotifications({ kind, instanceId = null, modId = null, versionId = null, syncJobId = null, meta = {}, title, body = "", userIds = null, extra = {} }) {
  let targets = userIds;
  if (!targets) {
    const { rows } = await query("SELECT id FROM users WHERE status = 'active'");
    targets = rows.map((r) => r.id);
  }
  for (const userId of targets) {
    let id = null;
    try {
      const { rows } = await query(
        `INSERT INTO notifications (user_id, instance_id, mod_id, kind, version_id, sync_job_id, meta, title, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [userId, instanceId, modId, kind, versionId, syncJobId, JSON.stringify(meta || {}), title, body]
      );
      id = rows[0]?.id ?? null;
    } catch (err) {
      console.error("notification failed:", err.message);
    }
    const unread = await unreadCount(userId).catch(() => null);
    await notifyUser(userId, {
      id,
      unread,
      kind,
      title,
      body,
      instanceId,
      modId,
      versionId,
      syncJobId,
      meta,
      createdAt: new Date().toISOString(),
      ...extra,
    });
  }
}

export async function unreadCount(userId) {
  const { rows } = await query(
    "SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL",
    [userId]
  );
  return rows[0].n;
}

export async function notificationFeed(userId, limit = 8) {
  const { rows } = await query(
    `SELECT n.*, i.name AS instance_name, i.image_path AS instance_image,
            m.name AS mod_name, m.disabled AS mod_disabled,
            m.icon_url AS icon_url, m.source AS source, m.project_id AS project_id
       FROM notifications n
       LEFT JOIN instances i ON i.id = n.instance_id
       LEFT JOIN mods m ON m.id = n.mod_id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  const unread = await unreadCount(userId);
  return { items: rows, unread };
}

// Notifications are delivered through MyWebhook, which owns the Telegram bot
// and chat pairing. The endpoint is editable in Settings → Notifications.
export async function telegramSend(text) {
  const settings = await getSettings();
  const url = String(settings.webhook_url || config.webhookUrl || "").trim();
  const enabled = settings.webhook_enabled ?? settings.telegram_enabled;
  if (!enabled || !url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ message: text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error("webhook send failed:", res.status, (await res.text().catch(() => "")).slice(0, 180));
      return false;
    }
    return true;
  } catch (err) {
    console.error("webhook send failed:", err.message);
    return false;
  }
}
