import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err.message);
});

export const query = (text, params) => pool.query(text, params);

export async function waitForDb(attempts = 40, delayMs = 1000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`Waiting for PostgreSQL (${i}/${attempts})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Cross-process guard for long jobs (scheduler, manual checks).
export async function tryAdvisoryLock(key) {
  const client = await pool.connect();
  const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [key]);
  if (!rows[0].locked) {
    client.release();
    return null;
  }
  return async () => {
    await client.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => {});
    client.release();
  };
}
