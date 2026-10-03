"""Process-local recovery proofs, invalidated by any source or locator change.

Never persisted or used for explicit verify/restore. These proofs only avoid
repeating an independent full verification during the same maintenance run.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


class VerificationSession:
    def __init__(self):
        self.proofs: dict[str, tuple[str, dict]] = {}

    @staticmethod
    def key(repository, manifest: dict) -> str:
        return hashlib.sha256(
            str(repository.root).encode()
            + json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    @staticmethod
    def fingerprint(repository, files: dict) -> str:
        from .backup_repository import _stamp
        from .physical_recovery import raw_path

        paths: set[Path] = set()
        digests = sorted({entry["sha256"] for entry in files.values()})
        locators = False
        signature = hashlib.sha256()
        for number, digest in enumerate(digests, 1):
            raw = raw_path(repository, digest)
            if raw.is_file():
                paths.add(raw)
            else:
                paths.update(repository.blob_files(digest))
                descriptor = repository.packed_path(digest)
                paths.add(descriptor)  # Creating a higher-priority alias invalidates the proof.
                location = repository.packs.location("descriptor/" + digest)
                signature.update(json.dumps([digest, "descriptor", location]).encode())
                if descriptor.is_file() or location is not None:
                    locators = True  # Descriptor/chunk closures retain conservative index binding.
                else:
                    plain = repository.blob_path(digest)
                    paths.add(plain)
                    if not plain.is_file():
                        signature.update(
                            json.dumps(
                                [digest, "blob", repository.packs.location("blob/" + digest)]
                            ).encode()
                        )
            if number % 128 == 0:
                repository._progress(
                    "checking-recovery-proof", files=number, totalFiles=len(digests)
                )
        if locators:
            # Include WAL as well as the database: changing a locator must not
            # reuse a proof even if it still points into the same pack file.
            for index in (repository.packs.index, repository.packed_store.packs.index):
                paths.update((index, Path(str(index) + "-wal")))
        for path in sorted(paths):
            if path.is_symlink():
                raise ValueError("recovery proof source must not be a symlink")
            signature.update(str(path).encode())
            signature.update(json.dumps(_stamp(path) if path.exists() else None).encode())
        return signature.hexdigest()

    def remember(self, repository, manifest: dict, result: dict, before: str) -> None:
        if before != self.fingerprint(repository, manifest["files"]):
            raise ValueError("recovery source changed during verification")
        self.proofs[self.key(repository, manifest)] = (before, dict(result))

    def verify(self, repository, manifest: dict) -> dict:
        before = self.fingerprint(repository, manifest["files"])
        cached = self.proofs.get(self.key(repository, manifest))
        if cached and cached[0] == before:
            repository._progress("reusing-session-verification", files=len(manifest["files"]))
            return dict(cached[1])
        result = repository._verify_full(manifest)
        self.remember(repository, manifest, result, before)
        return result
