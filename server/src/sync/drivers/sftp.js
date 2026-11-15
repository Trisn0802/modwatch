import crypto from "node:crypto";
import SftpClient from "ssh2-sftp-client";

function cleanPath(basePath, dir) {
  const base = String(basePath || "").replace(/\/+$/g, "");
  const part = String(dir || "").replace(/^\/+/g, "");
  const full = base ? `${base}/${part}` : part;
  if (!full || full.split("/").includes("..")) throw new Error("The remote path is not safe.");
  return full;
}

export async function connect(connection) {
  const config = connection.config || {};
  const secret = connection.secret || {};
  const host = String(config.host || "").trim();
  if (!host) throw new Error("The connection has no host.");
  const port = Number(config.port) || 22;
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
  if (config.hostFingerprint) {
    options.hostVerifier = (hash) => hash === config.hostFingerprint;
  } else {
    options.hostVerifier = (hash) => { captured = hash; return true; };
  }
  const client = new SftpClient(`modwatch-${connection.name || connection.id || "sftp"}`);
  await client.connect(options);
  return { client, fingerprint: captured || config.hostFingerprint || "" };
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
