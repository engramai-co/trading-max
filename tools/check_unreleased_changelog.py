"""Require categorized release notes under the changelog's Unreleased heading."""

from __future__ import annotations

import re
from pathlib import Path

from release_contract import CHANGELOG_BULLET_RE, CHANGELOG_SUBSECTION_RE


def main() -> int:
    text = Path("CHANGELOG.md").read_text(encoding="utf-8")
    match = re.search(r"^## \[Unreleased\]\s*$", text, re.MULTILINE)
    if match is None:
        print("unreleased changelog check failed: missing [Unreleased] heading")
        return 1
    next_heading = re.search(r"^## \[", text[match.end() :], re.MULTILINE)
    body_end = match.end() + next_heading.start() if next_heading else len(text)
    body = text[match.end() : body_end]
    if CHANGELOG_SUBSECTION_RE.search(body) is None or CHANGELOG_BULLET_RE.search(body) is None:
        print("unreleased changelog check failed: add a categorized changelog bullet")
        return 1
    print("unreleased changelog check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
