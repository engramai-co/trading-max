"""Resolve optional Alpaca credentials from the operating-system store."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from trading_max.analytics.alpaca_prices import AlpacaEnhancedPriceLoader, AlpacaHistoricalClient
from trading_max.analytics.intraday_reconstruction import CachedIntradayPriceLoader
from trading_max.infrastructure.alpaca_http import AlpacaHTTP, AlpacaRateBudget
from trading_max.infrastructure.alpaca_market_prices import AlpacaMarketPrices

from .credentials import CredentialStoreError


def alpaca_budget(root: Path) -> AlpacaRateBudget:
    return AlpacaRateBudget(root / "cache" / "alpaca-budget.json")


def _credentials(preferences, credentials) -> tuple[str, str]:
    raw = credentials.get(preferences.credential_reference("alpaca"))
    pair = json.loads(raw or "{}")
    key, secret = pair["api_key"], pair["api_secret"]
    if not isinstance(key, str) or not isinstance(secret, str) or not key or not secret:
        raise ValueError("missing credentials")
    return key, secret


def market_price_source_factory(root: Path, preferences, credentials):
    budget = alpaca_budget(root)
    lock = threading.Lock()
    fingerprint = None
    source = None

    def resolve():
        nonlocal fingerprint, source
        with lock:
            integration = preferences.get_integration("alpaca")
            if integration is None or not integration.enabled or not integration.configured:
                fingerprint, source = None, None
                return None
            if source is None or integration.credential_fingerprint != fingerprint:
                try:
                    key, secret = _credentials(preferences, credentials)
                except (CredentialStoreError, ValueError, KeyError, TypeError):
                    fingerprint, source = None, None
                else:
                    source = AlpacaMarketPrices(AlpacaHTTP(key, secret, budget=budget))
                    fingerprint = integration.credential_fingerprint
            return source

    return resolve


def reconstruction_loader_factory(root: Path, preferences, credentials):
    budget = alpaca_budget(root)

    def create():
        baseline = CachedIntradayPriceLoader(root / "cache" / "nav-prices")
        integration = preferences.get_integration("alpaca")
        if integration is None or not integration.enabled:
            return baseline
        try:
            key, secret = _credentials(preferences, credentials)
        except (CredentialStoreError, ValueError, KeyError, TypeError):
            baseline.diagnostics = {
                "alpaca": {"status": "fallback", "reason": "credential_store_unavailable"}
            }
            return baseline
        return AlpacaEnhancedPriceLoader(
            root / "cache" / "alpaca-nav-prices",
            baseline,
            AlpacaHistoricalClient(key, secret, budget=budget),
        )

    return create
