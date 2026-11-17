# ModWatch

ModWatch tracks the exact project versions a Minecraft instance runs and
keeps a server's files in step with them.

## Language

**ModWatch instance**:
A tracked modpack in ModWatch, with its own Minecraft version, loader and
project list.
_Avoid_: pack, server, instance

**AMP instance**:
One Minecraft server managed by AMP, addressed by its AMP instance name and
its own SFTP port.
_Avoid_: server, container, instance

**Connection**:
One endpoint and its credentials: an SFTP host with optional AMP power
control, or a Pterodactyl panel URL with a client API key. Secrets are
encrypted at rest.
_Avoid_: SFTP connection, endpoint, host

**Target**:
The binding of one connection to one ModWatch instance and one game server
(an AMP instance or a Pterodactyl server UUID): remote folder, sides,
remove policy and start timeout. A ModWatch instance can have many targets.
_Avoid_: link, binding, server

**Panel**:
The control surface for a game server, either AMP's ADS/instance API or a
Pterodactyl panel. It starts and stops the process; files move over SFTP or
through the panel API.
_Avoid_: dashboard, web UI

**Scan**:
A read-only comparison of tracked projects against the files on a target,
producing the diff actions add, replace, enable, disable, keep, extra and
blocked.
_Avoid_: check, sync

**Apply**:
A scan plus backup, stop, upload, start, ready check and rollback if the
restored server cannot run.
_Avoid_: sync, deploy, push

**Apply only**:
An apply that uploads and verifies the files without restarting the game
server. The new files do not take effect until someone restarts the server.
_Avoid_: partial apply, no-restart apply

**Apply and restart**:
An apply that restarts the game server after uploading and checks that it
reaches ready. This is the default.
_Avoid_: full apply, restart mode

**Account change**:
An admin-initiated change to another account's name, email, role, status,
password or photo, announced to that account with a before/after summary and
an optional reason.
_Avoid_: user edit, profile update

**Job**:
One recorded apply, with per-file items, a log and a final status:
succeeded, rolled_back or failed.
_Avoid_: run, task, operation

**Rollback**:
Restoring the files an apply replaced and restarting the previous set. It
is a successful safety outcome, not the same thing as a failed apply.
_Avoid_: revert, undo, failure

**Side**:
Where a project belongs: client only, server only, or both. Targets sync
server and both.
_Avoid_: environment, location
