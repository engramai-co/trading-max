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

## General envelope and filing compression (reader rollout)

The same logical contract applies to research artifacts. `trading-max-json-v1`
uses content-addressed gzip JSON subtrees, sorted object keys, and fixed groups
of 128 array elements. Subtrees up to 32 KiB remain single blocks; large scalar
strings remain bounded by the 256 MiB envelope limit. The descriptor records
original envelope length and SHA-256. Decoding must reproduce the original
canonical bytes, including every observation, provenance field and null.
Small envelopes and cached filing text can instead use the bounded `TMJSON1`
compression header. Binary source artifacts with metadata sidecars stay raw.

This release installs dual readers in artifact downloads, reference validation,
research filing caches and backup recovery. Default writes are still `legacy`.
`TRADING_MAX_ARTIFACT_STORAGE=compressed` enables whole-envelope compression;
`chunked` additionally shares large JSON subtrees. History-specific blocks take
precedence when `TRADING_MAX_HISTORY_STORAGE=chunked` is selected. No existing
file is migrated automatically by this reader rollout.

Activation requires the current release and both protected rollback runtimes to
read these formats. Subsequent migration must be bounded and resumable, verify
original logical bytes and identities before replacing a representation, and
verify recovery copies independently. Backup manifests keep their existing
schema; physical chunk dependencies are included and validated. Missing or
corrupt blocks fail closed rather than returning a partly reconstructed value.

The operational budget covers application state, independent recovery copies,
retained runtimes, logs and maintenance residue together. Daily maintenance may
retire verified obsolete recovery points, rebuildable caches and superseded
build outputs. It must never delete unique broker observations or transaction
records to satisfy a byte target. Budget reports must distinguish mandatory
record growth from removable duplication, preserve recovery headroom, and
surface a capacity warning before the configured limit is reached.

Production builds retain Next's self-contained standalone runtime and its
assets, the pinned Node executable, source revision and production Python
dependencies. Build-only npm dependencies, compiler caches and Python developer
tools are not needed after successful validation. A candidate with missing
runtime files or links to build-only directories must fail before cutover.

Recovery repositories can also read `packed/<original-file-sha256>.json`
representations. They return exactly the file bytes referenced by the existing
manifest; recovery dates, file hashes and manifests are unchanged. The packed
root owns independent blocks, never links to the live artifact store. Retention
traces this extra physical closure across every existing recovery manifest.
This reader release does not create packed backups or retire original blobs.
