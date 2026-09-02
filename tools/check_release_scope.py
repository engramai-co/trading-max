"""Report whether a Git diff requires a Trading Max product release."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
from pathlib import Path

from release_scope import VERSION_SURFACES, is_non_product_path, normalize_version_surface

GIT = shutil.which("git")
REVISION_RE = re.compile(r"^(?:[0-9a-f]{40}|HEAD)$")


def changed_paths(base: str, head: str) -> list[str]:
    if GIT is None:
        raise RuntimeError("git executable is required")
    if REVISION_RE.fullmatch(base) is None or REVISION_RE.fullmatch(head) is None:
        raise ValueError("revisions must be full lowercase commit SHAs or HEAD")
    result = subprocess.run(  # noqa: S603 - revisions are constrained above.
        [GIT, "diff", "--name-only", "--diff-filter=ACDMRTUXB", f"{base}...{head}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def revision_content(revision: str, path: str) -> str:
    if GIT is None:
        raise RuntimeError("git executable is required")
    result = subprocess.run(  # noqa: S603 - revision is constrained in changed_paths.
        [GIT, "show", f"{revision}:{path}"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def product_paths(base: str, head: str, paths: list[str]) -> list[str]:
    product: list[str] = []
    for path in paths:
        if path in VERSION_SURFACES:
            before = normalize_version_surface(path, revision_content(base, path))
            after = normalize_version_surface(path, revision_content(head, path))
            if before != after:
                product.append(path)
            continue
        if not is_non_product_path(path):
            product.append(path)
    return product


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--github-output", type=Path)
    arguments = parser.parse_args()

    paths = changed_paths(arguments.base, arguments.head)
    changed_product_paths = product_paths(arguments.base, arguments.head, paths)
    required = bool(changed_product_paths)
    label = "product release required" if required else "non-product change; release skipped"
    print(label)
    for path in changed_product_paths:
        print(f"- {path}")

    if arguments.github_output is not None:
        with arguments.github_output.open("a", encoding="utf-8") as output:
            output.write(f"release_required={'true' if required else 'false'}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
