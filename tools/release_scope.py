"""Classify whether a repository change alters the shipped product."""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import PurePosixPath

VERSION_SURFACES = {
    "VERSION",
    "apps/web/package-lock.json",
    "apps/web/package.json",
    "backend/pyproject.toml",
    "backend/src/trading_max/__init__.py",
    "contracts/openapi.json",
    "package.json",
    "pyproject.toml",
    "uv.lock",
}

NON_PRODUCT_PREFIXES = (
    ".agents/",
    ".codegraph/",
    ".codex/",
    ".cursor/",
    ".github/",
    ".impeccable/",
    "backend/tests/",
    "design-system/",
    "docs/",
    "research_",
    "services/api/tests/",
    "tools/",
)

NON_PRODUCT_FILES = {
    ".editorconfig",
    ".gitattributes",
    ".gitignore",
    "AGENTS.md",
    "CODEOWNERS",
    "LICENSE",
    "NOTICE",
    "deploy/macos/production-smoke.sh",
}

NON_PRODUCT_TEST_PARTS = {"__snapshots__", "e2e", "fixtures", "test", "tests"}
NON_PRODUCT_TEST_SUFFIXES = (
    ".spec.js",
    ".spec.jsx",
    ".spec.ts",
    ".spec.tsx",
    ".test.js",
    ".test.jsx",
    ".test.ts",
    ".test.tsx",
)


def is_non_product_path(value: str) -> bool:
    """Return whether *value* cannot change the installed product."""

    path = value.strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    if not path:
        return True
    pure_path = PurePosixPath(path)
    if path in NON_PRODUCT_FILES or pure_path.suffix.lower() in {".md", ".mdx"}:
        return True
    if path.startswith(NON_PRODUCT_PREFIXES):
        return True
    if any(part in NON_PRODUCT_TEST_PARTS for part in pure_path.parts):
        return True
    return path.endswith(NON_PRODUCT_TEST_SUFFIXES)


def release_required(paths: list[str] | tuple[str, ...]) -> bool:
    """Return whether at least one changed path alters the shipped product."""

    return any(not is_non_product_path(path) for path in paths)


def normalize_version_surface(path: str, content: str) -> object:
    """Remove only the product-version value from a known version surface."""

    if path == "VERSION":
        return "<VERSION>\n"
    if path in {"package.json", "apps/web/package.json"}:
        payload = json.loads(content)
        payload["version"] = "<VERSION>"
        return payload
    if path == "apps/web/package-lock.json":
        payload = json.loads(content)
        payload["version"] = "<VERSION>"
        payload["packages"][""]["version"] = "<VERSION>"
        return payload
    if path in {"pyproject.toml", "backend/pyproject.toml"}:
        payload = tomllib.loads(content)
        payload["project"]["version"] = "<VERSION>"
        return payload
    if path == "backend/src/trading_max/__init__.py":
        return re.sub(
            r'(?m)^__version__\s*=\s*"[^"]+"$',
            '__version__ = "<VERSION>"',
            content,
        )
    if path == "contracts/openapi.json":
        payload = json.loads(content)
        payload["info"]["version"] = "<VERSION>"
        return payload
    if path == "uv.lock":
        payload = tomllib.loads(content)
        for package in payload.get("package", []):
            if package.get("name") in {"trading-max", "trading-max-backend"}:
                package["version"] = "<VERSION>"
        return payload
    raise ValueError(f"not a known version surface: {path}")
