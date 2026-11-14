# ModWatch

Self-hosted update tracking for Minecraft modpacks. ModWatch remembers the exact Minecraft version, loader build and pack version an instance runs, then only reports a newer release when it fits that scope.

Built with Node 22, Express, Nunjucks and PostgreSQL 16. Ships as a two-service Docker Compose stack.

## What it does

- **Instances with a version lock.** Every check compares against the instance's Minecraft version and loader, not the newest release on the internet.
- **`.mrpack` import.** Upload a Modrinth pack, review the detected scope and mod list, then commit. Jars without a match land in an "Unknown mod detected" flow instead of being dropped.
- **Search.** Add-mod search updates as you type with a loading skeleton, source filters (All / Modrinth / CurseForge / GitHub) and direct project-URL resolution.
- **Connectors.** Modrinth works without credentials. CurseForge uses a public metadata fallback without a key for project URLs; if the fallback does not index a project, the same slug is matched on Modrinth. The official API adds search when a key is configured. GitHub search reads releases and can filter assets by pattern. Manual entries track private jars with no project page; pasting a supported project URL into the manual form detects the source and opens version selection.
- **Scheduled checks.** A background scheduler runs every N hours. Manual checks run from the dashboard, an instance or a single mod.
- **Notifications.** In-app inbox, topbar popover and MyWebhook delivery (Telegram bot + chat configured on the hook) for updates, unknown files, requests and source errors.
- **Approvals.** Admins manage instances and users. Members can propose mods; requests wait on the Approvals page and become tracked mods only after approval.
- **Photos.** Profile photos and instance icons, stored in the uploads volume with initials as the fallback.
- **Version controls.** Snooze one release, freeze the installed version, disable a file (exported as `.jar.disabled`), or ignore it entirely.
- **Download and update.** Update one mod or every waiting mod: ModWatch downloads the latest allowed jar to the uploads volume, moves the installed baseline, then checks again to confirm the new version is really current.
- **Export and share.** Admins generate a `.mrpack` from the tracked versions. A public `/s/<token>` page shows the scope and top updates, serves an OG image, and lets anyone download the pack without an account.
- **Themes.** OLED, Dark, Light or follow the system, chosen from a compact popover and applied before first paint.

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
| `TELEGRAM_BOT_TOKEN` | empty | Legacy direct Telegram token |
| `TELEGRAM_CHAT_ID` | empty | Legacy direct Telegram chat ID |

The scheduler honours the last finished check on restart. A database with no completed run schedules its first check after 90 seconds, then every configured interval.

### Connectors

- **Modrinth** uses the public API. No key required.
- **CurseForge** resolves project URLs and version lists through a public metadata fallback when no key is set. Adding `CURSEFORGE_API_KEY` switches to the official API, hash matching and direct file metadata.
- **GitHub** reads repository releases. Set `GITHUB_TOKEN` to avoid rate limits. A mod can use an asset glob such as `*-forge-*.jar`.
- **Manual** entries never call an API. They stay in the Manual filter and are useful for private or patched jars.

Unknown files can be linked to a Modrinth, CurseForge or GitHub project URL. The CurseForge fallback downloads the matching jar into the uploads volume so exports stay complete.

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

Set `APP_URL=https://modwatch.example.com` and `TRUST_PROXY=1`, then proxy to `http://127.0.0.1:3411`. Secure cookies turn on in production when `APP_URL` starts with `https://`.

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
    │   └── js/{theme.js,ui.js,charts.js}
    ├── src
    │   ├── app.js
    │   ├── checker.js
    │   ├── scheduler.js
    │   ├── import.js
    │   ├── seed-demo.js
    │   ├── demo-catalog.json
    │   ├── sources/{modrinth,curseforge,github}.js
    │   └── routes/
    └── views
```

## Troubleshooting

**The app starts but there is no admin.** `ADMIN_EMAIL` and `ADMIN_PASSWORD` are only used when the users table is empty. Add a user through the database or reset the volume and start again.

**CurseForge behaves differently than expected.** Without `CURSEFORGE_API_KEY` ModWatch uses the public metadata fallback for URL resolution and version lists. Add the key for hash matching and official file metadata.

**GitHub checks fail with 403.** The unauthenticated rate limit is low. Add `GITHUB_TOKEN`.

**The import preview expired.** Previews are cleaned after 24 hours and the scheduled cleanup runs on boot. Upload the `.mrpack` again.

**Uploads fail with a permissions error.** The container runs as the `node` user and owns `/app/uploads`. If you replaced the named volume with a bind mount, make that directory writable by UID 1000.

**Port 3411 is taken.** Change `MODWATCH_PORT` in `.env` and restart.
