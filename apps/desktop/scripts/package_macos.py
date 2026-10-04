"""Prepare a signed App/ZIP or a DMG without exporting keys or changing an install.

Notarization uses Apple's notarytool separately with a Keychain profile. This
keeps uploads, pending Apple submissions and final public publication explicit.
"""

from __future__ import annotations

import argparse
import json
import plistlib
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from verify_distribution import BUNDLE, ROOT, TEAM, check_signature

MAGIC = {
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
NODE = Path("Contents/Resources/runtime/node")
JIT = {"com.apple.security.cs.allow-jit": True}


def run(*args: str | Path, timeout: int = 120, stdout_only: bool = False) -> str:
    result = subprocess.run(  # noqa: S603 - fixed system tools, no shell or credentials
        [str(arg) for arg in args], capture_output=True, text=True, timeout=timeout, check=True
    )
    return result.stdout if stdout_only else result.stdout + result.stderr


def inspect_app(app: Path, version: str) -> list[Path]:
    if app.is_symlink() or not app.is_dir() or app.suffix != ".app":
        raise ValueError("Expected a real .app directory")
    app = app.resolve()
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    build = json.loads((app / "Contents/Resources/runtime/build-info.json").read_text())
    if (
        info.get("CFBundleIdentifier") != BUNDLE
        or info.get("CFBundleShortVersionString") != version
        or info.get("LSMinimumSystemVersion") != "13.0"
        or build.get("product_version") != version
    ):
        raise ValueError("App identity/version/platform and bundled runtime must match VERSION")
    code = []
    for path in app.rglob("*"):
        if path.is_symlink():
            if not path.resolve().is_relative_to(app) or not path.resolve().exists():
                raise ValueError(f"Bundle contains an escaping or broken symlink: {path}")
        elif path.is_file():
            with path.open("rb") as stream:
                magic = stream.read(4)
            if magic in MAGIC:
                code.append(path.relative_to(app))
    executable = info.get("CFBundleExecutable", "")
    if not isinstance(executable, str) or not executable or Path(executable).name != executable:
        raise ValueError("Unexpected executable name")
    required = {
        NODE,
        Path("Contents/MacOS") / executable,
        Path("Contents/Resources/runtime/python/bin/python3.12"),
    }
    if not required.issubset(code):
        raise ValueError("App, Node and Python native executables are required")
    return sorted(code, key=lambda path: (-len(path.parts), str(path)))


def identity_name(identity: str, *, rehearsal: bool = False) -> str:
    if not re.fullmatch(r"[A-Fa-f0-9]{40}", identity):
        raise ValueError("Use a certificate SHA-1 from security find-identity, never a password")
    listing = run("/usr/bin/security", "find-identity", "-v", "-p", "codesigning")
    matches = re.findall(r"\b" + identity.upper() + r'\s+"([^"]+)"', listing.upper())
    prefix = "APPLE DEVELOPMENT:" if rehearsal else "DEVELOPER ID APPLICATION:"
    if len(matches) != 1 or not matches[0].startswith(prefix):
        raise ValueError("Required valid signing identity is not available in Keychain")
    if not rehearsal and not matches[0].endswith(f"({TEAM})"):
        raise ValueError("Developer ID identity must belong to the expected Apple team")
    return matches[0]


def verify_code(path: Path, *, rehearsal: bool, entitlements: dict) -> None:
    run("/usr/bin/codesign", "--verify", "--strict", path)
    details = run("/usr/bin/codesign", "--display", "--verbose=4", path)
    prefix = "Authority=Apple Development:" if rehearsal else "Authority=Developer ID Application:"
    if f"TeamIdentifier={TEAM}" not in details.splitlines() or not any(
        line.startswith(prefix) for line in details.splitlines()
    ):
        raise ValueError(f"Unexpected signing identity on {path.name}")
    if not any("flags=" in line and "runtime" in line for line in details.splitlines()):
        raise ValueError(f"Missing Hardened Runtime on {path.name}")
    if not rehearsal and not any(line.startswith("Timestamp=") for line in details.splitlines()):
        raise ValueError(f"Missing secure timestamp on {path.name}")
    actual = run(
        "/usr/bin/codesign", "--display", "--entitlements", "-", "--xml", path, stdout_only=True
    )
    # codesign emits no entitlement blob for an empty dictionary, notably for libraries.
    parsed = plistlib.loads(actual.encode()) if actual.strip() else {}
    if parsed != entitlements:
        raise ValueError(f"Unexpected entitlements on {path.name}")


def prepare(
    app: Path, output: Path, identity: str, version: str, *, rehearsal: bool = False
) -> dict:
    # Inspect everything before allocating output or invoking a private signing key.
    code = inspect_app(app, version)
    identity_name(identity, rehearsal=rehearsal)
    if (
        output.exists()
        or output.is_symlink()
        or output.resolve().is_relative_to(ROOT)
        or output.resolve().is_relative_to(app.resolve())
    ):
        raise ValueError(
            "Use a new output directory outside the checkout; existing output is preserved"
        )
    output.mkdir(mode=0o700, parents=True)
    copied = output / app.name
    run("/usr/bin/ditto", app, copied, timeout=300)
    with tempfile.TemporaryDirectory(prefix="signing-", dir=output) as temporary:
        empty = Path(temporary) / "empty.plist"
        jit = Path(temporary) / "node.plist"
        empty.write_bytes(plistlib.dumps({}))
        jit.write_bytes(plistlib.dumps(JIT))

        def sign(path: Path, *, node: bool = False) -> None:
            run(
                "/usr/bin/codesign",
                "--force",
                "--sign",
                identity,
                "--options",
                "runtime",
                "--timestamp=none" if rehearsal else "--timestamp",
                "--entitlements",
                jit if node else empty,
                path,
            )
            verify_code(path, rehearsal=rehearsal, entitlements=JIT if node else {})

        for index, relative in enumerate(code, 1):
            sign(copied / relative, node=relative == NODE)
            sys.stdout.write(f"Signed native component {index}/{len(code)}: {relative}\n")
            sys.stdout.flush()
        sign(copied)
    run("/usr/bin/codesign", "--verify", "--deep", "--strict", copied)
    archive = None
    if not rehearsal:
        archive = output / f"trading-max-v{version}-macos-arm64-app.zip"
        run(
            "/usr/bin/ditto",
            "-c",
            "-k",
            "--sequesterRsrc",
            "--keepParent",
            copied,
            archive,
            timeout=300,
        )
    result = {
        "version": version,
        "app": str(copied),
        "native_components": len(code),
        "internal_rehearsal": rehearsal,
        "archive": str(archive) if archive else None,
        "notarized": False,
    }
    (output / "signing-result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def make_dmg(app: Path, output: Path, identity: str, version: str) -> dict:
    inspect_app(app, version)
    identity_name(identity)
    # Do not package a development-signed or unstapled application as a release.
    check_signature(app, app=True)
    expected = f"trading-max-v{version}-macos-arm64.dmg"
    if output.name != expected or output.exists() or output.is_symlink():
        raise ValueError(f"Use a new file named {expected}; existing files are preserved")
    if output.resolve().is_relative_to(ROOT) or not output.parent.is_dir():
        raise ValueError("DMG output must be in an existing directory outside the checkout")
    with tempfile.TemporaryDirectory(prefix="dmg-", dir=output.parent) as temporary:
        stage = Path(temporary) / "image"
        stage.mkdir()
        run("/usr/bin/ditto", app, stage / app.name, timeout=300)
        (stage / "Applications").symlink_to("/Applications")
        run(
            "/usr/bin/hdiutil",
            "create",
            "-volname",
            f"Trading Max {version}",
            "-srcfolder",
            stage,
            "-format",
            "UDZO",
            "-fs",
            "HFS+",
            output,
            timeout=300,
        )
    run("/usr/bin/codesign", "--sign", identity, "--timestamp", output)
    run("/usr/bin/codesign", "--verify", "--strict", output)
    return {
        "dmg": str(output),
        "notarized": False,
        "next": "Submit and staple this DMG, then run verify_distribution.py",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["prepare", "dmg"])
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--identity", required=True, help="Public certificate SHA-1; private key stays in Keychain"
    )
    parser.add_argument(
        "--internal-rehearsal",
        action="store_true",
        help="Prepare only: use an Apple Development identity; never emits an upload ZIP",
    )
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Packaging requires macOS")
    if args.stage == "dmg" and args.internal_rehearsal:
        parser.error("A rehearsal App cannot be packaged as a public DMG")
    version = (ROOT / "VERSION").read_text().strip()
    try:
        result = (
            prepare(
                args.app.absolute(),
                args.output.absolute(),
                args.identity,
                version,
                rehearsal=args.internal_rehearsal,
            )
            if args.stage == "prepare"
            else make_dmg(args.app.absolute(), args.output.absolute(), args.identity, version)
        )
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        sys.stderr.write(
            f"Packaging stopped; input App and existing output were preserved: {error}\n"
        )
        return 1
    sys.stdout.write(json.dumps(result, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
