from __future__ import annotations

from pathlib import Path

from trading_max.analytics.etf_details import etf_holdings_key
from trading_max.domain.etf import FundEvidence, FundListing, FundShareClass
from trading_max.reference import SecurityEntityRecord, SecurityListingRecord, SecurityMasterCatalog

from services.api.trading_max_api.artifacts import ArtifactStore
from services.api.trading_max_api.projections.listings import HoldingListingCalendars


def test_exact_listing_match_uses_immutable_security_and_fund_evidence(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path)
    stock_isin = "ZZ0000000001"
    fund_isin = "ZZ0000000002"
    catalog = SecurityMasterCatalog(
        records=[
            SecurityEntityRecord(
                entity_id="synthetic",
                canonical_ticker="DUP",
                entity_name="Synthetic issuer",
                source="test",
                listings=[
                    SecurityListingRecord(ticker="DUP", isin=stock_isin, mic=mic, source="test")
                    for mic in ("XPAR", "XAMS")
                ]
                + [
                    SecurityListingRecord(ticker="ONLY", isin=stock_isin, mic="XPAR", source="test")
                ],
            )
        ],
    )
    profile = FundShareClass(
        isin=fund_isin,
        issuer="Synthetic fund",
        listings=[
            FundListing(
                ticker=ticker,
                isin=fund_isin,
                mic=mic,
                source="test",
                evidence=FundEvidence(
                    source_url="",
                    fetched_at="2026-11-01",
                    parser_version="test",
                    coverage="available",
                ),
            )
            for ticker, mic in (("SYN", "XETR"), ("SYNGBP", "XLON"))
        ],
    )
    artifacts = [
        store.immutable_artifacts.put_json(
            key=key, payload=payload, kind="reference-data", producer_version="test"
        ).ref
        for key, payload in (
            ("reference/security_master.json", catalog.model_dump(mode="json")),
            (etf_holdings_key(fund_isin), {"profile": profile.model_dump(mode="json")}),
        )
    ]
    snapshot = store.immutable_snapshots.publish(
        scope="accounts", source="test", artifacts=artifacts
    )
    calendars = HoldingListingCalendars(
        lambda key: store.read_json(snapshot.manifest.run_id, key), {fund_isin}
    )

    assert calendars.name({"ticker": "ONLY", "isin": stock_isin}) == "XPAR"
    assert calendars.name({"ticker": "DUP", "isin": stock_isin}) is None
    assert calendars.name({"ticker": "ONLY", "isin": fund_isin}) is None
    assert calendars.name({"ticker": "SYN", "isin": fund_isin}) == "XETR"
    assert calendars.name({"ticker": "SYNGBP", "isin": fund_isin}) == "XLON"
    assert (
        calendars.name({"ticker": "SYN", "broker_ticker": "SYNl_EQ", "isin": fund_isin}) == "XLON"
    )
    assert calendars.name({"ticker": "ONLY", "isin": stock_isin, "mic": "XAMS"}) == "XAMS"
