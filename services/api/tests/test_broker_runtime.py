from services.api.trading_max_api.broker_runtime import broker_profiles_loader
from services.api.trading_max_api.settings import SettingsRepository


def test_desktop_profiles_are_resolved_after_connection_is_saved(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_MAX_DESKTOP_WORKSPACE_ID", "synthetic-workspace")
    settings = SettingsRepository(tmp_path)
    try:
        load = broker_profiles_loader(settings)
        assert load() == ()
        for profile in ("invest", "isa"):
            settings.save_integration(
                provider="trading212",
                profile=profile,
                enabled=True,
                model=None,
                base_url="https://live.trading212.com/api/v0",
                credential_fingerprint="synthetic-fingerprint",
                test_status="succeeded",
            )
            assert load() == (("invest",) if profile == "invest" else ("invest", "isa"))
        settings.remove_integration(provider="trading212", profile="isa")
        assert load() == ("invest",)
    finally:
        settings.close()


def test_legacy_source_profiles_remain_compatible(tmp_path, monkeypatch):
    monkeypatch.delenv("TRADING_MAX_DESKTOP_WORKSPACE_ID", raising=False)
    settings = SettingsRepository(tmp_path)
    try:
        assert broker_profiles_loader(settings)() == ("invest", "isa")
    finally:
        settings.close()
