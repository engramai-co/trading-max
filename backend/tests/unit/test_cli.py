from __future__ import annotations

import sqlite3
import stat
from pathlib import Path

import pytest
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
    capsys,
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
    capsys.readouterr()

    assert main(["setup", "--state-root", str(state_root)]) == 0

    assert env_path.read_text(encoding="utf-8") == customized
    assert stat.S_IMODE(env_path.stat().st_mode) == 0o600
    output = capsys.readouterr().out
    assert "bootstrap analysis provider: deepseek" in output
    assert "provider: fake" not in output


@pytest.mark.parametrize(
    ("api_token", "proxy_token", "message"),
    [
        (None, "synthetic-token", "internal API token is missing"),
        ("", "synthetic-token", "internal API token is missing"),
        ("   ", "synthetic-token", "internal API token is missing"),
        ("synthetic-token", None, "web proxy token is missing"),
        ("synthetic-token", "", "web proxy token is missing"),
        ("synthetic-token", "   ", "web proxy token is missing"),
        ("synthetic-api-token", "synthetic-proxy-token", "tokens do not match"),
    ],
)
def test_doctor_rejects_broken_internal_auth_without_printing_or_changing_tokens(
    tmp_path: Path,
    monkeypatch,
    capsys,
    api_token: str | None,
    proxy_token: str | None,
    message: str,
) -> None:
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    state_root = tmp_path / "state"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    path = state_root / "secrets" / "trading_max.env"
    values = cli._read_env(path)
    for key, value in {
        "TRADING_MAX_API_TOKEN": api_token,
        "PORTFOLIO_BACKEND_TOKEN": proxy_token,
    }.items():
        if value is None:
            values.pop(key)
        else:
            values[key] = value
    cli._write_env(path, values)
    before = path.read_bytes()
    capsys.readouterr()

    assert main(["doctor", "--state-root", str(state_root)]) == 1

    output = capsys.readouterr().out
    assert message in output
    assert "synthetic-" not in output
    assert path.read_bytes() == before


