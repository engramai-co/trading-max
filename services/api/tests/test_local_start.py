"""Exercise foreground supervision with synthetic processes and external state."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def foreground_host(tmp_path: Path):
    checkout = tmp_path / "checkout with spaces"
    scripts = checkout / "deploy/local"
    scripts.mkdir(parents=True)
    for name in ("start.sh", "run-web.sh"):
        shutil.copy2(ROOT / "deploy/local" / name, scripts / name)
    build = checkout / "apps/web/.next"
    (build / "standalone").mkdir(parents=True)
    (build / "BUILD_ID").write_text("synthetic")
    (build / "standalone/server.js").touch()
    pi_package = (
        checkout / "backend/src/trading_max/synthesis/_pi/node_modules/@earendil-works/pi-ai"
    )
    pi_package.mkdir(parents=True)
    (pi_package / "package.json").write_text('{"version":"synthetic"}')
    state = tmp_path / "state with spaces"
    (state / "secrets").mkdir(parents=True)
    (state / "secrets/trading_max.env").write_text(
        "TRADING_MAX_DEPLOYMENT_MODE=local_workstation\n"
    )
    binaries = tmp_path / "bin"
    binaries.mkdir()
    executable = binaries / "uv"
    executable.write_text(
        f"#!{sys.executable}\n"
        "import os, signal, subprocess, sys, time\n"
        "from pathlib import Path\n"
        "name = ('web' if Path(sys.argv[0]).name == 'node' else\n"
        "        'worker' if sys.argv[-1].endswith('worker_main') else 'api')\n"
        "root = Path(os.environ['TRADING_MAX_STATE_ROOT'])\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "def stop(signum, frame):\n"
        "    child.wait(timeout=5)\n"
        "    raise SystemExit(0)\n"
        "signal.signal(signal.SIGTERM, stop)\n"
        "(root / (name + '.pid')).write_text(str(os.getpid()))\n"
        "(root / (name + '.child')).write_text(str(child.pid))\n"
        "while not all((root / (component + '.pid')).exists()\n"
        "              for component in ('api', 'worker', 'web')):\n"
        "    time.sleep(0.01)\n"
        "if os.environ.get('FAIL_COMPONENT') == name:\n"
        "    child.terminate()\n"
        "    child.wait(timeout=5)\n"
        "    raise SystemExit(int(os.environ.get('FAIL_CODE', '17')))\n"
        "while True: time.sleep(1)\n"
    )
    executable.chmod(0o700)
    shutil.copy2(executable, binaries / "node")
    process = None

    def launch(**overrides: str) -> subprocess.Popen[str]:
        nonlocal process
        environment = {
            **os.environ,
            "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
            "TRADING_MAX_STATE_ROOT": str(state),
            "TRADING_MAX_NODE_BINARY": str(binaries / "node"),
            **overrides,
        }
        process = subprocess.Popen(
            ["/bin/bash", str(scripts / "start.sh")],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        deadline = time.monotonic() + 10
        while not all((state / f"{name}.pid").is_file() for name in ("api", "worker", "web")):
            if process.poll() is not None:
                pytest.fail(str(process.communicate()))
            if time.monotonic() > deadline:
                pytest.fail("synthetic foreground components did not start")
            time.sleep(0.01)
        return process

    yield launch, state
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
    # Only synthetic PID files created by this fixture are touched.
    for path in [*state.glob("*.pid"), *state.glob("*.child")]:
        with suppress(ProcessLookupError):
            os.kill(int(path.read_text()), signal.SIGKILL)


def assert_components_stopped(state: Path) -> None:
    for path in [*state.glob("*.pid"), *state.glob("*.child")]:
        with pytest.raises(ProcessLookupError):
            os.kill(int(path.read_text()), 0)


@pytest.mark.parametrize("component", ["api", "worker", "web"])
@pytest.mark.parametrize("exit_code", [0, 17])
def test_component_exit_stops_the_other_components(foreground_host, component, exit_code):
    launch, state = foreground_host
    process = launch(FAIL_COMPONENT=component, FAIL_CODE=str(exit_code))
    _, stderr = process.communicate(timeout=10)
    assert process.returncode == (exit_code or 1)
    assert f"{component} exited; stopping the other processes" in stderr
    assert_components_stopped(state)


@pytest.mark.parametrize("signum", [signal.SIGINT, signal.SIGTERM])
def test_stop_signal_reaps_components_and_descendants(foreground_host, signum):
    launch, state = foreground_host
    process = launch()
    process.send_signal(signum)
    process.communicate(timeout=10)
    assert process.returncode == 128 + signum
    assert_components_stopped(state)
