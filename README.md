# ModWatch

Self-hosted update tracking for Minecraft modpacks. ModWatch remembers the exact Minecraft version, loader build and pack version an instance runs, then only reports a newer release when it fits that scope.

Built with Node 22, Express, Nunjucks and PostgreSQL 16. Ships as a two-service Docker Compose stack.

## What it does

- **Instances with a version lock.** Every check compares against the instance's Minecraft version and loader, not the newest release on the internet.
- **`.mrpack` import with the full tree.** Upload a Modrinth pack, watch live progress while ModWatch reads the index, hashes files and matches them on Modrinth, then review a folder tree before committing. Mods, resource packs, data packs and shaders are all imported; files without a match land in the "Unknown project file" flow instead of being dropped.
- **Four project kinds.** Track mods, resource packs, data packs and shaders in one board. A kind selector sits before the source filter on the add page and in the global search. Only mods are locked to the instance loader; the other kinds match the Minecraft version, with data packs using Modrinth's `datapack` loader.
- **Search.** Add-project search updates as you type with a loading skeleton, kind tabs, source filters (All / Modrinth / CurseForge / GitHub) and direct project-URL resolution.
- **Connectors and credits.** Modrinth works without credentials and covers every kind. CurseForge uses a public metadata fallback without a key for project URLs; if the fallback does not index a project, the same slug is matched on Modrinth. The official API adds search when a key is configured. GitHub search reads releases and can filter assets by pattern, with the kind chosen manually. Manual entries track private files with no project page. Each project stores and shows its creator name, avatar and profile link (Modrinth team owner, CurseForge author or GitHub owner).
- **Member pack imports.** Members can upload a `.mrpack`, inspect the full preview and choose which config folders to keep. Their submission becomes an approval request; an admin reviews the project list, unknown files, folder tree and selected files before the instance is created. Requests expire after seven days and only the uploader and admins can open the preview.
- **Pack updates.** The instance menu’s **Import update** opens a dedicated page for that instance. Uploading a newer `.mrpack` compares every project and override file with what the instance already has: newer versions, older versions, new projects, unchanged projects and files not in the pack. Newer versions are replaced by default, older ones are skipped unless you choose Replace, and pack files are selected per folder. Admin applies directly; a member sends the same comparison for approval and sees a **Got updated** result table after it runs.
- **Pack files.** Overrides such as `config/`, `defaultconfigs/`, `saves/` and `screenshots/` appear in the preview with per-folder and per-file checkboxes. Selected files are stored with the instance and shown in a read-only Files tab with size, date, inline preview for text and images, and per-file download. Project files are tracked automatically and cannot be deselected.
- **Scheduled checks.** A background scheduler runs every N hours. Manual checks run from the dashboard, an instance or a single mod. The sidebar watcher card updates live over Pusher or the built-in SSE stream.
- **Notifications.** In-app inbox, topbar popover and MyWebhook delivery (Telegram bot + chat configured on the hook) for updates, unknown files, requests and source errors. Each instance has a Telegram digest switch: admins can turn it off from the Instances bell or the edit form without silencing in-app notifications.
- **Self-registration.** `/register` creates a Member account and signs it in. Admins are never self-assigned: a member requests the role from Account, admins receive a notification, and the owner changes the role on Users.
- **Approvals.** Admins manage instances and users. Members can propose mods; requests wait on the Approvals page and become tracked mods only after approval.
- **Photos.** Profile photos and instance icons accept PNG, JPEG, WebP, animated GIF and SVG. SVG is rasterised to PNG before it is served; GIF keeps its animation. Files live in the uploads volume with initials as the fallback.
- **Version controls.** Change any project to another version that fits the instance scope (including downgrades), snooze one release, freeze the installed version, disable a file (exported with a `.disabled` suffix), or ignore it entirely. A status badge sits on the project icon: update arrow, alert, question, pencil, eye-off, lock, clock or pause. The public share page keeps its status pills and adds the same badge.
- **Download and update.** Update one project or every waiting project: ModWatch downloads the latest allowed file to the uploads volume, moves the installed baseline, then checks again to confirm the new version is really current. Mods keep `.jar`, resource packs, data packs and shaders use `.zip`. Download and update controls are green; a source failure is marked with a red badge.
- **Monthly activity.** The dashboard plots updates found and downloaded mods for the last 12 months as an animated two-line chart, with the 12-month totals beside it.
- **Export and share.** Admins generate a `.mrpack` from the tracked versions; non-mod files are written as overrides under `overrides/resourcepacks/`, `overrides/datapacks/` and `overrides/shaderpacks/`. The raw ZIP groups files by kind (`mods/`, `resourcepacks/`, `datapacks/`, `shaderpacks/`), keeps disabled files with `.disabled`, and includes a README plus `modwatch-download.json` manifest. Source menus only scope the contents. Creating a share link opens the public page directly. A public `/s/<token>` page shows the scope and top updates, filters by kind/source, serves a 1200×630 OG image with the pack art and real mod icons, and lets anyone download the whole pack, one file selection, or a checked selection without an account. Stored config and pack files stay private to signed-in members; an admin can opt a single instance into including them in public downloads with the “Include config files in public downloads” switch.
- **Visible long writes.** Uploads, imports, project resolution and version tracking open a progress dialog with a real server-sent event log and a percentage, while a thin green bar at the top of the page shows that a request is running.
- **Server sync (read-only).** Add an SFTP connection under Settings → Sync, bind one or more AMP servers to an instance from its Servers page, then scan the remote `mods/` folder. ModWatch hashes the jars, matches them by SHA-1 then file name, and shows add, replace, enable, disable, keep and extra-on-server rows. Credentials are encrypted with AES-256-GCM via `SYNC_SECRET_KEY`; the host key is pinned on first test. This phase never writes to the server.
- **Filters and themes.** Modrinth-style checkbox popovers filter the instance and public share tables by kind and source, with removable chips for every active filter. OLED, Dark, Light or follow the system, chosen from a compact popover and applied before first paint.

