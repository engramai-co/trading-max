"""Read the open HMRC reporting funds register, independently of issuer data."""

from __future__ import annotations

import fcntl
import io
import json
import logging
from contextlib import suppress
from datetime import date, datetime, timedelta
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import httpx
from lxml import etree

from trading_max.domain.etf import FundEvidence
from trading_max.domain.etf_depth import ReportingPeriod, ReportingRegister, UKReportingFund

from .fund_downloads import isin, issuer_url
from .fund_holdings import _atomic_json

PUBLICATION = "https://www.gov.uk/government/publications/approved-offshore-reporting-funds"
CONTENT_API = PUBLICATION.replace("/government/", "/api/content/government/")
ATTACHMENT_ORIGIN = "https://assets.publishing.service.gov.uk"
ODS = "application/vnd.oasis.opendocument.spreadsheet"
PARSER = "hmrc-reporting-ods-v1"
REFRESH = timedelta(days=7)
RETRY = timedelta(days=1)
MAX_ODS = 12 * 1024 * 1024
MAX_XML = 192 * 1024 * 1024

_TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
_OFFICE = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
_TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
_HEADERS = ("isin no", "reporting fund, with effect from", "ceased to be an rf on")
LOGGER = logging.getLogger(__name__)


def _cells(row):
    # An ODS can represent many empty columns as a single repeated cell.
    # The current register has fewer than ten populated columns.
    cells = []
    for cell in row:
        if cell.tag not in {_TABLE + "table-cell", _TABLE + "covered-table-cell"}:
            continue
        value = (
            cell.get(_OFFICE + "date-value")
            or " ".join("".join(p.itertext()) for p in cell.iter(_TEXT + "p")).strip()
        )
        count = int(cell.get(_TABLE + "number-columns-repeated", "1"))
        cells.extend([value] * min(count, 32 - len(cells)))
        if len(cells) == 32:
            break
    return cells


def _date(raw: str) -> date:
    if "/" in raw:
        day, month, year = raw.split("/")
        return date(int(year), int(month), int(day))
    return date.fromisoformat(raw)


def parse_reporting_ods(payload: bytes) -> dict[str, list[ReportingPeriod]]:
    """Accept the named columns only; blanks and ambiguous identities stay unknown."""
    periods: dict[str, list[ReportingPeriod]] = {}
    cols = None
    with ZipFile(io.BytesIO(payload)) as archive:
        if archive.getinfo("content.xml").file_size > MAX_XML:
            raise ValueError("HMRC workbook content exceeds limit")
        with archive.open("content.xml") as xml:
            rows = etree.iterparse(
                xml, tag=_TABLE + "table-row", resolve_entities=False, no_network=True
            )
            for _, row in rows:
                cells = _cells(row)
                row.clear()
                while row.getprevious() is not None:
                    del row.getparent()[0]
                if cols is None:
                    headers = [cell.casefold() for cell in cells]
                    if all(key in headers for key in _HEADERS):
                        cols = tuple(headers.index(key) for key in _HEADERS)
                    continue
                if len(cells) <= max(cols):
                    continue
                identity, start, end = (cells[i] for i in cols)
                identity = isin(identity)
                if not identity:
                    continue
                try:
                    effective = _date(start)
                    ceased = None if end.casefold() in {"", "-", "n/a", "no data"} else _date(end)
                    if ceased is not None and ceased < effective:
                        raise ValueError("invalid reporting fund period")
                except ValueError:
                    # Retain a positive identity even when HMRC did not supply
                    # a usable period. Do not classify it as absent.
                    periods.setdefault(identity, [])
                    continue
                period = ReportingPeriod(effective_from=effective, ceased_on=ceased)
                group = periods.setdefault(identity, [])
                if period not in group:
                    group.append(period)
    if cols is None or not any(periods.values()):
        raise ValueError("HMRC reporting funds schema changed or empty")
    return periods


