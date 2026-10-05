"""Resume a signed desktop release on its maintainer Mac, without exporting keys.

Prepare/resume stops successfully while Apple is processing a saved submission.
Publish is a separate final action requiring matching native acceptance evidence.
All state, command output and artifacts belong in a private directory outside Git.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

import update_feed
from prepare_sparkle import inventory, prepare, sha256
from verify_distribution import ROOT, SEMVER

REPO = "engramai-co/trading-max"
SCRIPTS = ROOT / "apps/desktop/scripts"
REQUIRED_ACCEPTANCE = {
    "native_install",
    "update_success",
    "download_interrupt",
    "signature_rejection",
    "install_cancel_or_failure",
    "runtime_shutdown",
    "relaunch_preferences",
}


class Pending(Exception):
    """A durable Apple submission is pending; no upload should be repeated."""


def now() -> str:
    return dt.datetime.now(dt.UTC).isoformat()


def atomic_json(path: Path, value: dict) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("x") as stream:
        temporary.chmod(0o600)
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def git(*args: str) -> str:
    return subprocess.check_output(  # noqa: S603 - fixed Git queries
        ["git", *args],  # noqa: S607 - developer toolchain
        cwd=ROOT,
        text=True,
        timeout=30,
    ).strip()


def fingerprint(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Expected a regular release artifact: {path.name}")
    return {"path": str(path), "size": path.stat().st_size, "sha256": sha256(path)}


def check_fingerprint(record: dict) -> None:
    if fingerprint(Path(record["path"])) != record:
        raise ValueError("A recorded release artifact changed; start a new candidate")


def app_fingerprint(app: Path) -> str:
    if app.is_symlink() or not app.is_dir():
        raise ValueError("Expected a real application directory")
    return hashlib.sha256(json.dumps(inventory(app), sort_keys=True).encode()).hexdigest()


def matching_asset(assets: list[dict], path: Path) -> bool:
    matches = [asset for asset in assets if asset.get("name") == path.name]
    if not matches:
        return False
    record = fingerprint(path)
    if len(matches) != 1 or any(
        matches[0].get(key) != value
        for key, value in {
            "state": "uploaded",
            "size": record["size"],
            "digest": "sha256:" + record["sha256"],
        }.items()
    ):
        raise ValueError(f"Published asset {path.name} conflicts; never overwrite it")
    return True


def validate_acceptance(record: dict, dmg: Path, version: str) -> None:
    checks = record.get("checks", {})
    if (
        record.get("version") != version
        or record.get("sha256") != sha256(dmg)
        or not record.get("host")
        or not record.get("evidence")
        or any(checks.get(check) is not True for check in REQUIRED_ACCEPTANCE)
    ):
        raise ValueError("Native acceptance must cover every release gate and the exact DMG")


class Release:
    def __init__(self, work: Path, lock, config: dict | None = None):
        self.work = work
        self.lock = lock
        self.state_path = work / "release-state.json"
        if self.state_path.exists():
            self.state = read_json(self.state_path)
            if config and self.state["config"] != config:
                raise ValueError(
                    "Resume with the existing configuration; do not reuse a candidate directory"
                )
        else:
            if config is None:
                raise ValueError("No release state; use prepare first")
            self.state = {
                "schema": 1,
                "created_utc": now(),
                "config": config,
                "version": (ROOT / "VERSION").read_text().strip(),
                "source_commit": git("rev-parse", "HEAD"),
                "source_tree": git("rev-parse", "HEAD^{tree}"),
                "commands": [],
                "notary": {},
                "status": "created",
            }
            self.save()
        if self.state.get("schema") != 1:
            raise ValueError("Unknown release-state schema")
        self.version = self.state["version"]
        if not SEMVER.fullmatch(self.version):
            raise ValueError("Expected stable SemVer")

    def save(self) -> None:
        self.state["updated_utc"] = now()
        atomic_json(self.state_path, self.state)

    def phase(self, message: str) -> None:
        self.state["status"] = message
        self.save()
        sys.stdout.write(message + "\n")
        sys.stdout.flush()

    def command(self, name: str, args: list, *, timeout: int = 1800) -> str:
        number = len(self.state["commands"]) + 1
        output = self.work / f"{number:03d}-{name}.stdout"
        error = output.with_suffix(".stderr")
        item = {"name": name, "started_utc": now(), "stdout": str(output), "stderr": str(error)}
        self.state["commands"].append(item)
        self.save()
        environment = os.environ.copy()
        if self.state["config"].get("node"):
            environment["PATH"] = (
                str(Path(self.state["config"]["node"]).parent)
                + os.pathsep
                + environment.get("PATH", "")
            )
        with output.open("x") as out, error.open("x") as err:
            process = subprocess.Popen(  # noqa: S603 - fixed tools and public paths/profile names
                [str(arg) for arg in args],
                cwd=ROOT,
                stdout=out,
                stderr=err,
                start_new_session=True,
                pass_fds=(self.lock.fileno(),),
                env=environment,
            )
            # The subprocess retains the lock and output files if this driver is interrupted.
            item["pid"] = process.pid
            self.save()
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                item["interrupted"] = True
                self.save()
                raise ValueError(
                    f"{name} timed out; retained output requires reconciliation"
                ) from None
        item.update(exit=code, finished_utc=now())
        self.save()
        if code:
            raise ValueError(f"{name} failed ({code}); inspect {error}")
        return output.read_text()

    def assert_source(self) -> None:
        if (
            git("status", "--porcelain")
            or git("rev-parse", "HEAD^{tree}") != self.state["source_tree"]
        ):
            raise ValueError(
                "Source must be clean and match the candidate tree; use a new directory after changes"
            )
        if (ROOT / "VERSION").read_text().strip() != self.version:
            raise ValueError("Source version differs from the candidate")

    def build(self) -> Path:
        app = ROOT / "apps/desktop/src-tauri/target/release/bundle/macos/Trading Max Preview.app"
        if self.state.get("signed"):
            return app
        if not self.state.get("built"):
            self.phase("building locked desktop payload")
            prepare()
            commands = [
                ["uv", "sync", "--all-packages", "--group", "dev", "--frozen"],
                ["npm", "run", "llm:install"],
                ["npm", "--prefix", "apps/web", "ci", "--no-audit", "--no-fund"],
                ["npm", "--prefix", "apps/web", "run", "build"],
                ["npm", "--prefix", "apps/desktop", "ci", "--no-audit", "--no-fund"],
                [
                    "uv",
                    "run",
                    "--frozen",
                    "python",
                    SCRIPTS / "prepare_payload.py",
                    "--python-home",
                    self.state["config"]["python_home"],
                    "--node",
                    self.state["config"]["node"],
                ],
                ["npm", "--prefix", "apps/desktop", "run", "build"],
            ]
            for index, command in enumerate(commands):
                self.command(f"build-{index}", command)
            build = read_json(app / "Contents/Resources/runtime/build-info.json")
            if (
                build.get("source_revision") != self.state["source_commit"]
                or build.get("product_version") != self.version
            ):
                raise ValueError("Built application provenance differs from this candidate")
            self.state["built"] = app_fingerprint(app)
            self.save()
        if app_fingerprint(app) != self.state["built"]:
            raise ValueError("Built application changed before signing; start a new candidate")
        return app

    def sign(self, app: Path) -> Path:
        if not self.state.get("signed"):
            self.phase("signing application and nested helpers")
            candidate = self.work / f"signed-{uuid.uuid4().hex[:8]}"
            self.command(
                "sign",
                [
                    "uv",
                    "run",
                    "--frozen",
                    "python",
                    SCRIPTS / "package_macos.py",
                    "prepare",
                    "--app",
                    app,
                    "--output",
                    candidate,
                    "--identity",
                    self.state["config"]["identity"],
                ],
            )
            result = read_json(candidate / "signing-result.json")
            self.state["signed"] = {
                "app": result["app"],
                "archive": fingerprint(Path(result["archive"])),
            }
            self.save()
        check_fingerprint(self.state["signed"]["archive"])
        return Path(self.state["signed"]["app"])

    def notarize(self, stage: str, artifact: Path) -> None:
        record = self.state["notary"].get(stage)
        if record is None:
            self.phase(f"uploading {stage} for Apple notarization")
            record = {"artifact": fingerprint(artifact), "submission_started_utc": now()}
            self.state["notary"][stage] = record
            self.save()
            try:
                receipt = json.loads(
                    self.command(
                        f"notary-{stage}-submit",
                        [
                            "xcrun",
                            "notarytool",
                            "submit",
                            artifact,
                            "--keychain-profile",
                            self.state["config"]["notary_profile"],
                            "--no-s3-acceleration",
                            "--no-wait",
                            "--output-format",
                            "json",
                        ],
                    )
                )
            except (ValueError, json.JSONDecodeError):
                # The next resume inspects the saved command receipt, never blindly resubmits.
                record["upload_confirmation"] = "unknown"
                self.save()
                raise
            if not receipt.get("id") or receipt.get("message") != "Successfully uploaded file":
                raise ValueError(
                    "Apple did not confirm complete upload; preserve and reconcile the receipt"
                )
            record.update(id=receipt["id"], upload_confirmation="complete")
            self.save()
        elif not record.get("id"):
            attempts = [c for c in self.state["commands"] if c["name"] == f"notary-{stage}-submit"]
            try:
                receipt = read_json(Path(attempts[-1]["stdout"]))
            except (IndexError, OSError, ValueError):
                raise ValueError(
                    "Interrupted notarization has no complete receipt; inspect Apple history before retrying"
                ) from None
            if not receipt.get("id") or receipt.get("message") != "Successfully uploaded file":
                raise ValueError("Incomplete upload receipt: no automatic duplicate submission")
            record.update(id=receipt["id"], upload_confirmation="complete")
            self.save()
        if record.get("status") == "Accepted":
            return
        check_fingerprint(record["artifact"])
        response = json.loads(
            self.command(
                f"notary-{stage}-info",
                [
                    "xcrun",
                    "notarytool",
                    "info",
                    record["id"],
                    "--keychain-profile",
                    self.state["config"]["notary_profile"],
                    "--output-format",
                    "json",
                ],
                timeout=90,
            )
        )
        if response.get("id") != record["id"]:
            raise ValueError("Apple status does not match the saved submission")
        record["status"] = response.get("status")
        self.save()
        if record["status"] == "Invalid":
            self.command(
                f"notary-{stage}-log",
                [
                    "xcrun",
                    "notarytool",
                    "log",
                    record["id"],
                    "--keychain-profile",
                    self.state["config"]["notary_profile"],
                ],
                timeout=90,
            )
            raise ValueError(
                f"Apple rejected {stage}; inspect its saved log and build a new candidate"
            )
        if record["status"] == "In Progress":
            raise Pending(f"waiting for Apple: {stage} {record['id']}")
        if record["status"] != "Accepted":
            raise ValueError("Apple returned an unrecognized status; inspect the saved response")

    def prepare(self) -> None:
        self.assert_source()
        app = self.sign(self.build())
        self.notarize("app", Path(self.state["signed"]["archive"]["path"]))
        if not self.state.get("app_stapled"):
            self.phase("stapling accepted application")
            self.command("app-staple", ["xcrun", "stapler", "staple", app])
            self.command("app-staple-check", ["xcrun", "stapler", "validate", app])
            self.state["app_stapled"] = True
            self.save()
        if not self.state.get("dmg"):
            self.phase("assembling signed disk image")
            output = self.work / f"image-{uuid.uuid4().hex[:8]}"
            output.mkdir()
            dmg = output / f"trading-max-v{self.version}-macos-arm64.dmg"
            self.command(
                "dmg",
                [
                    "uv",
                    "run",
                    "--frozen",
                    "python",
                    SCRIPTS / "package_macos.py",
                    "dmg",
                    "--app",
                    app,
                    "--output",
                    dmg,
                    "--identity",
                    self.state["config"]["identity"],
                ],
            )
            self.state["dmg"] = str(dmg)
            self.save()
        dmg = Path(self.state["dmg"])
        self.notarize("dmg", dmg)
        if not self.state.get("dmg_stapled"):
            self.phase("stapling accepted disk image")
            self.command("dmg-staple", ["xcrun", "stapler", "staple", dmg])
            self.command("dmg-staple-check", ["xcrun", "stapler", "validate", dmg])
            self.state["dmg_stapled"] = fingerprint(dmg)
            self.save()
        check_fingerprint(self.state["dmg_stapled"])
        if not self.state.get("verified"):
            self.phase("verifying actual DMG and signed runtime")
            verification = self.work / f"verification-{uuid.uuid4().hex[:8]}"
            verification.mkdir()
            manifest = verification / dmg.with_suffix(".json").name
            self.command(
                "distribution",
                [
                    "uv",
                    "run",
                    "--frozen",
                    "python",
                    SCRIPTS / "verify_distribution.py",
                    dmg,
                    "--output",
                    manifest,
                ],
            )
            update_feed.validate_manifest(dmg, read_json(manifest), self.version)
            runtime_result = self.work / f"runtime-{uuid.uuid4().hex[:8]}.json"
            self.command(
                "runtime",
                [
                    "uv",
                    "run",
                    "--frozen",
                    "python",
                    SCRIPTS / "validate_runtime.py",
                    app / "Contents/Resources/runtime",
                    runtime_result,
                ],
            )
            runtime = read_json(runtime_result)
            if len(runtime.get("checks", [])) < 19:
                raise ValueError("Packaged runtime acceptance did not complete")
            self.state["verified"] = {
                "manifest": fingerprint(manifest),
                "runtime": fingerprint(runtime_result),
            }
            self.save()
        for artifact in self.state["verified"].values():
            check_fingerprint(artifact)
        manifest = Path(self.state["verified"]["manifest"]["path"])
        if not self.state.get("feed"):
            self.phase("signing update archive and appcast")
            feed = dmg.with_suffix(".xml")
            if feed.exists():
                update_feed.verify_existing(dmg, manifest, feed)
            else:
                update_feed.create(dmg, manifest, feed)
            self.state["feed"] = fingerprint(feed)
            self.save()
        check_fingerprint(self.state["feed"])
        self.phase("ready for native acceptance; nothing published")

    def publish(self, acceptance: Path) -> None:
        self.assert_source()
        if not self.state.get("feed") or not self.state.get("verified"):
            raise ValueError("Prepare must complete before publication")
        dmg = Path(self.state["dmg"])
        validate_acceptance(read_json(acceptance), dmg, self.version)
        files = [self.state["dmg_stapled"], self.state["verified"]["manifest"], self.state["feed"]]
        for record in files:
            check_fingerprint(record)
        update_feed.verify_existing(
            dmg, Path(self.state["verified"]["manifest"]["path"]), Path(self.state["feed"]["path"])
        )
        self.command(
            "fetch-release",
            ["git", "fetch", "origin", f"refs/tags/v{self.version}:refs/tags/v{self.version}"],
        )
        if git("rev-parse", f"v{self.version}^{{tree}}") != self.state["source_tree"]:
            raise ValueError("Published source tag does not match the accepted candidate tree")
        tag = f"v{self.version}"
        self.phase("publishing verified assets; appcast last")
        for record in files:
            path = Path(record["path"])
            release = json.loads(
                self.command(
                    "release-query",
                    [
                        "gh",
                        "release",
                        "view",
                        tag,
                        "--repo",
                        REPO,
                        "--json",
                        "assets,isDraft,isPrerelease,url",
                    ],
                )
            )
            if release["isDraft"] or release["isPrerelease"]:
                raise ValueError("Source release must already be public and stable")
            if not matching_asset(release["assets"], path):
                self.command(
                    "release-upload", ["gh", "release", "upload", tag, str(path), "--repo", REPO]
                )
            release = json.loads(
                self.command(
                    "release-verify",
                    ["gh", "release", "view", tag, "--repo", REPO, "--json", "assets"],
                )
            )
            if not matching_asset(release["assets"], path):
                raise ValueError("GitHub did not expose the exact uploaded artifact")
        self.state["acceptance"] = fingerprint(acceptance)
        self.state["published_utc"] = now()
        self.phase("published; all remote asset digests verified")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "resume", "status", "publish"])
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--identity", help="Public Developer ID certificate fingerprint")
    parser.add_argument("--notary-profile", help="Existing macOS Keychain profile name")
    parser.add_argument("--python-home", type=Path)
    parser.add_argument("--node", type=Path)
    parser.add_argument("--acceptance", type=Path)
    parser.add_argument("--wait-seconds", type=int, default=0)
    args = parser.parse_args()
    work = args.work_dir.absolute()
    if (
        work.is_symlink()
        or work.resolve().is_relative_to(ROOT)
        or not 0 <= args.wait_seconds <= 3600
    ):
        parser.error("Use a private directory outside Git and a bounded wait of 0–3600 seconds")
    if args.action == "status":
        state = read_json(work / "release-state.json")
        sys.stdout.write(
            json.dumps(
                {key: state.get(key) for key in ("version", "status", "notary", "published_utc")},
                indent=2,
            )
            + "\n"
        )
        return 0
    if sys.platform != "darwin":
        parser.error("Signed desktop releases require the maintainer Mac")
    if args.action == "publish" and not args.acceptance:
        parser.error("Publication requires exact-DMG native acceptance evidence")
    config = None
    if args.action == "prepare":
        if (
            not args.identity
            or not re.fullmatch(r"[A-Fa-f0-9]{40}", args.identity)
            or not all((args.notary_profile, args.python_home, args.node))
        ):
            parser.error("Prepare requires identity, notary-profile, python-home and node")
        config = {
            "identity": args.identity,
            "notary_profile": args.notary_profile,
            "python_home": str(args.python_home.resolve()),
            "node": str(args.node.resolve()),
        }
    work.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (work / "release.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            sys.stdout.write(
                "A release command or its child is still running; existing work is preserved.\n"
            )
            return 2
        release = Release(work, lock, config)
        deadline = time.monotonic() + args.wait_seconds
        try:
            while True:
                try:
                    if args.action == "publish":
                        release.publish(args.acceptance)
                    else:
                        release.prepare()
                    return 0
                except Pending as pending:
                    release.phase(str(pending))
                    if time.monotonic() >= deadline:
                        return 0
                    time.sleep(min(30, max(0, deadline - time.monotonic())))
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            release.state["last_error"] = str(error)
            release.phase("stopped with preserved evidence")
            sys.stderr.write(str(error) + "\n")
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
