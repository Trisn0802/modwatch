import Pusher from "pusher";

import { config } from "./config.js";

const enabled = config.pusherReady;
const client = enabled
  ? new Pusher({
      appId: config.pusherAppId,
      key: config.pusherKey,
      secret: config.pusherSecret,
      cluster: config.pusherCluster,
      useTLS: true,
    })
  : null;

export const WORKSPACE_CHANNEL = "private-workspace";

export function realtimeEnabled() {
  return enabled;
}

export function userChannel(userId) {
  return `private-user-${userId}`;
}

export async function broadcast(channel, event, data) {
  if (!client) return false;
  try {
    await client.trigger(channel, event, data);
    return true;
  } catch (err) {
    console.error("pusher trigger:", err.message);
    return false;
  }
}

export async function broadcastRefresh(scope, extra = {}) {
  return broadcast(WORKSPACE_CHANNEL, "refresh", { scope, ...extra });
}

export async function notifyUser(userId, payload) {
  return broadcast(userChannel(userId), "notification", payload);
}

export function authorizeChannel(socketId, channel) {
  if (!client) return null;
  return client.authorizeChannel(socketId, channel);
}

export function realtimeConfig() {
  return {
    enabled,
    key: config.pusherKey,
    cluster: config.pusherCluster,
  };
}
