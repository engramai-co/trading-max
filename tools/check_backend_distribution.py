"""Verify that built backend archives retain their required runtime files."""

from __future__ import annotations

import argparse
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def validate_distributions(directory: Path) -> None:
    """Check both the wheel and source archive without extracting either."""
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    stem = f"trading_max_backend-{version}"
    references = {
        f"reference/data/{path.name}": path.read_bytes()
        for path in (ROOT / "backend/src/trading_max/reference/data").glob("*.json")
    }
    if not references:
        raise ValueError("backend reference data is missing from the source checkout")
    for name in ("package.json", "package-lock.json", "index.mjs", "oauth.mjs"):
        references[f"synthesis/_pi/{name}"] = (
            ROOT / "backend/src/trading_max/synthesis/_pi" / name
        ).read_bytes()
    for name in ("__init__.py", "completion.py", "model.py", "device_login.py"):
        references[f"llm/{name}"] = (ROOT / "backend/src/trading_max/llm" / name).read_bytes()
    migrations = {
        f"migrations/{path.name}": path.read_bytes()
        for path in (ROOT / "backend/migrations").glob("*.sql")
    }
    if not migrations:
        raise ValueError("database migrations are missing from the source checkout")
    wheel_files = {f"trading_max/{name}": data for name, data in references.items()}
    wheel_files.update({f"trading_max/{name}": data for name, data in migrations.items()})
    source_files = {f"{stem}/src/trading_max/{name}": data for name, data in references.items()}
    source_files.update({f"{stem}/{name}": data for name, data in migrations.items()})
    forbidden = ("/synthesis/_pi/complete.mjs", "/synthesis/_pi/node_modules/")
    with zipfile.ZipFile(directory / f"{stem}-py3-none-any.whl") as wheel:
        names = wheel.namelist()
        if any(part in name for name in names for part in forbidden):
            raise ValueError("wheel contains stale model bridge files or Node dependencies")
        for member, expected in wheel_files.items():
            if names.count(member) != 1 or wheel.read(member) != expected:
                raise ValueError(f"wheel runtime file is missing, duplicated or changed: {member}")
    with tarfile.open(directory / f"{stem}.tar.gz") as source:
        names = source.getnames()
        if any(part in name for name in names for part in forbidden):
            raise ValueError(
                "source archive contains stale model bridge files or Node dependencies"
            )
        for member, expected in source_files.items():
            if names.count(member) != 1:
                raise ValueError(f"source runtime file is missing or duplicated: {member}")
            stream = source.extractfile(member)
            if stream is None or stream.read() != expected:
                raise ValueError(f"source runtime file changed: {member}")


def main() -> None:
    """Validate the archives created by the backend distribution build."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    validate_distributions(args.directory)
    print("backend distribution runtime files: verified")


if __name__ == "__main__":
    main()
