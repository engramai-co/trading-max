# Immutable object packs and recovery catalogs

Tracking: [storage architecture issue #68](https://github.com/engramai-co/trading-max/issues/68).

This is a reader-first, optional physical storage layer. Installing its reader
release does not convert existing state or change default writers. Existing
loose gzip chunks, compressed envelopes and original recovery manifests remain
readable. Logical artifact IDs, amounts, precision, provenance, missing fields,
nulls and original downloads do not change.

## Sealed records and a derived locator

An object pack contains bounded Zstandard frames: a record directory and the
original record bytes. Its filename is the SHA-256 of the complete sealed pack.
The directory includes each immutable key, offset, byte length and SHA-256.
Readers validate the file, frame bounds, records and the SQLite locator against
that directory. Cached reads include the physical file identity, timestamps and
size. Corruption stops a read; a different representation is not silently used
to hide a corrupt authoritative object.

A private SQLite index locates records. A pack is fsynced before its entries are
committed in a short transaction. The derived index uses a rollback journal;
it does not introduce a growing WAL or daily copies of mutable database pages.
Missing or corrupt indexes can be rebuilt from sealed packs into a new file,
validated and atomically published. Existing indexes survive a failed rebuild.
An interrupted publication may leave an unindexed pack; recovery indexes it
before catalog entry IDs can be reused. Conflicting entries fail closed.

Readers support mixed loose and sealed data. Ordinary artifact writes continue
to create atomic loose objects and reuse already sealed immutable keys. Packing
is a separate bounded maintenance operation; it must not rewrite sealed history
for each observation. Binary artifacts retain their signed sidecar path.

## Recovery manifests

A catalog stores each distinct `(path, file metadata)` entry once, including
unknown fields. Each manifest retains its header and an ordered vector of
persistent integer entry keys. These keys are part of the sealed records, not
SQLite row IDs. The original manifest SHA-256 and byte count remain in a small
published descriptor. Noncanonical imported JSON retains its exact raw bytes.

A manifest can be reconstructed without a parent manifest or the live state.
All content belongs independently to the backup repository; there are no links
to mutable production files. Restoring packed logical artifacts materializes
standalone original envelopes, allowing older application readers to inspect a
recovery without the new storage format. Backups of live packed data use this
logical representation rather than copying a live locator database.

Retention continues to protect unique historical evidence. Shared sealed packs
must be treated as reference units, never deleted by loose-file orphan rules.
A capacity target does not permit removing original observations or reducing
financial precision.

## Rollout and acceptance

Before removing any loose representation, require a verified independent
recovery point and byte/financial parity across the active application and its
two retained rollback readers. Install compatible readers before enabling any
conversion. Keep migration bounded, journaled and resumable; never replace
running state with a rehearsal restore.

Validate index loss, truncated and oversized frames, changed cached files,
conflicting records, interrupted publication, concurrent readers, null/absent
fields, original manifest replay, source loss and independent restore. Real
account data and measurements stay outside Git; tests use synthetic fixtures.
Whole-installation accounting includes records, recovery, runtimes, logs and
maintenance residue. Report migration scratch separately from steady state.

This layer does not itself alter query sampling, financial calculations or
browser payload size. Indexed range APIs are a separate part of the rollout.