## Quick start

Requirements: Docker 24+ with Compose v2.

```bash
cp .env.example .env
```

Edit `.env` and set at least:

- `POSTGRES_PASSWORD`
- `SESSION_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Then:

```bash
docker compose up -d --build
```

Open <http://localhost:3411>. The first account is created from `ADMIN_EMAIL` and `ADMIN_PASSWORD` only when the database has no users.

To use a different host port, change `MODWATCH_PORT` in `.env`.

### Local development

Run PostgreSQL in Docker and the app on the host with hot reload. This is the
fastest loop while changing templates or CSS.

```bash
# Node 22 is required.
nvm use 22                  # if nvm manages your Node versions
cp .env.example .env        # one env file for Docker and local dev
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db

cd server
npm install
npm run dev
```

Set `DEV_DATABASE_URL` and `DEV_PORT` in the root `.env` (see `.env.example`).
There is no second env file: the local process reads the same `.env` as Compose.
Stop the app container first (`docker compose stop app`) so only one process
talks to the scheduler. For production, stop `npm run dev` first (it holds port
3411), then go back to the full stack:

```bash
docker compose up -d --build
```

### Optional demo workspace

The demo loader never runs during container start. It rebuilds three sample instances and leaves other instances alone:

```bash
docker compose exec app npm run seed:demo
```

Demo sign-ins (password `modwatch-demo`):

| Role | Email |
| --- | --- |
| Admin | `demo@modwatch.local` |
| Member | `maya@modwatch.local` |
| Member | `arif@modwatch.local` |

Set `DEMO_PASSWORD` to override the demo password. The loader creates these accounts with `@modwatch.local` addresses and resets their password on every run.

## First run checklist

1. Sign in as the admin.
2. Open **Instances → New instance** or **Import .mrpack**.
3. For a pack, upload the `.mrpack`, confirm the detected Minecraft version, loader and pack version, then import.
4. Resolve any unidentified jars from the instance's **Unknown** tab: link a project URL, keep the jar as manual, or ignore it.
5. Open **Settings → General** to set the check interval, and **Settings → Sources** to review the connectors. CurseForge works without a key through the public metadata fallback.
6. Try **Check now** on an instance. Updates appear on the board and in notifications.

## Configuration

All runtime settings live in `.env`. Compose passes only the variables declared in `docker-compose.yml`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_USER` | `modwatch` | Database user |
| `POSTGRES_PASSWORD` | required | Database password |
| `POSTGRES_DB` | `modwatch` | Database name |
| `SESSION_SECRET` | required | Session signing key |
| `MODWATCH_PORT` | `3411` | Host port for the UI |
| `DEV_DATABASE_URL` | empty | Local dev only: PostgreSQL on `127.0.0.1:5433` |
| `DEV_PORT` | empty | Local dev only: host port for `npm run dev` |
| `ADMIN_NAME` | `Admin` | First admin display name |
| `ADMIN_EMAIL` | empty | First admin email |
| `ADMIN_PASSWORD` | empty | First admin password |
| `APP_URL` | empty | Public URL, e.g. `https://modwatch.example.com` |
| `TRUST_PROXY` | `0` | Set `1` behind an HTTPS reverse proxy |
| `CHECK_INTERVAL_HOURS` | `6` | Scheduler default; editable in Settings |
| `MAX_UPLOAD_MB` | `100` | `.mrpack` upload limit |
| `APP_VERSION` | `1.0` | Version label in the UI |
| `CURSEFORGE_API_KEY` | empty | Official CurseForge API; without it ModWatch uses the public metadata fallback |
| `GITHUB_TOKEN` | empty | Raises GitHub API limits |
| `WEBHOOK_URL` | empty | MyWebhook endpoint used for delivery |
| `PUSHER_APP_ID` | empty | Pusher Channels app id for realtime refresh |
| `PUSHER_KEY` | empty | Pusher public key |
| `PUSHER_SECRET` | empty | Pusher secret (server only) |
| `PUSHER_CLUSTER` | `ap1` | Pusher cluster |
| `TELEGRAM_BOT_TOKEN` | empty | Legacy direct Telegram token |
| `TELEGRAM_CHAT_ID` | empty | Legacy direct Telegram chat ID |

