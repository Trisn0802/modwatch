const sessions = new Map();

function endpoint(connection) {
  const raw = String(connection.config?.ampUrl || "http://127.0.0.1:8080").replace(/\/+$/g, "");
  return raw;
}

function cacheKey(connection, base = endpoint(connection)) {
  return `${base}|${connection.config?.ampUsername || ""}`;
}

async function login(connection, base = endpoint(connection)) {
  const url = base;
  const username = String(connection.config?.ampUsername || "").trim();
  const password = String(connection.secret?.ampPassword || "");
  if (!username || !password) throw new Error("AMP username and password are not configured on this connection.");
  const response = await fetch(`${url}/API/Core/Login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ username, password, token: "", rememberMe: false }),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.sessionID) {
    throw new Error(data.Message || data.Title || "AMP login failed.");
  }
  const session = { id: data.sessionID, at: Date.now() };
  sessions.set(cacheKey(connection, base), session);
  return session;
}

async function sessionFor(connection, force = false, base = endpoint(connection)) {
  const cached = sessions.get(cacheKey(connection, base));
  if (!force && cached && Date.now() - cached.at < 25 * 60_000) return cached;
  return login(connection, base);
}

async function call(connection, module, method, args = {}, retry = true) {
  const session = await sessionFor(connection);
  const response = await fetch(`${endpoint(connection)}/API/${module}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ SESSIONID: session.id, ...args }),
  });
  const data = await response.json().catch(() => ({}));
  if (retry && data?.Title && /session|login/i.test(`${data.Title} ${data.Message || ""}`)) {
    await sessionFor(connection, true);
    return call(connection, module, method, args, false);
  }
  if (data?.Title && /error|invalid|missing|denied|permission/i.test(`${data.Title} ${data.Message || ""}`)) {
    throw new Error(data.Message || data.Title);
  }
  return data;
}

function ampInstance(connection) {
  return String(connection.config?.ampInstance || "").trim();
}

export async function status(connection) {
  const name = ampInstance(connection);
  if (!name) throw new Error("The AMP instance name is not configured.");
  const list = await call(connection, "ADSModule", "GetLocalInstances");
  const found = (Array.isArray(list) ? list : []).find(
    (item) => item.InstanceName === name || item.FriendlyName === name || item.InstanceID === name
  );
  if (!found) throw new Error(`AMP instance ${name} was not found.`);
  const detail = await call(connection, "ADSModule", "GetInstance", { InstanceId: found.InstanceID }).catch(() => null);
  const players = Number(detail?.Metrics?.["Active Users"]?.RawValue || 0);
  const instanceUrl = String(connection.config?.ampInstanceUrl || "").replace(/\/+$/, "")
    || `http://${detail?.IP || "127.0.0.1"}:${detail?.Port || 8083}`;
  return {
    name: found.InstanceName,
    running: Boolean(found.Running),
    id: found.InstanceID,
    appState: found.AppState,
    players,
    instanceUrl,
  };
}

export async function start(connection) {
  const name = ampInstance(connection);
  if (!name) throw new Error("The AMP instance name is not configured.");
  await call(connection, "ADSModule", "StartInstance", { InstanceName: name });
}

export async function stop(connection) {
  const name = ampInstance(connection);
  if (!name) throw new Error("The AMP instance name is not configured.");
  await call(connection, "ADSModule", "StopInstance", { InstanceName: name });
}

async function instanceCall(connection, method, args = {}, retry = true) {
  const state = await status(connection);
  const base = state.instanceUrl;
  const session = await sessionFor(connection, false, base);
  const response = await fetch(`${base}/API/Core/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ SESSIONID: session.id, ...args }),
  });
  const data = await response.json().catch(() => ({}));
  if (retry && data?.Title && /session|login/i.test(`${data.Title} ${data.Message || ""}`)) {
    await sessionFor(connection, true, base);
    return instanceCall(connection, method, args, false);
  }
  if (data?.Title && /error|invalid|missing|denied|permission/i.test(`${data.Title} ${data.Message || ""}`)) {
    throw new Error(data.Message || data.Title);
  }
  return data;
}

export async function appStatus(connection) {
  const state = await status(connection);
  const data = await instanceCall(connection, "GetStatus").catch(() => null);
  const game = data?.Ports?.find?.((port) => port.Name === "Game Port");
  return {
    ...state,
    state: Number(data?.State ?? state.appState ?? 0),
    running: Boolean(game?.Listening) || Number(data?.State) === 20,
    players: Number(data?.Metrics?.["Active Users"]?.RawValue ?? state.players ?? 0),
    gameListening: Boolean(game?.Listening),
  };
}

export async function appStop(connection) {
  await instanceCall(connection, "Stop");
}

export async function appStart(connection) {
  await instanceCall(connection, "Start");
}

export async function test(connection) {
  const state = await status(connection);
  return { ok: true, instance: state.name, running: state.running };
}

export function ampConfigured(connection) {
  return Boolean(connection.config?.ampUrl && connection.config?.ampUsername && connection.secret?.ampPassword && connection.config?.ampInstance);
}
