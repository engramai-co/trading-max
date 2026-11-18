from datetime import date

import pytest
from trading_max.research.evidence_notice import estimate_items, estimate_step, statement_items
from trading_max.research.valuation_maintenance import EstimateChange, Restatement, Restating

END = date(2026, 12, 31)


def eps(saved, current, currency="USD"):
    return EstimateChange(
        metric="consensusEps", period_end=END, currency=currency, saved=saved, current=current
    )


def growth(saved, current):
    return EstimateChange(
        metric="consensusRevenueGrowth", period_end=END, saved=saved, current=current
    )


@pytest.mark.parametrize(
    ("change", "step"),
    [
        (eps(2.0, 2.09), 0),
        (eps(2.0, 2.1), 1),
        (eps(2.0, 1.9), -1),
        (eps(2.0, 2.21), 2),
        (eps(-0.5, -0.4), 4),
        (eps(0.0, 0.01), 1),
        (eps(0.0, 0.0), 0),
        (growth(0.13, 0.15), 1),
        (growth(0.15, 0.169), 0),
        (growth(0.15, 0.31), 8),
        (growth(0.12, 0.08), -2),
    ],
)
def test_consensus_moves_count_in_whole_steps_from_the_saved_value(change, step):
    assert estimate_step(change) == step


def test_the_same_move_keeps_its_key_and_a_further_step_is_new():
    assert estimate_items([eps(2.0, 2.05), growth(0.15, 0.16)]) == []
    [first] = estimate_items([eps(2.0, 2.12)])
    [drifted] = estimate_items([eps(2.0, 2.18)])
    [further] = estimate_items([eps(2.0, 2.22)])
    assert first.key == drifted.key == "consensusEps:2026-12-31:USD:1"
    assert further.key == "consensusEps:2026-12-31:USD:2"
    assert (first.saved, first.current, first.currency) == (2.0, 2.12, "USD")
    [back] = estimate_items([eps(2.0, 1.85)])
    assert back.key == "consensusEps:2026-12-31:USD:-1"


def test_new_statements_and_restatements_name_their_period():
    unchanged = Restating(None, [], "unchanged")
    assert statement_items("ttm:2025-12-31", "ttm:2025-12-31", unchanged) == []
    [newer] = statement_items("ttm:2025-12-31", "ttm:2026-03-31", unchanged)
    assert (newer.kind, newer.key, newer.period_id) == (
        "statements",
        "statements:ttm:2026-03-31",
        "ttm:2026-03-31",
    )

    def restated(current):
        change = Restatement(
            period_id="ttm:2025-12-31",
            metric="revenue",
            saved=4000,
            current=current,
            unit="currency",
            currency="USD",
        )
        return Restating(None, [change], "restated", "metrics-incomplete", ("cash",))

    [first] = statement_items("ttm:2025-12-31", "ttm:2025-12-31", restated(3850))
    [again] = statement_items("ttm:2025-12-31", "ttm:2025-12-31", restated(3850))
    [other] = statement_items("ttm:2025-12-31", "ttm:2025-12-31", restated(3800))
    assert first.kind == "restatement" and first.period_id == "ttm:2025-12-31"
    assert first.key == again.key != other.key
    # A period that cannot be checked is not evidence on its own.
    missing = Restating(None, [], "unavailable", "period-missing")
    assert statement_items("ttm:2025-12-31", "ttm:2025-12-31", missing) == []
