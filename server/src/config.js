import path from "node:path";
import dotenv from "dotenv";

dotenv.config();
// Running from server/: the production .env lives one folder up.
dotenv.config({ path: path.resolve(process.cwd(), "..", ".env") });

const numberEnv = (value, fallback) => {
  if (value == null || String(value).trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const nodeEnv = process.env.NODE_ENV || "development";
const devUrl = nodeEnv !== "production" ? process.env.DEV_DATABASE_URL : "";
const devPort = nodeEnv !== "production" ? process.env.DEV_PORT : "";

export const config = {
  port: Number(process.env.PORT || devPort || 3000),
  databaseUrl:
    process.env.DATABASE_URL ||
    devUrl ||
    "postgres://modwatch:modwatch@localhost:5432/modwatch",
  sessionSecret: process.env.SESSION_SECRET || "modwatch-dev-secret-change-me",
  nodeEnv,
  trustProxy: process.env.TRUST_PROXY === "1",
  appUrl: (process.env.APP_URL || "").replace(/\/$/, ""),
  adminName: process.env.ADMIN_NAME || "Admin",
  adminEmail: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD || "",
  checkIntervalHours: Math.max(1, numberEnv(process.env.CHECK_INTERVAL_HOURS, 6)),
  maxUploadMb: Math.max(1, numberEnv(process.env.MAX_UPLOAD_MB, 100)),
  curseforgeApiKey: process.env.CURSEFORGE_API_KEY || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  webhookUrl: (process.env.WEBHOOK_URL || "").trim(),
  pusherAppId: process.env.PUSHER_APP_ID || "",
  pusherKey: process.env.PUSHER_KEY || "",
  pusherSecret: process.env.PUSHER_SECRET || "",
  pusherCluster: process.env.PUSHER_CLUSTER || "ap1",
  appVersion: process.env.APP_VERSION || "1.0",
  get contact() {
    return this.appUrl || this.adminEmail || "self-hosted";
  },
  get telegramReady() {
    return Boolean(this.telegramBotToken && this.telegramChatId);
  },
  get webhookReady() {
    return Boolean(this.webhookUrl);
  },
  get pusherReady() {
    return Boolean(this.pusherAppId && this.pusherKey && this.pusherSecret && this.pusherCluster);
  },
  get curseforgeReady() {
    return Boolean(this.curseforgeApiKey);
  },
  get curseforgeFallback() {
    return true;
  },
};
