"""Verify the actual DMG contents before emitting the desktop download manifest.

Maintainer-only: requires macOS and Xcode command line tools. No signing keys are
read/exported and nothing is uploaded. Run after signing, notarizing and stapling.
"""

from __future__ import annotations

import argparse
import base64
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
MINIMUM_MACOS = "13.0"
ROOT = Path(__file__).resolve().parents[3]
SEMVER = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")
MACHO_MAGIC = {
    bytes.fromhex(value)
    for value in (
        "feedface",
        "feedfacf",
        "cefaedfe",
        "cffaedfe",
        "cafebabe",
        "bebafeca",
        "cafebabf",
        "bfbafeca",
    )
}


def run(*args: str | Path) -> str:
    result = subprocess.run(  # noqa: S603 - fixed system tools; no shell or credentials
        [str(arg) for arg in args], capture_output=True, text=True, timeout=60, check=True
    )
    return result.stdout + result.stderr


def check_load_commands(output: str, minimum: str = MINIMUM_MACOS) -> None:
    """Check deployment/load commands, not the linker version or a dylib's own ID."""

    def version(value: str) -> tuple[int, ...]:
        if not re.fullmatch(r"\d+(?:\.\d+){0,2}", value):
            raise ValueError("Missing or invalid native deployment version")
        parts = tuple(int(part) for part in value.split("."))
        return parts + (0,) * (3 - len(parts))

    minimums = []
    for block in re.split(r"^Load command \d+\s*$", output, flags=re.MULTILINE):
        command = re.search(r"^\s*cmd (LC_\w+)\s*$", block, re.MULTILINE)
        if not command:
            continue
        command = command.group(1)
        if command in {"LC_BUILD_VERSION", "LC_VERSION_MIN_MACOSX"}:
            if command == "LC_BUILD_VERSION":
                platform = re.search(r"^\s*platform (\S+)\s*$", block, re.MULTILINE)
                if not platform or platform.group(1).upper() not in {"1", "MACOS"}:
                    raise ValueError("Native component must target macOS")
            key = "minos" if command == "LC_BUILD_VERSION" else "version"
            target = re.search(rf"^\s*{key} (\S+)\s*$", block, re.MULTILINE)
            minimums.append(version(target.group(1) if target else ""))
        elif command in {
            "LC_LOAD_DYLIB",
            "LC_LOAD_WEAK_DYLIB",
            "LC_REEXPORT_DYLIB",
            "LC_LOAD_UPWARD_DYLIB",
            "LC_RPATH",
        }:
            key = "path" if command == "LC_RPATH" else "name"
            target = re.search(rf"^\s*{key} (.+) \(offset \d+\)\s*$", block, re.MULTILINE)
            if not target:
                raise ValueError("Invalid native library load path")
            dependency = target.group(1)
            if dependency.startswith("/") and not dependency.startswith(
                ("/System/Library/", "/usr/lib/")
            ):
                raise ValueError("Native component depends on a non-system absolute path")
    if not minimums or any(target > version(minimum) for target in minimums):
        raise ValueError(f"Native component requires a newer macOS than {minimum}")


def check_native_compatibility(app: Path) -> int:
    count = 0
    for path in app.rglob("*"):
        if path.is_symlink():
            if not path.resolve().is_relative_to(app.resolve()) or not path.resolve().exists():
                raise ValueError("App contains an escaping or broken symlink")
            continue
        if not path.is_file():
            continue
        with path.open("rb") as stream:
            if stream.read(4) not in MACHO_MAGIC:
                continue
        if "arm64" not in run("/usr/bin/lipo", "-archs", path).split():
            raise ValueError(f"Missing arm64 code: {path.relative_to(app)}")
        try:
            check_load_commands(run("/usr/bin/otool", "-arch", "arm64", "-l", path))
        except ValueError as error:
            raise ValueError(f"{path.relative_to(app)}: {error}") from error
        count += 1
    if not count:
        raise ValueError("App contains no native code")
    return count


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
        or info.get("LSMinimumSystemVersion") != MINIMUM_MACOS
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
    if tuple(map(int, version.split("."))) >= (1, 12, 0):
        check_updater(app, info)
    check_native_compatibility(app)


def check_updater(app: Path, info: dict) -> None:
    expected = plistlib.loads((ROOT / "apps/desktop/src-tauri/Info.plist").read_bytes())
    keys = [key for key in expected if key.startswith("SU")]
    if any(info.get(key) != expected[key] for key in keys):
        raise ValueError("Bundled updater trust or user-consent configuration differs from source")
    if len(base64.b64decode(info.get("SUPublicEDKey", ""), validate=True)) != 32:
        raise ValueError("Updater is missing its pinned Ed25519 public key")
    framework = app / "Contents/Frameworks/Sparkle.framework"
    if not (framework / "Sparkle").is_file():
        raise ValueError("Bundled updater framework is missing")
    lock = json.loads((ROOT / "apps/desktop/sparkle.lock.json").read_text())
    framework_info = plistlib.loads((framework / "Resources/Info.plist").read_bytes())
    if framework_info.get("CFBundleShortVersionString") != lock["version"]:
        raise ValueError("Bundled updater framework differs from the pinned SDK")
    # Nested helpers must also carry our team's signature, not the upstream SDK's.
    for bundle in [framework, *framework.rglob("*.app"), *framework.rglob("*.xpc")]:
        details = run("/usr/bin/codesign", "--display", "--verbose=4", bundle)
        if f"TeamIdentifier={TEAM}" not in details.splitlines():
            raise ValueError("Updater helper has a different signing team")


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
        "minimum_macos": MINIMUM_MACOS,
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
