-- ModWatch schema (PostgreSQL 16)
-- Idempotent. Run at every start inside a transaction guarded by pg_advisory_lock.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  password_hash TEXT NOT NULL,
  avatar_path   TEXT,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path TEXT;

CREATE TABLE IF NOT EXISTS instances (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  mc_version         TEXT NOT NULL,
  loader             TEXT NOT NULL CHECK (loader IN ('forge','fabric','neoforge','quilt','plugin')),
  loader_version     TEXT NOT NULL DEFAULT '',
  pack_name          TEXT NOT NULL DEFAULT '',
  pack_version       TEXT NOT NULL DEFAULT '',
  notes              TEXT NOT NULL DEFAULT '',
  image_path         TEXT,
  share_token        TEXT,
  share_created_at   TIMESTAMPTZ,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_checked_at    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE instances ADD COLUMN IF NOT EXISTS image_path TEXT;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS share_token TEXT;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS share_created_at TIMESTAMPTZ;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS telegram_updates BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE instances ADD COLUMN IF NOT EXISTS config_public BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS instances_share_token_uq ON instances (share_token) WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS imports (
  id             SERIAL PRIMARY KEY,
  instance_id    INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  file_name      TEXT NOT NULL,
  pack_name      TEXT NOT NULL DEFAULT '',
  pack_version   TEXT NOT NULL DEFAULT '',
  mc_version     TEXT NOT NULL DEFAULT '',
  loader         TEXT NOT NULL DEFAULT '',
  loader_version TEXT NOT NULL DEFAULT '',
  counts         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mods (
  id                   SERIAL PRIMARY KEY,
  instance_id          INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  side                 TEXT NOT NULL DEFAULT 'both' CHECK (side IN ('both','client','server')),
  source               TEXT NOT NULL CHECK (source IN ('modrinth','curseforge','github','hangar','spigot','manual')),
  project_id           TEXT,
  project_url          TEXT NOT NULL DEFAULT '',
  github_asset_pattern TEXT NOT NULL DEFAULT '',
  installed_version    TEXT NOT NULL DEFAULT '',
  installed_version_id TEXT,
  file_name            TEXT NOT NULL DEFAULT '',
  file_sha1            TEXT,
  file_sha512          TEXT,
  file_size            BIGINT,
  icon_url             TEXT,
  download_url         TEXT,
  stored_path          TEXT,
  stored_version_id    TEXT,
  disabled             BOOLEAN NOT NULL DEFAULT false,
  frozen_at            TIMESTAMPTZ,
  channel_policy       TEXT NOT NULL DEFAULT 'release' CHECK (channel_policy IN ('release','beta','alpha')),
  status               TEXT NOT NULL DEFAULT 'up_to_date'
                       CHECK (status IN ('up_to_date','update_available','unknown','manual','source_error','ignored','frozen')),
  latest_version       TEXT NOT NULL DEFAULT '',
  latest_version_id    TEXT,
  latest_published_at  TIMESTAMPTZ,
  snoozed_version_id   TEXT,
  last_checked_at      TIMESTAMPTZ,
  last_error           TEXT,
  added_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE mods ADD COLUMN IF NOT EXISTS channel_policy TEXT NOT NULL DEFAULT 'release';
ALTER TABLE mods ADD COLUMN IF NOT EXISTS icon_url TEXT;
ALTER TABLE mods ADD COLUMN IF NOT EXISTS download_url TEXT;
ALTER TABLE mods ADD COLUMN IF NOT EXISTS stored_path TEXT;
ALTER TABLE mods ADD COLUMN IF NOT EXISTS stored_version_id TEXT;
ALTER TABLE mods ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mods ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ;
ALTER TABLE mods ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'mod';
ALTER TABLE mods ADD COLUMN IF NOT EXISTS creator_name TEXT NOT NULL DEFAULT '';
ALTER TABLE mods ADD COLUMN IF NOT EXISTS creator_url TEXT NOT NULL DEFAULT '';
ALTER TABLE mods ADD COLUMN IF NOT EXISTS creator_avatar_url TEXT;
ALTER TABLE mods DROP CONSTRAINT IF EXISTS mods_status_check;
ALTER TABLE mods ADD CONSTRAINT mods_status_check
  CHECK (status IN ('up_to_date','update_available','unknown','manual','source_error','ignored','frozen'));
ALTER TABLE mods DROP CONSTRAINT IF EXISTS mods_kind_check;
ALTER TABLE mods ADD CONSTRAINT mods_kind_check
  CHECK (kind IN ('mod','resourcepack','datapack','shader'));
CREATE UNIQUE INDEX IF NOT EXISTS mods_source_project_uq
  ON mods (instance_id, source, project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mods_instance_status_idx ON mods (instance_id, status);
CREATE INDEX IF NOT EXISTS mods_instance_kind_idx ON mods (instance_id, kind);
CREATE INDEX IF NOT EXISTS mods_sha1_idx ON mods (file_sha1);

CREATE TABLE IF NOT EXISTS mod_versions_cache (
  id                SERIAL PRIMARY KEY,
  mod_id            INTEGER NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  version_id        TEXT NOT NULL,
  version_string    TEXT NOT NULL,
  channel           TEXT NOT NULL DEFAULT 'release' CHECK (channel IN ('release','beta','alpha')),
  mc_versions       TEXT[] NOT NULL DEFAULT '{}',
  loaders           TEXT[] NOT NULL DEFAULT '{}',
  published_at      TIMESTAMPTZ,
  changelog_url     TEXT NOT NULL DEFAULT '',
  download_page_url TEXT NOT NULL DEFAULT '',
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mod_id, version_id)
);

CREATE TABLE IF NOT EXISTS unknown_mods (
  id               SERIAL PRIMARY KEY,
  instance_id      INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  import_id        INTEGER REFERENCES imports(id) ON DELETE SET NULL,
  file_name        TEXT NOT NULL,
  file_sha1        TEXT NOT NULL,
  file_sha512      TEXT,
  file_size        BIGINT,
  stored_path      TEXT,
  jar_mod_id       TEXT,
  jar_name         TEXT,
  jar_version      TEXT,
  jar_loaders      TEXT[] NOT NULL DEFAULT '{}',
  reason           TEXT NOT NULL DEFAULT 'no_match',
  resolution       TEXT NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending','source_set','manual','ignored')),
  mod_id           INTEGER REFERENCES mods(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  UNIQUE (instance_id, file_sha1)
);
ALTER TABLE unknown_mods ADD COLUMN IF NOT EXISTS stored_path TEXT;
ALTER TABLE unknown_mods ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'mod';
ALTER TABLE unknown_mods DROP CONSTRAINT IF EXISTS unknown_mods_kind_check;
ALTER TABLE unknown_mods ADD CONSTRAINT unknown_mods_kind_check
  CHECK (kind IN ('mod','resourcepack','datapack','shader'));

-- Bytes from the pack that are not tracked projects: configs, defaults,
-- scripts and other overrides the user chose to keep with the instance.
CREATE TABLE IF NOT EXISTS instance_files (
  id          SERIAL PRIMARY KEY,
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  import_id   INTEGER REFERENCES imports(id) ON DELETE SET NULL,
  path        TEXT NOT NULL,
  folder      TEXT NOT NULL DEFAULT '',
  file_name   TEXT NOT NULL,
  file_size   BIGINT NOT NULL DEFAULT 0,
  file_sha1   TEXT,
  stored_path TEXT NOT NULL,
  modified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (instance_id, path)
);
CREATE INDEX IF NOT EXISTS instance_files_instance_idx ON instance_files (instance_id, path);

CREATE TABLE IF NOT EXISTS exports (
  id          SERIAL PRIMARY KEY,
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  file_path   TEXT NOT NULL,
  file_size   BIGINT,
  counts      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exports_instance_idx ON exports (instance_id, created_at DESC);
ALTER TABLE exports ADD COLUMN IF NOT EXISTS include_files BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS mod_requests (
  id            SERIAL PRIMARY KEY,
  instance_id   INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  requested_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT NOT NULL DEFAULT '',
  mod_id        INTEGER REFERENCES mods(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS mod_requests_status_idx ON mod_requests (status, created_at);

-- A member's request for the admin role waits here until an admin decides.
CREATE TABLE IF NOT EXISTS role_requests (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_role TEXT NOT NULL DEFAULT 'admin' CHECK (requested_role IN ('admin')),
  note           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decision_note  TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS role_requests_pending_uq
  ON role_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS role_requests_status_idx ON role_requests (status, created_at);

-- A member's .mrpack import waits here until an admin reviews the preview.
CREATE TABLE IF NOT EXISTS import_requests (
  id             SERIAL PRIMARY KEY,
  token          TEXT NOT NULL UNIQUE,
  requested_by   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  file_name      TEXT NOT NULL DEFAULT '',
  pack_name      TEXT NOT NULL DEFAULT '',
  pack_version   TEXT NOT NULL DEFAULT '',
  mc_version     TEXT NOT NULL DEFAULT '',
  loader         TEXT NOT NULL DEFAULT '',
  loader_version TEXT NOT NULL DEFAULT '',
  counts         JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_files TEXT[] NOT NULL DEFAULT '{}',
  decision_note  TEXT NOT NULL DEFAULT '',
  decided_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  instance_id    INTEGER REFERENCES instances(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);
CREATE INDEX IF NOT EXISTS import_requests_status_idx ON import_requests (status, created_at);
CREATE INDEX IF NOT EXISTS import_requests_user_idx ON import_requests (requested_by, created_at DESC);
ALTER TABLE import_requests ADD COLUMN IF NOT EXISTS instance_id INTEGER REFERENCES instances(id) ON DELETE CASCADE;
ALTER TABLE import_requests ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'new';
ALTER TABLE import_requests ADD COLUMN IF NOT EXISTS selected_projects JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE import_requests DROP CONSTRAINT IF EXISTS import_requests_mode_check;
ALTER TABLE import_requests ADD CONSTRAINT import_requests_mode_check CHECK (mode IN ('new','update'));

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id INTEGER REFERENCES instances(id) ON DELETE CASCADE,
  mod_id      INTEGER REFERENCES mods(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('update','unknown','request','decision','error','system','sync','account')),
  version_id  TEXT,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_update_uq
  ON notifications (user_id, mod_id, version_id) WHERE kind = 'update';
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, read_at);
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('update','unknown','request','decision','error','system','sync','account'));

CREATE TABLE IF NOT EXISTS check_runs (
  id          SERIAL PRIMARY KEY,
  instance_id INTEGER REFERENCES instances(id) ON DELETE CASCADE,
  trigger     TEXT NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule','manual','import')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  checked     INTEGER NOT NULL DEFAULT 0,
  updates     INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activity (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT '',
  subject_id   INTEGER,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_created_idx ON activity (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- express-session store (connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  sid    VARCHAR NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expire_idx ON "session" (expire);

-- Server sync: connections, targets, remote file cache and future apply jobs.
CREATE TABLE IF NOT EXISTS sync_connections (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  driver          TEXT NOT NULL CHECK (driver IN ('amp','sftp','folder','pterodactyl')),
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_enc      TEXT,
  last_test_at    TIMESTAMPTZ,
  last_test_ok    BOOLEAN,
  last_test_error TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_targets (
  id                    SERIAL PRIMARY KEY,
  instance_id           INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  connection_id         INTEGER NOT NULL REFERENCES sync_connections(id) ON DELETE RESTRICT,
  name                  TEXT NOT NULL,
  remote_ref            TEXT NOT NULL DEFAULT '',
  mods_path             TEXT NOT NULL DEFAULT 'mods',
  sides                 TEXT[] NOT NULL DEFAULT ARRAY['both','server'],
  remove_policy         TEXT NOT NULL DEFAULT 'never' CHECK (remove_policy IN ('never','backup_then_remove')),
  require_empty_server  BOOLEAN NOT NULL DEFAULT true,
  use_amp_backup        BOOLEAN NOT NULL DEFAULT false,
  start_timeout_seconds INTEGER NOT NULL DEFAULT 300,
  keep_backups          INTEGER NOT NULL DEFAULT 5,
  last_scan_at          TIMESTAMPTZ,
  last_scan_summary     JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (instance_id, name)
);
CREATE INDEX IF NOT EXISTS sync_targets_instance_idx ON sync_targets (instance_id);

CREATE TABLE IF NOT EXISTS sync_remote_files (
  target_id  INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  size       BIGINT NOT NULL DEFAULT 0,
  sha1       TEXT,
  mod_id     INTEGER REFERENCES mods(id) ON DELETE SET NULL,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target_id, path)
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id          SERIAL PRIMARY KEY,
  target_id   INTEGER NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('dry_run','apply','restart')),
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','succeeded','failed','rolled_back','cancelled')),
  plan        JSONB NOT NULL DEFAULT '{}'::jsonb,
  result      JSONB NOT NULL DEFAULT '{}'::jsonb,
  log         TEXT NOT NULL DEFAULT '',
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_jobs_target_idx ON sync_jobs (target_id, created_at DESC);

ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_mode_check;
ALTER TABLE sync_jobs ADD CONSTRAINT sync_jobs_mode_check
  CHECK (mode IN ('dry_run','apply','restart'));

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sync_job_id INTEGER REFERENCES sync_jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS notifications_sync_job_idx ON notifications (sync_job_id);

CREATE TABLE IF NOT EXISTS sync_job_items (
  id            SERIAL PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  mod_id        INTEGER REFERENCES mods(id) ON DELETE SET NULL,
  action        TEXT NOT NULL CHECK (action IN ('add','replace','disable','enable','remove','keep','blocked')),
  file_name     TEXT NOT NULL DEFAULT '',
  old_file_name TEXT NOT NULL DEFAULT '',
  sha1          TEXT,
  size          BIGINT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','done','failed','skipped','rolled_back')),
  error         TEXT NOT NULL DEFAULT ''
);