The scheduler honours the last finished check on restart. A database with no completed run schedules its first check after 90 seconds, then every configured interval.

### Connectors

- **Modrinth** uses the public API. No key required.
- **CurseForge** resolves project URLs and version lists through a public metadata fallback when no key is set. Adding `CURSEFORGE_API_KEY` switches to the official API, hash matching and direct file metadata.
- **GitHub** reads repository releases. Set `GITHUB_TOKEN` to avoid rate limits. A mod can use an asset glob such as `*-forge-*.jar`.
- **Manual** entries never call an API. They stay in the Manual filter and are useful for private or patched jars.

Unknown files can be linked to a Modrinth, CurseForge or GitHub project URL. The CurseForge fallback downloads the matching jar into the uploads volume so exports stay complete.

### Realtime (Pusher)

Set `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET` and `PUSHER_CLUSTER`. The
server broadcasts a scoped `refresh` event to `private-workspace` after every
successful write and after scheduled checks. Each user also gets a private
`private-user-<id>` channel for new notifications. Pages reload only when the
scope matches and no modal or form is active; the notification badge updates
without a reload.

The scheduler also broadcasts its armed/checking state, so the sidebar updates
without a refresh. A native `/api/events` Server-Sent Events stream mirrors the
same workspace events inside the app process; it keeps the watcher card, badge
and scoped reloads live when Pusher is unreachable. The 60-second polling
fallback remains for long-lived tabs and browsers without `EventSource`.

### MyWebhook

