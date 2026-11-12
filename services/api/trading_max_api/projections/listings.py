"""Resolve a held listing from broker identity and immutable reference evidence."""

from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Callable, Mapping
from contextlib import suppress
from functools import cached_property
from typing import Any

from trading_max.analytics.etf_details import etf_holdings_key
from trading_max.domain.etf import FundShareClass
from trading_max.reference import SecurityMasterCatalog
from trading_max.research.listing import LONDON, US, broker_listing

from .values import JsonObject

_BROKER_CALENDARS = {LONDON: "XLON", US: "XNYS"}


class HoldingListingCalendars:
    def __init__(self, read_json: Callable[[str], JsonObject], fund_isins: set[str]) -> None:
        self.read_json = read_json
        self.fund_isins = fund_isins
        self._fund_calendars: dict[str, dict[str, set[str]]] = {}

    @cached_property
    def _master_calendars(self) -> dict[tuple[str, str], set[str]]:
        calendars: defaultdict[tuple[str, str], set[str]] = defaultdict(set)
        with suppress(FileNotFoundError, TypeError, ValueError):
            catalog = SecurityMasterCatalog.model_validate(
                self.read_json("reference/security_master.json")
            )
            for security in catalog.records:
                for line in security.listings:
                    if line.isin and line.mic:
                        calendars[line.isin.strip().upper(), line.ticker.strip().upper()].add(
                            line.mic.strip().upper()
                        )
        return dict(calendars)

    def _fund_mics(self, isin: str, ticker: str) -> set[str]:
        if isin not in self._fund_calendars:
            calendars: defaultdict[str, set[str]] = defaultdict(set)
            with suppress(FileNotFoundError, TypeError, ValueError):
                artifact = self.read_json(etf_holdings_key(isin))
                if not isinstance(artifact, dict):
                    raise TypeError("expected an ETF holdings object")
                profile = FundShareClass.model_validate(artifact.get("profile"))
                if profile.isin.strip().upper() == isin:
                    for line in profile.listings:
                        if line.isin.strip().upper() == isin and line.mic:
                            calendars[line.ticker.strip().upper()].add(line.mic.strip().upper())
            self._fund_calendars[isin] = dict(calendars)
        return self._fund_calendars[isin].get(ticker, set())

    def name(self, position: Mapping[str, Any]) -> str | None:
        if mic := str(position.get("mic") or "").strip().upper():
            return mic
        listing = broker_listing(position.get("broker_ticker"))
        if listing:
            return _BROKER_CALENDARS.get(listing.partition(":")[0])
        ticker = str(position.get("ticker") or "").strip().upper()
        if ticker.endswith(".L"):
            return "XLON"

        # An issuer or share class can trade on several exchanges. Never
        # infer its venue from the ISIN alone or from its trading currency.
        isin = str(position.get("isin") or "").strip().upper()
        if not ticker or not re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}[0-9]", isin):
            return None
        mics = self._fund_mics(isin, ticker) if isin in self.fund_isins else set()
        if not mics:
            mics = self._master_calendars.get((isin, ticker), set())
        return next(iter(mics)) if len(mics) == 1 else None
