import * as amp from "./drivers/amp.js";
import * as pterodactyl from "./drivers/pterodactyl.js";
import * as sftp from "./drivers/sftp.js";

export async function createRemote(connection, target) {
  if (!connection) throw new Error("The sync connection was not found.");
  if (connection.driver === "pterodactyl") {
    const serverId = String(target.remote_ref || "").trim();
    if (!serverId) throw new Error("This target has no Pterodactyl server UUID.");
    return {
      kind: "pterodactyl",
      stopTimeoutMs: 360_000,
      power: {
        configured: pterodactyl.pterodactylConfigured(connection) && Boolean(serverId),
        status: () => pterodactyl.status(connection, serverId),
        start: () => pterodactyl.start(connection, serverId),
        stop: () => pterodactyl.stop(connection, serverId),
        isStarted: (state) => state.state === "running",
        isStopped: (state) => state.state === "offline",
      },
      players: () => pterodactyl.players(connection, serverId),
      files: {
        listDir: (dir) => pterodactyl.listDir(connection, serverId, dir),
        read: (file) => pterodactyl.readFile(connection, serverId, file),
        write: (file, localPath) => pterodactyl.writeFile(connection, serverId, file, localPath),
        copy: (from, to) => pterodactyl.copyFile(connection, serverId, from, to),
        rename: (from, to) => pterodactyl.renameFile(connection, serverId, from, to),
        remove: (file) => pterodactyl.removeFile(connection, serverId, file),
        exists: (file) => pterodactyl.existsFile(connection, serverId, file),
        hash: (file) => pterodactyl.hashFile(connection, serverId, file),
        mkdir: (dir) => pterodactyl.mkdir(connection, serverId, dir),
      },
      close: async () => {},
    };
  }

  if (connection.driver !== "sftp") {
    throw new Error(`The ${connection.driver} driver is not available in this build.`);
  }
  const { client, fingerprint } = await sftp.connect(connection);
  return {
    kind: "sftp",
    fingerprint,
    stopTimeoutMs: 180_000,
    power: {
      configured: amp.ampConfigured(connection),
      status: () => amp.appStatus(connection),
      start: () => amp.appStart(connection),
      stop: () => amp.appStop(connection),
      isStarted: (state) => Boolean(state.gameListening) || Number(state.state) === 20,
      isStopped: (state) => Number(state.state) === 0 && !state.gameListening,
    },
    players: async () => Number((await amp.appStatus(connection)).players || 0),
    files: {
      listDir: (dir) => sftp.listDir(client, connection, dir),
      read: (file) => sftp.readRemote(client, connection, file),
      write: (file, localPath) => sftp.writeRemote(client, connection, file, localPath),
      copy: (from, to) => sftp.copyRemote(client, connection, from, to),
      rename: (from, to) => sftp.renameRemote(client, connection, from, to),
      remove: (file) => sftp.removeRemote(client, connection, file),
      exists: (file) => sftp.existsRemote(client, connection, file),
      hash: (file) => sftp.hashRemote(client, connection, file),
      mkdir: (dir) => sftp.mkdirRemote(client, connection, dir),
    },
    close: () => sftp.close(client),
  };
}
