from __future__ import annotations

import json
from pathlib import Path

from trading_max.application import AccountReviewStage, TypedWorkerRuntime
from trading_max.application.stages import StageContext
from trading_max.domain import ArtifactQuality
from trading_max.infrastructure import ContentAddressedArtifactStore

NAV = (
    "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
    "WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
    "2026-08-01,100,900,1000,1000,1000,,1,0\n"
    "2026-08-02,100,920,1020,0,0,0.02,1.02,0\n"
    "2026-08-03,100,910,1010,0,0,-0.0098039,1.01,-0.0098039\n"
)

BASELINE_NAV = (
    "Date,CashGBP,MarketValueGBP,SyntheticNAVGBP,ExternalFlowGBP,"
    "WeightedExternalFlowGBP,DailyReturn,TWRWealth,Drawdown\n"
    "2026-08-01,100,900,1000,1000,1000,,,,\n"
)

PERFORMANCE = {
    "schema_version": 1,
    "account": "A",
    "periods": 2,
    "twr_total_return": 0.01,
    "annualized_return": 0.12,
    "annualized_volatility": 0.20,
    "sharpe_sonia": 0.8,
    "sortino_sonia": 1.1,
    "calmar_ratio": 0.7,
    "information_ratio": 0.3,
    "max_drawdown": -0.01,
    "current_drawdown": -0.01,
    "net_external_flows_gbp": 1000.0,
    "nav_quality": "synthetic_market_nav",
}


def _managed_export(
    state_root: Path,
    profile: str,
    *,
    with_closed_campaigns: bool,
) -> None:
    export_dir = state_root / "trading212" / profile / "exports"
    export_dir.mkdir(parents=True)
    export = export_dir / "synthetic.csv"
    rows = [
        "open,Market buy,2026-08-01T09:00:00Z,HOLD,Holding,1,100,100,0,",
    ]
    if with_closed_campaigns:
        rows = [
            "w-buy,Market buy,2026-08-01T10:00:00Z,WIN,Winner,1,100,100,0,",
            "w-sell,Market sell,2026-08-02T10:00:00Z,WIN,Winner,1,120,120,0,20",
            "l-buy,Market buy,2026-08-01T11:00:00Z,LOSS,Loser,1,100,100,0,",
            "l-sell,Market sell,2026-08-03T11:00:00Z,LOSS,Loser,1,90,90,0,-10",
            *rows,
        ]
    export.write_text(
        "ID,Action,Time (UTC),Ticker,Name,No. of shares,Price / share,Total,"
        "Currency conversion fee,Result\n" + "\n".join(rows) + "\n",
        encoding="utf-8",
    )
    manifest = state_root / "trading212" / profile / "latest_export.json"
    manifest.write_text(
        json.dumps(
            {
                "profile": profile,
                "csv": {"path": f"{profile}/exports/{export.name}"},
            }
        ),
        encoding="utf-8",
    )


def _account(ticker: str) -> dict[str, object]:
    return {
        "profile": "invest",
        "fetched_at": "2026-08-03T20:00:00Z",
        "total_value_gbp": 1010.0,
        "cash_gbp": 100.0,
        "investments_value_gbp": 910.0,
        "position_value_gbp": 910.0,
        "total_cost_gbp": 800.0,
        "realized_profit_loss_gbp": 10.0,
        "unrealized_profit_loss_gbp": 110.0,
        "positions": [
            {
                "ticker": ticker,
                "broker_ticker": f"{ticker}_US_EQ",
                "name": "Synthetic Holding",
                "isin": "US0000000001",
                "quantity": 1.0,
                "current_price": 910.0,
                "price_currency": "USD",
                "current_value_gbp": 910.0,
                "total_cost_gbp": 800.0,
                "unrealized_profit_loss_gbp": 110.0,
                "fx_impact_gbp": 5.0,
            }
        ],
        "checks": {
            "positions_match_investments": True,
            "cash_plus_investments_matches_total": True,
        },
    }


def _seed_inputs(
    tmp_path: Path,
    *,
    nav: str = NAV,
    performance: dict[str, object] = PERFORMANCE,
    lookthrough: dict[str, object],
    lookthrough_quality: ArtifactQuality | None = None,
) -> tuple[ContentAddressedArtifactStore, tuple[str, ...]]:
    artifacts = ContentAddressedArtifactStore(tmp_path / "artifacts")
    refs = []
    for code, profile in (("A", "invest"), ("B", "isa")):
        account = artifacts.put_json(
            key=f"account/{profile}.json",
            payload={**_account("HOLD"), "profile": profile},
            kind="account",
            producer_version="accounts-v1",
        )
        risk = artifacts.put_json(
            key=f"account/performance_{code.lower()}.json",
            payload={**performance, "account": code},
            kind="performance",
            producer_version="performance-v1",
        )
        nav_artifact = artifacts.put_bytes(
            key=f"account/nav/daily_nav_{code.lower()}.csv",
            content=nav.encode(),
            kind="nav_series",
            media_type="text/csv",
            producer_version="nav-v1",
        )
        refs.extend([account.ref.artifact_id, risk.ref.artifact_id, nav_artifact.ref.artifact_id])
    lookthrough_artifact = artifacts.put_json(
        key="account/lookthrough_metrics.json",
        payload=lookthrough,
        kind="lookthrough",
        producer_version="lookthrough-v8",
        quality=lookthrough_quality,
    )
    refs.append(lookthrough_artifact.ref.artifact_id)
    return artifacts, tuple(refs)


