#!/usr/bin/env node
// Optional demo workspace. Run explicitly: npm run seed:demo
// The Docker stack never runs this on its own. It removes and rebuilds only the
// three demo instances below, leaving other instances and users untouched.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";

import { pool, query, waitForDb, withTransaction } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(here, "demo-catalog.json"), "utf8"));

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "modwatch-demo";
const HOUR = 3_600_000;
const DAY = 86_400_000;

const USERS = [
  { name: "Raka Pradana", email: "demo@modwatch.local", role: "admin", status: "active" },
  { name: "Maya Kusuma", email: "maya@modwatch.local", role: "member", status: "active" },
  { name: "Arif Nugroho", email: "arif@modwatch.local", role: "member", status: "active" },
  { name: "Lena Wijaya", email: "lena@modwatch.local", role: "member", status: "disabled" },
];

const INSTANCES = [
  {
    key: "gugu",
    name: "Gugu Gaga",
    pack_name: "Gugu Gaga",
    pack_version: "1.3.0-testing",
    mc_version: "1.20.1",
    loader: "forge",
    loader_version: "47.4.28",
    notes: "Kitchen-sink pack for the Friday crew. Create and Mekanism stay on release; two private jars are tracked by hand.",
    catalog_key: "gugu",
    take: 40,
    updates: 8,
    ignored: 2,
    error: true,
    checkedHoursAgo: 0.62,
    createdDaysAgo: 42,
  },
  {
    key: "bettermc",
    name: "Better MC [FABRIC]",
    pack_name: "Better MC [FABRIC] 1.21.1",
    pack_version: "31.0.0",
    mc_version: "1.21.1",
    loader: "fabric",
    loader_version: "0.16.9",
    notes: "Client-side performance preset for the shared server. Shader pack lives outside the instance.",
    catalog_key: "bettermc",
    take: 28,
    updates: 4,
    ignored: 1,
    error: true,
    checkedHoursAgo: 2.1,
    createdDaysAgo: 29,
  },
  {
    key: "stoneworks",
    name: "Stoneworks SMP",
    pack_name: "Stoneworks SMP",
    pack_version: "2026.02",
    mc_version: "1.21.4",
    loader: "plugin",
    loader_version: "",
    notes: "Paper plugins for the public survival server. No client mods, no shader stack.",
    catalog_key: "stoneworks",
    take: 16,
    updates: 2,
    ignored: 1,
    error: false,
    checkedHoursAgo: 5.4,
    createdDaysAgo: 17,
  },
];

const ago = (ms) => new Date(Date.now() - ms);
const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");
const sha512 = (text) => crypto.createHash("sha512").update(text).digest("hex");

function sideFor(entry, instance) {
  if (instance.loader === "plugin") return "server";
  if (entry.client === "unsupported") return "server";
  if (entry.server === "unsupported") return "client";
  return "both";
}

function channelFor(version) {
  if (version?.type === "alpha") return "alpha";
  if (version?.type === "beta") return "beta";
  return "release";
}

