"""A listing and its evidence as selected from one immutable publication."""

from dataclasses import dataclass, replace
from functools import cached_property

from trading_max.research.held_funds import FundListingIdentity
from trading_max.research.venues import VenueClaim, resolve_venue, row_claims


@dataclass(frozen=True)
class PinnedListing:
    requested: str
    route: str
    ticker: str
    claims: tuple[VenueClaim, ...]
    aliases: tuple[str, ...] = ()
    held: FundListingIdentity | None = None
    price_row: dict | None = None
    fund_bars: bool = False
    quote_unit: str = ""

    @property
    def symbol(self):
        """Qualified symbol for this listing, independent of the legacy bar key."""
        return next((s for s in (self.requested, self.route, self.ticker) if "." in s), self.ticker)

    @cached_property
    def base_venue(self):
        return resolve_venue(self.requested, *self.claims, aliases=self.aliases)

    def venue(self, *additional: VenueClaim):
        if not additional:
            return self.base_venue
        return resolve_venue(self.requested, *self.claims, *additional, aliases=self.aliases)

    def with_event_claims(self, *rows):
        """Inherit container identity before joining evidence from several event feeds."""
        claims = list(self.claims)

        def collect(block):
            claims.extend(row_claims(self.ticker, block))
            for name in ("calendar", "analyst", "financials", "evidence"):
                child = block.get(name)
                if isinstance(child, dict):
                    collect(child)

        for row in rows:
            if row:
                collect(row)
        return replace(self, claims=tuple(claims))

    def event_row(self, row):
        """Check each parent before extracting dates, ratings, dividends or stories."""
        if not row:
            return {}, False

        def checked(block, inherited):
            observed = row_claims(self.ticker, block)
            # Most dated items inherit their parent's listing without any claims of their own.
            has_evidence = any(
                claim.source not in {"identity", "symbol"}
                or claim.value != self.ticker
                or claim.listing != self.ticker
                for claim in observed
            )
            claims = (*inherited, *observed) if has_evidence else inherited
            if self.venue(*claims).conflict:
                return {}, True
            result = block
            rejected = False
            for key in (
                "calendar",
                "analyst",
                "financials",
                "evidence",
                "items",
                "news",
                "dividends",
                "filings",
                "earningsEvents",
                "earningsHistory",
                "upgradesDowngrades",
            ):
                child = block.get(key)
                if isinstance(child, dict):
                    value, conflict = checked(child, claims)
                elif isinstance(child, list):
                    value = []
                    conflict = False
                    for item in child:
                        if isinstance(item, dict):
                            item, invalid = checked(item, claims)
                            conflict |= invalid
                            if not item and invalid:
                                continue
                        value.append(item)
                else:
                    continue
                if conflict:
                    result = {**result, key: value}
                    rejected = True
            return result, rejected

        return checked(row, ())


def exact_row(rows, ticker):
    return next((row for row in rows if str(row.get("ticker") or "").upper() == ticker), None)
