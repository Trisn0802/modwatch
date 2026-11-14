import { query } from "./db.js";
import { config } from "./config.js";

const DEFAULTS = {
  check_interval_hours: config.checkIntervalHours,
  default_channel_policy: "release",
  telegram_chat_id: config.telegramChatId || "",
  telegram_enabled: config.telegramReady,
  curseforge_enabled: config.curseforgeReady,
};

export async function ensureSettings() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }
}

export async function getSettings() {
  const { rows } = await query("SELECT key, value FROM settings");
  const out = { ...DEFAULTS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

export async function getSetting(key) {
  const { rows } = await query("SELECT value FROM settings WHERE key = $1", [key]);
  return rows.length ? rows[0].value : DEFAULTS[key];
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

export function nextCheckAt(intervalHours, lastCheckedAt) {
  const base = lastCheckedAt ? new Date(lastCheckedAt).getTime() : Date.now();
  return new Date(base + Math.max(1, Number(intervalHours || 6)) * 3_600_000);
}