def test_account_review_stage_consumes_typed_lenses_and_publishes_both_accounts(
    tmp_path: Path,
) -> None:
    for profile in ("invest", "isa"):
        _managed_export(tmp_path, profile, with_closed_campaigns=True)
    artifacts, upstream = _seed_inputs(
        tmp_path,
        lookthrough={
            "positions": [
                {
                    "ticker": "HOLD",
                    "country": "United States",
                    "gics": {"sectorName": "Information Technology"},
                }
            ],
            "warnings": [],
        },
    )

    result = AccountReviewStage(tmp_path, artifacts).run(
        StageContext(
            job_id="review",
            scope="accounts",
            upstream_artifact_ids=upstream,
        )
    )

    assert result.warnings == ()
    assert len(result.artifacts) == 1
    stored = artifacts.get_json(result.artifacts[0].artifact_id)
    assert stored.ref.key == "account/account_reviews.json"
    assert stored.ref.kind == "account_review"
    assert stored.ref.quality.status == "verified"
    assert stored.ref.dependency_artifact_ids == sorted(upstream)
    assert set(stored.payload["accounts"]) == {"A", "B"}
    for code, profile in (("A", "invest"), ("B", "isa")):
        review = stored.payload["accounts"][code]
        assert review["account"] == {"code": code, "kind": profile, "currency": "GBP"}
        assert review["strategy_risk"]["metrics"]["twr_total_return"] == 0.01
        assert review["strategy_risk"]["metrics"]["sharpe_sonia"] == 0.8
        assert review["coverage"]["provenance"]["performance_artifact_id"]
        assert review["coverage"]["provenance"]["lookthrough_artifact_id"]
        assert review["ending_risk"]["exposures"]["country"]["buckets"][0]["label"] == (
            "United States"
        )
        assert (
            review["ending_risk"]["exposures"]["industry"]["buckets"][0]["label"]
            == "Information Technology"
        )


def test_account_review_stage_is_registered_after_all_authoritative_lenses(
    tmp_path: Path,
) -> None:
    names = list(TypedWorkerRuntime(tmp_path).registry().names())

    assert names.index("accounts.snapshot") < names.index("accounts.review")
    assert names.index("portfolio.lookthrough") < names.index("accounts.review")
    assert names.index("accounts.nav") < names.index("accounts.review")
    assert names.index("accounts.performance") < names.index("accounts.review")


def test_account_review_stage_carries_unavailable_reasons_and_upstream_quality(
    tmp_path: Path,
) -> None:
    for profile in ("invest", "isa"):
        _managed_export(tmp_path, profile, with_closed_campaigns=False)
    incomplete_performance = {
        **PERFORMANCE,
        "periods": 0,
        "twr_total_return": None,
        "sharpe_sonia": None,
        "sortino_sonia": None,
        "calmar_ratio": None,
    }
    artifacts, upstream = _seed_inputs(
        tmp_path,
        nav=BASELINE_NAV,
        performance=incomplete_performance,
        lookthrough={"positions": [{"ticker": "HOLD", "country": "Other markets", "gics": None}]},
        lookthrough_quality=ArtifactQuality(
            status="warning",
            warnings=["taxonomy classification is incomplete"],
        ),
    )

    result = AccountReviewStage(tmp_path, artifacts).run(
        StageContext(
            job_id="review-partial",
            scope="accounts",
            upstream_artifact_ids=upstream,
        )
    )

    assert any("taxonomy classification is incomplete" in warning for warning in result.warnings)
    assert any("phases unavailable" in warning for warning in result.warnings)
    assert any(
        "strategy_risk.twr_total_return unavailable" in warning for warning in result.warnings
    )
    stored = artifacts.get_json(result.artifacts[0].artifact_id)
    assert stored.ref.quality.status == "warning"
    for review in stored.payload["accounts"].values():
        strategy = review["strategy_risk"]
        assert strategy["status"] == "partial"
        assert strategy["metrics"]["twr_total_return"] is None
        assert strategy["metric_unavailable_reasons"]["twr_total_return"]
        assert review["phases"]["status"] == "unavailable"
        assert review["phases"]["unavailable_reason"]
        assert review["realised_trade_quality"]["status"] == "unavailable"
        assert review["attribution"]["status"] == "unavailable"
        assert review["ending_risk"]["exposures"]["country"]["status"] == "unavailable"
        assert review["ending_risk"]["exposures"]["industry"]["status"] == "unavailable"
        assert all(
            bucket.get("label") != "Unknown"
            for exposure in review["ending_risk"]["exposures"].values()
            for bucket in exposure.get("buckets", [])
        )
