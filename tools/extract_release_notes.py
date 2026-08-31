"""Print one release's validated CHANGELOG body for tags and GitHub Releases."""

from __future__ import annotations

import argparse
from pathlib import Path

from release_contract import ReleaseContractError, extract_release_notes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("version")
    arguments = parser.parse_args()
    try:
        notes = extract_release_notes(
            arguments.path.read_text(encoding="utf-8"),
            arguments.version,
        )
    except (OSError, ReleaseContractError) as error:
        print(f"release-note extraction failed: {error}")
        return 1
    print(notes, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
