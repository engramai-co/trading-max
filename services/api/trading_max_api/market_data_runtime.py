"""Resolve optional reconstruction credentials only inside the worker process."""

from __future__ import annotations

import json
from pathlib import Path

from trading_max.analytics.alpaca_prices import AlpacaEnhancedPriceLoader, AlpacaHistoricalClient
from trading_max.analytics.intraday_reconstruction import CachedIntradayPriceLoader

from .credentials import CredentialStoreError


def reconstruction_loader_factory(root: Path, preferences, credentials):
    def create():
        baseline = CachedIntradayPriceLoader(root / "cache" / "nav-prices")
        integration = preferences.get_integration("alpaca")
        if integration is None or not integration.enabled:
            return baseline
        try:
            raw = credentials.get(preferences.credential_reference("alpaca"))
            pair = json.loads(raw or "{}")
            key, secret = pair["api_key"], pair["api_secret"]
            if not isinstance(key, str) or not isinstance(secret, str) or not key or not secret:
                raise ValueError("missing credentials")
        except (CredentialStoreError, ValueError, KeyError, TypeError):
            baseline.diagnostics = {
                "alpaca": {"status": "fallback", "reason": "credential_store_unavailable"}
            }
            return baseline
        return AlpacaEnhancedPriceLoader(
            root / "cache" / "alpaca-nav-prices",
            baseline,
            AlpacaHistoricalClient(key, secret),
        )

    return create
