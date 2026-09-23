# Desktop upgrade recovery

Status: implementation of the existing local-workspace upgrade safety gap.

## Scope

Before a newer bundled App opens an existing local workspace database, create a
verified, deduplicated recovery snapshot outside the workspace. Reuse the
existing backup repository and its database, digest and snapshot verification.
Keep the native settings/navigation unchanged. Public installers, signed update
feeds and automatic binary downloads remain deferred.

## Transaction

The supervisor owns the workspace runtime lock throughout capture, startup and
any recovery. A durable journal binds the workspace UUID, absolute path, original
version and target version to one backup. Commit the new manifest version only
after the API and web entry are responsive and existing snapshot readiness is
verified. A failed or cancelled pre-commit startup stops owned children and
restores the verified baseline. An interrupted transaction resumes recovery on
next open before starting any service. A later runtime failure after commit does
not rewind new financial records.

Restore in two journaled phases while retaining the same runtime lock inode:
move failed-start data into a private recovery folder, then move the verified
restored entries into the original folder. Keep logs, credentials and the lock
outside the swap. Interrupted moves are idempotent; unknown/conflicting entries
stop recovery rather than overwrite data. Retain the failed state for diagnosis.

Atomic recovery currently requires the workspace and recovery directory to be
on the same filesystem volume. A cross-volume upgrade is rejected before
starting migrations; recovery rechecks this before moving entries. Existing
same-version workspaces are not restricted by this upgrade-only check.

## Boundaries and alternatives

Keychain credentials and the App connection profile are never part of the
transaction. Remote-server sessions cannot invoke it. Backup failure or a time
budget failure stops before services start. A same-version reopen needs no new
recovery copy. Existing source installations keep their existing deployment
controller. Full directory renaming was rejected because it would replace the
locked inode and allow another process to race startup. Restoring only SQLite
was rejected because snapshot pointers, imports and settings must agree.

A previous binary is not silently launched or downloaded. This protects data
when a user installs a new internal build; verified binary updates belong to
the deferred distribution work. After a failed upgrade, the existing recovery
screen reports the restored state and supports retry with a fixed/previous App.

## Acceptance

Synthetic tests cover successful upgrade/reopen, failed migration/startup,
process interruption in each restore phase, a busy workspace, future schema,
tampered recovery metadata, corrupt backup, bounded backup and unchanged
connection/credential boundaries. Packaged-runtime tests exercise the actual
bundled migration/backup implementation and verify no installation writes.
Real-account checks only open an existing approved local workspace; no fault
injection or deliberate rollback is performed against production.
