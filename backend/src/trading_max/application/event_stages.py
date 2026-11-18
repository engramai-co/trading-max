"""Publish independent, versioned news and calendar evidence on scheduled research runs."""

from datetime import UTC, datetime

from trading_max.domain import ArtifactQuality
from trading_max.research.calendars.refresh import (
    MACRO_KEY,
    MACRO_STATUS_KEY,
    official_reader,
    refresh_calendar,
)
from trading_max.research.news import NEWS_KEY, NEWS_STATUS_KEY, refresh_news

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
        refs = {r.key: r for r in latest.manifest.artifacts} if latest else {}

        def previous(key):
            return self.artifacts.get_json(refs[key].artifact_id).payload if key in refs else {}

        prior = previous(self.key)
        status = previous(self.status_key)
        combined = prior
        if self.key == NEWS_KEY and status:
            combined = {
                self.collection: {
                    k: {**v, **status[self.collection].get(k, {})}
                    for k, v in prior.get(self.collection, {}).items()
                }
            }
        payload = self.refresh(combined, context, datetime.now(UTC))
        rows = payload[self.collection]
        diagnostics = {
            self.collection: {
                k: {
                    field: row[field]
                    for field in ("checked_at", "as_of", "error", "publisher")
                    if field in row
                }
                for k, row in rows.items()
            }
        }
        content = (
            {self.collection: {k: {"items": v.get("items", [])} for k, v in rows.items()}}
            if self.key == NEWS_KEY
            else payload
        )
        warnings = [key for key, row in rows.items() if row.get("error")]
        # Oldest good observation is the coverage clock, even after a failed
        # attempt publishes fresh diagnostics.
        as_of = min((r["as_of"] for r in rows.values() if r.get("as_of")), default=None)
        quality = ArtifactQuality(status="warning" if warnings else "verified", warnings=warnings)
        content_ref = refs.get(self.key)
        if not content_ref or content != prior:
            content_ref = self.artifacts.put_json(
                key=self.key,
                kind=self.name,
                payload=content,
                producer_version=self.version,
                as_of=as_of,
                quality=ArtifactQuality() if self.key == NEWS_KEY else quality,
            ).ref
        status_ref = refs.get(self.status_key)
        if not status_ref or diagnostics != status:
            status_ref = self.artifacts.put_json(
                key=self.status_key,
                kind=self.name + ".status",
                payload=diagnostics,
                producer_version=self.version,
                as_of=as_of,
                quality=quality,
            ).ref
        return StageResult(artifacts=(content_ref, status_ref), warnings=tuple(warnings))


class MacroCalendarStage(EventSourceStage):
    name = "research.macro_calendar"
    key = MACRO_KEY
    status_key = MACRO_STATUS_KEY
    version = "official-calendar-v1"
    collection = "sources"

    def refresh(self, previous, context, now):
        with official_reader() as fetch:
            return refresh_calendar(previous, now, fetch)


class SecurityNewsStage(EventSourceStage):
    name = "research.security_news"
    key = NEWS_KEY
    status_key = NEWS_STATUS_KEY
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
