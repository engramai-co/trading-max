"""Fetch the pinned Sparkle SDK; keep generated binaries and signing keys out of Git."""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

DESKTOP = Path(__file__).resolve().parents[1]
DESTINATION = DESKTOP / "vendor/sparkle"
LOCK = DESKTOP / "sparkle.lock.json"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inventory(root: Path) -> dict[str, str]:
    result = {}
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        if relative == ".verified-sdk.json":
            continue
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()) or not path.exists():
                raise ValueError("Sparkle SDK has an escaping or broken symlink")
            result[relative] = "symlink:" + str(path.readlink())
        elif path.is_file():
            result[relative] = sha256(path) + ":" + oct(path.stat().st_mode & 0o777)
    return result


def prepare(destination: Path = DESTINATION) -> Path:
    lock = json.loads(LOCK.read_text())
    receipt = destination / ".verified-sdk.json"
    if destination.is_symlink():
        raise ValueError("Sparkle SDK directory must not be a symlink")
    if destination.exists():
        saved = json.loads(receipt.read_text())
        if saved["lock"] != lock or saved["files"] != inventory(destination):
            raise ValueError(
                "Existing Sparkle SDK differs from its receipt; preserve it for inspection"
            )
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sparkle-", dir=destination.parent) as temp:
        temp = Path(temp)
        archive = temp / "sdk.tar.xz"
        request = urllib.request.Request(lock["url"], headers={"User-Agent": "Trading-Max-Build"})  # noqa: S310 - pinned HTTPS SDK
        with urllib.request.urlopen(request, timeout=60) as response, archive.open("xb") as stream:  # noqa: S310 - pinned HTTPS URL and mandatory digest
            remaining = lock["size"] + 1
            while remaining:
                chunk = response.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                stream.write(chunk)
                remaining -= len(chunk)
        if archive.stat().st_size != lock["size"] or sha256(archive) != lock["sha256"]:
            raise ValueError("Sparkle SDK size/digest does not match the pinned upstream release")
        extracted = temp / "sdk"
        extracted.mkdir()
        with tarfile.open(archive) as tar:
            tar.extractall(extracted, filter="data")
        for required in ["Sparkle.framework/Sparkle", "bin/generate_keys", "bin/sign_update"]:
            if not (extracted / required).is_file():
                raise ValueError(f"Sparkle SDK is missing {required}")
        files = inventory(extracted)
        (extracted / ".verified-sdk.json").write_text(
            json.dumps({"lock": lock, "files": files}, indent=2) + "\n"
        )
        shutil.move(extracted, destination)
    return destination


if __name__ == "__main__":
    sys.stdout.write(str(prepare()) + "\n")
