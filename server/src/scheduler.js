import { query } from "./db.js";
import { getSettings } from "./settings.js";
import { checkAll } from "./checker.js";
import { broadcastScheduler } from "./realtime.js";

let timer = null;
let lastRun = null;
let running = false;

export function schedulerState() {
  return { lastRun, nextRun: timer?._nextRun || null, running };
}

function announce() {
  const state = schedulerState();
  broadcastScheduler({
    running: state.running,
    nextRun: state.nextRun ? new Date(state.nextRun).toISOString() : null,
    lastRun: state.lastRun ? new Date(state.lastRun).toISOString() : null,
  }).catch(() => {});
}

async function tick() {
  if (running) return;
  running = true;
  announce();
  try {
    const settings = await getSettings();
    const hours = Math.max(1, Number(settings.check_interval_hours || 6));
    console.log(`Scheduled check started (every ${hours}h)`);
    await checkAll({ trigger: "schedule" });
    lastRun = new Date();
    console.log("Scheduled check finished");
  } catch (err) {
    console.error("Scheduled check failed:", err.message);
  } finally {
    running = false;
    await scheduleNext();
  }
}

export async function scheduleNext() {
  if (timer) clearTimeout(timer);
  const settings = await getSettings();
  const hours = Math.max(1, Number(settings.check_interval_hours || 6));
  const delay = hours * 3_600_000;
  timer = setTimeout(tick, delay);
  timer._nextRun = new Date(Date.now() + delay);
  announce();
}

export async function startScheduler() {
  const settings = await getSettings();
  const hours = Math.max(1, Number(settings.check_interval_hours || 6));
  const interval = hours * 3_600_000;

  // A restart must not trigger an immediate full sweep when a check just ran.
  // Honour the last finished run and only fall back to the 90s warm-up on a
  // database that has never completed one.
  let delay = 90_000;
  try {
    const { rows } = await query(
      "SELECT max(finished_at) AS last FROM check_runs WHERE finished_at IS NOT NULL"
    );
    const last = rows[0]?.last ? new Date(rows[0].last).getTime() : 0;
    if (last) {
      lastRun = new Date(last);
      delay = Math.max(90_000, Math.min(interval, last + interval - Date.now()));
    }
  } catch (err) {
    console.error("Scheduler start:", err.message);
  }

  timer = setTimeout(tick, delay);
  timer._nextRun = new Date(Date.now() + delay);
  announce();
  console.log(`Scheduler armed: next check in ${Math.round(delay / 60_000)}m, then every ${hours}h`);
}

export function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}
