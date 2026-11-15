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
One SFTP endpoint plus the optional AMP power credentials for exactly one
AMP instance. Secrets are encrypted at rest.
_Avoid_: SFTP connection, endpoint, host

**Target**:
The binding of one connection to one ModWatch instance: remote folder,
sides, remove policy and start timeout. A ModWatch instance can have many
targets; a target belongs to one AMP instance.
_Avoid_: link, binding, server

**Scan**:
A read-only comparison of tracked projects against the files on a target,
producing the diff actions add, replace, enable, disable, keep, extra and
blocked.
_Avoid_: check, sync

**Apply**:
A scan plus backup, stop, upload, start, ready check and rollback if the
restored server cannot run.
_Avoid_: sync, deploy, push

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
