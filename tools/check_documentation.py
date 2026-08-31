"""Validate repository-local links in tracked Markdown documentation."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\((?P<target>[^)]+)\)")
EXTERNAL_PREFIXES = ("#", "http://", "https://", "mailto:")
CANONICAL_MARKERS = {
    "README.md": ("https://github.com/engramai-co/trading-max",),
    ".agents/skills/trading-max-onboard/SKILL.md": (
        "engramai-co/trading-max",
        "trading-max doctor --check-updates",
    ),
}
STALE_MARKERS = (
    "git clone <repository-url>",
    "canonical repository remains private",
    "latest validated private release tag",
    "OPS_DISPATCH_TOKEN",
)


def tracked_markdown_files() -> list[Path]:
    """Return tracked Markdown files so generated directories stay out of scope."""
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git executable is required for documentation checks")
    result = subprocess.run(  # noqa: S603 - executable resolved from trusted PATH
        [git, "ls-files", "--cached", "-z", "--", "*.md"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [ROOT / path for path in result.stdout.decode().split("\0") if path]


def local_link_violations() -> list[str]:
    """Return missing or escaping repository-local Markdown links."""
    violations: list[str] = []
    for document in tracked_markdown_files():
        for line_number, line in enumerate(
            document.read_text(encoding="utf-8").splitlines(),
            start=1,
        ):
            for match in MARKDOWN_LINK.finditer(line):
                raw_target = match.group("target").strip()
                target = raw_target.split(maxsplit=1)[0].strip("<>")
                if not target or target.startswith(EXTERNAL_PREFIXES):
                    continue
                candidate = (document.parent / target.split("#", maxsplit=1)[0]).resolve()
                try:
                    candidate.relative_to(ROOT)
                except ValueError:
                    violations.append(
                        f"{document.relative_to(ROOT)}:{line_number}: "
                        f"link escapes repository: {target}"
                    )
                    continue
                if not candidate.exists():
                    violations.append(
                        f"{document.relative_to(ROOT)}:{line_number}: "
                        f"missing local target: {target}"
                    )
    return violations


def content_contract_violations() -> list[str]:
    """Reject known stale topology text and missing canonical markers."""

    violations: list[str] = []
    for path, markers in CANONICAL_MARKERS.items():
        content = (ROOT / path).read_text(encoding="utf-8")
        for marker in markers:
            if marker not in content:
                violations.append(f"{path}: missing current-topology marker {marker!r}")
    for document in tracked_markdown_files():
        content = document.read_text(encoding="utf-8")
        for marker in STALE_MARKERS:
            if marker in content:
                violations.append(f"{document.relative_to(ROOT)}: stale topology marker {marker!r}")
    return violations


def main() -> int:
    """Print documentation-link failures and return a CI-friendly status."""
    violations = local_link_violations() + content_contract_violations()
    if violations:
        print("documentation violations:")
        print("\n".join(f"- {violation}" for violation in violations))
        return 1
    print("documentation links: clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
