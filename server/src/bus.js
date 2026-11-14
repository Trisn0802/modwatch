import { EventEmitter } from "node:events";

// In-process fan-out for Server-Sent Events. Pusher stays the cross-process
// transport; this bus keeps realtime working when the hosted service is down.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publishLocal(channel, event, data) {
  bus.emit("event", { channel, event, data });
}

export function subscribeLocal(listener) {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
