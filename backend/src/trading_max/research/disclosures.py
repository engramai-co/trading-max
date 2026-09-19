"""Public research evidence from the existing Yahoo adapter and filed XBRL.

Only actual provider records are returned. Filing parsing is deterministic and
cached outside the checkout; unavailable sections retain an explicit state.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import UTC, date, datetime
from html.parser import HTMLParser
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from urllib.parse import urlparse

import httpx
import yfinance as yf

from trading_max.infrastructure.singleflight import SingleFlightCache
from trading_max.research.facts import fingerprint, number

logger = logging.getLogger(__name__)

REVENUE_TAGS = {
    "revenuefromcontractwithcustomerexcludingassessedtax",
    "revenues",
    "salesrevenuenet",
    "revenuefromcontractwithcustomerincludingassessedtax",
}


class InlineFacts(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.contexts: dict[str, dict[str, Any]] = {}
        self.facts: list[dict[str, Any]] = []
        self.context: dict[str, Any] | None = None
        self.active_fact: dict[str, Any] | None = None
        self.capture: str | None = None
        self.dimension: str | None = None
        self.text: list[str] = []
        self.fact_text: list[str] = []
        self.exclude = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        local = tag.split(":")[-1]
        if local == "context":
            self.context = {"id": values.get("id"), "dimensions": {}}
        if self.context is not None and local in {
            "startdate",
            "enddate",
            "instant",
            "explicitmember",
        }:
            self.capture, self.text = local, []
            self.dimension = values.get("dimension")
        if tag in {"ix:nonfraction", "ix:nonnumeric"}:
            self.active_fact, self.fact_text = values, []
        if tag == "ix:exclude":
            self.exclude += 1

    def handle_data(self, text: str) -> None:
        if self.capture:
            self.text.append(text)
        if self.active_fact is not None and not self.exclude:
            self.fact_text.append(text)

    def handle_endtag(self, tag: str) -> None:
        local = tag.split(":")[-1]
        if self.capture == local and self.context is not None:
            text = "".join(self.text).strip()
            if local == "explicitmember" and self.dimension:
                self.context["dimensions"][self.dimension] = text
            else:
                self.context[local] = text
            self.capture = None
        if local == "context" and self.context is not None:
            self.contexts[str(self.context["id"])] = self.context
            self.context = None
        if tag == "ix:exclude":
            self.exclude = max(0, self.exclude - 1)
        if tag in {"ix:nonfraction", "ix:nonnumeric"} and self.active_fact is not None:
            self.facts.append({**self.active_fact, "text": "".join(self.fact_text).strip()})
            self.active_fact = None


def _fact_number(fact: dict[str, Any]) -> float | None:
    if str(fact.get("xsi:nil", "")).strip().lower() in {"true", "1"}:
        return None
    text = fact["text"].strip().replace(",", "").replace("$", "").replace("\xa0", "")
    if text in {"—", "–", "-"}:
        text = "0"
    sign = -1 if fact.get("sign") == "-" or text.startswith("(") else 1
    value = number(text.strip("()"))
    scale = number(fact.get("scale", 0))
    if value is None or scale is None or abs(scale) > 15:
        return None
    return sign * value * 10**scale


def parse_filing(content: str, *, url: str, filed_at: str, form: str) -> dict[str, Any]:
    parser = InlineFacts()
    parser.feed(content)
    document_facts = {
        str(f.get("name", "")).split(":")[-1].lower(): f
        for f in parser.facts
        if "document" in str(f.get("name", "")).lower()
    }
    metadata = {
        name: "true"
        if f.get("format", "").endswith("fixed-true")
        else "false"
        if f.get("format", "").endswith("fixed-false")
        else f["text"]
        for name, f in document_facts.items()
    }
    focus_year = number(metadata.get("documentfiscalyearfocus"))
    focus_period = metadata.get("documentfiscalperiodfocus", "")
    doc_end = ""
    for fmt in ("%Y-%m-%d", "%B %d, %Y", "%b %d, %Y", "%d %B %Y"):
        try:
            doc_end = (
                datetime.strptime(" ".join(metadata.get("documentperiodenddate", "").split()), fmt)
                .replace(tzinfo=UTC)
                .date()
                .isoformat()
            )
            break
        except ValueError:
            pass
    if not doc_end:
        # Some annual filings omit a visible DEI end-date fact. The fiscal-focus
        # fact's XBRL context still explicitly identifies the reporting period.
        focus = document_facts.get("documentfiscalyearfocus", {})
        doc_end = parser.contexts.get(str(focus.get("contextref")), {}).get("enddate", "")
    version = hashlib.sha256(content.encode()).hexdigest()
    periods, segments, totals = {}, {}, {}
    observations = {}
    for fact in parser.facts:
        tag = str(fact.get("name", "")).split(":")[-1].lower()
        if tag not in REVENUE_TAGS and tag not in {
            "earningspersharediluted",
            "earningspersharebasic",
            "commonstocksharesoutstanding",
        }:
            continue
        context = parser.contexts.get(str(fact.get("contextref")), {})
        if tag == "commonstocksharesoutstanding":
            value = _fact_number(fact)
            instant = context.get("instant")
            if instant and not context.get("dimensions") and value is not None and value > 0:
                key = ("shares", instant)
                observation = {"metric": "shares", "date": instant, "value": value}
                if key in observations and observations[key]["value"] != value:
                    observation["value"] = None
                observations[key] = observation
            continue
        start, end = context.get("startdate"), context.get("enddate")
        try:
            days = (date.fromisoformat(end) - date.fromisoformat(start)).days + 1
        except (ValueError, TypeError):
            continue
        kind = (
            "annual"
            if 330 <= days <= 380
            else "quarterly"
            if 65 <= days <= 110
            else "semiannual"
            if 150 <= days <= 210
            else "yearToDate"
            if 240 <= days <= 300
            else "irregular"
            if metadata.get("documenttransitionreport", "").lower() in {"true", "1"}
            else None
        )
        value = _fact_number(fact)
        if not kind or value is None:
            continue
        unit = str(fact.get("unitref") or "")
        currency = next(
            (
                code
                for code in ("USD", "GBP", "EUR", "JPY", "CNY", "CAD", "CHF", "AUD", "HKD")
                if code.lower() in unit.lower()
            ),
            None,
        )
        dimensions = context.get("dimensions") or {}
        fiscal_year = (
            int(focus_year) - (int(doc_end[:4]) - int(end[:4]))
            if focus_year and re.match(r"\d{4}-", doc_end)
            else int(end[:4])
        )
        period_key = kind + ":" + end
        if not dimensions and tag in {"earningspersharediluted", "earningspersharebasic"}:
            if tag == "earningspersharediluted":
                key = (kind, start, end, currency)
                observation = {
                    "metric": "eps",
                    "kind": kind,
                    "periodStart": start,
                    "periodEnd": end,
                    "currency": currency,
                    "value": value,
                }
                if key in observations and observations[key]["value"] != value:
                    observation["value"] = None
                observations[key] = observation
            continue
        if tag not in REVENUE_TAGS:
            continue
        if not dimensions:
            key = ("revenue", start, end, currency)
            observation = {
                "metric": "revenue",
                "kind": kind,
                "periodStart": start,
                "periodEnd": end,
                "currency": currency,
                "value": value,
            }
            if key in observations and observations[key]["value"] != value:
                observation["value"] = None
            observations[key] = observation
            if kind == "yearToDate":
                continue
            totals[(start, end, currency)] = value
            periods[period_key] = {
                "kind": kind,
                "actualStart": start,
                "actualEnd": end,
                "fiscalYear": fiscal_year,
                "fiscalQuarter": int(focus_period[1:])
                if kind == "quarterly" and re.fullmatch(r"Q[1-4]", focus_period)
                else None,
                "publishedAt": filed_at,
                "url": url,
                "sourceVersion": version,
                "form": form,
            }
            continue
        if kind == "yearToDate":
            continue
        if len(dimensions) != 1:
            continue
        axis, member = next(iter(dimensions.items()))
        if any(word in axis.lower() for word in ("geograph", "country", "region")):
            dimension = "geography"
        elif any(
            word in axis.lower()
            for word in ("productorservice", "businesssegment", "reportablesegment", "segmentaxis")
        ):
            dimension = "business"
        else:
            continue
        name = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", member.split(":")[-1].removesuffix("Member"))
        name = {
            "IPhone": "iPhone",
            "IPad": "iPad",
            "Service": "Services",
            "Product": "Products",
            "US": "United States",
            "CN": "China",
            "Wearables Homeand Accessories": "Wearables, Home and Accessories",
        }.get(name, name)
        identity = (start, end, dimension, axis, member, currency)
        segments[identity] = {
            "id": fingerprint(identity),
            "name": name,
            "member": member,
            "axis": axis,
            "dimension": dimension,
            "kind": kind,
            "periodStart": start,
            "periodEnd": end,
            "fiscalYear": fiscal_year,
            "value": value,
            "currency": currency,
            "source": "filed-xbrl",
            "url": url,
            "publishedAt": filed_at,
            "version": version,
        }
    for segment in segments.values():
        total = totals.get((segment["periodStart"], segment["periodEnd"], segment["currency"]))
        segment["reportedTotal"] = total
        segment["share"] = segment["value"] / total if total and total > 0 else None
    # Do not stack a standard product subtotal with its reported components.
    # A subtotal is removed only when multiple issuer products reconcile to it.
    for identity, segment in list(segments.items()):
        if segment["member"] != "us-gaap:ProductMember":
            continue
        leaves = [
            s
            for s in segments.values()
            if s["axis"] == segment["axis"]
            and s["periodStart"] == segment["periodStart"]
            and s["periodEnd"] == segment["periodEnd"]
            and s["currency"] == segment["currency"]
            and not s["member"].startswith("us-gaap:")
        ]
        if len(leaves) > 1 and abs(sum(s["value"] for s in leaves) - segment["value"]) <= max(
            1, abs(segment["value"]) * 1e-6
        ):
            del segments[identity]
    return {
        "periods": list(periods.values()),
        "segments": list(segments.values()),
        "version": version,
        "observations": list(observations.values()),
        "publishedAt": filed_at,
        "url": url,
        "form": form,
        "periodEnd": doc_end or None,
        "fiscalYear": int(focus_year) if focus_year else None,
        "fiscalPeriod": focus_period or None,
    }


def link_filing_periods(
    filings: list[dict[str, Any]], releases: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Join verified document metadata; never infer an amendment from its date alone."""
    by_url = {r["url"]: r for r in releases}
    rows = []
    for filing in filings:
        document = next(
            (by_url[url] for url in filing.get("documents", {}).values() if url in by_url),
            None,
        )
        row = dict(filing)
        if document:
            row.update(
                {key: document.get(key) for key in ("periodEnd", "fiscalYear", "fiscalPeriod")}
            )
            row["sourceVersion"] = document["version"]
        rows.append(row)
    for row in rows:
        if not row.get("amendment") or not row.get("periodEnd"):
            continue
        originals = [
            f
            for f in rows
            if f["form"] == row["form"].removesuffix("/A")
            and f.get("periodEnd") == row["periodEnd"]
            and f["date"] <= row["date"]
        ]
        if len(originals) == 1:
            row["amendsId"] = originals[0]["id"]
            row["amendsUrl"] = originals[0]["url"]
            originals[0]["amendments"] = [
                *originals[0].get("amendments", []),
                {"id": row["id"], "url": row["url"], "date": row["date"]},
            ]
    return rows


