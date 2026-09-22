"""Exercise the actual bundled processes with synthetic, disposable state."""
# This executable test harness launches its own payload and probes its loopback URLs.
# ruff: noqa: S101, S603, S310

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path


def wait_for(predicate, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    raise TimeoutError("Condition did not become true")


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def fingerprint(root: Path):
    """Include additions, removals and content changes in the install tree."""
    result = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            result[str(path.relative_to(root))] = ("link", str(path.readlink()))
        elif path.is_file():
            with path.open("rb") as stream:
                result[str(path.relative_to(root))] = hashlib.file_digest(
                    stream, "sha256"
                ).hexdigest()
    return result


def main(payload: Path, output: Path):
    results = {"runtime": str(payload), "checks": [], "launches": []}
    before = fingerprint(payload)
    with tempfile.TemporaryDirectory(prefix="Trading Max runtime checks ") as temporary:
        root = Path(temporary) / "State with spaces"
        env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(Path(temporary) / "home"),
            "LANG": "en_US.UTF-8",
        }
        Path(env["HOME"]).mkdir()

        def read():
            path = root / "runtime-status.json"
            return json.loads(path.read_text()) if path.exists() else {}

        def start(*flags):
            command = [
                str(payload / "python/bin/python3.12"),
                "-I",
                "-B",
                "-u",
                str(payload / "supervisor.py"),
                "supervise",
                "--state-root",
                str(root),
                "--parent-pid",
                str(os.getpid()),
                *flags,
            ]
            return subprocess.Popen(
                command, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )

        def ready(process):
            def check():
                value = read()
                if process.poll() is not None or (
                    value.get("supervisor_pid") == process.pid and value.get("stage") == "error"
                ):
                    logs = {p.name: p.read_text()[-3000:] for p in (root / "logs").glob("*.log")}
                    raise RuntimeError(json.dumps({"status": value, "logs": logs}))
                return (
                    value
                    if value.get("supervisor_pid") == process.pid and value.get("stage") == "ready"
                    else None
                )

            value = wait_for(check)
            results["launches"].append({"ready_ms": value["ready_ms"]})
            return value

        def stopped(value):
            wait_for(lambda: not any(alive(value[key]) for key in ("api_pid", "web_pid")), 10)

        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen()
            port = busy.getsockname()[1]
            process = start("--api-port", str(port), "--web-port", str(port))
            try:
                value = ready(process)
                assert port not in (value["api_port"], value["web_port"])
                results["checks"].extend(
                    ["bundled runtimes only", "state path with spaces", "busy ports preserved"]
                )
                pages = []
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{value['api_port']}/ready", timeout=5
                ) as response:
                    run_id = json.load(response)["latestRunId"]
                for path in (
                    "",
                    "analytics?range=6M",
                    "holdings",
                    "research?ticker=BE",
                    "settings",
                    "health",
                    "api/backend/dashboard/lens/overview",
                    "api/backend/research/BE/prices?interval=1d",
                    "api/company-logo/BE",
                    f"api/backend/dashboard/history?range=6M&scope=total&runId={run_id}",
                ):
                    started = time.monotonic()
                    with urllib.request.urlopen(value["web_url"] + path, timeout=20) as response:
                        body = response.read()
                        if "/history?" in path and not json.loads(body)["history"]["points"]:
                            raise AssertionError("Rendered history would be empty")
                        if "/lens/overview" in path and json.loads(body)["totalValueGbp"] != 2000:
                            raise AssertionError("Synthetic balance contract changed")
                        if "/prices?" in path and len(json.loads(body)["points"]) < 100:
                            raise AssertionError("Research price chart would be empty")
                        pages.append(
                            {
                                "path": path or "/",
                                "status": response.status,
                                "bytes": len(body),
                                "ms": round((time.monotonic() - started) * 1000, 1),
                            }
                        )
                results["http_pages"] = pages
                duplicate = start()
                assert duplicate.wait(timeout=10) == 73
                assert read()["supervisor_pid"] == process.pid
                results["checks"].append("duplicate runtime cannot replace active owner")
                request = urllib.request.Request(
                    f"http://127.0.0.1:{value['api_port']}/v1/watchlist",
                    data=b"{}",
                    headers={"Content-Type": "application/json"},
                )
                try:
                    urllib.request.urlopen(request, timeout=5)
                    raise AssertionError("Mutation unexpectedly accepted")
                except urllib.error.HTTPError as error:
                    assert error.code == 403
                results["checks"].append("demo mutations rejected")
            finally:
                process.terminate()
                process.wait(timeout=10)
            stopped(value)
            results["checks"].append("normal exit stops both services")

        for failure in ("api_pid", "web_pid", "supervisor"):
            process = start()
            try:
                value = ready(process)
                os.kill(process.pid if failure == "supervisor" else value[failure], signal.SIGKILL)
                process.wait(timeout=10)
                stopped(value)
                if failure != "supervisor":
                    assert read()["stage"] == "error"
                results["checks"].append(f"{failure} abrupt exit leaves no owned children")
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
        results["checks"].append("restart preserves seeded state")
        # A live PID is insufficient: a suspended service must expose recovery.
        # Signals are sent only to the child IDs of this disposable harness.
        for target in ("api_pid", "web_pid"):
            process = start()
            stalled_pid = None
            try:
                value = ready(process)
                stalled_pid = value[target]
                os.kill(stalled_pid, signal.SIGSTOP)
                assert process.wait(timeout=95) != 0
                stopped(value)
                assert read()["stage"] == "error"
                assert "持续无响应" in read()["detail"]
                results["checks"].append(
                    f"{target} persistent stall exposes recovery and cleans owned children"
                )
            finally:
                if stalled_pid and alive(stalled_pid):
                    os.kill(stalled_pid, signal.SIGCONT)
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
        # A real workspace starts empty and can reach Settings without a snapshot.
        create = subprocess.run(
            [
                str(payload / "python/bin/python3.12"),
                "-I",
                "-B",
                str(payload / "supervisor.py"),
                "workspace-create",
                "--state-root",
                temporary,
                "--name",
                "Local empty workspace",
            ],
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        workspace = json.loads(create.stdout)
        root = Path(workspace["path"])
        manifest_before = (root / "trading-max-workspace.json").read_bytes()
        for _repeat in range(2):
            process = start("--workspace-id", workspace["id"])
            try:
                value = ready(process)
                base = f"http://127.0.0.1:{value['web_port']}"
                with urllib.request.urlopen(value["web_url"], timeout=15) as response:
                    assert response.status == 200
                    assert "onboarding=1" in value["web_url"]
                with urllib.request.urlopen(
                    base + "/api/backend/local-workspace", timeout=5
                ) as response:
                    state = json.load(response)
                    assert (
                        not state["connectedAccounts"]
                        and not state["canConfirm"]
                        and not state["confirmed"]
                    )
                    assert state["readiness"]["status"] == "not_ready"
                with urllib.request.urlopen(
                    base + "/api/backend/settings/integrations", timeout=5
                ) as response:
                    integrations = json.load(response)["integrations"]
                    assert all(not item["configured"] for item in integrations)
                for path, body in [("refresh", {}), ("confirm", {"runId": "imaginary"})]:
                    request = urllib.request.Request(
                        base + "/api/backend/local-workspace/" + path,
                        data=json.dumps(body).encode(),
                        headers={"Content-Type": "application/json", "Origin": base},
                    )
                    try:
                        urllib.request.urlopen(request, timeout=5)
                        raise AssertionError("Incomplete enrollment accepted")
                    except urllib.error.HTTPError as error:
                        assert error.code == 409, error.code
                duplicate = start("--workspace-id", workspace["id"])
                assert duplicate.wait(timeout=10) == 73
                assert read()["supervisor_pid"] == process.pid
                assert not (root / ".seeded-v1").exists() and not (root / "latest.json").exists()
            finally:
                process.terminate()
                process.wait(timeout=10)
            stopped(value)
        assert (root / "trading-max-workspace.json").read_bytes() == manifest_before
        results["checks"].extend(
            [
                "empty real workspace reaches Settings without fake balances",
                "real workspace does not inherit configured integrations",
                "refresh and confirmation require a connected account",
                "real workspace duplicate owner rejected and restart preserves identity",
            ]
        )
    after = fingerprint(payload)
    changed = sorted(
        key for key in before.keys() | after.keys() if before.get(key) != after.get(key)
    )
    if changed:
        raise AssertionError(f"Installed runtime was modified: {changed[:20]}")
    results["checks"].append("installed runtime remains byte-for-byte unchanged")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    main(args.payload.resolve(), args.output.resolve())
