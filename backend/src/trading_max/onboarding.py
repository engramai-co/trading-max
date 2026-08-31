"""First-run onboarding orchestration for a local Trading Max workstation."""

from __future__ import annotations

import getpass
import os
import shutil
import subprocess
import sys
import time
import webbrowser
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from .source_checkout import (
    CANONICAL_REPOSITORY,
    SourceCheckoutError,
    inspect_source_checkout,
)

API_URL = "http://127.0.0.1:8421"
WEB_URL = "http://127.0.0.1:3413"
SUPPORTED_NODE_MAJOR = 20


class OnboardingError(RuntimeError):
    """A safe, operator-facing onboarding failure."""


@dataclass(frozen=True, slots=True)
class OnboardingOptions:
    app_root: Path
    state_root: Path
    interactive: bool
    build_web: bool
    service_action: str
    open_browser: bool


def repository_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _run(
    arguments: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> None:
    rendered = " ".join(arguments)
    print(f"  → {rendered}")
    try:
        subprocess.run(  # noqa: S603 - argv is fixed or operator-selected path
            arguments,
            cwd=cwd,
            env=env,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise OnboardingError(f"command failed: {rendered}") from exc


def _tool_version(command: str, *arguments: str) -> str:
    executable = shutil.which(command)
    if executable is None:
        raise OnboardingError(f"required tool is missing: {command}")
    try:
        result = subprocess.run(  # noqa: S603 - resolved executable, fixed argv
            [executable, *arguments],
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise OnboardingError(f"could not run {command}") from exc
    return (result.stdout or result.stderr).strip().splitlines()[0]


def preflight(app_root: Path) -> None:
    if not (app_root / "pyproject.toml").is_file():
        raise OnboardingError(f"not a Trading Max source checkout: {app_root}")
    print("\n[1/6] Checking the local toolchain")
    versions = {
        "Git": _tool_version("git", "--version"),
        "uv": _tool_version("uv", "--version"),
        "Node": _tool_version("node", "--version"),
        "npm": _tool_version("npm", "--version"),
    }
    try:
        node_major = int(versions["Node"].lstrip("v").split(".", maxsplit=1)[0])
    except ValueError as exc:
        raise OnboardingError(f"could not parse Node version: {versions['Node']}") from exc
    if node_major < SUPPORTED_NODE_MAJOR:
        raise OnboardingError("Node.js 20.19 or newer is required; Node 22 LTS is recommended")
    for label, value in versions.items():
        print(f"  ✓ {label}: {value}")
    try:
        source = inspect_source_checkout(app_root)
    except SourceCheckoutError as exc:
        raise OnboardingError(str(exc)) from exc
    if source.canonical_remote is None:
        raise OnboardingError(
            f"no remote points to the canonical {CANONICAL_REPOSITORY} repository"
        )
    if source.dirty:
        raise OnboardingError("the source checkout has uncommitted changes")
    print(f"  ✓ Source: {CANONICAL_REPOSITORY}@{source.commit[:12]} ({source.branch})")


def build_web(app_root: Path) -> None:
    print("\n[3/6] Installing locked web dependencies and building")
    _run(["uv", "sync", "--all-packages", "--frozen"], cwd=app_root)
    _run(
        ["npm", "--prefix", "apps/web", "ci", "--no-audit", "--no-fund"],
        cwd=app_root,
    )
    _run(["npm", "--prefix", "apps/web", "run", "build"], cwd=app_root)


def _load_bootstrap(path: Path) -> dict[str, str]:
    from .cli import _read_env

    return _read_env(path)


def _api_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    detail = payload.get("detail") if isinstance(payload, dict) else None
    if isinstance(detail, dict) and isinstance(detail.get("message"), str):
        return detail["message"]
    if isinstance(detail, str):
        return detail
    return f"HTTP {response.status_code}"


def _request(
    client: httpx.Client,
    method: str,
    path: str,
    *,
    token: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    response = client.request(
        method,
        path,
        headers=_api_headers(token),
        json=payload,
    )
    if response.is_error:
        raise OnboardingError(_error_message(response))
    if response.status_code == 204:
        return {}
    result = response.json()
    if not isinstance(result, dict):
        raise OnboardingError("local API returned an unexpected response")
    return result


def _wait_for_api(client: httpx.Client, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise OnboardingError("the temporary local API exited during startup")
        try:
            response = client.get("/health")
            if response.status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.25)
    raise OnboardingError("the temporary local API did not become healthy within 30 seconds")


@contextmanager
def temporary_api(
    *,
    app_root: Path,
    state_root: Path,
    bootstrap: dict[str, str],
) -> Iterator[httpx.Client]:
    with httpx.Client(base_url=API_URL, timeout=2) as existing:
        try:
            response = existing.get(
                "/v1/settings/integrations",
                headers=_api_headers(bootstrap["TRADING_MAX_API_TOKEN"]),
            )
        except httpx.HTTPError:
            response = None
        if response is not None and response.status_code == 200:
            print("  ✓ reusing the authenticated local API already running")
            yield existing
            return
        if response is not None:
            raise OnboardingError(
                "ports 8421/3413 belong to another local installation; "
                "stop it or onboard the matching state root"
            )
    log_root = state_root / "logs"
    log_root.mkdir(parents=True, exist_ok=True)
    environment = {
        **os.environ,
        **bootstrap,
        "TRADING_MAX_STATE_ROOT": str(state_root),
    }
    log_path = log_root / "onboarding-api.log"
    with log_path.open("ab") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "services.api.trading_max_api"],
            cwd=app_root,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            with httpx.Client(base_url=API_URL, timeout=25) as client:
                _wait_for_api(client, process)
                yield client
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def _confirm(prompt: str, *, default: bool = False) -> bool:
    suffix = " [Y/n] " if default else " [y/N] "
    while True:
        answer = input(prompt + suffix).strip().lower()
        if not answer:
            return default
        if answer in {"y", "yes"}:
            return True
        if answer in {"n", "no"}:
            return False
        print("Please answer y or n.")


def _choose(prompt: str, choices: list[str], *, default: int = 0) -> int:
    print(prompt)
    for index, choice in enumerate(choices, start=1):
        marker = " (default)" if index - 1 == default else ""
        print(f"  {index}. {choice}{marker}")
    while True:
        answer = input("> ").strip()
        if not answer:
            return default
        if answer.isdigit() and 1 <= int(answer) <= len(choices):
            return int(answer) - 1
        print(f"Choose a number from 1 to {len(choices)}.")


def _configure_trading212_profile(
    client: httpx.Client,
    *,
    token: str,
    profile: str,
    secret_reader: Callable[[str], str] = getpass.getpass,
) -> bool:
    label = "Invest" if profile == "invest" else "Stocks ISA"
    if not _confirm(f"Connect Trading 212 {label}?"):
        return False
    key_id = secret_reader(f"{label} API key ID (hidden): ").strip()
    secret = secret_reader(f"{label} secret key (hidden): ").strip()
    if not key_id or not secret:
        print("  – skipped: both values are required")
        return False
    candidate = {
        "apiKeyId": key_id,
        "secretKey": secret,
        "environment": "live",
    }
    print("  → testing read-only broker access")
    tested = _request(
        client,
        "POST",
        f"/v1/settings/integrations/trading212/{profile}/test",
        token=token,
        payload=candidate,
    )
    validation_token = tested.get("validationToken")
    if not isinstance(validation_token, str):
        raise OnboardingError("broker validation did not return a save receipt")
    _request(
        client,
        "PUT",
        f"/v1/settings/integrations/trading212/{profile}",
        token=token,
        payload={
            **candidate,
            "validationToken": validation_token,
            "enabled": True,
        },
    )
    print(f"  ✓ {label} tested and saved to the operating-system credential store")
    return True


def _configure_llm(
    client: httpx.Client,
    *,
    token: str,
    secret_reader: Callable[[str], str] = getpass.getpass,
) -> bool:
    selection = _choose(
        "\nChoose an analysis provider:",
        ["Keep deterministic fake provider", "OpenCode Go", "DeepSeek"],
    )
    if selection == 0:
        print("  ✓ fake provider kept; no portfolio data will leave this computer")
        return False
    provider = "opencode" if selection == 1 else "deepseek"
    providers = _request(
        client,
        "GET",
        "/v1/settings/llm/providers",
        token=token,
    )
    descriptors = providers.get("providers")
    if not isinstance(descriptors, list):
        raise OnboardingError("local API did not return the provider registry")
    descriptor = next(
        (
            item
            for item in descriptors
            if isinstance(item, dict) and item.get("provider") == provider
        ),
        None,
    )
    if not isinstance(descriptor, dict):
        raise OnboardingError(f"provider is unavailable: {provider}")
    models = descriptor.get("models")
    default_model = descriptor.get("defaultModel")
    if not isinstance(models, list) or not all(isinstance(item, str) for item in models):
        raise OnboardingError(f"provider model registry is invalid: {provider}")
    default_index = models.index(default_model) if default_model in models else 0
    model = models[_choose("Choose a model:", models, default=default_index)]
    api_key = secret_reader(f"{descriptor.get('label', provider)} API key (hidden): ").strip()
    if not api_key:
        print("  – skipped: an API key is required")
        return False
    candidate = {"apiKey": api_key, "model": model}
    print("  → testing model connectivity")
    tested = _request(
        client,
        "POST",
        f"/v1/settings/llm/providers/{provider}/test",
        token=token,
        payload=candidate,
    )
    validation_token = tested.get("validationToken")
    if not isinstance(validation_token, str):
        raise OnboardingError("provider validation did not return a save receipt")
    _request(
        client,
        "PUT",
        f"/v1/settings/llm/providers/{provider}",
        token=token,
        payload={
            **candidate,
            "validationToken": validation_token,
            "enabled": True,
        },
    )
    policy = providers.get("routePolicy")
    if not isinstance(policy, dict) or not isinstance(policy.get("revision"), int):
        raise OnboardingError("local API did not return the route policy revision")
    _request(
        client,
        "PUT",
        "/v1/settings/llm/route-policy",
        token=token,
        payload={
            "defaultRoute": f"{provider}/{model}",
            "overrides": policy.get("overrides") or {},
            "expectedRevision": policy["revision"],
        },
    )
    print(f"  ✓ {provider}/{model} tested, saved, and selected")
    return True


def configure_integrations(
    client: httpx.Client,
    *,
    token: str,
    interactive: bool,
) -> bool:
    print("\n[4/6] Configuring optional data providers")
    if not interactive:
        print("  – skipped in non-interactive mode; no secrets are accepted as CLI flags")
        return False
    broker_configured = False
    try:
        for profile in ("invest", "isa"):
            broker_configured |= _configure_trading212_profile(
                client,
                token=token,
                profile=profile,
            )
        _configure_llm(client, token=token)
    except (EOFError, KeyboardInterrupt) as exc:
        raise OnboardingError("interactive credential setup was cancelled") from exc
    return broker_configured


def install_macos_service(options: OnboardingOptions) -> bool:
    if sys.platform != "darwin":
        if options.service_action == "install":
            raise OnboardingError("the packaged long-running service currently supports macOS only")
        return False
    should_install = options.service_action == "install"
    if options.service_action == "ask":
        should_install = _confirm(
            "\nInstall per-user macOS services so Trading Max starts after login?",
            default=True,
        )
    if not should_install:
        return False
    print("\n[5/6] Installing the local macOS service")
    _run(
        [
            sys.executable,
            "deploy/local/install-macos-service.py",
            "install",
            "--app-root",
            str(options.app_root),
            "--state-root",
            str(options.state_root),
        ],
        cwd=options.app_root,
    )
    return True


def _wait_for_service() -> None:
    deadline = time.monotonic() + 30
    with httpx.Client(timeout=2) as client:
        while time.monotonic() < deadline:
            try:
                if client.get(f"{API_URL}/health").status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.5)
    raise OnboardingError("installed local service did not become healthy within 30 seconds")


def onboard(options: OnboardingOptions, *, initialize: Callable[[Path], int]) -> int:
    app_root = options.app_root.expanduser().resolve()
    state_root = options.state_root.expanduser().resolve()
    preflight(app_root)
    print("\n[2/6] Initializing external state")
    if initialize(state_root) != 0:
        raise OnboardingError("state initialization failed")
    if options.build_web:
        build_web(app_root)
    else:
        print("\n[3/6] Web build skipped by request")
        if not (app_root / "apps" / "web" / ".next" / "BUILD_ID").is_file():
            raise OnboardingError("web build is missing; rerun without --skip-build")
    bootstrap = _load_bootstrap(state_root / "secrets" / "trading_max.env")
    token = bootstrap.get("TRADING_MAX_API_TOKEN")
    if not token:
        raise OnboardingError("bootstrap is missing the internal API token")
    with temporary_api(
        app_root=app_root,
        state_root=state_root,
        bootstrap=bootstrap,
    ) as client:
        broker_configured = configure_integrations(
            client,
            token=token,
            interactive=options.interactive,
        )
    service_installed = install_macos_service(options)
    print("\n[6/6] Verifying the installation")
    if service_installed:
        _wait_for_service()
        print(f"  ✓ API healthy at {API_URL}")
        print(f"  ✓ Trading Max available at {WEB_URL}")
        if broker_configured:
            with httpx.Client(base_url=API_URL, timeout=10) as client:
                _request(
                    client,
                    "POST",
                    "/v1/jobs/refresh",
                    token=token,
                    payload={"scope": "all"},
                )
            print("  ✓ first portfolio refresh queued; follow progress from Health")
        if options.open_browser:
            webbrowser.open(WEB_URL)
    else:
        print("  ✓ configuration verified")
        print("  → start Trading Max with: deploy/local/start.sh")
        print(f"  → then open: {WEB_URL}")
        print(f"  → configure your own API credentials at: {WEB_URL}/settings")
    print("\nOnboarding complete. Secrets were not written to the checkout or bootstrap file.")
    return 0


__all__ = [
    "OnboardingError",
    "OnboardingOptions",
    "configure_integrations",
    "onboard",
    "preflight",
    "repository_root",
]
