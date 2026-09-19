# Immutable history storage migration

## Motivation and contract

Appending an observation currently serializes another complete history object.
File-level content addressing cannot reuse the unchanged observations. This RFC
adds a physical representation, without changing the logical artifact identity,
financial values, observation cadence, provenance or snapshot schema.

History objects use consecutive UTC-date groups, bounded to 512 observations per
block. Values and `source_artifact_ids` are stored separately, preserving field
absence and nulls. Content-addressed gzip blocks precede an atomically published
descriptor. Reassembly must match both the original envelope bytes and the
existing logical artifact digest. Other artifact families remain unchanged.

## Rollout and rollback

The default writer remains `legacy`. `TRADING_MAX_HISTORY_STORAGE=shadow` keeps
the complete original object and also writes and verifies the chunked form.
Readers, downloads, snapshot validation and backups understand both physical
forms. `chunked` is an explicit operator opt-in, not an automatic migration.

Do not enable chunked production writes until the active release and both
protected rollback releases contain the dual reader and have passed recovery
tests. Older releases require their matching legacy backup or a verified full
JSON export. A later bounded migration may replace old representations only
after checking references, dependencies and restore parity; this release does
not perform that migration or garbage-collect application objects.

## Alternatives and verification

Plain gzip reduces each file but still duplicates every history version. Whole
point chunks also change whenever reconstruction updates provenance. Separating
sources allows stable values to be reused without losing the audit trail.

Synthetic tests cover absent/null provenance, unsorted and repeated dates,
append, rebuild, window rollover, missing/corrupt chunks, cached-reference
invalidation, atomic publication, downloads and backup/restore. Shadow writes
verify the original bytes before publication. No real account fixtures or
production measurements belong in this repository.
