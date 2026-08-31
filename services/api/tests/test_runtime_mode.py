from __future__ import annotations

from pathlib import Path

import pytest

from services.api.trading_max_api.app import create_app
from services.api.trading_max_api.config import APP_ROOT, Settings, default_data_root
from services.api.trading_max_api.typed_analysis import TypedAnalysisManager
from services.api.trading_max_api.typed_jobs import TypedJobManager


def test_default_schedules_are_four_full_refreshes_and_24_7_intraday(tmp_path) -> None:
    settings = Settings(data_root=tmp_path)

    assert settings.full_refresh_times == ("06:30", "12:00", "17:30", "22:30")
    assert settings.intraday_interval_seconds == 600
    assert settings.intraday_window_start == "00:00"
    assert settings.intraday_window_end == "00:00"
    assert settings.intraday_weekdays == (1, 2, 3, 4, 5, 6, 7)
    assert settings.intraday_retention_days == 40


def test_legacy_single_nightly_time_remains_a_supported_environment_fallback(
    monkeypatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("TRADING_MAX_DATA_ROOT", str(tmp_path))
    monkeypatch.delenv("TRADING_MAX_FULL_REFRESH_TIMES", raising=False)
    monkeypatch.setenv("TRADING_MAX_NIGHTLY_HOUR", "9")
    monkeypatch.setenv("TRADING_MAX_NIGHTLY_MINUTE", "15")

    assert Settings.from_env().full_refresh_times == ("09:15",)


def test_production_rejects_embedded_worker(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TRADING_MAX_ENV", "production")
    settings = Settings(
        data_root=tmp_path,
        embedded_worker=True,
    )

    with pytest.raises(RuntimeError, match="EMBEDDED_WORKER"):
        settings.validate_runtime_mode()


def test_development_uses_typed_runtime_by_default(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("TRADING_MAX_ENV", raising=False)
    settings = Settings(
        data_root=tmp_path,
    )

    settings.validate_runtime_mode()


def test_production_requires_external_absolute_data_root(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("TRADING_MAX_ENV", "production")
    monkeypatch.setenv("TRADING_MAX_DATA_ROOT", "relative-state")

    with pytest.raises(RuntimeError, match="absolute path"):
        default_data_root()

    checkout_state = APP_ROOT / "runtime"
    monkeypatch.setenv("TRADING_MAX_DATA_ROOT", str(checkout_state))
    with pytest.raises(RuntimeError, match="outside the application checkout"):
        default_data_root()

    external_state = tmp_path / "checkout"
    settings = Settings(data_root=external_state, api_token="test-token")
    settings.validate_runtime_mode()


def test_typed_app_wires_typed_analysis_and_job_control_planes(tmp_path: Path) -> None:
    app = create_app(
        Settings(
            data_root=tmp_path / "state",
            llm_provider="fake",
            embedded_worker=False,
        )
    )

    assert isinstance(app.state.analysis, TypedAnalysisManager)
    assert isinstance(app.state.jobs, TypedJobManager)
    app.state.jobs.close()
    app.state.analysis.close()
