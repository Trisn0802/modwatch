import crypto from "node:crypto";

import { config } from "../config.js";

const ALGORITHM = "aes-256-gcm";

function key() {
  const raw = String(config.syncSecretKey || "").trim();
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw Object.assign(new Error("SYNC_SECRET_KEY is missing. Add a 32-byte hex key to .env before saving connection credentials."), {
      code: "SYNC_KEY",
    });
  }
  return Buffer.from(raw, "hex");
}

export function syncKeyReady() {
  try { key(); return true; } catch { return false; }
}

export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value || {}), "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decryptSecret(value) {
  if (!value) return {};
  const [ivPart, tagPart, dataPart] = String(value).split(".");
  if (!ivPart || !tagPart || !dataPart) throw new Error("The stored connection secret is not valid.");
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  const text = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(text);
}
