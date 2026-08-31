from __future__ import annotations

from pathlib import Path

from trading_max.application import TypedWorkerRuntime


def test_account_registry_orders_nav_before_performance(tmp_path: Path) -> None:
    names = list(TypedWorkerRuntime(tmp_path).registry().names())

    assert names.index("accounts.snapshot") < names.index("accounts.nav")
    assert names.index("accounts.snapshot") < names.index("reference.security_master")
    assert names.index("reference.security_master") < names.index("portfolio.lookthrough")
    assert names.index("accounts.snapshot") < names.index("portfolio.lookthrough")
    assert names.index("accounts.nav") < names.index("accounts.performance")
    assert names.index("accounts.capital_recovery") < names.index("accounts.nav")


def test_research_registry_orders_market_dependencies(tmp_path: Path) -> None:
    names = list(TypedWorkerRuntime(tmp_path).registry().names())

    assert names.index("market.snapshot") < names.index("research.technical")
    assert names.index("market.snapshot") < names.index("research.taxonomy")
    assert names.index("research.technical") < names.index("research.options")
    assert names.index("research.technical") < names.index("research.adr")
    assert names.index("research.fundamentals") < names.index("research.valuation")
    assert names.index("research.technical") < names.index("research.valuation")


def test_research_registry_has_explicit_market_and_research_stages(
    tmp_path: Path,
) -> None:
    registry = TypedWorkerRuntime(tmp_path).registry()
    names = list(registry.names())

    assert names.index("market.snapshot") < names.index("research.technical")
    assert names.index("research.technical") < names.index("research.options")
    assert names.index("research.technical") < names.index("research.adr")
    registry.validate_order(names)
