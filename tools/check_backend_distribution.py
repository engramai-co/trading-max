"""Verify that built backend archives retain their required reference data."""

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
    for name in ("package.json", "package-lock.json", "index.mjs", "complete.mjs"):
        references[f"synthesis/_pi/{name}"] = (
            ROOT / "backend/src/trading_max/synthesis/_pi" / name
        ).read_bytes()
    with zipfile.ZipFile(directory / f"{stem}-py3-none-any.whl") as wheel:
        names = wheel.namelist()
        for name, expected in references.items():
            member = f"trading_max/{name}"
            if names.count(member) != 1 or wheel.read(member) != expected:
                raise ValueError(f"wheel reference data is missing, duplicated or changed: {name}")
    with tarfile.open(directory / f"{stem}.tar.gz") as source:
        names = source.getnames()
        for name, expected in references.items():
            member = f"{stem}/src/trading_max/{name}"
            if names.count(member) != 1:
                raise ValueError(f"source reference data is missing or duplicated: {name}")
            stream = source.extractfile(member)
            if stream is None or stream.read() != expected:
                raise ValueError(f"source reference data changed: {name}")


def main() -> None:
    """Validate the archives created by the backend distribution build."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    validate_distributions(args.directory)
    print("backend distribution reference data: verified")


if __name__ == "__main__":
    main()
