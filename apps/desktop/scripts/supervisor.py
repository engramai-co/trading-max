"""Own bundled local processes; keep demo and real workspaces explicitly separate."""
# Executable paths come only from this signed bundle. Health URLs are our loopback listeners.
# ruff: noqa: S603, S310

from __future__ import annotations

import argparse
import fcntl
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

RUNTIME = Path(__file__).resolve().parent
MARKER = "trading-max-desktop-preview-v1\n"
STOP = threading.Event()


def status(root: Path, stage: str, message: str, **details: object) -> None:
    value = {"stage": stage, "message": message, "supervisor_pid": os.getpid(), **details}
    path = root / "runtime-status.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def reserve_port(preferred: int = 0) -> int:
    with socket.socket() as listener:
        try:
            listener.bind(("127.0.0.1", preferred))
        except OSError:
            if not preferred:
                raise
            listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def prepare_identity(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    marker = root / "DESKTOP_PREVIEW_ONLY"
    if not marker.exists():
        if any(root.iterdir()):
            raise RuntimeError("Unmarked state directory: existing files were not changed")
        marker.write_text(MARKER, encoding="utf-8")
    if marker.read_text(encoding="utf-8") != MARKER:
        raise RuntimeError("Preview data identity does not match")


def prepare_state(root: Path) -> None:
    prepare_identity(root)
    if not (root / ".seeded-v1").exists():
        if (root / "latest.json").exists():
            raise RuntimeError("Existing unrecognized snapshot was not overwritten")
        shutil.copytree(RUNTIME / "seed", root, dirs_exist_ok=True)
        (root / ".seeded-v1").write_text(
            "synthetic contract fixture; not broker data\n", encoding="utf-8"
        )
    (root / "logs").mkdir(exist_ok=True)


def clean_environment(
    root: Path, api_port: int, web_port: int, token: str, workspace_id: str | None = None
) -> dict[str, str]:
    env = {key: os.environ[key] for key in ("HOME", "TMPDIR", "USER") if key in os.environ}
    env.update(
        {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": "en_US.UTF-8",
            "PYTHONDONTWRITEBYTECODE": "1",
            "TRADING_MAX_DATA_ROOT": str(root),
            "TRADING_MAX_STATE_ROOT": str(root),
            "TRADING_MAX_LOG_DIR": str(root / "logs"),
            "TRADING_MAX_ENV": "desktop-preview",
            "TRADING_MAX_DEPLOYMENT_MODE": "local_workstation",
            "TRADING_MAX_API_HOST": "127.0.0.1",
            "TRADING_MAX_API_PORT": str(api_port),
            "TRADING_MAX_API_TOKEN": token,
            "TRADING_MAX_ALLOWED_ORIGINS": f"http://127.0.0.1:{web_port}",
            "TRADING_MAX_CREDENTIAL_SERVICE": "com.engram.trading-max.desktop-preview.credentials",
            "TRADING_MAX_ENABLE_LEGACY_CREDENTIAL_LOOKUP": "false",
            "TRADING_MAX_EMBEDDED_WORKER": "true",
            "TRADING_MAX_LLM_PROVIDER": "fake",
            "TRADING_MAX_NIGHTLY_ENABLED": "false",
            "TRADING_MAX_INTRADAY_ENABLED": "false",
            "TRADING_MAX_PERFORMANCE_ENABLED": "false",
            "TRADING_MAX_RESEARCH_ENABLED": "false",
            "TRADING_MAX_ALERT_MONITOR_ENABLED": "false",
            "NEXT_TELEMETRY_DISABLED": "1",
            "NODE_ENV": "production",
            "HOSTNAME": "127.0.0.1",
            "PORT": str(web_port),
            "TRADING_MAX_DESKTOP_SUPERVISOR_PID": str(os.getpid()),
            "PORTFOLIO_BACKEND_URL": f"http://127.0.0.1:{api_port}",
            "PORTFOLIO_BACKEND_TOKEN": token,
        }
    )
    if workspace_id:
        env.update(
            {
                "TRADING_MAX_ENV": "desktop-local",
                "TRADING_MAX_DESKTOP_WORKSPACE_ID": workspace_id,
                "TRADING_MAX_CREDENTIAL_SERVICE": f"com.engram.trading-max.workspace.{workspace_id}",
                "TRADING_MAX_LLM_PROVIDER": "openai",
                "TRADING_MAX_LLM_ANALYSIS_ENABLED": "false",
                # Foreground scheduling can be enabled explicitly in Settings.
                "PATH": f"{RUNTIME}:/usr/bin:/bin:/usr/sbin:/sbin",
            }
        )
    return env


def terminate_owned(children: list[subprocess.Popen]) -> None:
    for child in children:
        if child.poll() is None:
            child.terminate()
    deadline = time.monotonic() + 3
    for child in children:
        try:
            child.wait(timeout=max(0.05, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)


def await_url(url: str, children: list[subprocess.Popen], *, readiness: bool = False) -> None:
    deadline = time.monotonic() + 70
    while not STOP.is_set() and time.monotonic() < deadline:
        if any(child.poll() is not None for child in children):
            raise RuntimeError("A bundled service exited before becoming ready; see logs")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if readiness:
                    result = json.load(response)
                    if result.get("status") == "ready" and result.get("latestRunId"):
                        return
                elif response.status == 200:
                    return
        except (OSError, ValueError, urllib.error.URLError):
            pass
        STOP.wait(0.15)
    if STOP.is_set():
        raise InterruptedError("Preview was closed")
    raise TimeoutError("Service readiness timed out; see logs")


def watch_parent(parent_pid: int, stop_action) -> None:
    while not STOP.wait(0.3):
        if os.getppid() != parent_pid:
            STOP.set()
            stop_action()
            return


def supervise(args) -> int:
    root = args.state_root.resolve()
    if args.workspace_id:
        from trading_max.desktop_workspace import inspect_workspace

        if inspect_workspace(root)["id"] != args.workspace_id:
            raise RuntimeError("工作区标识已变化；未启动服务。")
    else:
        prepare_identity(root)
    lock = (root / "runtime.lock").open("a")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        # The active owner retains its status file and its processes.
        return 73
    children: list[subprocess.Popen] = []
    started = time.monotonic()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: STOP.set())
    threading.Thread(target=watch_parent, args=(args.parent_pid, lambda: None), daemon=True).start()
    try:
        if args.workspace_id:
            (root / "logs").mkdir(exist_ok=True, mode=0o700)
        else:
            prepare_state(root)
        status(
            root,
            "starting",
            "正在准备本机工作区…" if args.workspace_id else "正在准备本机演示资料…",
        )
        api_port = reserve_port(args.api_port)
        web_port = reserve_port(args.web_port)
        while web_port == api_port:
            web_port = reserve_port()
        env = clean_environment(
            root, api_port, web_port, secrets.token_urlsafe(32), args.workspace_id
        )
        with (root / "logs/api-process.log").open("w") as api_log:
            api = subprocess.Popen(
                [
                    sys.executable,
                    "-I",
                    "-B",
                    "-u",
                    str(RUNTIME / "supervisor.py"),
                    "api",
                    "--parent-pid",
                    str(os.getpid()),
                ],
                cwd=root,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=api_log,
                stderr=subprocess.STDOUT,
            )
        children.append(api)
        status(root, "api_starting", "正在启动资料与计算服务…", api_port=api_port, api_pid=api.pid)
        # Empty real workspaces must reach Settings before they can become ready.
        await_url(
            f"http://127.0.0.1:{api_port}/health"
            if args.workspace_id
            else f"http://127.0.0.1:{api_port}/ready",
            children,
            readiness=not args.workspace_id,
        )
        status(
            root,
            "web_starting",
            "资料已就绪，正在打开投资工作台…",
            api_port=api_port,
            api_pid=api.pid,
        )
        with (root / "logs/web-process.log").open("w") as web_log:
            web = subprocess.Popen(
                [str(RUNTIME / "node"), str(RUNTIME / "node-launcher.cjs")],
                cwd=RUNTIME / "web",
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=web_log,
                stderr=subprocess.STDOUT,
            )
        children.append(web)
        web_url = f"http://127.0.0.1:{web_port}/"
        await_url(web_url, children)
        entry_url = web_url
        if args.workspace_id:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{api_port}/v1/local-workspace", timeout=5
            ) as response:
                onboarding = json.load(response)
            if (
                not onboarding.get("confirmed")
                or onboarding.get("readiness", {}).get("status") != "ready"
            ):
                entry_url += "settings?tab=accounts&onboarding=1"
        ready = {
            "web_url": entry_url,
            "api_port": api_port,
            "web_port": web_port,
            "api_pid": api.pid,
            "web_pid": web.pid,
            "ready_ms": round((time.monotonic() - started) * 1000, 1),
        }
        status(
            root,
            "ready",
            "本机服务已启动，请完成账户设置。" if args.workspace_id else "本机演示资料已就绪。",
            **ready,
        )
        while not STOP.wait(0.3):
            if any(child.poll() is not None for child in children):
                raise RuntimeError(
                    "A bundled service stopped; the other owned services were stopped as well"
                )
        terminate_owned(children)
        status(root, "stopped", "预览已关闭。")
        return 0
    except InterruptedError:
        terminate_owned(children)
        status(root, "stopped", "预览已关闭。")
        return 0
    except Exception as error:
        terminate_owned(children)
        status(
            root,
            "error",
            "本机服务暂时无法启动，可以重新尝试。",
            detail=f"{type(error).__name__}: {error}",
        )
        return 1
    finally:
        terminate_owned(children)
        lock.close()