1. Create a hook at [MyWebhook](https://webhook.trisnahome.my.id) and connect the Telegram bot/chat there.
2. Paste the hook endpoint into **Settings → Notifications**, or set `WEBHOOK_URL`.
3. Enable **MyWebhook delivery** and press **Send test message**.

ModWatch posts one JSON body per event: `{ "message": "..." }`. The bot token and chat ID stay inside MyWebhook; ModWatch never stores them. Direct Telegram delivery remains available through the legacy `TELEGRAM_*` variables if you deliberately use it.

## CurseForge API application

ModWatch is a self-hosted, non-commercial update tracker. It reads project metadata and file/version lists to tell the owner when a modpack file is behind; it does not redistribute mod jars publicly or replace the CurseForge API for other apps. The public metadata fallback is used only when no API key is configured. With a key, the official endpoints provide search, files and fingerprint data. This repository is public so the CurseForge reviewer can inspect the connector boundary in `server/src/sources/curseforge.js`, the resolution flow in `server/src/routes/instances.js`, and the export policy in `server/src/export.js`.

## Roles

| Role | Can do |
| --- | --- |
| Admin | Everything: instances, imports, checks, settings, sources, users, approvals |
| Member | View instances and mods, run checks, request mods, manage their own account |

Anyone can create a Member account from `/register`. Members request Admin access from **Settings → Account**; the request notifies every active admin and is written to the activity log. An admin reviews the account and changes the role on **Users**. Members can never promote themselves.

Requests from members are stored with their proposed payload. Approving one inserts the mod and starts a check. Rejecting one keeps a note for the requester.

## Themes

The topbar theme button opens a compact popover with **OLED**, **Dark**, **Light** and **System**. The choice is stored in `localStorage` and applied by `theme.js` before the first paint, so there is no flash. OLED is the default: true black ground, flat cards, no gradients or shadows.

## Development commands

One env file at the repo root drives both Compose and the host process.
`DEV_DATABASE_URL` and `DEV_PORT` point `npm run dev` at the Docker database on
port 5433. The app creates and migrates its schema on boot with an advisory
lock. Uploads live in `server/uploads`.

```bash
npm run check       # syntax check the entry points
npm run seed:demo   # load the demo workspace
npm start           # production start
```

## Data and backups

Two named volumes hold all state:

- `db-data` — PostgreSQL data
- `uploads` — avatars, instance images, imported jars, generated `.mrpack` exports and OG cache

Back up the database and the uploads volume together:

```bash
docker compose exec db pg_dump -U modwatch modwatch > modwatch-$(date +%F).sql
docker run --rm -v modwatch_uploads:/data -v "$PWD":/backup alpine tar czf /backup/modwatch-uploads-$(date +%F).tar.gz -C /data .
```

Restore the SQL with `psql` and the archive into the same `modwatch_uploads` volume. The database stores relative paths, so both pieces must match.

## Reverse proxy

Set `APP_URL=https://modwatch.example.com` and `TRUST_PROXY=1`, then proxy to `http://127.0.0.1:3411`. Secure cookies turn on in production when `APP_URL` starts with `https://`. Disable response buffering for `/api/events` so the SSE fallback streams immediately (Nginx: `proxy_buffering off;`).

The app sets a strict Content Security Policy. All JavaScript is served from `/assets`; inline scripts and inline event handlers are blocked by design.

## Project layout

```
.
├── docker-compose.yml
├── .env.example
└── server
    ├── Dockerfile
    ├── db/schema.sql
    ├── public/assets
    │   ├── css/modwatch.css
    │   └── js/{theme.js,ui.js,charts.js,realtime.js}
    ├── src
    │   ├── app.js
    │   ├── checker.js
    │   ├── mod-zip.js
    │   ├── scheduler.js
    │   ├── realtime.js
    │   ├── bus.js
    │   ├── import.js
    │   ├── seed-demo.js
    │   ├── demo-catalog.json
    │   ├── sources/{modrinth,curseforge,github}.js
    │   └── routes/
    └── views
```

## Contributors

**Maintainer**

- **Trisna Almuti** ([@Trisn0802](https://github.com/Trisn0802)) — product, infrastructure, CurseForge API integration and release testing.

**Implementation support**

- **DeepSeek** — AI coding assistant used for implementation, debugging, UI refinement and documentation support across ModWatch.

**Open-source dependencies**

See `server/package.json` for the full dependency list. ModWatch also vendors `pusher-js` (MIT) for the realtime client.

## Troubleshooting

**The app starts but there is no admin.** `ADMIN_EMAIL` and `ADMIN_PASSWORD` are only used when the users table is empty. Add a user through the database or reset the volume and start again.

**CurseForge behaves differently than expected.** Without `CURSEFORGE_API_KEY` ModWatch uses the public metadata fallback for URL resolution and version lists. Add the key for hash matching and official file metadata.

**GitHub checks fail with 403.** The unauthenticated rate limit is low. Add `GITHUB_TOKEN`.

**The import preview expired.** Previews are cleaned after 24 hours and the scheduled cleanup runs on boot. Upload the `.mrpack` again.

**Uploads fail with a permissions error.** The container runs as the `node` user and owns `/app/uploads`. If you replaced the named volume with a bind mount, make that directory writable by UID 1000.

**Port 3411 is taken.** Change `MODWATCH_PORT` in `.env` and restart.
