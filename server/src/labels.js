export const STATUS = {
  update_available: { label: "Update available", tone: "positive", order: 0 },
  up_to_date: { label: "Up to date", tone: "neutral", order: 1 },
  unknown: { label: "Unknown", tone: "warning", order: 2 },
  manual: { label: "Manual", tone: "info", order: 3 },
  source_error: { label: "Source error", tone: "negative", order: 4 },
  ignored: { label: "Ignored", tone: "muted", order: 5 },
  frozen: { label: "Frozen", tone: "info", order: 2 },
  snoozed: { label: "Snoozed", tone: "muted", order: 2 },
};

export const SOURCE = {
  modrinth: { label: "Modrinth", tone: "neutral" },
  curseforge: { label: "CurseForge", tone: "neutral" },
  github: { label: "GitHub", tone: "neutral" },
  hangar: { label: "Hangar", tone: "neutral" },
  spigot: { label: "Spigot", tone: "neutral" },
  manual: { label: "Manual", tone: "info" },
};

export const LOADER = {
  forge: "Forge",
  fabric: "Fabric",
  neoforge: "NeoForge",
  quilt: "Quilt",
  plugin: "Plugin",
};

export const CHANNEL = {
  release: "Release",
  beta: "Beta + release",
  alpha: "Alpha + beta + release",
};

export const SIDE = {
  both: "Client + server",
  client: "Client only",
  server: "Server only",
};

export const REASON = {
  no_match: "No match on Modrinth or CurseForge",
  curseforge_not_configured: "No Modrinth hash match. Link the CurseForge project URL to track it.",
  lookup_error: "The source could not be reached during import",
};

export const ROLE = {
  admin: "Admin",
  member: "Member",
};

export const USER_STATUS = {
  active: { label: "Active", tone: "positive" },
  disabled: { label: "Disabled", tone: "muted" },
};

export const ACTIVITY_LABEL = {
  import: "Imported a modpack",
  instance_created: "Created an instance",
  instance_updated: "Updated an instance",
  instance_deleted: "Deleted an instance",
  mod_added: "Added a mod",
  mod_updated: "Updated a mod",
  mod_removed: "Removed a mod",
  mod_snoozed: "Snoozed a version",
  mod_unsnoozed: "Restored a snoozed update",
  mod_frozen: "Froze a version",
  mod_unfrozen: "Unfroze a mod",
  mod_disabled: "Disabled a file",
  mod_enabled: "Enabled a file",
  mod_ignored: "Ignored a mod",
  unknown_resolved: "Resolved an unknown file",
  request_created: "Requested a mod",
  request_approved: "Approved a request",
  request_rejected: "Rejected a request",
  check_run: "Ran a check",
  settings_updated: "Changed settings",
  user_created: "Created a user",
  user_updated: "Updated a user",
  login: "Signed in",
};