def match_periods(raw: dict[str, Any], periods: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for kind, key in (("annual", "incomeStatement"), ("quarterly", "quarterlyIncomeStatement")):
        ends = {
            str(key)[:10]
            for row in raw.get(key) or []
            for key in row
            if re.match(r"\d{4}-\d{2}-\d{2}", str(key))
        }
        for end in ends:
            matches = [
                p
                for p in periods
                if (
                    p["kind"] == kind
                    or (kind == "quarterly" and p["kind"] in {"semiannual", "irregular"})
                )
                and abs((date.fromisoformat(end) - date.fromisoformat(p["actualEnd"])).days) <= 7
            ]
            if matches:
                chosen = max(matches, key=lambda p: (p["publishedAt"], p["actualEnd"]))
                result.append({**chosen, "providerEnd": end, "providerKind": kind})
    return result


class ResearchEvidenceProvider:
    def __init__(self, cache_root: Path) -> None:
        self.root = cache_root
        self.documents: SingleFlightCache[str, str] = SingleFlightCache(4)
        self.parsed_filings: SingleFlightCache[str, dict[str, Any]] = SingleFlightCache(32)
        self.document_slots = threading.BoundedSemaphore(3)

    def _document(self, url: str) -> str:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in {
            "cdn.yahoofinance.com",
            "www.sec.gov",
            "www.apple.com",
        }:
            raise ValueError("unsupported-filing-host")

        def load() -> str:
            path = self.root / (hashlib.sha256(url.encode()).hexdigest() + ".html")
            if path.is_file():
                return path.read_text()
            with self.document_slots:
                response = httpx.get(
                    url,
                    timeout=25,
                    headers={
                        "User-Agent": "TradingMax research https://github.com/engramai-co/trading-max"
                    },
                )
                response.raise_for_status()
                if len(response.content) > 25_000_000:
                    raise ValueError("filing-exceeds-size-limit")
                self._write_cache(path, response.text)
                return response.text

        return self.documents.get_or_compute(url, load)

    @staticmethod
    def _write_cache(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(mode="w", dir=path.parent, suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            try:
                handle.write(content)
                handle.flush()
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)

    def _filing(self, filing: dict[str, Any]) -> dict[str, Any] | None:
        form = filing["type"]
        url = (filing.get("exhibits") or {}).get(form)
        if not url:
            return None
        key = fingerprint([url, str(filing["date"]), form, "inline-parser-v2"])

        def load() -> dict[str, Any]:
            path = self.root / (key + ".parsed.json")
            with suppress(OSError, ValueError):
                saved = json.loads(path.read_text())
                if all(k in saved for k in ("periods", "segments", "observations", "publishedAt")):
                    return saved
            parsed = parse_filing(
                self._document(url), url=url, filed_at=str(filing["date"]), form=form
            )
            self._write_cache(path, json.dumps(parsed))
            return parsed

        return self.parsed_filings.get_or_compute(key, load)

    def _filings(self, selected: list[dict[str, Any]]) -> list[dict[str, Any] | Exception | None]:
        # Bound external requests, keep provider order for deterministic merging,
        # and retain each failure independently rather than dropping other filings.
        def read(filing):
            try:
                return self._filing(filing)
            except (ValueError, OSError, httpx.HTTPError) as exc:
                return exc

        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="research-filing") as pool:
            return list(pool.map(read, selected))

    def __call__(self, ticker: str, financials: dict[str, Any]) -> dict[str, Any]:
        cache = self.root / (fingerprint([ticker, "evidence-v8"]) + ".json")
        if cache.is_file() and time.time() - cache.stat().st_mtime < 6 * 3600:
            return json.loads(cache.read_text())
        proxy = yf.Ticker(ticker)
        result: dict[str, Any] = {
            "asOf": datetime.now(UTC).isoformat(),
            "filings": [],
            "news": [],
            "dividends": [],
            "segments": [],
            "periodEvidence": [],
            "status": {},
        }
        try:
            filings = proxy.get_sec_filings() or []
            result["filings"] = [
                {
                    "id": fingerprint([f.get("edgarUrl"), f.get("type"), str(f.get("date"))]),
                    "accession": (re.search(r"\d{10}-\d{2}-\d{6}", str(f.get("edgarUrl") or ""))[0])
                    if re.search(r"\d{10}-\d{2}-\d{6}", str(f.get("edgarUrl") or ""))
                    else None,
                    "amendment": str(f.get("type") or "").endswith("/A"),
                    "date": str(f.get("date") or ""),
                    "form": str(f.get("type") or ""),
                    "title": str(f.get("title") or ""),
                    "url": f.get("edgarUrl"),
                    "documents": dict(f.get("exhibits") or {}),
                }
                for f in filings[:80]
            ]
            result["filings"] = list({f["id"]: f for f in result["filings"]}.values())
            selected, counts = [], {}
            for filing in filings:
                form = filing.get("type")
                base_form = str(form).removesuffix("/A")
                if base_form not in {"10-K", "10-Q", "20-F", "40-F"} or counts.get(form, 0) >= (
                    4 if base_form in {"10-K", "20-F", "40-F"} else 8
                ):
                    continue
                counts[form] = counts.get(form, 0) + 1
                selected.append(filing)
            periods, segments = [], {}
            releases = []
            started = time.perf_counter()
            for parsed in self._filings(selected):
                if isinstance(parsed, Exception):
                    result["status"]["filingContent"] = {
                        "state": "missing",
                        "reason": type(parsed).__name__,
                    }
                    continue
                if parsed is None:
                    continue
                periods.extend(parsed["periods"])
                releases.append(parsed)
                for segment in parsed["segments"]:
                    identity = (
                        segment["kind"],
                        segment["periodEnd"],
                        segment["member"],
                        segment["axis"],
                        segment["currency"],
                    )
                    # Newest filed restatement wins in this snapshot only.
                    if (
                        identity not in segments
                        or segments[identity]["publishedAt"] < segment["publishedAt"]
                    ):
                        segments[identity] = segment
            logger.info(
                "research_filings ticker=%s count=%d duration_ms=%.1f",
                ticker,
                len(selected),
                (time.perf_counter() - started) * 1000,
            )
            result["segments"] = list(segments.values())
            result["filings"] = link_filing_periods(result["filings"], releases)
            annual_revenue = {}
            for release in sorted(releases, key=lambda r: r["publishedAt"]):
                for observation in release["observations"]:
                    if observation["metric"] == "revenue" and observation["kind"] == "annual":
                        annual_revenue[(observation["periodEnd"], observation["currency"])] = {
                            **observation,
                            "url": release["url"],
                            "sourceVersion": release["version"],
                            "publishedAt": release["publishedAt"],
                        }
            result["annualRevenue"] = list(annual_revenue.values())
            if releases:
                try:
                    from trading_max.research.filing_multiples import (
                        release_multiples,
                        release_sales_multiples,
                    )

                    history = proxy.history(period="10y", auto_adjust=False, actions=True)
                    metadata = proxy.get_history_metadata() or {}
                    code = metadata.get("currency")
                    scale = 0.01 if code in {"GBp", "GBX"} else 1
                    code = "GBP" if scale == 0.01 else code
                    # Yahoo Close is split-adjusted. Undo splits after each
                    # historical date before pairing with originally filed EPS.
                    reverse_splits = (
                        history.get("Stock Splits").replace(0, 1).iloc[::-1].cumprod().iloc[::-1]
                    )
                    rows = [
                        {
                            "date": str(day.date()),
                            "split": float(row.get("Stock Splits") or 0),
                            "close": float(row["Close"])
                            * float(reverse_splits.loc[day] / (row.get("Stock Splits") or 1))
                            * scale,
                        }
                        for day, row in history.iterrows()
                    ]
                    result["releaseMultiples"] = release_multiples(releases, rows, code)
                    result["releaseSalesMultiples"] = release_sales_multiples(releases, rows, code)
                except Exception as exc:
                    result["status"]["releaseMultiples"] = {
                        "state": "missing",
                        "reason": type(exc).__name__,
                    }
            result["periodEvidence"] = match_periods(financials, periods)
            result["status"]["filings"] = {"state": "available" if filings else "missing"}
        except Exception as exc:
            result["status"]["filings"] = {"state": "missing", "reason": type(exc).__name__}
        try:
            dividends = proxy.get_dividends(period="max")
            dividend_code = (proxy.get_history_metadata() or {}).get("currency")
            dividend_scale = 0.01 if dividend_code in {"GBp", "GBX"} else 1
            dividend_code = "GBP" if dividend_scale == 0.01 else dividend_code
            result["dividends"] = [
                {
                    "date": str(day.date()),
                    "amount": float(value) * dividend_scale,
                    "currency": dividend_code,
                    "kind": "unspecified",
                    "basis": "provider-adjusted-per-share",
                }
                for day, value in dividends.items()
                if value is not None
            ][-120:]
            result["dividendCoverage"] = {
                "hasEarlierRecords": len(dividends) > 120,
                "start": result["dividends"][0]["date"] if result["dividends"] else None,
                "end": str(datetime.now(UTC).date()),
                "basis": "provider-adjusted-per-share",
            }
        except Exception as exc:
            result["status"]["dividends"] = {"state": "missing", "reason": type(exc).__name__}
        try:
            seen = set()
            for row in proxy.news or []:
                news = row.get("content") or {}
                url = (news.get("canonicalUrl") or {}).get("url")
                identity = (
                    re.sub(r"\W+", "", str(news.get("title") or "").casefold()),
                    str(news.get("pubDate") or "")[:10],
                )
                if (
                    not url
                    or url in seen
                    or identity in seen
                    or urlparse(url).scheme not in {"http", "https"}
                ):
                    continue
                seen.add(url)
                seen.add(identity)
                result["news"].append(
                    {
                        "id": row.get("id"),
                        "title": news.get("title"),
                        "url": url,
                        "publishedAt": news.get("pubDate"),
                        "source": (news.get("provider") or {}).get("displayName"),
                        "entityAssociation": "provider-security-feed",
                    }
                )
        except Exception as exc:
            result["status"]["news"] = {"state": "missing", "reason": type(exc).__name__}
        self.root.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(result, default=str))
        return result
