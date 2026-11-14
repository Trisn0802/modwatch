import express from "express";

import { subscribeLocal } from "../bus.js";

export const eventsRouter = express.Router();

// Server-Sent Events fallback for realtime updates. Pusher remains the primary
// transport; this stream keeps the UI live if the hosted service is unreachable.
eventsRouter.get("/api/events", (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).end();

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 3000\n\n");

  const allowed = new Set(["private-workspace", `private-user-${user.id}`]);
  const write = (chunk) => {
    if (!res.writableEnded && !res.destroyed) res.write(chunk);
  };
  const off = subscribeLocal(({ channel, event, data }) => {
    if (!allowed.has(channel)) return;
    write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  });
  const heartbeat = setInterval(() => write(": ping\n\n"), 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    off();
  });
});
