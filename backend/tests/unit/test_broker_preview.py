import json

import pytest

from tools.build_broker_preview import MARKER, prepare_destination, prior_close
from tools.serve_broker_preview import refresh_broker_inputs


def test_preview_rejects_existing_unmarked_data(tmp_path):
    (tmp_path / "portfolio.json").write_text("existing account state")
    with pytest.raises(ValueError, match="clean directory"):
        prepare_destination(tmp_path)
    assert (tmp_path / "portfolio.json").read_text() == "existing account state"
    assert not (tmp_path / MARKER).exists()


def test_preview_rejects_old_synthetic_state_even_with_new_marker(tmp_path):
    (tmp_path / "SYNTHETIC_DEMO_ONLY").touch()
    (tmp_path / MARKER).touch()
    with pytest.raises(ValueError, match="fully synthetic"):
        prepare_destination(tmp_path)


def test_preview_marks_new_external_state_and_allows_resume(tmp_path):
    prepare_destination(tmp_path)
    assert (tmp_path / MARKER).is_file()
    prepare_destination(tmp_path)


def test_simulated_fill_uses_an_observed_past_price_or_fails():
    market = {"symbol": "TEST", "daily": {"2026-01-02": 12, "2026-01-05": 18}}
    assert prior_close(market, "2026-01-05") == 12
    with pytest.raises(ValueError, match="no real price"):
        prior_close(market, "2026-01-02")


@pytest.mark.parametrize("missing", [False, True])
def test_preview_refresh_uses_quotes_and_never_publishes_partial_accounts(tmp_path, missing):
    from trading_max.ingestion.brokers.trading212 import ManagedAccountStore

    prepare_destination(tmp_path)
    for profile in ("invest", "isa"):
        ManagedAccountStore(profile, data_root=tmp_path / "trading212").write_snapshot(
            {
                "fetched_at_utc": "2026-01-01T00:00:00Z",
                "account_summary": {
                    "currency": "GBP",
                    "totalValue": 90,
                    "cash": {"availableToTrade": 10},
                    "investments": {
                        "currentValue": 80,
                        "totalCost": 70,
                        "realizedProfitLoss": 0,
                        "unrealizedProfitLoss": 10,
                    },
                },
                "positions": [
                    {
                        "instrument": {"ticker": "TEST", "name": "Fixture", "currency": "USD"},
                        "quantity": 2,
                        "currentPrice": 50,
                        "walletImpact": {
                            "currentValue": 80,
                            "totalCost": 70,
                            "unrealizedProfitLoss": 10,
                        },
                    }
                ],
            }
        )

    def quote(symbol):
        if missing and symbol == "GBPUSD=X":
            raise ValueError("FX unavailable")
        return {"price": 1.25 if symbol == "GBPUSD=X" else 60, "currency": "USD", "as_of": 1}

    if missing:
        with pytest.raises(ValueError, match="FX unavailable"):
            refresh_broker_inputs(tmp_path, quote_loader=quote)
        assert len(list(tmp_path.glob("trading212/*/snapshots/*.json"))) == 2
    else:
        refresh_broker_inputs(tmp_path, quote_loader=quote)
        for profile in ("invest", "isa"):
            path = sorted(tmp_path.glob(f"trading212/{profile}/snapshots/*.json"))[-1]
            result = json.loads(path.read_text())
            assert result["account_summary"]["totalValue"] == 106
            assert result["positions"][0]["walletImpact"]["totalCost"] == 70
            assert result["positions"][0]["quantity"] == 2


@pytest.mark.parametrize(
    "regular,pre,post,expected", [(100, 200, 90, 12), (300, 200, 290, 10), (300, 200, 400, 13)]
)
def test_live_preview_uses_newest_session_quote(monkeypatch, regular, pre, post, expected):
    import yfinance as yf

    from tools.serve_broker_preview import live_quote

    class Ticker:
        def __init__(self, symbol):
            pass

        def get_info(self):
            return {
                "currency": "USD",
                "regularMarketPrice": 10,
                "regularMarketTime": regular,
                "preMarketPrice": 12,
                "preMarketTime": pre,
                "postMarketPrice": 13,
                "postMarketTime": post,
            }

    monkeypatch.setattr(yf, "Ticker", Ticker)
    assert live_quote("TEST")["price"] == expected


@pytest.mark.parametrize("failure", [True, False])
def test_preview_resume_invalidates_old_outputs_and_dependants(tmp_path, monkeypatch, failure):
    from types import SimpleNamespace

    from trading_max.application import runtime
    from trading_max.application.stages import StageRegistry, StageResult
    from trading_max.domain.contracts import ArtifactRef

    from services.api.trading_max_api import typed_jobs
    from tools.build_broker_preview import build, write_json

    required = [
        "account/broker_snapshot_metrics.json",
        "research/technical.json",
        "research/fundamentals.json",
        "account/nav/valuation_history.json",
    ]

    def artifact(key, version):
        return ArtifactRef(
            artifact_id=f"{version}:{key}", key=key, sha256="test", producer_version=version
        )

    stale_keys = [*required, "removed.json"]
    write_json(
        tmp_path / "preview-build.json",
        {
            "tickers": [],
            "completed": {"source": "source-v1", "dependent": "dependent-v1"},
            "failures": {},
            "artifacts": {
                key: artifact(key, "source-v1").model_dump(mode="json", by_alias=False)
                for key in stale_keys
            }
            | {
                "dependent.json": artifact("dependent.json", "dependent-v1").model_dump(
                    mode="json", by_alias=False
                )
            },
        },
    )
    called = []

    class Source:
        name, version, dependencies = "source", "source-v2", ()

        def run(self, context):
            called.append(self.name)
            assert not context.inputs
            if failure:
                raise ValueError("provider unavailable")
            return StageResult(artifacts=tuple(artifact(key, self.version) for key in required))

    class Dependent:
        name, version, dependencies = "dependent", "dependent-v1", ("source",)

        def run(self, context):
            called.append(self.name)
            assert set(context.inputs) == set(required)
            assert all(ref.producer_version == "source-v2" for ref in context.inputs.values())
            return StageResult(artifacts=(artifact("dependent.json", self.version),))

    published = []

    def publish(**kwargs):
        published.extend(kwargs["artifacts"])
        return SimpleNamespace(manifest=SimpleNamespace(run_id="test-preview"))

    monkeypatch.setattr(
        runtime,
        "TypedWorkerRuntime",
        lambda state: SimpleNamespace(
            registry=lambda: StageRegistry([Source(), Dependent()]),
            snapshots=SimpleNamespace(publish=publish),
        ),
    )
    monkeypatch.setattr(
        typed_jobs, "stage_plan", lambda *args, **kwargs: [("source", ""), ("dependent", "")]
    )
    if failure:
        with pytest.raises(RuntimeError, match="required data unavailable"):
            build(tmp_path, {}, resume=True)
        assert called == ["source"]
        assert not published
        saved = json.loads((tmp_path / "preview-build.json").read_text())
        assert not saved["artifacts"]
        assert set(saved["failures"]) == {"source", "dependent"}
    else:
        build(tmp_path, {}, resume=True)
        assert called == ["source", "dependent"]
        assert {ref.key for ref in published} == {*required, "dependent.json"}
        assert all(ref.producer_version != "source-v1" for ref in published)
