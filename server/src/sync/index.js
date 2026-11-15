import fs from "node:fs";
import crypto from "node:crypto";

import { query } from "../db.js";
import { jarAbsolute } from "../uploads.js";
import { decryptSecret } from "./crypto.js";
import { lookupByHash } from "../sources/modrinth.js";
import { buildPlan } from "./plan.js";
import { createRemote } from "./remote.js";
import * as pterodactyl from "./drivers/pterodactyl.js";
import * as sftp from "./drivers/sftp.js";

function connectionWithSecret(row) {
  if (!row) return null;
  let secret = {};
  if (row.secret_enc) secret = decryptSecret(row.secret_enc);
  return {
    ...row,
    config: row.config || {},
    secret,
  };
}

export async function syncConnectionById(id) {
  const { rows } = await query("SELECT * FROM sync_connections WHERE id = $1", [id]);
  return connectionWithSecret(rows[0]);
}

export async function syncConnectionList() {
  const { rows } = await query(
    `SELECT id, name, driver, config, last_test_at, last_test_ok, last_test_error,
            (secret_enc IS NOT NULL) AS has_secret
       FROM sync_connections ORDER BY name`
  );
  return rows;
}

export async function syncTargetById(id) {
  const { rows } = await query(
    `SELECT t.*, c.name AS connection_name, c.driver, c.config AS connection_config
       FROM sync_targets t JOIN sync_connections c ON c.id = t.connection_id
      WHERE t.id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function syncTargetsForInstance(instanceId) {
  const { rows } = await query(
    `SELECT t.*, c.name AS connection_name, c.driver
       FROM sync_targets t JOIN sync_connections c ON c.id = t.connection_id
      WHERE t.instance_id = $1 ORDER BY t.name`,
    [instanceId]
  );
  return rows;
}

async function mapProjects(observed) {
  const hashes = [...new Set(observed.map((file) => file.sha1).filter(Boolean))];
  const map = new Map();
  if (!hashes.length) return map;
  try {
    const versions = await lookupByHash(hashes.slice(0, 500));
    for (const [hash, version] of versions) {
      if (version.project_id) map.set(hash, version.project_id);
    }
  } catch {}
  return map;
}

async function desiredMods(instanceId, sides) {
  const { rows } = await query(
    `SELECT id, name, kind, side, status, disabled, file_name, file_sha1, installed_version, stored_path, download_url, project_id
       FROM mods
      WHERE instance_id = $1 AND kind = 'mod' AND status <> 'ignored'
        AND side = ANY($2::text[])
      ORDER BY name`,
    [instanceId, sides]
  );
  return rows.map((mod) => {
    const absolute = jarAbsolute(mod.stored_path);
    let sha1 = mod.file_sha1 || "";
    if (absolute && !sha1) {
      try { sha1 = crypto.createHash("sha1").update(fs.readFileSync(absolute)).digest("hex"); } catch {}
    }
    return {
      id: mod.id,
      name: mod.name,
      file_name: mod.file_name,
      file_sha1: sha1,
      project_id: mod.project_id || null,
      installed_version: mod.installed_version,
      disabled: Boolean(mod.disabled),
      kind: mod.kind,
      side: mod.side,
      stored: Boolean(absolute),
      available: Boolean(absolute) || Boolean(mod.download_url),
      download_url: mod.download_url || "",
    };
  });
}

export async function scanTarget(targetId, { onProgress } = {}) {
  const report = (event) => { try { onProgress?.(event); } catch {} };
  const target = await syncTargetById(targetId);
  if (!target) throw new Error("Sync target not found.");
  const connection = await syncConnectionById(target.connection_id);
  if (!connection) throw new Error("Sync connection not found.");
  const desired = await desiredMods(target.instance_id, target.sides);
  const where = connection.driver === "pterodactyl" ? "the panel API" : `${connection.config?.host || "the server"} over SFTP`;
  report({ stage: "connect", message: `Connecting to ${where}`, percent: 10 });
  const remote = await createRemote(connection, target);
  const fingerprint = remote.fingerprint || "";
  let observed = [];
  try {
    report({ stage: "list", message: `Listing ${target.mods_path || "mods"}`, percent: 20 });
    const files = (await remote.files.listDir(target.mods_path || "mods").catch(() => [])).filter(
      (file) => file.type !== "d" && /\.jar(?:\.disabled)?$/i.test(file.name)
    );
    const { rows: cached } = await query(
      "SELECT path, file_name, size, sha1 FROM sync_remote_files WHERE target_id = $1",
      [target.id]
    );
    const cache = new Map(cached.map((row) => [row.path, row]));
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const prior = cache.get(file.path);
      let sha1 = "";
      if (prior && Number(prior.size) === Number(file.size) && prior.sha1) {
        sha1 = prior.sha1;
      } else {
        report({
          stage: "hash",
          message: `Hashing ${file.name} (${index + 1}/${files.length})`,
          percent: 25 + Math.round(((index + 1) / Math.max(1, files.length)) * 55),
        });
        const hashed = await remote.files.hash(file.path);
        sha1 = hashed.sha1;
        file.size = hashed.size;
      }
      observed.push({ ...file, sha1 });
    }
  } finally {
    await remote.close();
  }
  report({ stage: "plan", message: "Building the diff", percent: 90 });
  const projectByHash = await mapProjects(observed);
  for (const file of observed) file.projectId = projectByHash.get(file.sha1) || null;
  const plan = buildPlan(desired, observed);
  const summary = {
    counts: plan.counts,
    warnings: plan.warnings,
    items: plan.items,
    desired: desired.length,
    observed: observed.length,
    scanned_at: new Date().toISOString(),
    connection: connection.name,
  };
  await query(
    "UPDATE sync_targets SET last_scan_at = now(), last_scan_summary = $2::jsonb WHERE id = $1",
    [target.id, JSON.stringify(summary)]
  );
  await query("DELETE FROM sync_remote_files WHERE target_id = $1", [target.id]);
  for (const file of observed) {
    await query(
      `INSERT INTO sync_remote_files (target_id, path, file_name, size, sha1, scanned_at)
       VALUES ($1,$2,$3,$4,$5,now())`,
      [target.id, file.path, file.name, file.size, file.sha1]
    );
  }
  if (fingerprint && !connection.config?.hostFingerprint) {
    await query(
      "UPDATE sync_connections SET config = config || jsonb_build_object('hostFingerprint', $2::text) WHERE id = $1",
      [connection.id, fingerprint]
    );
  }
  report({ stage: "done", message: `Scanned ${observed.length} jars; ${plan.counts.add + plan.counts.replace} changes`, percent: 100 });
  return { target, connection, desired, observed, plan, summary, fingerprint };
}

export async function testSyncConnection(id, dir = "mods", serverId = "") {
  const connection = await syncConnectionById(id);
  if (!connection) throw new Error("Connection not found.");
  if (connection.driver === "pterodactyl") {
    const result = await pterodactyl.test(connection, serverId);
    await query(
      "UPDATE sync_connections SET last_test_at = now(), last_test_ok = true, last_test_error = NULL WHERE id = $1",
      [id]
    );
    return result;
  }
  if (connection.driver !== "sftp") throw new Error(`The ${connection.driver} driver is not available in this build.`);
  const result = await sftp.testConnection(connection, dir);
  await query(
    "UPDATE sync_connections SET last_test_at = now(), last_test_ok = true, last_test_error = NULL WHERE id = $1",
    [id]
  );
  if (result.fingerprint && !connection.config?.hostFingerprint) {
    await query(
      "UPDATE sync_connections SET config = config || jsonb_build_object('hostFingerprint', $2::text) WHERE id = $1",
      [id, result.fingerprint]
    );
  }
  return result;
}
