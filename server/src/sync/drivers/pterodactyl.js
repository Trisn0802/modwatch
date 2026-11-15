import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function panelUrl(connection) {
  return String(connection.config?.panelUrl || "").replace(/\/+$/g, "");
}

function apiKey(connection) {
  return String(connection.secret?.apiKey || "").trim();
}

export function pterodactylConfigured(connection) {
  return Boolean(panelUrl(connection) && apiKey(connection));
}

function serverBase(connection, serverId) {
  const id = String(serverId || "").trim();
  if (!id) throw new Error("The target has no Pterodactyl server UUID.");
  return `/api/client/servers/${encodeURIComponent(id)}`;
}

async function request(connection, method, endpoint, { json, raw, expect = "json" } = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey(connection)}`,
    Accept: "application/json",
  };
  let body;
  if (raw !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    body = raw;
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const response = await fetch(`${panelUrl(connection)}${endpoint}`, { method, headers, body });
  if (response.status === 204) return null;
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) {
    const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.code || text.slice(0, 200) || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (expect === "text") return text;
  return data;
}

function serverPath(connection, serverId, suffix) {
  return `${serverBase(connection, serverId)}${suffix}`;
}

function remoteDir(dir) {
  const clean = String(dir || "").replace(/^\/+|\/+$/g, "");
  return clean ? `/${clean}` : "/";
}

function parentOf(file) {
  const dir = path.posix.dirname(String(file || ""));
  return dir === "." ? "/" : `/${dir.replace(/^\/+/, "")}`;
}

export async function status(connection, serverId) {
  const data = await request(connection, "GET", serverPath(connection, serverId, "/resources"));
  const state = String(data?.attributes?.current_state || "offline");
  return {
    name: serverId,
    state,
    running: state === "running",
    gameListening: state === "running",
    suspended: Boolean(data?.attributes?.is_suspended),
    players: 0,
  };
}

export async function start(connection, serverId) {
  await request(connection, "POST", serverPath(connection, serverId, "/power"), { json: { signal: "start" } });
}

export async function stop(connection, serverId) {
  await request(connection, "POST", serverPath(connection, serverId, "/power"), { json: { signal: "stop" } });
}

export async function restart(connection, serverId) {
  await request(connection, "POST", serverPath(connection, serverId, "/power"), { json: { signal: "restart" } });
}

export async function listServers(connection) {
  const data = await request(connection, "GET", "/api/client");
  return (data?.data || []).map((item) => ({
    id: item.attributes?.identifier,
    uuid: item.attributes?.uuid,
    name: item.attributes?.name,
    state: item.attributes?.status,
  }));
}

export async function test(connection, serverId = "") {
  if (!pterodactylConfigured(connection)) {
    throw new Error("Panel URL and client API key are required for a Pterodactyl connection.");
  }
  if (serverId) {
    const state = await status(connection, serverId);
    const files = await listDir(connection, serverId, "mods").catch(() => []);
    return { ok: true, kind: "pterodactyl", files: files.filter((file) => file.type !== "d").length, state: state.state };
  }
  const servers = await listServers(connection);
  return { ok: true, kind: "pterodactyl", files: servers.length, servers };
}

export async function listDir(connection, serverId, dir) {
  const directory = remoteDir(dir);
  const data = await request(
    connection,
    "GET",
    serverPath(connection, serverId, `/files/list?directory=${encodeURIComponent(directory)}`)
  );
  const clean = String(dir || "").replace(/^\/+|\/+$/g, "");
  return (data?.data || []).map((item) => ({
    name: item.attributes?.name || "",
    path: clean ? `${clean}/${item.attributes?.name}` : item.attributes?.name,
    type: item.attributes?.is_file ? "f" : "d",
    size: Number(item.attributes?.size) || 0,
    modifiedAt: item.attributes?.modified_at || null,
  }));
}

export async function readFile(connection, serverId, file) {
  const target = `/${String(file || "").replace(/^\/+/, "")}`;
  const data = await request(
    connection,
    "GET",
    serverPath(connection, serverId, `/files/download?file=${encodeURIComponent(target)}`)
  );
  const url = data?.attributes?.url;
  if (!url) throw new Error("The panel did not return a download URL.");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`The file download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

export async function writeFile(connection, serverId, file, localPath) {
  const buffer = await fs.promises.readFile(localPath);
  const target = `/${String(file || "").replace(/^\/+/, "")}`;
  await request(
    connection,
    "POST",
    serverPath(connection, serverId, `/files/write?file=${encodeURIComponent(target)}`),
    { raw: buffer }
  );
  return buffer.length;
}

export async function copyFile(connection, serverId, from, to) {
  const buffer = await readFile(connection, serverId, from);
  await writeBuffer(connection, serverId, to, buffer);
}

async function writeBuffer(connection, serverId, file, buffer) {
  const target = `/${String(file || "").replace(/^\/+/, "")}`;
  await request(
    connection,
    "POST",
    serverPath(connection, serverId, `/files/write?file=${encodeURIComponent(target)}`),
    { raw: buffer }
  );
}

export async function renameFile(connection, serverId, from, to) {
  await request(connection, "PUT", serverPath(connection, serverId, "/files/rename"), {
    json: {
      root: parentOf(from),
      files: [{ from: path.posix.basename(from), to: path.posix.basename(to) }],
    },
  });
}

export async function removeFile(connection, serverId, file) {
  await request(connection, "POST", serverPath(connection, serverId, "/files/delete"), {
    json: { root: parentOf(file), files: [path.posix.basename(file)] },
  }).catch(() => {});
}

export async function existsFile(connection, serverId, file) {
  const parent = path.posix.dirname(String(file || ""));
  const entries = await listDir(connection, serverId, parent === "." ? "" : parent).catch(() => []);
  return entries.some((entry) => entry.name === path.posix.basename(file));
}

export async function mkdir(connection, serverId, dir) {
  const wanted = String(dir || "").replace(/^\/+|\/+$/g, "");
  if (!wanted) return;
  const parts = wanted.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    const parent = current ? `/${current}` : "/";
    current = current ? `${current}/${part}` : part;
    const entries = await listDir(connection, serverId, current).catch(() => null);
    if (entries === null) {
      await request(connection, "POST", serverPath(connection, serverId, "/files/create-folder"), {
        json: { root: parent, name: part },
      }).catch(() => {});
    }
  }
}

export async function hashFile(connection, serverId, file) {
  const buffer = await readFile(connection, serverId, file);
  return { sha1: crypto.createHash("sha1").update(buffer).digest("hex"), size: buffer.length };
}

export async function players(connection, serverId) {
  const buffer = await readFile(connection, serverId, "logs/latest.log").catch(() => null);
  if (!buffer) return 0;
  const text = buffer.toString("utf8");
  const boot = text.lastIndexOf("Starting minecraft server version");
  const session = boot === -1 ? text : text.slice(boot);
  const joined = (session.match(/ joined the game/g) || []).length;
  const left = (session.match(/ left the game/g) || []).length;
  return Math.max(0, joined - left);
}
