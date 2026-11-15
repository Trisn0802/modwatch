import crypto from "node:crypto";
import SftpClient from "ssh2-sftp-client";

function cleanPath(basePath, dir) {
  const base = String(basePath || "").replace(/\/+$/g, "");
  const part = String(dir || "").replace(/^\/+/g, "");
  const full = base ? `${base}/${part}` : part;
  if (!full || full.split("/").includes("..")) throw new Error("The remote path is not safe.");
  return full;
}

export function normalizeFingerprint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[a-f0-9]{64}$/i.test(raw)) return raw.toLowerCase();
  const encoded = raw.replace(/^SHA256:/i, "").replace(/\s+/g, "");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 32) return bytes.toString("hex");
  return raw.toLowerCase();
}

export async function connect(connection) {
  const config = connection.config || {};
  const secret = connection.secret || {};
  const host = String(config.host || "").trim();
  if (!host) throw new Error("The connection has no host.");
  const port = Number(config.port) || 22;
  const pinned = normalizeFingerprint(config.hostFingerprint);
  let captured = "";
  const options = {
    host,
    port,
    username: String(config.username || ""),
    readyTimeout: 20_000,
    hostHash: "sha256",
  };
  if (secret.password) options.password = secret.password;
  if (secret.privateKey) options.privateKey = secret.privateKey;
  if (secret.passphrase) options.passphrase = secret.passphrase;
  if (pinned) {
    options.hostVerifier = (hash) => hash === pinned;
  } else {
    options.hostVerifier = (hash) => { captured = hash; return true; };
  }
  const client = new SftpClient(`modwatch-${connection.name || connection.id || "sftp"}`);
  await client.connect(options);
  return { client, fingerprint: captured || pinned || "" };
}

export async function listFiles(client, connection, dir) {
  const remote = cleanPath(connection.config?.basePath, dir);
  const entries = await client.list(remote);
  return (entries || [])
    .filter((entry) => entry.type !== "d" && /\.jar(?:\.disabled)?$/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: `${remote.replace(/\/+$/g, "")}/${entry.name}`,
      size: Number(entry.size) || 0,
      modifiedAt: entry.modifyTime ? new Date(entry.modifyTime).toISOString() : null,
    }));
}

export async function listDir(client, connection, dir) {
  const remote = cleanPath(connection.config?.basePath, dir);
  const entries = await client.list(remote);
  return (entries || []).map((entry) => ({
    name: entry.name,
    type: entry.type,
    size: Number(entry.size) || 0,
    modifiedAt: entry.modifyTime ? new Date(entry.modifyTime).toISOString() : null,
  }));
}

export async function hashFile(client, remotePath) {
  const stream = client.createReadStream(remotePath);
  const hash = crypto.createHash("sha1");
  let size = 0;
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => { size += chunk.length; hash.update(chunk); });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return { sha1: hash.digest("hex"), size };
}

export async function testConnection(connection, dir = "mods") {
  const { client, fingerprint } = await connect(connection);
  try {
    const files = await listFiles(client, connection, dir);
    return { ok: true, files: files.length, fingerprint };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function close(client) {
  await client?.end().catch(() => {});
}

export function remotePath(connection, dir) {
  return cleanPath(connection.config?.basePath, dir);
}

export async function mkdirRemote(client, connection, dir) {
  const remote = remotePath(connection, dir);
  await client.mkdir(remote, true);
  return remote;
}

export async function existsRemote(client, connection, path) {
  return client.exists(remotePath(connection, path));
}

export async function statRemote(client, connection, path) {
  return client.stat(remotePath(connection, path)).catch(() => null);
}

export async function readRemote(client, connection, path) {
  return client.get(remotePath(connection, path));
}

export async function writeRemote(client, connection, path, localPath) {
  const remote = remotePath(connection, path);
  await client.fastPut(localPath, remote);
  return remote;
}

export async function copyRemote(client, connection, from, to) {
  const data = await client.get(remotePath(connection, from));
  await client.put(data, remotePath(connection, to));
}

export async function renameRemote(client, connection, from, to) {
  await client.rename(remotePath(connection, from), remotePath(connection, to));
}

export async function removeRemote(client, connection, path) {
  await client.delete(remotePath(connection, path)).catch(() => {});
}

export async function hashRemote(client, connection, path) {
  return hashFile(client, remotePath(connection, path));
}
