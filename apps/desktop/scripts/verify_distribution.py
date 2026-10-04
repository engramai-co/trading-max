"""Verify the actual DMG contents before emitting the desktop download manifest.

Maintainer-only: requires macOS and Xcode command line tools. No signing keys are
read/exported and nothing is uploaded. Run after signing, notarizing and stapling.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import plistlib
import re
import subprocess
import sys
import tempfile
from pathlib import Path

TEAM = "H757XFW8A9"
BUNDLE = "com.engram.trading-max.desktop-preview"
ROOT = Path(__file__).resolve().parents[3]
SEMVER = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")


def run(*args: str | Path) -> str:
    result = subprocess.run(  # noqa: S603 - fixed system tools; no shell or credentials
        [str(arg) for arg in args], capture_output=True, text=True, timeout=60, check=True
    )
    return result.stdout + result.stderr


def check_signature(path: Path, *, app: bool) -> None:
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", path)
    details = run("/usr/bin/codesign", "--display", "--verbose=4", path)
    lines = details.splitlines()
    if f"TeamIdentifier={TEAM}" not in lines or not any(
        line.startswith("Authority=Developer ID Application:") for line in lines
    ):
        raise ValueError("Package must use the expected Developer ID Application team")
    if app and not any("flags=" in line and "runtime" in line for line in lines):
        raise ValueError("App must enable Hardened Runtime")
    run("/usr/bin/xcrun", "stapler", "validate", path)
    if app:
        run("/usr/sbin/spctl", "--assess", "--type", "execute", path)
    else:
        run(
            "/usr/sbin/spctl",
            "--assess",
            "--type",
            "open",
            "--context",
            "context:primary-signature",
            path,
        )


def check_contents(mount: Path, version: str) -> None:
    apps = list(mount.glob("*.app"))
    if len(apps) != 1 or apps[0].is_symlink():
        raise ValueError("DMG must contain exactly one real application bundle")
    app = apps[0]
    check_signature(app, app=True)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    if (
        info.get("CFBundleIdentifier") != BUNDLE
        or info.get("CFBundleShortVersionString") != version
        or info.get("LSMinimumSystemVersion") != "13.0"
    ):
        raise ValueError("App identity, version or minimum macOS does not match the release")
    executable = info.get("CFBundleExecutable", "")
    if not isinstance(executable, str) or not executable or Path(executable).name != executable:
        raise ValueError("Invalid app executable path")
    architectures = run("/usr/bin/lipo", "-archs", app / "Contents/MacOS" / executable).split()
    if architectures != ["arm64"]:
        raise ValueError("Current desktop release must contain the Apple Silicon executable")
    build = json.loads((app / "Contents/Resources/runtime/build-info.json").read_text())
    if build.get("product_version") != version:
        raise ValueError("Bundled runtime version does not match the shell")


def verify(dmg: Path, version: str) -> dict:
    if not SEMVER.fullmatch(version):
        raise ValueError("Expected a stable MAJOR.MINOR.PATCH version")
    name = f"trading-max-v{version}-macos-arm64.dmg"
    if dmg.name != name or dmg.is_symlink() or not dmg.is_file():
        raise ValueError(f"Expected a regular file named {name}")
    before = dmg.stat()
    if not 0 < before.st_size <= 2_147_483_648:
        raise ValueError("Unexpected DMG size")
    check_signature(dmg, app=False)
    with tempfile.TemporaryDirectory(prefix="trading-max-distribution-") as temporary:
        mount = Path(temporary) / "mounted"
        mount.mkdir()
        attached = False
        try:
            run(
                "/usr/bin/hdiutil",
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-mountpoint",
                mount,
                dmg,
            )
            attached = True
            check_contents(mount, version)
        finally:
            if attached:
                run("/usr/bin/hdiutil", "detach", mount)
    with dmg.open("rb") as stream:
        sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    after = dmg.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        raise ValueError("DMG changed during verification; no release manifest generated")
    return {
        "schema": 1,
        "version": version,
        "target": "macos-arm64",
        "bundle_id": BUNDLE,
        "team_id": TEAM,
        "signing": "Developer ID Application",
        "notarized": True,
        "minimum_macos": "13.0",
        "asset": {"name": name, "size": before.st_size, "sha256": sha256},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dmg", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Distribution verification requires macOS")
    version = (ROOT / "VERSION").read_text().strip()
    expected = f"trading-max-v{version}-macos-arm64.json"
    if args.output.name != expected:
        parser.error(f"Output must be named {expected}")
    if args.output.exists() or args.output.is_symlink():
        parser.error("Output already exists; refusing to overwrite earlier release evidence")
    try:
        result = verify(args.dmg.absolute(), version)
        with args.output.open("x") as stream:
            stream.write(json.dumps(result, indent=2) + "\n")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.stderr.write(f"Distribution verification failed: {error}\n")
        return 1
    sys.stdout.write(f"Verified desktop distribution manifest: {args.output}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