async function main() {
  await waitForDb();

  const { rows: schemaRows } = await query("SELECT to_regclass('public.users') AS table_name");
  if (!schemaRows[0].table_name) {
    console.error("The ModWatch tables are missing. Start the app once so it can create the schema, then run this again.");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const summary = await withTransaction(async (client) => {
    const userIds = {};
    for (const user of USERS) {
      const { rows } = await client.query(
        `INSERT INTO users (name, email, role, status, password_hash, last_login_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name, role = EXCLUDED.role, status = EXCLUDED.status,
           password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [
          user.name, user.email, user.role, user.status, passwordHash,
          user.status === "active" ? ago(HOUR * 3) : null,
          ago(DAY * 46),
        ]
      );
      userIds[user.email] = rows[0].id;
    }
    const adminId = userIds["demo@modwatch.local"];
    const mayaId = userIds["maya@modwatch.local"];
    const arifId = userIds["arif@modwatch.local"];

    // Rebuild only the demo instances. Cascades clear their mods, unknown files,
    // requests, notifications and check runs.
    const demoIds = INSTANCES.map((item) => item.name);
    await client.query("DELETE FROM instances WHERE name = ANY($1::text[])", [demoIds]);
    await client.query("DELETE FROM activity WHERE meta @> '{\"demo\": true}'::jsonb");

    const state = { instances: {}, mods: [], unknown: [], requests: {}, activity: [] };

    for (const spec of INSTANCES) {
      const lastChecked = ago(HOUR * spec.checkedHoursAgo);
      const createdAt = ago(DAY * spec.createdDaysAgo);
      const { rows } = await client.query(
        `INSERT INTO instances (name, mc_version, loader, loader_version, pack_name, pack_version, notes,
            created_by, last_checked_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          spec.name, spec.mc_version, spec.loader, spec.loader_version, spec.pack_name,
          spec.pack_version, spec.notes, adminId, lastChecked, createdAt,
        ]
      );
      const instance = { ...spec, id: rows[0].id, lastChecked, createdAt };
      state.instances[spec.key] = instance;

      const entries = catalog[spec.catalog_key].slice(0, spec.take);
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        const versions = entry.versions;
        if (!versions.length) continue;

        const isUpdate = index < spec.updates && versions.length > 1;
        const ignoredIndexes = new Set(
          Array.from({ length: spec.ignored }, (_, n) => entries.length - 2 - n)
        );
        const isIgnored = ignoredIndexes.has(index);
        const latest = versions[0];
        const installed = isUpdate ? versions[1] : versions[0];
        const status = isIgnored
          ? "ignored"
          : isUpdate
            ? "update_available"
            : "up_to_date";

        let channelPolicy = channelFor(latest);
        if (channelPolicy === "release" && index % 13 === 0) channelPolicy = "beta";
        if (channelPolicy === "beta" && index % 29 === 0) channelPolicy = "alpha";

        const projectUrl = `https://modrinth.com/mod/${entry.slug}`;
        const fileSha1 = installed.sha1 || sha1(`${spec.key}:${entry.project_id}`);
        const fileSha512 = installed.sha512 || sha512(`${spec.key}:${entry.project_id}`);

        const { rows: modRows } = await client.query(
          `INSERT INTO mods (instance_id, name, side, source, project_id, project_url, github_asset_pattern,
              installed_version, installed_version_id, file_name, file_sha1, file_sha512, file_size,
              channel_policy, status, latest_version, latest_version_id, latest_published_at,
              last_checked_at, last_error, added_by, created_at)
           VALUES ($1,$2,$3,'modrinth',$4,$5,'',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           RETURNING id`,
          [
            instance.id, entry.name, sideFor(entry, instance), entry.project_id, projectUrl,
            installed.version, installed.id, installed.file, fileSha1, fileSha512, installed.size,
            channelPolicy, status, latest.version, latest.id, latest.published,
            lastChecked,
            null,
            adminId, createdAt,
          ]
        );
        const modId = modRows[0].id;

        state.mods.push({
          id: modId,
          instanceKey: spec.key,
          instanceName: spec.name,
          name: entry.name,
          status,
          installed: installed.version,
          latest: latest.version,
          latestId: latest.id,
        });
        if (status === "update_available") {
          state.updateMods = state.updateMods || [];
          state.updateMods.push(state.mods[state.mods.length - 1]);
        }

        const cache = [versions[0], versions[1], versions[2]].filter(Boolean);
        const seenVersions = new Set();
        for (const version of cache) {
          if (seenVersions.has(version.id)) continue;
          seenVersions.add(version.id);
          await client.query(
            `INSERT INTO mod_versions_cache (mod_id, version_id, version_string, channel, mc_versions,
                loaders, published_at, changelog_url, download_page_url, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (mod_id, version_id) DO NOTHING`,
            [
              modId, version.id, version.version, version.type, version.game?.length ? version.game : [spec.mc_version],
              version.loaders?.length ? version.loaders : [spec.loader], version.published,
              version.changelog || "", version.page || "", lastChecked,
            ]
          );
        }
      }

      // CurseForge-sourced entry that fails while no API key is configured, so
      // the Errors tab has a real, stable row.
      if (spec.error) {
        const projectId = spec.key === "gugu" ? "889910" : "889911";
        const slug = spec.key === "gugu" ? "immersive-optimization" : "bettermc-tweaks";
        const { rows: errorRows } = await client.query(
          `INSERT INTO mods (instance_id, name, side, source, project_id, project_url, github_asset_pattern,
              installed_version, file_name, file_sha1, file_sha512, file_size, channel_policy, status,
              latest_version, last_checked_at, last_error, added_by, created_at)
           VALUES ($1,$2,'client','curseforge',$3,$4,'',$5,$6,$7,$8,$9,'release','source_error',
              $5,$10,$11,$12,$13) RETURNING id`,
          [
            instance.id,
            spec.key === "gugu" ? "Immersive Optimization" : "Better MC Tweaks",
            projectId,
            `https://www.curseforge.com/minecraft/mc-mods/${slug}`,
            spec.key === "gugu" ? "2.4.1" : "4.0.2",
            spec.key === "gugu" ? "immersive-optimization-2.4.1.jar" : "bettermc-tweaks-4.0.2.jar",
            sha1(`${projectId}:error`), sha512(`${projectId}:error`), 1_482_112,
            lastChecked,
            "CurseForge is not configured. Add CURSEFORGE_API_KEY to .env.",
            adminId, createdAt,
          ]
        );
        state.mods.push({
          id: errorRows[0].id,
          instanceKey: spec.key,
          instanceName: spec.name,
          name: spec.key === "gugu" ? "Immersive Optimization" : "Better MC Tweaks",
          status: "source_error",
        });
      }
    }

    // Hand-tracked jars: no project page, so they stay manual on purpose.
    const manualMods = [
      { key: "gugu", name: "Luxium", version: "2.8.4-pre-alpha", file: "Luxium-1.20.1-2.8.4-pre-alpha.jar", size: 3_407_872, side: "client", policy: "alpha" },
      { key: "gugu", name: "Godwand", version: "1.4.2", file: "godwand-forge-1.20.1-1.4.2.jar", size: 831_488, side: "both", policy: "release" },
      { key: "gugu", name: "Gugu Tweaks", version: "0.9.7", file: "gugu-tweaks-0.9.7.jar", size: 214_016, side: "both", policy: "release" },
      { key: "bettermc", name: "Better MC Config", version: "31.0.0", file: "bettermc-config-31.0.0.jar", size: 118_784, side: "client", policy: "release" },
      { key: "stoneworks", name: "Stoneworks Core", version: "2026.02.1", file: "stoneworks-core-2026.02.1.jar", size: 692_224, side: "server", policy: "release" },
    ];
    for (const item of manualMods) {
      const instance = state.instances[item.key];
      const { rows } = await client.query(
        `INSERT INTO mods (instance_id, name, side, source, installed_version, file_name, file_sha1, file_sha512,
            file_size, channel_policy, status, latest_version, last_checked_at, added_by, created_at)
         VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9,'manual',$4,$10,$11,$12) RETURNING id`,
        [
          instance.id, item.name, item.side, item.version, item.file,
          sha1(`${item.key}:${item.name}`), sha512(`${item.key}:${item.name}`), item.size,
          item.policy, instance.lastChecked, userIds["maya@modwatch.local"], instance.createdAt,
        ]
      );
      state.mods.push({
        id: rows[0].id, instanceKey: item.key, instanceName: instance.name,
        name: item.name, status: "manual", installed: item.version, latest: item.version,
      });
    }

    // Two unidentified jars in the main pack.
    const gugu = state.instances.gugu;
    const unknownSeed = [
      {
        file: "gugu-voicechat-patch-1.0.3.jar", jar_name: "Gugu Voice Chat Patch", jar_version: "1.0.3",
        jar_id: "guguvoicepatch", loaders: ["forge"], reason: "no_match", age: HOUR * 30,
      },
      {
        file: "wand-durability-fix-2.1.0.jar", jar_name: "Wand Durability Fix", jar_version: "2.1.0",
        jar_id: "wanddurabilityfix", loaders: ["forge"], reason: "curseforge_not_configured", age: HOUR * 30,
      },
    ];
    for (const item of unknownSeed) {
      const { rows } = await client.query(
        `INSERT INTO unknown_mods (instance_id, file_name, file_sha1, file_sha512, file_size,
            jar_mod_id, jar_name, jar_version, jar_loaders, reason, resolution, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING id`,
        [
          gugu.id, item.file, sha1(`${gugu.name}:${item.file}`), sha512(`${gugu.name}:${item.file}`),
          486_912, item.jar_id, item.jar_name, item.jar_version, item.loaders, item.reason, ago(item.age),
        ]
      );
      state.unknown.push({ id: rows[0].id, ...item });
    }

    const requestPayload = (mod) => ({
      ...mod,
      requested_from: "add-mod",
      mc_versions: [state.instances[mod.instance_key].mc_version],
      loaders: [state.instances[mod.instance_key].loader],
      channel: mod.channel_policy,
    });

    const pendingOne = {
      instance_key: "gugu",
      name: "Distant Horizons",
      source: "modrinth",
      project_id: "uCdwusMi",
      project_url: "https://modrinth.com/mod/distanthorizons",
      installed_version: "2.3.4-b",
      installed_version_id: null,
      file_name: "DistantHorizons-2.3.4-b-1.20.1.jar",
      file_sha1: null,
      file_sha512: null,
      file_size: 14_811_136,
      channel_policy: "beta",
      side: "client",
      github_asset_pattern: "",
      published_at: ago(DAY * 2).toISOString(),
      changelog_url: "",
      download_page_url: "",
    };
    const pendingTwo = {
      instance_key: "gugu",
      name: "Wand Durability Fix",
      source: "manual",
      project_id: null,
      project_url: "",
      installed_version: "2.1.0",
      installed_version_id: null,
      file_name: "wand-durability-fix-2.1.0.jar",
      file_sha1: null,
      file_sha512: null,
      file_size: 486_912,
      channel_policy: "release",
      side: "both",
      github_asset_pattern: "",
      published_at: null,
      changelog_url: "",
      download_page_url: "",
    };

    const { rows: pendingRows } = await client.query(
      `INSERT INTO mod_requests (instance_id, requested_by, payload, status, created_at)
       VALUES ($1,$2,$3::jsonb,'pending',$4), ($5,$6,$7::jsonb,'pending',$8) RETURNING id`,
      [
        gugu.id, mayaId, JSON.stringify(requestPayload(pendingOne)), ago(HOUR * 20),
        gugu.id, arifId, JSON.stringify(requestPayload(pendingTwo)), ago(HOUR * 7),
      ]
    );
    state.requests.pendingOne = pendingRows[0].id;
    state.requests.pendingTwo = pendingRows[1].id;

    const { rows: decidedRows } = await client.query(
      `INSERT INTO mod_requests (instance_id, requested_by, payload, status, decided_by, decision_note,
          created_at, decided_at)
       VALUES ($1,$2,$3::jsonb,'approved',$4,$5,$6,$7),
              ($8,$9,$10::jsonb,'rejected',$11,$12,$13,$14) RETURNING id`,
      [
        gugu.id, arifId,
        JSON.stringify(requestPayload({
          ...pendingTwo, name: "Jade Additions", file_name: "jade-additions-1.20.1-1.1.0.jar",
          installed_version: "1.1.0", file_size: 176_128,
        })),
        adminId, "Fits the 1.20.1 scope. Keep it client side.", ago(DAY * 2), ago(DAY * 2 - HOUR),
        state.instances.bettermc.id, mayaId,
        JSON.stringify(requestPayload({
          ...pendingOne, instance_key: "bettermc", name: "OptiFine", source: "manual",
          project_id: null, project_url: "", file_name: "OptiFine_1.21.1_HD_U_I6.jar",
          installed_version: "HD U I6", channel_policy: "release", side: "client",
        })),
        adminId, "Oculus and Embeddium already cover shaders. OptiFine breaks the pack.",
        ago(DAY * 3), ago(DAY * 3 - HOUR * 3),
      ]
    );
    state.requests.approved = decidedRows[0].id;
    state.requests.rejected = decidedRows[1].id;

    // Check runs feed the seven-day chart on the overview.
    const runSeed = [
      { key: "gugu", hours: 0.62, checked: 43, updates: 8, errors: 1, trigger: "schedule" },
      { key: "bettermc", hours: 2.1, checked: 30, updates: 4, errors: 1, trigger: "schedule" },
      { key: "stoneworks", hours: 5.4, checked: 17, updates: 2, errors: 0, trigger: "schedule" },
      { key: "gugu", hours: 24 + 6.2, checked: 43, updates: 7, errors: 1, trigger: "schedule" },
      { key: "bettermc", hours: 48 + 1.4, checked: 30, updates: 3, errors: 1, trigger: "schedule" },
      { key: "stoneworks", hours: 72 + 3.8, checked: 17, updates: 1, errors: 0, trigger: "schedule" },
      { key: "gugu", hours: 96 + 4.5, checked: 42, updates: 5, errors: 1, trigger: "schedule" },
      { key: "bettermc", hours: 120 + 2.2, checked: 29, updates: 2, errors: 1, trigger: "schedule" },
      { key: "gugu", hours: 144 + 5.1, checked: 42, updates: 4, errors: 0, trigger: "manual" },
    ];
    for (const run of runSeed) {
      const started = ago(HOUR * run.hours);
      await client.query(
        `INSERT INTO check_runs (instance_id, trigger, started_at, finished_at, checked, updates, errors)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          state.instances[run.key].id, run.trigger, started,
          new Date(started.getTime() + 46_000), run.checked, run.updates, run.errors,
        ]
      );
    }

    const updates = (state.updateMods || []).filter((mod) => mod.latestId);
    const notificationTime = (index) => ago(HOUR * (0.4 + index * 1.15));
    for (let i = 0; i < Math.min(8, updates.length); i++) {
      const mod = updates[i];
      const instance = state.instances[mod.instanceKey];
      await client.query(
        `INSERT INTO notifications (user_id, instance_id, mod_id, kind, version_id, title, body, created_at, read_at)
         VALUES ($1,$2,$3,'update',$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [
          adminId, instance.id, mod.id, mod.latestId,
          `${mod.name} ${mod.installed} → ${mod.latest}`,
          `${instance.name} · ${instance.loader} ${instance.mc_version}. Open the version board to see the release.`,
          notificationTime(i), i < 5 ? ago(HOUR * 0.2) : null,
        ]
      );
    }
    for (let i = 0; i < Math.min(3, updates.length); i++) {
      const mod = updates[updates.length - 1 - i];
      const instance = state.instances[mod.instanceKey];
      await client.query(
        `INSERT INTO notifications (user_id, instance_id, mod_id, kind, version_id, title, body, created_at, read_at)
         VALUES ($1,$2,$3,'update',$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [
          mayaId, instance.id, mod.id, mod.latestId,
          `${mod.name} ${mod.installed} → ${mod.latest}`,
          `${instance.name} · newer release inside the channel policy.`,
          notificationTime(i + 1), i === 2 ? ago(HOUR * 3) : null,
        ]
      );
    }

    for (const [index, item] of state.unknown.entries()) {
      await client.query(
        `INSERT INTO notifications (user_id, instance_id, kind, title, body, created_at)
         VALUES ($1,$2,'unknown',$3,$4,$5)`,
        [
          adminId, gugu.id, `Unknown jar: ${item.file}`,
          `${item.jar_name || "No metadata inside the jar"} · decide whether to link, keep or ignore it.`,
          ago(HOUR * (18 + index * 9)),
        ]
      );
    }

    await client.query(
      `INSERT INTO notifications (user_id, instance_id, kind, title, body, created_at)
       VALUES ($1,$2,'request',$3,$4,$5)`,
      [
        adminId, gugu.id, "Maya requested Distant Horizons",
        "Gugu Gaga · waiting for an admin decision.", ago(HOUR * 19.5),
      ]
    );
    await client.query(
      `INSERT INTO notifications (user_id, instance_id, kind, title, body, created_at, read_at)
       VALUES ($1,$2,'decision',$3,$4,$5,$6)`,
      [
        mayaId, gugu.id, "Approved: Jade Additions",
        "An admin approved your request in Gugu Gaga.", ago(DAY * 2 - HOUR), ago(DAY * 2 - HOUR),
      ]
    );
    await client.query(
      `INSERT INTO notifications (user_id, instance_id, kind, title, body, created_at, read_at)
       VALUES ($1,$2,'decision',$3,$4,$5,$6)`,
      [
        arifId, gugu.id, "Approved: Jade Additions",
        "An admin approved your request in Gugu Gaga.", ago(DAY * 2 - HOUR), ago(DAY * 2 - HOUR),
      ]
    );
    await client.query(
      `INSERT INTO notifications (user_id, instance_id, kind, title, body, created_at)
       VALUES ($1,$2,'error',$3,$4,$5)`,
      [
        adminId, state.instances.gugu.id, "Immersive Optimization check failed",
        "CurseForge is not configured. Add CURSEFORGE_API_KEY in .env to track this mod.",
        ago(HOUR * 0.5),
      ]
    );
    await client.query(
      `INSERT INTO notifications (user_id, instance_id, kind, title, body, created_at)
       VALUES ($1,$2,'system',$3,$4,$5)`,
      [
        adminId, null, "Demo workspace ready",
        "Three instances, nine days of checks and two unidentified jars are loaded.",
        ago(HOUR * 26),
      ]
    );

    const updateMod = (state.updateMods || [])[0] || state.mods[0];
    const activitySeed = [
      { user: adminId, action: "import", type: "instance", id: gugu.id, meta: { demo: true, file: "Gugu Gaga-1.3.0-testing.mrpack", counts: { mods: 142, identified: 140, unknown: 2 } }, at: ago(DAY * 3 + HOUR * 4) },
      { user: adminId, action: "instance_created", type: "instance", id: state.instances.stoneworks.id, meta: { demo: true, name: "Stoneworks SMP", mcVersion: "1.21.4", loader: "plugin" }, at: ago(DAY * 5) },
      { user: mayaId, action: "mod_added", type: "mod", id: state.mods.find((m) => m.instanceKey === "bettermc")?.id || null, meta: { demo: true, name: "Sodium", instance: "Better MC [FABRIC]" }, at: ago(DAY * 2 + HOUR) },
      { user: adminId, action: "unknown_resolved", type: "instance", id: gugu.id, meta: { demo: true, file: "gugu-voicechat-patch-1.0.3.jar", resolution: "manual" }, at: ago(DAY + HOUR * 5) },
      { user: mayaId, action: "request_created", type: "request", id: state.requests.pendingOne, meta: { demo: true, mod: "Distant Horizons", instance: "Gugu Gaga" }, at: ago(HOUR * 20) },
      { user: adminId, action: "settings_updated", type: "settings", id: null, meta: { demo: true, key: "check_interval_hours", value: 6 }, at: ago(HOUR * 8) },
      { user: adminId, action: "request_approved", type: "request", id: state.requests.approved, meta: { demo: true, mod: "Jade Additions", instance: "Gugu Gaga" }, at: ago(DAY * 2 - HOUR) },
      { user: adminId, action: "request_rejected", type: "request", id: state.requests.rejected, meta: { demo: true, mod: "OptiFine", note: "Oculus and Embeddium already cover shaders." }, at: ago(DAY * 3 - HOUR * 3) },
      { user: arifId, action: "login", type: "user", id: arifId, meta: { demo: true }, at: ago(HOUR * 4.4) },
      { user: mayaId, action: "mod_updated", type: "mod", id: updateMod?.id || null, meta: { demo: true, name: updateMod?.name || "", from: updateMod?.installed || "", to: updateMod?.latest || "" }, at: ago(HOUR * 2.6) },
      { user: adminId, action: "check_run", type: "instance", id: gugu.id, meta: { demo: true, trigger: "schedule", checked: 43, updates: 8, errors: 1 }, at: ago(HOUR * 0.55) },
      { user: adminId, action: "user_created", type: "user", id: mayaId, meta: { demo: true, name: "Maya Kusuma", email: "maya@modwatch.local", role: "member" }, at: ago(DAY * 7) },
    ];
    for (const entry of activitySeed) {
      await client.query(
        `INSERT INTO activity (user_id, action, subject_type, subject_id, meta, created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [entry.user, entry.action, entry.type, entry.id, JSON.stringify(entry.meta), entry.at]
      );
    }

    return {
      users: USERS.length,
      instances: INSTANCES.length,
      mods: state.mods.length,
      updates: (state.updateMods || []).length,
      unknown: state.unknown.length,
      requests: 4,
    };
  });

  console.log("");
  console.log("ModWatch demo workspace");
  console.log(`  ${summary.instances} instances · ${summary.mods} mods · ${summary.updates} updates · ${summary.unknown} unknown jars`);
  console.log("");
  console.log("  Admin   demo@modwatch.local  /  " + DEMO_PASSWORD);
  console.log("  Member  maya@modwatch.local  /  " + DEMO_PASSWORD);
  console.log("  Member  arif@modwatch.local  /  " + DEMO_PASSWORD);
  console.log("");
  console.log("Run again to rebuild the three demo instances. Other instances are left alone.");
}

main()
  .catch((err) => {
    console.error("Demo seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
