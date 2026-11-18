"""Publish independent, versioned news and calendar evidence on scheduled research runs."""

from datetime import UTC, datetime

from trading_max.domain import ArtifactQuality
from trading_max.research.calendars.refresh import MACRO_KEY, official_reader, refresh_calendar
from trading_max.research.news import NEWS_KEY, refresh_news

from .research_stages import _upstream_json
from .stages import StageResult


class EventSourceStage:
    required_for = frozenset()
    dependencies = ()

    def __init__(self, artifacts, snapshots):
        self.artifacts = artifacts
        self.snapshots = snapshots

    def run(self, context):
        latest = self.snapshots.latest(verify_artifacts=False)
        prior = (
            next((ref for ref in latest.manifest.artifacts if ref.key == self.key), None)
            if latest
            else None
        )
        previous = self.artifacts.get_json(prior.artifact_id).payload if prior else {}
        now = datetime.now(UTC)
        payload = self.refresh(previous, context, now)
        if prior and payload == previous:
            return StageResult(artifacts=(prior,))
        rows = payload[self.collection]
        warnings = [key for key, row in rows.items() if row.get("error")]
        # Oldest good observation is the coverage clock, even after a failed
        # attempt publishes fresh diagnostics.
        as_of = min((r["as_of"] for r in rows.values() if r.get("as_of")), default=None)
        ref = self.artifacts.put_json(
            key=self.key,
            kind=self.name,
            payload=payload,
            producer_version=self.version,
            as_of=as_of,
            quality=ArtifactQuality(
                status="warning" if warnings else "verified", warnings=warnings
            ),
        ).ref
        return StageResult(artifacts=(ref,), warnings=tuple(warnings))


class MacroCalendarStage(EventSourceStage):
    name = "research.macro_calendar"
    key = MACRO_KEY
    version = "official-calendar-v1"
    collection = "sources"

    def refresh(self, previous, context, now):
        with official_reader() as fetch:
            return refresh_calendar(previous, now, fetch)


class SecurityNewsStage(EventSourceStage):
    name = "research.security_news"
    key = NEWS_KEY
    version = "security-news-v1"
    collection = "securities"

    def __init__(self, artifacts, snapshots, market_service):
        super().__init__(artifacts, snapshots)
        self.market = market_service

    def refresh(self, previous, context, now):
        financials = _upstream_json(self.artifacts, context, "research/financials.json")
        evidence = (
            {
                row["ticker"]: row.get("financials", {}).get("evidence", {})
                for row in financials.payload["rows"]
            }
            if financials
            else {}
        )
        return refresh_news(previous, context.tickers, now, self.market.prices, financials=evidence)
