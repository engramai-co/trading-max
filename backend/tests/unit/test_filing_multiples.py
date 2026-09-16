import pytest
from trading_max.research.filing_multiples import release_multiples, release_sales_multiples


def test_published_information_and_negative_eps_not_future_restatement():
    base = {
        "url": "https://example.test/filing",
        "version": "v1",
        "publishedAt": "2025-02-01",
        "observations": [
            {
                "metric": "eps",
                "kind": "annual",
                "periodStart": "2024-01-01",
                "periodEnd": "2024-12-31",
                "currency": "USD",
                "value": 2,
            }
        ],
    }
    revised = {
        **base,
        "version": "v2",
        "publishedAt": "2025-05-01",
        "observations": [{**base["observations"][0], "value": -1}],
    }
    prices = [
        {"date": "2025-01-31", "close": 70},
        {"date": "2025-02-03", "close": 80},
        {"date": "2025-05-02", "close": 60},
    ]
    rows = release_multiples([base, revised], prices, "USD")
    assert rows[0]["pe"] == 40
    assert rows[0]["sourceVersion"] == "v1"
    assert rows[1]["pe"] is None
    assert rows[1]["state"] == "notMeaningful"
    assert release_multiples([base], prices, "GBP") == []


def test_quarterly_sales_multiple_reconciles_ttm_and_retains_historical_evidence():
    def revenue(start, end, kind, value):
        return {
            "metric": "revenue",
            "periodStart": start,
            "periodEnd": end,
            "kind": kind,
            "value": value,
            "currency": "USD",
        }

    annual = {
        "form": "10-K",
        "publishedAt": "2025-02-10",
        "periodEnd": "2024-12-31",
        "url": "https://example.test/annual",
        "version": "annual-1",
        "observations": [
            revenue("2024-01-01", "2024-12-31", "annual", 400),
            {"metric": "shares", "date": "2025-02-01", "value": 100},
        ],
    }
    quarter = {
        "form": "10-Q",
        "publishedAt": "2025-07-15",
        "periodEnd": "2025-06-30",
        "url": "https://example.test/quarter",
        "version": "quarter-1",
        "observations": [
            revenue("2025-01-01", "2025-06-30", "semiannual", 250),
            revenue("2024-01-01", "2024-06-30", "semiannual", 200),
            {"metric": "shares", "date": "2025-07-01", "value": 120},
        ],
    }
    revised = {
        **quarter,
        "version": "quarter-2",
        "publishedAt": "2025-09-01",
        "periodEnd": "2025-08-31",
        "observations": [revenue("2024-01-01", "2024-12-31", "annual", 800)],
    }
    prices = [{"date": "2025-02-11", "close": 20}, {"date": "2025-07-16", "close": 15, "split": 2}]
    rows = release_sales_multiples([quarter, revised, annual], prices, "USD")
    assert len(rows) == 2
    assert rows[0]["ps"] == 5
    assert rows[1]["revenue"] == 450
    assert rows[1]["ps"] == pytest.approx(15 * 240 / 450)
    assert rows[1]["components"][0]["sourceVersion"] == "annual-1"
    assert rows[1]["shareSplitAdjustment"] == 2
    missing_prior = {
        **quarter,
        "observations": [quarter["observations"][0], quarter["observations"][2]],
    }
    assert len(release_sales_multiples([annual, missing_prior], prices, "USD")) == 1
    assert release_sales_multiples([annual, quarter], prices, "GBP") == []
    assert release_sales_multiples([{**annual, "form": "20-F"}], prices, "USD") == []