def api(args) -> int:
    sys.path[:0] = [str(RUNTIME), str(RUNTIME / "code"), str(RUNTIME / "code/backend/src")]

    # Demonstration data must not silently mix with downloaded market/provider data.
    def offline_only(event, values):
        if event == "socket.connect":
            address = values[1]
            if isinstance(address, tuple) and address[0] not in {"127.0.0.1", "::1", "localhost"}:
                raise OSError("External data connections are disabled in desktop preview")

    is_demo = not os.environ.get("TRADING_MAX_DESKTOP_WORKSPACE_ID")
    if is_demo:
        sys.addaudithook(offline_only)
    import uvicorn
    from fastapi.responses import JSONResponse
    from preview_data import PreviewPrices, PreviewSearch

    from services.api.trading_max_api.app import create_app
    from services.api.trading_max_api.config import Settings
    from services.api.trading_max_api.credentials import CredentialStoreError

    class PreviewCredentials:
        def get(self, reference):
            return None

        def put(self, reference, secret):
            raise CredentialStoreError("Real connections are disabled in desktop preview")

        def delete(self, reference):
            raise CredentialStoreError("Real connections are disabled in desktop preview")

    app = create_app(
        Settings.from_env(), credential_store=PreviewCredentials() if is_demo else None
    )
    if is_demo:
        app.state.security_prices = PreviewPrices()
        app.state.security_search = PreviewSearch()

    @app.middleware("http")
    async def demo_read_only(request, call_next):
        if is_demo and request.method not in {"GET", "HEAD", "OPTIONS"}:
            return JSONResponse(
                status_code=403,
                content={
                    "detail": "这是独立演示资料，真实账户连接和数据更新将在下一阶段开放。",
                    "code": "desktop_preview_read_only",
                },
            )
        response = await call_next(request)
        if is_demo:
            response.headers["X-Trading-Max-Preview"] = "synthetic-read-only"
        return response

    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=int(os.environ["TRADING_MAX_API_PORT"]),
            timeout_graceful_shutdown=2,
            access_log=False,
        )
    )

    def orphan_exit():
        server.should_exit = True

    threading.Thread(target=watch_parent, args=(args.parent_pid, orphan_exit), daemon=True).start()
    server.run()
    return 0


def main() -> int:
    os.umask(0o077)
    sys.path[:0] = [str(RUNTIME), str(RUNTIME / "code"), str(RUNTIME / "code/backend/src")]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode", choices=("supervise", "api", "workspace-create", "workspace-inspect")
    )
    parser.add_argument("--state-root", type=Path)
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--workspace-id")
    parser.add_argument("--name")
    parser.add_argument("--api-port", type=int, default=0)
    parser.add_argument("--web-port", type=int, default=0)
    args = parser.parse_args()
    if args.mode.startswith("workspace-"):
        from trading_max.desktop_workspace import create_workspace, inspect_workspace

        try:
            result = (
                create_workspace(args.state_root, args.name)
                if args.mode == "workspace-create"
                else inspect_workspace(args.state_root)
            )
            sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
            return 0
        except (ValueError, OSError) as error:
            sys.stdout.write(json.dumps({"error": str(error)}, ensure_ascii=False) + "\n")
            return 1
    if args.parent_pid <= 0:
        parser.error("--parent-pid is required")
    if args.mode == "supervise" and args.state_root is None:
        parser.error("--state-root is required for supervision")
    return supervise(args) if args.mode == "supervise" else api(args)


if __name__ == "__main__":
    raise SystemExit(main())
