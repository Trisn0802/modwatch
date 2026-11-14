import { config } from "../config.js";

const USER_AGENT = `ModWatch/1.0 (${config.contact})`;

const cache = new Map();

export function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;
  const value = Promise.resolve()
    .then(loader)
    .then((result) => {
      cache.set(key, { value: result, expires: Date.now() + ttlMs });
      return result;
    })
    .catch((err) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

export function clearSourceCache() {
  cache.clear();
}

export async function requestJson(url, { method = "GET", headers = {}, body, retries = 2, timeoutMs = 20_000 } = {}) {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
          ...headers,
        },
        body,
        signal: controller.signal,
      });
      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers.get("retry-after") || 2);
        await new Promise((r) => setTimeout(r, Math.min(15, Math.max(1, retryAfter)) * 1000));
        attempt += 1;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const error = new Error(`${res.status} ${res.statusText}${text ? `: ${text.slice(0, 180)}` : ""}`);
        error.status = res.status;
        throw error;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

export { USER_AGENT };
