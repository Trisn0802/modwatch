function baseName(name) {
  return String(name || "").replace(/\.disabled$/i, "");
}

function remoteDisabled(name) {
  return /\.disabled$/i.test(String(name || ""));
}

export function buildPlan(desired, observed) {
  const items = [];
  const warnings = [];
  const used = new Set();
  const bySha1 = new Map();
  const byName = new Map();
  const byProject = new Map();
  for (const file of observed) {
    if (file.sha1) {
      if (!bySha1.has(file.sha1)) bySha1.set(file.sha1, []);
      bySha1.get(file.sha1).push(file);
    }
    const key = baseName(file.name).toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(file);
    if (file.projectId) {
      if (!byProject.has(file.projectId)) byProject.set(file.projectId, []);
      byProject.get(file.projectId).push(file);
    }
  }

  for (const mod of desired) {
    const name = baseName(mod.file_name || `${mod.name}.jar`);
    const key = name.toLowerCase();
    const remote = (mod.file_sha1 ? (bySha1.get(mod.file_sha1) || [])[0] : null)
      || (mod.project_id ? (byProject.get(mod.project_id) || [])[0] : null)
      || (byName.get(key) || [])[0]
      || null;
    if (remote) used.add(remote.path);

    if (!mod.available) {
      items.push({
        modId: mod.id, name: mod.name, version: mod.installed_version || "", action: "blocked",
        file: name, oldFile: "", reason: "No stored jar and no download URL",
      });
      continue;
    }
    if (!remote) {
      items.push({
        modId: mod.id, name: mod.name, version: mod.installed_version || "", action: "add",
        file: mod.disabled ? `${name}.disabled` : name, oldFile: "",
        reason: mod.disabled
          ? "Disabled in ModWatch; add as disabled"
          : mod.stored ? "Missing on server" : "Missing on server; will download from source",
      });
      continue;
    }

    const same = Boolean(mod.file_sha1 && remote.sha1 && mod.file_sha1 === remote.sha1);
    const remoteIsDisabled = remoteDisabled(remote.name);
    if (same) {
      if (mod.disabled && !remoteIsDisabled) {
        items.push({
          modId: mod.id, name: mod.name, version: mod.installed_version || "", action: "disable",
          file: `${remote.name}.disabled`, oldFile: remote.name,
          remoteSha1: remote.sha1, remoteSize: remote.size,
          reason: "Disabled in ModWatch",
        });
      } else if (!mod.disabled && remoteIsDisabled) {
        items.push({
          modId: mod.id, name: mod.name, version: mod.installed_version || "", action: "enable",
          file: baseName(remote.name), oldFile: remote.name,
          remoteSha1: remote.sha1, remoteSize: remote.size,
          reason: "Enabled in ModWatch",
        });
      } else {
        items.push({
          modId: mod.id, name: mod.name, version: mod.installed_version || "", action: "keep",
          file: remote.name, oldFile: remote.name, reason: "Same file",
          remoteSha1: remote.sha1, remoteSize: remote.size,
        });
      }
      continue;
    }

    items.push({
      modId: mod.id, name: mod.name, version: mod.installed_version || "", action: "replace",
      file: mod.disabled ? `${name}.disabled` : name, oldFile: remote.name,
      remoteSha1: remote.sha1, remoteSize: remote.size,
      reason: mod.stored
        ? `Different file (${remote.name})`
        : `Different file (${remote.name}); will download from source`,
    });
  }

  for (const file of observed) {
    if (used.has(file.path)) continue;
    items.push({
      modId: null, name: baseName(file.name), action: "extra",
      file: file.name, oldFile: file.name, remotePath: file.path,
      remoteSha1: file.sha1, remoteSize: file.size,
      reason: "On server, not tracked in ModWatch",
    });
  }

  const counts = { add: 0, replace: 0, disable: 0, enable: 0, keep: 0, extra: 0, blocked: 0 };
  for (const item of items) counts[item.action] = (counts[item.action] || 0) + 1;
  if (!items.length) warnings.push("No jars matched either side.");
  return { items, counts, warnings };
}