def test_doctor_flags_shared_namespace_for_custom_state_without_migrating_it(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    monkeypatch.setattr(cli, "default_state_root", lambda: tmp_path / "default-state")
    state_root = tmp_path / "custom-state"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    path = state_root / "secrets" / "trading_max.env"
    values = cli._read_env(path)
    values["TRADING_MAX_CREDENTIAL_SERVICE"] = DEFAULT_CREDENTIAL_SERVICE
    cli._write_env(path, values)
    before = path.read_bytes()

    assert main(["doctor", "--state-root", str(state_root)]) == 1

    assert (
        "custom state root uses the shared default credential namespace" in capsys.readouterr().out
    )
    assert path.read_bytes() == before


def test_doctor_distinguishes_configuration_checks_from_runtime_and_provider_health(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    state_root = tmp_path / "state"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    before = {
        path.relative_to(state_root): path.read_bytes()
        for path in state_root.rglob("*")
        if path.is_file()
    }
    capsys.readouterr()

    assert main(["doctor", "--state-root", str(state_root)]) == 0

    output = capsys.readouterr().out
    assert "doctor: configuration checks passed" in output
    assert "runtime readiness: not checked" in output
    assert "provider access: not checked" in output
    assert "credential store availability: not checked" in output
    after = {
        path.relative_to(state_root): path.read_bytes()
        for path in state_root.rglob("*")
        if path.is_file()
    }
    assert after == before


def test_doctor_allows_the_historical_namespace_at_the_default_state_root(
    tmp_path: Path,
    monkeypatch,
) -> None:
    state_root = tmp_path / "default-state"
    monkeypatch.setattr(cli, "default_state_root", lambda: state_root)
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    assert main(["setup", "--state-root", str(state_root)]) == 0
    assert main(["doctor", "--state-root", str(state_root)]) == 0


def test_doctor_reads_uncheckpointed_schema_changes_without_changing_live_state(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    state_root = tmp_path / "state"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    writer = sqlite3.connect(state_root / "trading_max.db")
    try:
        latest = writer.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        writer.execute("DELETE FROM schema_migrations WHERE version = ?", (latest,))
        writer.commit()
        assert (state_root / "trading_max.db-wal").stat().st_size > 0
        before = {
            path.relative_to(state_root): path.read_bytes()
            for path in state_root.rglob("*")
            if path.is_file()
        }

        assert main(["doctor", "--state-root", str(state_root)]) == 1

        after = {
            path.relative_to(state_root): path.read_bytes()
            for path in state_root.rglob("*")
            if path.is_file()
        }
        assert after == before
    finally:
        writer.close()


def test_doctor_reports_database_changes_during_diagnostic_copy(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    state_root = tmp_path / "state"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    copy_diagnostic_file = cli._copy_diagnostic_file
    writer = sqlite3.connect(state_root / "trading_max.db")
    writer.execute("CREATE TABLE diagnostic_fixture (value INTEGER)")
    writer.commit()

    def copy_then_change(source: Path, destination: Path, size: int) -> None:
        copy_diagnostic_file(source, destination, size)
        writer.execute(
            "DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)"
        )
        writer.commit()

    monkeypatch.setattr(cli, "_copy_diagnostic_file", copy_then_change)
    try:
        assert main(["doctor", "--state-root", str(state_root)]) == 1
        assert "state database changed during inspection" in capsys.readouterr().out
    finally:
        writer.close()


def test_doctor_avoids_copying_a_checkpointed_database(tmp_path: Path, monkeypatch) -> None:
    state_root = tmp_path / "state"
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    assert main(["setup", "--state-root", str(state_root)]) == 0

    def copying_is_unnecessary(*_args, **_kwargs) -> None:
        pytest.fail("a checkpointed database must not be copied")

    monkeypatch.setattr(cli, "_copy_diagnostic_file", copying_is_unnecessary)
    assert main(["doctor", "--state-root", str(state_root)]) == 0


def test_doctor_reports_unverified_schema_when_wal_copy_would_exceed_its_limit(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    state_root = tmp_path / "state"
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    assert main(["setup", "--state-root", str(state_root)]) == 0
    writer = sqlite3.connect(state_root / "trading_max.db")
    try:
        writer.execute("CREATE TABLE diagnostic_fixture (value INTEGER)")
        writer.commit()
        before = {
            path.relative_to(state_root): path.read_bytes()
            for path in state_root.rglob("*")
            if path.is_file()
        }
        monkeypatch.setattr(cli, "MAX_DIAGNOSTIC_COPY_BYTES", 1)
        capsys.readouterr()

        assert main(["doctor", "--state-root", str(state_root)]) == 1

        output = capsys.readouterr().out
        assert "configuration check incomplete" in output
        assert "schema is not verified" in output
        assert "doctor found problems" not in output
        after = {
            path.relative_to(state_root): path.read_bytes()
            for path in state_root.rglob("*")
            if path.is_file()
        }
        assert after == before
    finally:
        writer.close()


def test_doctor_does_not_claim_an_unverified_remote_is_canonical(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    def unverified_source(app_root: Path) -> SourceCheckout:
        return SourceCheckout(app_root, "a" * 40, "main", False, None)

    monkeypatch.setattr(cli, "inspect_source_checkout", unverified_source)
    state_root = tmp_path / "state"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    capsys.readouterr()

    assert main(["doctor", "--state-root", str(state_root)]) == 1

    output = capsys.readouterr().out
    assert "engramai-co/trading-max@" not in output
    assert "canonical source: not verified" in output


@pytest.mark.parametrize("configured_root", [None, "", "relative-state"])
def test_doctor_rejects_missing_or_relative_bootstrap_data_roots(
    tmp_path: Path,
    monkeypatch,
    capsys,
    configured_root: str | None,
) -> None:
    state_root = tmp_path / "state"
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    assert main(["setup", "--state-root", str(state_root)]) == 0
    path = state_root / "secrets" / "trading_max.env"
    values = cli._read_env(path)
    if configured_root is None:
        values.pop("TRADING_MAX_DATA_ROOT")
    else:
        values["TRADING_MAX_DATA_ROOT"] = configured_root
    cli._write_env(path, values)

    assert main(["doctor", "--state-root", str(state_root)]) == 1
    assert "bootstrap data root" in capsys.readouterr().out


def test_doctor_reports_invalid_bootstrap_encoding_without_dumping_content(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    state_root = tmp_path / "state"
    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    assert main(["setup", "--state-root", str(state_root)]) == 0
    path = state_root / "secrets" / "trading_max.env"
    path.write_bytes(b"SECRET=synthetic-sensitive-value\xff")
    capsys.readouterr()

    assert main(["doctor", "--state-root", str(state_root)]) == 1
    output = capsys.readouterr().out
    assert "not valid UTF-8" in output
    assert "synthetic-sensitive-value" not in output


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


@pytest.mark.parametrize("used,expected", [(3_000_000_000, 0), (5_100_000_000, 1)])
def test_doctor_reports_installation_capacity_without_changing_records(
    tmp_path, monkeypatch, capsys, used, expected
):
    import json

    monkeypatch.setattr(cli, "inspect_source_checkout", _clean_source)
    state_root = tmp_path / "Trading Max"
    assert main(["setup", "--state-root", str(state_root)]) == 0
    capacity = state_root / "runtime/storage-budget.json"
    capacity.parent.mkdir(parents=True, exist_ok=True)
    capacity.write_text(
        json.dumps(
            {
                "usedBytes": used,
                "budgetBytes": 5_000_000_000,
                "status": "ok" if used < 5_000_000_000 else "over-budget",
                "measuredAt": "2026-09-20T12:00:00+00:00",
            }
        )
    )
    before = capacity.read_bytes()
    assert main(["doctor", "--state-root", str(state_root)]) == expected
    assert "installation storage:" in capsys.readouterr().out
    assert capacity.read_bytes() == before
