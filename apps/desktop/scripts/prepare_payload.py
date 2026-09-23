"""Bundle existing runtimes and locked product code; no runtime downloads."""
# These are developer-supplied build tool paths, always executed without a shell.
# ruff: noqa: S603, S607

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DESKTOP = ROOT / "apps/desktop"


def run(*args, cwd=ROOT):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def configure_desktop_web(web: Path) -> None:
    """Keep the signed install immutable, including Next fetch/image caches."""
    entry = web / "server.js"
    source = entry.read_text()
    anchor = "process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)"
    if source.count(anchor) != 1:
        raise RuntimeError("Unsupported Next standalone entry; cache policy was not applied")
    entry.write_text(
        source.replace(
            anchor,
            "// Desktop preview: bounded memory cache only; never write into the signed app.\n"
            "nextConfig.experimental.isrFlushToDisk = false\n"
            "nextConfig.images.maximumDiskCacheSize = 0\n" + anchor,
        )
    )
    # Builds must not carry caches from an earlier local preview session.
    shutil.rmtree(web / ".next/cache", ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-home", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("This preview currently targets Apple Silicon macOS only")
    if not subprocess.check_output([str(args.node), "--version"], text=True).startswith("v22."):
        raise SystemExit("Use the project's supported Node 22 runtime")
    if not subprocess.check_output(
        [str(args.python_home / "bin/python3.12"), "--version"], text=True
    ).startswith("Python 3.12."):
        raise SystemExit("Use a standalone Python 3.12 runtime")
    run(sys.executable, ROOT / "tools/check_version_consistency.py")
    payload = DESKTOP / "payload"
    payload.mkdir(exist_ok=True)
    marker = payload / ".build-payload"
    if any(payload.iterdir()) and not marker.exists():
        raise SystemExit("Refusing to replace an unmarked payload directory")
    marker.write_text("generated desktop runtime payload\n")
    if (payload / "python").exists():
        shutil.rmtree(payload / "python")
    shutil.copytree(
        args.python_home,
        payload / "python",
        symlinks=True,
        ignore=shutil.ignore_patterns(
            "__pycache__",
            "*.pyc",
            "*.a",
            "test",
            "tests",
            "idlelib",
            "tkinter",
            "turtledemo",
            "ensurepip",
        ),
    )
    # Replace the inode rather than overwriting an executable used by a prior
    # validation run. macOS can retain its old code-signature cache and SIGKILL
    # an otherwise valid copied binary until it is atomically replaced.
    node_staging = payload / "node.new"
    shutil.copy2(args.node, node_staging)
    node_staging.replace(payload / "node")
    node_license = args.node.resolve().parents[1] / "LICENSE"
    if not node_license.is_file():
        raise SystemExit("The Node distribution's LICENSE file is required")
    shutil.copy2(node_license, payload / "NODE-LICENSE.txt")
    requirements = payload / "runtime-requirements.txt"
    run(
        "uv",
        "export",
        "--all-packages",
        "--no-dev",
        "--no-emit-workspace",
        "--no-hashes",
        "--frozen",
        "--output-file",
        requirements,
    )
    site = payload / "python/lib/python3.12/site-packages"
    run(
        "uv",
        "pip",
        "install",
        "--python",
        payload / "python/bin/python3.12",
        "--target",
        site,
        "--no-compile-bytecode",
        "-r",
        requirements,
    )
    for source, target in [
        (ROOT / "backend/src/trading_max", payload / "code/backend/src/trading_max"),
        (ROOT / "backend/migrations", payload / "code/backend/migrations"),
        (ROOT / "services/api/trading_max_api", payload / "code/services/api/trading_max_api"),
    ]:
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(
            source,
            target,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules", "test"),
        )
    pi = payload / "code/backend/src/trading_max/synthesis/_pi"
    run(
        args.node.with_name("npm"),
        "ci",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        cwd=pi,
    )
    shutil.copy2(ROOT / "services/__init__.py", payload / "code/services/__init__.py")
    shutil.copy2(ROOT / "services/api/__init__.py", payload / "code/services/api/__init__.py")
    shutil.copy2(ROOT / "VERSION", payload / "code/VERSION")
    shutil.copy2(ROOT / "LICENSE", payload / "LICENSE")
    shutil.copy2(DESKTOP / "scripts/supervisor.py", payload / "supervisor.py")
    shutil.copy2(DESKTOP / "scripts/preview_data.py", payload / "preview_data.py")
    shutil.copy2(DESKTOP / "scripts/node-launcher.cjs", payload / "node-launcher.cjs")
    web = ROOT / "apps/web/.next/standalone"
    if not (web / "server.js").is_file():
        raise SystemExit("Build apps/web before preparing the desktop payload")
    if (payload / "web").exists():
        shutil.rmtree(payload / "web")
    shutil.copytree(
        web,
        payload / "web",
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("*.map", ".DS_Store"),
    )
    configure_desktop_web(payload / "web")
    seed = payload / "seed"
    if seed.exists():
        shutil.rmtree(seed)
    run(sys.executable, DESKTOP / "scripts/build_seed.py", seed)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    info = {
        "product_version": (ROOT / "VERSION").read_text().strip(),
        "source_revision": revision,
        "runtime": "Tauri/WKWebView + Node 22 + Python 3.12",
        "data": "isolated synthetic demo or explicitly selected local workspace",
        "node_sha256": hashlib.sha256(args.node.read_bytes()).hexdigest(),
        "python_version": subprocess.check_output(
            [str(payload / "python/bin/python3.12"), "--version"], text=True
        ).strip(),
    }
    (payload / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")


if __name__ == "__main__":
    main()
