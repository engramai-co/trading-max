from __future__ import annotations

import sqlite3
import stat
from pathlib import Path

import trading_max.cli as cli
from trading_max.cli import main
from trading_max.credentials import DEFAULT_CREDENTIAL_SERVICE
from trading_max.onboarding import OnboardingOptions
from trading_max.source_checkout import SourceCheckout


def _clean_source(app_root: Path) -> SourceCheckout:
    return SourceCheckout(
        root=app_root.expanduser().resolve(),
        commit="a" * 40,
        branch="main",
        dirty=False,
        canonical_remote="origin",
    )


def test_setup_creates_external_bootstrap_and_latest_schema(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    state_root = tmp_path / "Trading Max"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    env_path = state_root / "secrets" / "trading_max.env"
    assert env_path.is_file()
    bootstrap = env_path.read_text(encoding="utf-8")
    assert "TRADING_MAX_DEPLOYMENT_MODE=local_workstation" in bootstrap
    assert "TRADING_MAX_SECURITY_PROFILE_REQUEST_BUDGET=48" in bootstrap
    assert f"TRADING_MAX_CREDENTIAL_SERVICE={DEFAULT_CREDENTIAL_SERVICE}." in bootstrap
    assert main(["doctor", "--state-root", str(state_root)]) == 0


def test_doctor_is_read_only_when_schema_is_stale(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    state_root = tmp_path / "Trading Max"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    database_path = state_root / "trading_max.db"
    with sqlite3.connect(database_path) as connection:
        latest = connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
        ).fetchone()[0]
        connection.execute("DELETE FROM schema_migrations WHERE version = ?", (latest,))

    assert main(["doctor", "--state-root", str(state_root)]) == 1

    with sqlite3.connect(database_path) as connection:
        restored = connection.execute(
            "SELECT 1 FROM schema_migrations WHERE version = ?", (latest,)
        ).fetchone()
    assert restored is None


def test_doctor_update_check_reports_stale_canonical_main(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    monkeypatch.setattr(cli, "canonical_main_sha", lambda _source: "b" * 40)
    state_root = tmp_path / "Trading Max"
    assert main(["setup", "--state-root", str(state_root)]) == 0

    assert main(["doctor", "--state-root", str(state_root), "--check-updates"]) == 1
    output = capsys.readouterr().out
    assert "source update available" in output
    assert "engramai-co/trading-max@aaaaaaaaaaaa" in output


def test_setup_is_idempotent_and_preserves_existing_configuration(
    tmp_path: Path,
) -> None:
    state_root = tmp_path / "Trading Max"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    env_path = state_root / "secrets" / "trading_max.env"
    initial = env_path.read_text(encoding="utf-8")
    customized = initial.replace(
        "TRADING_MAX_NIGHTLY_ENABLED=false",
        "TRADING_MAX_NIGHTLY_ENABLED=true",
    ).replace(
        "TRADING_MAX_LLM_PROVIDER=fake",
        "TRADING_MAX_LLM_PROVIDER=deepseek",
    )
    env_path.write_text(customized, encoding="utf-8")

    assert main(["setup", "--state-root", str(state_root)]) == 0

    assert env_path.read_text(encoding="utf-8") == customized
    assert stat.S_IMODE(env_path.stat().st_mode) == 0o600


def test_custom_state_roots_receive_distinct_credential_namespaces(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"

    assert main(["setup", "--state-root", str(first)]) == 0
    assert main(["setup", "--state-root", str(second)]) == 0

    first_values = cli._read_env(first / "secrets" / "trading_max.env")
    second_values = cli._read_env(second / "secrets" / "trading_max.env")
    first_service = first_values["TRADING_MAX_CREDENTIAL_SERVICE"]
    second_service = second_values["TRADING_MAX_CREDENTIAL_SERVICE"]
    assert first_service.startswith(f"{DEFAULT_CREDENTIAL_SERVICE}.")
    assert second_service.startswith(f"{DEFAULT_CREDENTIAL_SERVICE}.")
    assert first_service != second_service


def test_state_root_environment_variable_is_respected(
    tmp_path: Path,
    monkeypatch,
) -> None:
    state_root = tmp_path / "configured-state"
    monkeypatch.setenv("TRADING_MAX_STATE_ROOT", str(state_root))

    assert main(["setup"]) == 0
    assert (state_root / "trading_max.db").is_file()


def test_onboard_non_interactive_never_prompts_for_secrets(
    tmp_path: Path,
    monkeypatch,
) -> None:
    captured: list[OnboardingOptions] = []

    def fake_onboard(
        options: OnboardingOptions,
        *,
        initialize,
    ) -> int:
        del initialize
        captured.append(options)
        return 0

    monkeypatch.setattr(cli, "onboard", fake_onboard)
    state_root = tmp_path / "state"
    app_root = tmp_path / "checkout"

    assert (
        main(
            [
                "onboard",
                "--state-root",
                str(state_root),
                "--app-root",
                str(app_root),
                "--non-interactive",
                "--skip-build",
                "--install-service",
                "--no-browser",
            ]
        )
        == 0
    )

    assert captured == [
        OnboardingOptions(
            app_root=app_root,
            state_root=state_root,
            interactive=False,
            build_web=False,
            service_action="install",
            open_browser=False,
        )
    ]


def test_init_alias_uses_safe_noninteractive_service_default(
    tmp_path: Path,
    monkeypatch,
) -> None:
    captured: list[OnboardingOptions] = []

    def fake_onboard(
        options: OnboardingOptions,
        *,
        initialize,
    ) -> int:
        del initialize
        captured.append(options)
        return 0

    monkeypatch.setattr(cli, "onboard", fake_onboard)
    assert (
        main(
            [
                "init",
                "--state-root",
                str(tmp_path / "state"),
                "--non-interactive",
                "--skip-build",
            ]
        )
        == 0
    )
    assert captured[0].service_action == "skip"
