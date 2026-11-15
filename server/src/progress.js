import crypto from "node:crypto";

const OP_RE = /^[a-f0-9-]{36}$/;
const MAX_EVENTS = 200;
const MAX_CHANNELS = 200;
const CHANNEL_TTL = 5 * 60_000;

const channels = new Map();

function prune() {
  const now = Date.now();
  for (const [op, channel] of channels) {
    if (channel.doneAt && now - channel.doneAt > CHANNEL_TTL) channels.delete(op);
  }
  while (channels.size > MAX_CHANNELS) {
    const oldest = [...channels.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (!oldest) break;
    channels.delete(oldest[0]);
  }
}

function channelFor(op) {
  let channel = channels.get(op);
  if (!channel) {
    channel = { events: [], clients: new Set(), touchedAt: Date.now(), doneAt: 0 };
    channels.set(op, channel);
    prune();
  }
  channel.touchedAt = Date.now();
  return channel;
}

export function isProgressOp(value) {
  return OP_RE.test(String(value || ""));
}

export function newProgressOp() {
  return crypto.randomUUID();
}

export function publishProgress(op, event = {}) {
  if (!isProgressOp(op)) return;
  const channel = channelFor(op);
  const payload = { at: Date.now(), ...event };
  channel.events.push(payload);
  if (channel.events.length > MAX_EVENTS) channel.events.shift();
  const frame = `event: progress\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of channel.clients) {
    try {
      client.write(frame);
    } catch {
      channel.clients.delete(client);
    }
  }
  if (payload.stage === "done" || payload.stage === "error") channel.doneAt = Date.now();
}

export function subscribeProgress(op, req, res) {
  if (!isProgressOp(op)) return false;
  const channel = channelFor(op);
  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 2000\n\n");
  for (const event of channel.events) {
    res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
  }
  channel.clients.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    channel.clients.delete(res);
  });
  return true;
}

export function finishProgress(op, message = "Done") {
  publishProgress(op, { stage: "done", percent: 100, message });
}

export function failProgress(op, message = "The operation failed.", meta = {}) {
  publishProgress(op, { stage: "error", message, ...meta });
}

// Keep the map from growing when a browser disconnects mid-operation.
const sweeper = setInterval(prune, 60_000);
sweeper.unref?.();