def reporting_fund(
    register: ReportingRegister | None, share_isin: str | None, today: date
) -> UKReportingFund | None:
    identity = isin(share_isin)
    if register is None or not identity:
        return None
    periods = register.periods.get(identity)
    active = [
        item
        for item in periods or ()
        if item.effective_from <= today and (item.ceased_on is None or item.ceased_on > today)
    ]
    period = None
    if periods is None:
        state = "not-listed"
    elif not periods or len(active) > 1:
        state = "unavailable"
    elif active:
        state, period = "reporting", active[0]
    elif prior := [item for item in periods if item.ceased_on and item.ceased_on <= today]:
        state, period = "ceased", max(prior, key=lambda item: item.ceased_on)
    else:
        state, period = "effective-later", min(periods, key=lambda item: item.effective_from)
    return UKReportingFund(
        state=state,
        publication_date=register.publication_date,
        effective_from=period.effective_from if period else None,
        ceased_on=period.ceased_on if period else None,
        evidence=FundEvidence(
            source_url=register.attachment_url,
            effective_at=(
                period.effective_from if period else register.publication_date
            ).isoformat(),
            fetched_at=register.fetched_at.isoformat(),
            parser_version=register.parser_version,
            coverage="missing" if state == "unavailable" else "available",
        ),
    )


def _download(client: httpx.Client, url: str, limit: int) -> bytes:
    with client.stream("GET", url, follow_redirects=False) as response:
        response.raise_for_status()
        result = bytearray()
        for chunk in response.iter_bytes(chunk_size=65536):
            result.extend(chunk)
            if len(result) > limit:
                raise ValueError("HMRC download exceeds limit")
        return bytes(result)


class HMRCReportingSource:
    """One global request budget per state root; retain the last valid release."""

    def __init__(self, root: Path, client: httpx.Client | None = None) -> None:
        self.root = root / "reference" / "hmrc-reporting"
        self.client = client

    def refresh(self, now: datetime) -> ReportingRegister | None:
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "refresh.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return self._refresh(now)

    def _refresh(self, now: datetime) -> ReportingRegister | None:
        path = self.root / "register-v1.json"
        clock = self.root / "attempt-v1.json"
        previous = None
        with suppress(ValueError, OSError):
            previous = ReportingRegister.model_validate_json(path.read_bytes())
        try:
            retry_at = datetime.fromisoformat(json.loads(clock.read_bytes())["nextAt"])
            if now < retry_at:
                return previous
        except (ValueError, OSError, KeyError, TypeError):
            pass
        # Bound attempts even if a worker is interrupted mid-download.
        _atomic_json(clock, {"nextAt": (now + RETRY).isoformat()})
        client = self.client or httpx.Client(
            timeout=httpx.Timeout(15), headers={"User-Agent": "Trading Max reporting funds"}
        )
        try:
            data = json.loads(_download(client, CONTENT_API, 1024 * 1024))
            (attachment,) = (
                item
                for item in data["details"]["attachments"]
                if item.get("content_type") == ODS
                and item.get("title", "").casefold() == "list of reporting funds a to z"
            )
            url = issuer_url(attachment["url"], ATTACHMENT_ORIGIN)
            if not url.endswith(".ods"):
                raise ValueError("HMRC attachment is not an ODS document")
            publication_date = datetime.fromisoformat(data["public_updated_at"]).date()
            if (
                previous
                and previous.parser_version == PARSER
                and previous.attachment_url == url
                and previous.publication_date == publication_date
            ):
                result = previous
            else:
                result = ReportingRegister(
                    source_url=PUBLICATION,
                    attachment_url=url,
                    publication_date=publication_date,
                    fetched_at=now,
                    parser_version=PARSER,
                    periods=parse_reporting_ods(_download(client, url, MAX_ODS)),
                )
                _atomic_json(path, result.model_dump(mode="json"))
            _atomic_json(clock, {"nextAt": (now + REFRESH).isoformat()})
            return result
        except (
            httpx.HTTPError,
            ValueError,
            TypeError,
            KeyError,
            OSError,
            BadZipFile,
            etree.LxmlError,
        ) as exc:
            LOGGER.warning("HMRC reporting funds refresh failed: %s", type(exc).__name__)
            return previous
        finally:
            if self.client is None:
                client.close()
